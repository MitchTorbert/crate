// "Old hard drive": a permanent copy of an old iTunes library (or a plain music folder),
// read in the browser from files the person picks, saved to their account, then browsable.
"use strict";

const VAULT = { data: null, loading: false, status: "", tab: "albums", sort: "plays", q: "", year: "", shown: 120, open: null };

// Track rows are stored as arrays to keep the archive small. Order matters.
const TF = ["id", "name", "artist", "albumArtist", "album", "genre", "year", "trackNo", "discNo", "ms",
  "plays", "lastPlayed", "added", "rating", "loved", "skips", "kind", "path", "compilation", "composer"];

// ------------------------------------------------------------------ reading an iTunes library file

function plistValue(node) {
  switch (node.tagName) {
    case "dict": {
      const o = {};
      const kids = node.children;
      for (let i = 0; i < kids.length - 1; i += 2) o[kids[i].textContent] = plistValue(kids[i + 1]);
      return o;
    }
    case "array": return Array.from(node.children, plistValue);
    case "integer": case "real": return Number(node.textContent);
    case "true": return true;
    case "false": return false;
    default: return node.textContent; // string, date, data
  }
}

function parseItunesXml(text) {
  const doc = new DOMParser().parseFromString(text, "application/xml");
  if (doc.querySelector("parsererror")) throw new Error("That file couldn't be read as an iTunes library.");
  const root = doc.querySelector("plist > dict");
  if (!root) throw new Error("That file isn't an iTunes library.");
  const lib = plistValue(root);
  if (!lib.Tracks) throw new Error("That file has no songs in it. Pick “iTunes Music Library.xml” or “iTunes Library.xml”.");

  const tracks = [];
  for (const t of Object.values(lib.Tracks)) {
    if (t["Podcast"] || t["Movie"] || t["TV Show"] || /video|podcast|audiobook|book/i.test(t["Kind"] || "")) continue;
    tracks.push([
      t["Track ID"], t["Name"] || "", t["Artist"] || "", t["Album Artist"] || "", t["Album"] || "", t["Genre"] || "",
      t["Year"] || null, t["Track Number"] || null, t["Disc Number"] || null, t["Total Time"] || null,
      t["Play Count"] || 0, t["Play Date UTC"] || "", t["Date Added"] || "", t["Rating"] || 0, t["Loved"] ? 1 : 0,
      t["Skip Count"] || 0, t["Kind"] || "", decodeLocation(t["Location"]), t["Compilation"] ? 1 : 0, t["Composer"] || "",
    ]);
  }
  const ids = new Set(tracks.map((t) => t[0]));
  const playlists = [];
  for (const p of lib.Playlists || []) {
    if (p["Master"] || p["Distinguished Kind"] || p["Folder"]) continue;
    const items = (p["Playlist Items"] || []).map((x) => x["Track ID"]).filter((id) => ids.has(id));
    if (!items.length) continue;
    playlists.push({ name: p["Name"] || "Untitled", smart: !!p["Smart Info"], items });
  }
  return { source: "iTunes library", tracks, playlists, libraryDate: lib["Date"] || "", musicFolder: decodeLocation(lib["Music Folder"]) };
}

function decodeLocation(loc) {
  if (!loc) return "";
  try { return decodeURIComponent(String(loc).replace(/^file:\/\/(localhost)?/, "")); } catch { return String(loc); }
}

// ------------------------------------------------------------------ reading a plain music folder

const AUDIO_EXT = /\.(mp3|m4a|m4p|aac|flac|wav|aiff?|alac|ogg|opus|wma)$/i;

function parseFolder(files) {
  const tracks = [];
  let id = 1;
  for (const f of files) {
    if (!AUDIO_EXT.test(f.name)) continue;
    const parts = (f.webkitRelativePath || f.name).split("/").filter(Boolean);
    let album = parts.length >= 3 ? parts[parts.length - 2] : "";
    let artist = parts.length >= 4 ? parts[parts.length - 3] : "";
    if (/^(disc|cd)\s*\d+$/i.test(album) && parts.length >= 5) { album = parts[parts.length - 3]; artist = parts[parts.length - 4]; }
    const m = album.match(/^(.+?)\s+[-–]\s+(.+)$/);
    if (m && (!artist || parts.length <= 3)) { artist = m[1]; album = m[2]; }
    const name = f.name.replace(AUDIO_EXT, "").replace(/^\d{1,2}[-\s.]+(\d{1,2}[\s.]+)?/, "").trim();
    const no = Number((f.name.match(/^(\d{1,2})/) || [])[1]) || null;
    tracks.push([id++, name, artist, "", album, "", null, no, null, null, 0, "", new Date(f.lastModified).toISOString(), 0, 0, 0,
      f.name.split(".").pop().toUpperCase(), parts.join("/"), 0, ""]);
  }
  if (!tracks.length) throw new Error("No music files were found in that folder.");
  return { source: "Music folder", tracks, playlists: [] };
}

// ------------------------------------------------------------------ saving

// Sizes are measured in UTF-8 bytes, which is what Firestore counts.
const utf8 = new TextEncoder();
function chunkBy(list, maxBytes) {
  const out = [];
  let cur = [], size = 0;
  for (const item of list) {
    const s = utf8.encode(JSON.stringify(item)).length + 8;
    if (cur.length && size + s > maxBytes) { out.push(cur); cur = []; size = 0; }
    cur.push(item); size += s;
  }
  if (cur.length) out.push(cur);
  return out;
}

async function saveArchive(parsed) {
  const docs = {};
  // Firestore can't store arrays of arrays, so each track row is kept as a JSON string.
  chunkBy(parsed.tracks.map((t) => JSON.stringify(t)), 600000).forEach((rows, i) => { docs[`tracks-${String(i).padStart(3, "0")}`] = { rows }; });
  chunkBy(parsed.playlists, 600000).forEach((pls, i) => { docs[`playlists-${String(i).padStart(3, "0")}`] = { pls }; });
  docs.info = {
    source: parsed.source, importedAt: Math.floor(Date.now() / 1000), fields: TF,
    trackCount: parsed.tracks.length, playlistCount: parsed.playlists.length,
    libraryDate: parsed.libraryDate || "", musicFolder: parsed.musicFolder || "",
    chunks: Object.keys(docs).length,
  };
  await Store.saveVault(docs, (i, n) => setVaultStatus(`Saving to your account… ${i} of ${n}`));
}

function unpackArchive(raw) {
  if (!raw?.info) return null;
  const tracks = [], playlists = [];
  for (const id of Object.keys(raw).sort()) {
    if (id.startsWith("tracks-")) for (const r of raw[id].rows) tracks.push(JSON.parse(r));
    if (id.startsWith("playlists-")) playlists.push(...raw[id].pls);
  }
  return { info: raw.info, tracks, playlists };
}

function setVaultStatus(text) {
  VAULT.status = text;
  const el = document.getElementById("vault-status");
  if (el) el.textContent = text;
}

async function importOld(files, kind) {
  if (!Store.canArchive()) { toast("Sign in to Crate first so the archive is saved to your account."); return; }
  VAULT.loading = true;
  setVaultStatus("Reading…");
  render();
  try {
    let parsed;
    if (kind === "xml") {
      const f = files[0];
      setVaultStatus(`Reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      parsed = parseItunesXml(await f.text());
    } else {
      parsed = parseFolder([...files]);
    }
    setVaultStatus(`Found ${parsed.tracks.length.toLocaleString()} songs. Saving to your account…`);
    await saveArchive(parsed);
    // Prove it landed: read everything back from the server and compare.
    setVaultStatus("Checking the saved copy…");
    const back = unpackArchive(await Store.loadVault({ fromServer: true }));
    if (!back || back.tracks.length !== parsed.tracks.length || back.playlists.length !== parsed.playlists.length) {
      throw new Error("The saved copy didn't match what was read. Keep the drive plugged in and try again.");
    }
    VAULT.data = back;
    VAULT.verified = true;
    setVaultStatus("");
  } catch (e) {
    setVaultStatus("");
    VAULT.loading = false;
    toast(e.message || "Couldn't read that.");
    render();
    return;
  }
  VAULT.loading = false;
  render();
}

// ------------------------------------------------------------------ browsing

function albumsOf(data) {
  const byKey = new Map();
  for (const r of data.tracks) {
    const t = Object.fromEntries(TF.map((f, i) => [f, r[i]]));
    const artist = t.compilation ? "Various Artists" : (t.albumArtist || t.artist);
    const k = norm(t.album || "(no album)") + "|" + norm(artist);
    const a = byKey.get(k) || { k, title: t.album || "(no album)", artist, year: t.year, genre: t.genre, songs: 0, plays: 0, last: "", added: "", rated: [], loved: 0 };
    a.songs++; a.plays += t.plays || 0;
    if (t.lastPlayed > a.last) a.last = t.lastPlayed;
    if (t.added && (!a.added || t.added < a.added)) a.added = t.added;
    if (t.rating) a.rated.push(t.rating);
    a.loved += t.loved || 0;
    if (!a.year && t.year) a.year = t.year;
    if (!a.genre && t.genre) a.genre = t.genre;
    byKey.set(k, a);
  }
  return [...byKey.values()].map((a) => ({ ...a, stars: a.rated.length ? Math.round(a.rated.reduce((x, y) => x + y, 0) / a.rated.length / 20) : 0 }));
}

const stars = (n) => (n ? "★".repeat(n) + "☆".repeat(5 - n) : "");
const shortDate = (d) => (d ? new Date(d).toLocaleDateString(undefined, { month: "short", year: "numeric" }) : "");

function renderVault() {
  // Look for a saved archive once per visit; "Import again" skips it.
  if (!VAULT.data && !VAULT.loading && !VAULT.checked && Store.canArchive()) {
    VAULT.loading = true;
    VAULT.status = "Loading your saved library…";
    Store.loadVault().then((raw) => { VAULT.data = unpackArchive(raw); })
      .catch(() => {})
      .finally(() => { VAULT.loading = false; VAULT.checked = true; VAULT.status = ""; if (S.route.name === "vault") render(); });
  }
  const d = VAULT.data;
  view.innerHTML = `
    <h1 class="page-title">Old hard drive</h1>
    ${d ? vaultBrowse(d) : vaultImport()}`;
  wireVault();
}

function vaultImport() {
  if (!Store.canArchive()) {
    return `<div class="empty" style="margin-top:16px">Sign in to Crate first (top right), so everything is saved to your account and not just this browser.</div>`;
  }
  return `
    <p class="note">Save a permanent copy of your old iTunes library to your Crate account: every song, play count, rating, date added, and playlist.
      It stays here after you unplug the drive.</p>
    <section class="import">
      <div class="drop">
        ${VAULT.loading ? `<b id="vault-status">${esc(VAULT.status || "Loading…")}</b>` : `
        <b>1. Pick your iTunes library file</b>
        <span class="note">On the old drive, open <b>Users → your name → Music → iTunes</b> and pick <b>iTunes Music Library.xml</b> (or <b>iTunes Library.xml</b>). Not the “.itl” file.</span>
        <div class="import-btns"><label class="btn primary">Choose the library file<input type="file" id="vault-xml" accept=".xml,text/xml" hidden></label></div>
        <span class="meta" style="margin-top:10px">No .xml file? Choose the music folder itself (iTunes Media → Music). That keeps artists, albums, and songs, but not play counts or ratings.</span>
        <div class="import-btns"><label class="btn">Choose the music folder<input type="file" id="vault-dir" webkitdirectory multiple hidden></label></div>`}
      </div>
    </section>`;
}

function vaultBrowse(d) {
  const albums = albumsOf(d);
  const plays = d.tracks.reduce((n, r) => n + (r[10] || 0), 0);
  const years = {};
  for (const a of albums) if (a.added) { const y = a.added.slice(0, 4); years[y] = (years[y] || 0) + 1; }
  const q = VAULT.q.toLowerCase();
  let list = albums.filter((a) => (!VAULT.year || (a.added || "").startsWith(VAULT.year)) && (!q || `${a.title} ${a.artist} ${a.genre}`.toLowerCase().includes(q)));
  const sorters = {
    plays: (a, b) => b.plays - a.plays, added: (a, b) => (b.added || "").localeCompare(a.added || ""), oldest: (a, b) => (a.added || "~").localeCompare(b.added || "~"),
    rating: (a, b) => b.stars - a.stars || b.plays - a.plays, artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  };
  list.sort(sorters[VAULT.sort]);
  const owned = new Map(allAlbums().map((x) => [norm(x.title) + "|" + norm(x.artist), x]));
  const info = d.info;
  return `
    <p class="note">${VAULT.verified ? "<b>Saved and checked.</b> Everything below is stored in your account, so it's safe to unplug the drive. " : ""}
      ${d.tracks.length.toLocaleString()} songs · ${albums.length.toLocaleString()} albums · ${d.playlists.length} playlists · ${plays.toLocaleString()} plays.
      From ${esc(info.source)}${info.libraryDate ? `, last updated ${shortDate(info.libraryDate)}` : ""}.</p>
    <div class="vault-tabs">
      <button class="btn ${VAULT.tab === "albums" ? "primary" : ""}" data-vtab="albums">Albums</button>
      <button class="btn ${VAULT.tab === "playlists" ? "primary" : ""}" data-vtab="playlists">Playlists (${d.playlists.length})</button>
      <button class="btn" id="vault-backup" title="Save a copy as a file on this computer">Download a backup file</button>
      <button class="link" id="vault-redo">Import again</button>
    </div>
    ${VAULT.tab === "playlists" ? vaultPlaylists(d) : `
    <div class="vault-tools">
      <input id="vault-q" type="search" placeholder="Filter by album, artist, or genre" value="${esc(VAULT.q)}" autocomplete="off">
      <select id="vault-sort" aria-label="Sort albums">
        ${[["plays", "Most played"], ["added", "Newest added"], ["oldest", "Oldest added"], ["rating", "Highest rated"], ["artist", "Artist A–Z"]]
          .map(([v, l]) => `<option value="${v}" ${VAULT.sort === v ? "selected" : ""}>${l}</option>`).join("")}
      </select>
    </div>
    <div class="year-chips">
      <button class="chip ${VAULT.year ? "" : "on"}" data-vyear="">All years</button>
      ${Object.keys(years).sort().map((y) => `<button class="chip ${VAULT.year === y ? "on" : ""}" data-vyear="${y}">Added ${y} <span>${years[y]}</span></button>`).join("")}
    </div>
    <div class="vault-table" role="table">
      <div class="vrow vhead" role="row"><span>Album</span><span>Songs</span><span>Plays</span><span>Added</span><span>Rating</span><span></span></div>
      ${list.slice(0, VAULT.shown).map((a) => {
        const have = owned.get(norm(a.title) + "|" + norm(a.artist));
        return `
        <div class="vrow" role="row" data-vk="${esc(a.k)}">
          <span class="vt"><b>${esc(a.title)}</b><small>${esc(a.artist)}${a.year ? " · " + a.year : ""}${a.genre ? " · " + esc(a.genre) : ""}</small></span>
          <span class="num">${a.songs}</span><span class="num">${a.plays.toLocaleString()}</span>
          <span class="num">${shortDate(a.added)}</span><span class="stars">${stars(a.stars)}</span>
          <span class="vact">${have ? `<span class="meta"><i class="dot" style="background:${esc(have.shelf.color)}"></i>${esc(have.shelf.name)}</span>`
            : `<select aria-label="Shelf for ${esc(a.title)}"><option value="">Add to…</option>${shelfOptions("")}</select>`}</span>
        </div>`;
      }).join("")}
    </div>
    ${list.length > VAULT.shown ? `<button class="btn" id="vault-more" style="margin-top:14px">Show more (${(list.length - VAULT.shown).toLocaleString()} left)</button>` : ""}
    `}`;
}

function vaultPlaylists(d) {
  const byId = new Map(d.tracks.map((r) => [r[0], r]));
  return `<div class="vault-pls">${d.playlists.map((p, i) => `
    <details class="howto" ${VAULT.open === i ? "open" : ""} data-vpl="${i}">
      <summary>${esc(p.name)} <span class="meta">${p.items.length} songs${p.smart ? " · smart playlist" : ""}</span></summary>
      <ol class="pl-tracks">${p.items.map((id) => byId.get(id)).filter(Boolean)
        .map((r) => `<li>${esc(r[1])} <span class="meta">${esc(r[2])}${r[4] ? " · " + esc(r[4]) : ""}</span></li>`).join("")}</ol>
    </details>`).join("") || `<div class="empty">No playlists in this library.</div>`}</div>`;
}

function wireVault() {
  const xml = document.getElementById("vault-xml"), dir = document.getElementById("vault-dir");
  if (xml) xml.onchange = () => xml.files[0] && importOld(xml.files, "xml");
  if (dir) dir.onchange = () => dir.files.length && importOld(dir.files, "folder");
  const q = document.getElementById("vault-q");
  if (q) q.oninput = () => { VAULT.q = q.value; VAULT.shown = 120; clearTimeout(VAULT.t); VAULT.t = setTimeout(() => { render(); const el = document.getElementById("vault-q"); el.focus(); el.setSelectionRange(el.value.length, el.value.length); }, 250); };
  const s = document.getElementById("vault-sort");
  if (s) s.onchange = () => { VAULT.sort = s.value; VAULT.shown = 120; render(); };
  document.getElementById("vault-more")?.addEventListener("click", () => { VAULT.shown += 200; render(); });
  document.getElementById("vault-backup")?.addEventListener("click", downloadBackup);
  document.getElementById("vault-redo")?.addEventListener("click", () => { VAULT.data = null; VAULT.verified = false; VAULT.checked = true; view.innerHTML = `<h1 class="page-title">Old hard drive</h1>${vaultImport()}`; wireVault(); });
  view.querySelectorAll("[data-vpl]").forEach((el) => el.addEventListener("toggle", () => { if (el.open) VAULT.open = Number(el.dataset.vpl); }));
}

function downloadBackup() {
  const d = VAULT.data;
  const blob = new Blob([JSON.stringify({ info: d.info, fields: TF, tracks: d.tracks, playlists: d.playlists })], { type: "application/json" });
  const a = document.createElement("a");
  a.href = URL.createObjectURL(blob);
  a.download = `crate-old-library-${new Date().toISOString().slice(0, 10)}.json`;
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

view.addEventListener("click", (e) => {
  const tab = e.target.closest("[data-vtab]");
  if (tab) { VAULT.tab = tab.dataset.vtab; render(); return; }
  const yr = e.target.closest("[data-vyear]");
  if (yr) { VAULT.year = yr.dataset.vyear; VAULT.shown = 120; render(); }
});

view.addEventListener("change", async (e) => {
  const sel = e.target.closest(".vrow select");
  if (!sel || !sel.value) return;
  const row = sel.closest(".vrow");
  const a = albumsOf(VAULT.data).find((x) => x.k === row.dataset.vk);
  if (!a) return;
  sel.disabled = true;
  const found = await Catalog.find(a.artist, a.title).catch(() => null);
  const id = await addAlbum(found ? { ...found } : { title: a.title, artist: a.artist, year: a.year }, sel.value);
  if (id) { addedToast(found?.title || a.title, sel.value, id); render(); }
  else { sel.disabled = false; sel.value = ""; }
});
