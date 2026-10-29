// "Old hard drive": a permanent copy of an old iTunes library (or a plain music folder),
// read in the browser from files the person picks, saved to their account, then browsable.
"use strict";

const VAULT = { data: null, loading: false, status: "", tab: "albums", sort: "plays", q: "", year: "", shown: 120, open: null };

// Track rows are stored as arrays to keep the archive small. Order matters.
const TF = ["id", "name", "artist", "albumArtist", "album", "genre", "year", "trackNo", "discNo", "ms",
  "plays", "lastPlayed", "added", "rating", "loved", "skips", "kind", "path", "compilation", "composer", "modified"];

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

// ------------------------------------------------------------------ reading an iTunes .itl file
// The .itl format is Apple's own and undocumented. The body is AES-128-ECB encrypted (a
// fixed, widely published key) for a leading stretch of bytes, then zlib-compressed. Inside
// is a run of tagged chunks: "htim" starts a song, "hohm" holds one text field, "hpim"
// starts a playlist, "hptm" is one playlist entry. Older files are big-endian; iTunes 10+
// files are little-endian, which also reverses the tags ("mith", "mhoh", "miph", "mtph").
// Song field positions below were confirmed against a real iTunes 12.1 library.

const ITL_KEY = "BHUILuilfghuila3";

function loadAes() {
  if (window.aesjs) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/aes-js/3.1.2/index.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Couldn't load the decoder. Check your connection and try again."));
    document.head.append(s);
  });
}

async function inflateZlib(bytes) {
  const out = new Response(new Blob([bytes]).stream().pipeThrough(new DecompressionStream("deflate")));
  return new Uint8Array(await out.arrayBuffer());
}

const tagAt = (d, p) => String.fromCharCode(d[p], d[p + 1], d[p + 2], d[p + 3]);

async function decryptItl(buf) {
  const d = new Uint8Array(buf), dv = new DataView(buf);
  if (tagAt(d, 0) !== "hdfm") throw new Error("That isn't an iTunes library (.itl) file.");
  const headerLen = dv.getUint32(4);
  const version = new TextDecoder("latin1").decode(d.slice(17, 17 + d[16]));
  const body = d.slice(headerLen);
  const declared = headerLen >= 96 ? dv.getUint32(92) : 0;
  await loadAes();
  const ecb = new aesjs.ModeOfOperation.ecb(aesjs.utils.utf8.toBytes(ITL_KEY));
  // Different iTunes versions encrypt different amounts; try the likely ones.
  for (const n of [...new Set([declared, 102400, body.length])].filter((x) => x > 0)) {
    const size = Math.min(n, body.length) & ~15;
    const plain = body.slice();
    plain.set(ecb.decrypt(body.slice(0, size)), 0);
    if (plain[0] === 0x78) { try { return { version, data: await inflateZlib(plain) }; } catch {} }
    if (/^h[a-z]{3}$/.test(tagAt(plain, 0))) return { version, data: plain };
  }
  throw new Error("This .itl file couldn't be decoded here.");
}

function hohmText(d, dv, pos, total, le) {
  if (total < 40) return null;
  const enc = dv.getUint32(pos + 24, le), len = dv.getUint32(pos + 28, le);
  if (len <= 0 || 40 + len > total) return null;
  const bytes = d.subarray(pos + 40, pos + 40 + len);
  // 1 = UTF-16 (in the file's byte order); 2 = plain ASCII; 3 = UTF-8.
  if (enc === 1) return new TextDecoder(le ? "utf-16le" : "utf-16be").decode(bytes);
  try { return new TextDecoder("utf-8", { fatal: true }).decode(bytes); }
  catch { return new TextDecoder("latin1").decode(bytes); }
}

const HOHM = { 0x02: "name", 0x03: "album", 0x04: "artist", 0x05: "genre", 0x06: "kind", 0x0D: "path", 0x0B: "url", 0x1B: "albumArtist" };
const MAC_EPOCH = 2082844800; // seconds from 1904-01-01 to 1970-01-01
const macDate = (s) => (s > MAC_EPOCH ? new Date((s - MAC_EPOCH) * 1000).toISOString().slice(0, 19) + "Z" : "");
// Built-in lists every library has; "####!####" is the hidden whole-library list.
const BUILT_IN = /^(####!####|Library|Music|Movies|TV Shows|Podcasts|Audiobooks|Books|Purchased|Genius|iTunes U|Voice Memos|Home Videos|Music Videos|Tones|Rentals)$/i;

function parseItlChunks(d) {
  const dv = new DataView(d.buffer, d.byteOffset, d.byteLength);
  const le = tagAt(d, 0) === "msdh";
  const tag = (t) => (le ? [...t].reverse().join("") : t);
  const T = { song: tag("htim"), text: tag("hohm"), list: tag("hpim"), item: tag("hptm") };
  const u32 = (p) => dv.getUint32(p, le);
  const tracks = new Map(), playlists = [];
  let track = null, pl = null, pos = 0;
  while (pos + 12 <= d.length) {
    const t = tagAt(d, pos);
    const hl = /^[a-z]{4}$/.test(t) ? u32(pos + 4) : 0;
    if (hl < 8 || hl > 1e6 || pos + hl > d.length) { pos++; continue; } // not a chunk start: resync
    if (t === T.text) {
      const total = u32(pos + 8);
      if (total < hl || pos + total > d.length) { pos++; continue; }
      const type = u32(pos + 12);
      const text = hohmText(d, dv, pos, total, le);
      if (text != null) {
        if (pl && type === 0x64) pl.name = pl.name || text;
        else if (track && HOHM[type] && !track[HOHM[type]]) track[HOHM[type]] = text;
      }
      pos += total;
      continue;
    }
    if (t === T.song) {
      track = { id: u32(pos + 16) };
      if (le && hl >= 224) {
        Object.assign(track, {
          modified: macDate(u32(pos + 32)), ms: u32(pos + 40) || null, trackNo: u32(pos + 44) || null,
          year: u32(pos + 52) || null, plays: u32(pos + 76), lastPlayed: macDate(u32(pos + 100)),
          added: macDate(u32(pos + 120)), skips: u32(pos + 216),
        });
      }
      tracks.set(track.id, track);
      pl = null;
    }
    else if (t === T.list) { pl = { name: "", raw: [] }; playlists.push(pl); track = null; }
    else if (t === T.item && pl) pl.raw.push(d.slice(pos, pos + hl));
    pos += hl;
  }
  // The song id inside a playlist entry is at byte 24 in files seen so far; check the neighbours too.
  let best = 24, bestHits = -1;
  for (let off = 8; off <= 40; off += 4) {
    let hits = 0;
    for (const p of playlists) for (const r of p.raw) if (r.length >= off + 4 && tracks.has(new DataView(r.buffer).getUint32(off, le))) hits++;
    if (hits > bestHits) { best = off; bestHits = hits; }
  }
  const pls = playlists.map((p) => ({
    name: p.name || "Untitled", smart: false,
    items: p.raw.filter((r) => r.length >= best + 4).map((r) => new DataView(r.buffer).getUint32(best, le)).filter((id) => tracks.has(id)),
  })).filter((p) => p.items.length && !BUILT_IN.test(p.name));
  return { tracks: [...tracks.values()], playlists: pls, full: le };
}

async function parseItl(file) {
  const buf = await file.arrayBuffer();
  const raw = new Uint8Array(buf);
  let decoded = null, problem = "";
  try {
    const { version, data } = await decryptItl(buf);
    const { tracks, playlists, full } = parseItlChunks(data);
    const notMusic = (t) => /video|podcast|book|movie/i.test(t.kind || "") || /podcast/i.test(t.genre || "") || /\/(Podcasts|Movies|TV Shows|Books)\//.test(decodeLocation(t.url) || "");
    const songs = tracks.filter((t) => t.name && !notMusic(t));
    if (!songs.length) throw new Error("No songs were found inside the file.");
    decoded = {
      version,
      tracks: songs.map((t) => [t.id, t.name || "", t.artist || "", t.albumArtist || "", t.album || "", t.genre || "", t.year || null,
        t.trackNo || null, null, t.ms || null, t.plays || 0, t.lastPlayed || "", t.added || "", 0, 0, t.skips || 0, t.kind || "",
        decodeLocation(t.url) || t.path || "", 0, "", t.modified || ""]),
      playlists, full,
    };
  } catch (e) { problem = e.message; }
  return {
    source: "iTunes library (.itl)" + (decoded ? `, iTunes ${decoded.version}` : ""),
    tracks: decoded?.tracks || [], playlists: decoded?.playlists || [], raw, rawName: file.name, problem,
    partial: !!decoded && !decoded.full,
  };
}

async function sha256(bytes) {
  const h = await crypto.subtle.digest("SHA-256", bytes);
  return [...new Uint8Array(h)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
function toBase64(bytes) {
  let s = "";
  for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return btoa(s);
}
function fromBase64(b64) {
  const s = atob(b64), out = new Uint8Array(s.length);
  for (let i = 0; i < s.length; i++) out[i] = s.charCodeAt(i);
  return out;
}

/** Keeps the untouched original file in the account, so nothing depends on decoding being complete. */
async function saveOriginalFile(raw, name) {
  const b64 = toBase64(raw), docs = {}, size = 600000;
  for (let i = 0, n = 0; i < b64.length; i += size, n++) docs[`part-${String(n).padStart(4, "0")}`] = { b64: b64.slice(i, i + size) };
  const hash = await sha256(raw);
  docs.info = { name, bytes: raw.length, sha256: hash, parts: Object.keys(docs).length, savedAt: Math.floor(Date.now() / 1000) };
  await Store.saveVault(docs, (i, n) => setVaultStatus(`Saving your original library file… ${i} of ${n}`), "vaultfile");
  setVaultStatus("Checking the saved file…");
  const back = await Store.loadVault({ fromServer: true, collection: "vaultfile" });
  const joined = Object.keys(back).filter((k) => k.startsWith("part-")).sort().map((k) => back[k].b64).join("");
  if ((await sha256(fromBase64(joined))) !== hash) throw new Error("The saved copy of your library file didn't match. Keep the drive plugged in and try again.");
  return docs.info;
}

async function downloadOriginal() {
  const back = await Store.loadVault({ collection: "vaultfile" });
  if (!back?.info) { toast("No original library file is saved."); return; }
  const bytes = fromBase64(Object.keys(back).filter((k) => k.startsWith("part-")).sort().map((k) => back[k].b64).join(""));
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([bytes], { type: "application/octet-stream" }));
  a.download = back.info.name || "iTunes Library.itl";
  document.body.append(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
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
    partial: !!parsed.partial, original: parsed.original || null,
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
    if (kind === "xml" && /\.itl$/i.test(files[0].name)) {
      const f = files[0];
      setVaultStatus(`Reading ${f.name} (${(f.size / 1e6).toFixed(1)} MB)…`);
      parsed = await parseItl(f);
      // Save the untouched file first: it holds everything, whatever decoding manages.
      parsed.original = await saveOriginalFile(parsed.raw, parsed.rawName);
      if (!parsed.tracks.length) {
        VAULT.loading = false;
        VAULT.fileOnly = parsed.original;
        setVaultStatus("");
        render();
        return;
      }
    } else if (kind === "xml") {
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
    const k = Catalog.albumKey(t.album || "(no album)", artist);
    const a = byKey.get(k) || { k, title: Catalog.baseTitle(t.album) || "(no album)", artist, year: t.year, genre: t.genre, songs: 0, plays: 0, last: "", added: "", rated: [], loved: 0, ids: [] };
    a.songs++; a.plays += t.plays || 0; a.ids.push(t.id);
    if (t.lastPlayed > a.last) a.last = t.lastPlayed;
    // A rebuilt library resets "date added"; the file's own date is often the truer "when I got it".
    const got = [t.added, t.modified].filter(Boolean).sort()[0];
    if (got && (!a.added || got < a.added)) a.added = got;
    if (t.rating) a.rated.push(t.rating);
    a.loved += t.loved || 0;
    if (!a.year && t.year) a.year = t.year;
    if (!a.genre && t.genre) a.genre = t.genre;
    byKey.set(k, a);
  }
  return [...byKey.values()].map((a) => ({ ...a, stars: a.rated.length ? Math.round(a.rated.reduce((x, y) => x + y, 0) / a.rated.length / 20) : 0 }));
}

const fileSize = (n) => (n >= 1e6 ? `${(n / 1e6).toFixed(1)} MB` : `${Math.max(1, Math.round(n / 1e3))} KB`);
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
    ${VAULT.fileOnly ? `<div class="empty" style="margin:16px 0">
        <b>Your library file is saved and checked</b> (${fileSize(VAULT.fileOnly.bytes)}, stored in your account), so nothing in it will be lost when you unplug the drive.
        Crate couldn't read the songs out of it yet. Send that file to Claude so the reader can be finished, or use “Choose the music folder” below to list your albums now.
        <p><button class="btn" id="vault-original">Download the saved file</button></p></div>` : ""}
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
        <b>Pick your iTunes library file</b>
        <span class="note">On the old drive, open <b>Users → your name → Music → iTunes</b> and pick <b>iTunes Library.itl</b>, or <b>iTunes Music Library.xml</b> if you have one. Crate saves an exact copy of the file to your account either way.</span>
        <div class="import-btns"><label class="btn primary">Choose the library file<input type="file" id="vault-xml" accept=".xml,.itl,text/xml" hidden></label></div>
        <span class="meta" style="margin-top:10px">Also worth doing: choose the music folder itself (iTunes Media → Music) to record every album folder on the drive.</span>
        <div class="import-btns"><label class="btn">Choose the music folder<input type="file" id="vault-dir" webkitdirectory multiple hidden></label></div>`}
      </div>
    </section>`;
}

function vaultBrowse(d) {
  if (d.info.partial && VAULT.sort === "plays") VAULT.sort = "artist"; // no play counts to sort by yet
  const albums = albumsOf(d);
  const plays = d.tracks.reduce((n, r) => n + (r[10] || 0), 0);
  const years = {};
  for (const a of albums) if (a.added) { const y = a.added.slice(0, 4); years[y] = (years[y] || 0) + 1; }
  const q = VAULT.q.toLowerCase();
  const worship = albums.filter((a) => Catalog.isWorship(a)).length;
  // Songs from hidden playlists (handmade mixes) shouldn't show up as albums either.
  const hiddenIds = new Set(d.playlists.filter((p) => hiddenPlaylists().has(p.name)).flatMap((p) => p.items));
  const fromHidden = (a) => a.ids.every((id) => hiddenIds.has(id));
  const sortedKeys = new Set(allAlbums().map((x) => Catalog.albumKey(x.title, x.artist)));
  const isSorted = (a) => sortedKeys.has(a.k);
  const hideSorted = vaultPref("hideSorted", true);
  const counts = { mixes: albums.filter(fromHidden).length, sorted: albums.filter(isSorted).length };
  let list = albums.filter((a) => !fromHidden(a) && !(hideSorted && isSorted(a)) && (VAULT.showWorship || !Catalog.isWorship(a)) && (!VAULT.year || (a.added || "").startsWith(VAULT.year)) && (!q || `${a.title} ${a.artist} ${a.genre}`.toLowerCase().includes(q)));
  const sorters = {
    plays: (a, b) => b.plays - a.plays, added: (a, b) => (b.added || "").localeCompare(a.added || ""), oldest: (a, b) => (a.added || "~").localeCompare(b.added || "~"),
    rating: (a, b) => b.stars - a.stars || b.plays - a.plays, artist: (a, b) => a.artist.localeCompare(b.artist) || a.title.localeCompare(b.title),
  };
  list.sort(sorters[VAULT.sort]);
  const owned = new Map(allAlbums().map((x) => [Catalog.albumKey(x.title, x.artist), x]));
  const info = d.info;
  return `
    <p class="note">${VAULT.verified ? "<b>Saved and checked.</b> Everything below is stored in your account, so it's safe to unplug the drive. " : ""}
      ${d.tracks.length.toLocaleString()} songs · ${albums.length.toLocaleString()} albums · ${d.playlists.length} playlists${info.partial ? "" : ` · ${plays.toLocaleString()} plays`}.
      From ${esc(info.source)}${info.libraryDate ? `, last updated ${shortDate(info.libraryDate)}` : ""}.</p>
    ${info.partial ? `<p class="note"><b>Play counts, ratings and dates added aren't shown yet.</b> They're in your original library file, which is saved in your account
      (${fileSize(info.original.bytes)}, checked). Crate can fill them in once the .itl reader is finished; send the file to Claude to make that happen.
      <button class="link" id="vault-original">Download the saved file</button></p>` : ""}
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
    <label class="meta vault-check"><input type="checkbox" id="vault-hide-sorted" ${hideSorted ? "checked" : ""}> Hide albums already on a shelf (${counts.sorted})</label>
    ${counts.mixes ? `<p class="meta" style="text-transform:none;letter-spacing:0;margin:0 0 6px">${counts.mixes} album ${counts.mixes === 1 ? "entry" : "entries"} from hidden playlists left out.</p>` : ""}
    ${worship ? `<p class="meta" style="text-transform:none;letter-spacing:0;margin:0 0 10px">${VAULT.showWorship ? `Showing ${worship} worship albums.` : `${worship} worship albums hidden.`}
      <button class="link" id="vault-worship">${VAULT.showWorship ? "Hide them" : "Show them"}</button></p>` : ""}
    <div class="year-chips">
      <button class="chip ${VAULT.year ? "" : "on"}" data-vyear="">All years</button>
      ${Object.keys(years).sort().map((y) => `<button class="chip ${VAULT.year === y ? "on" : ""}" data-vyear="${y}">Added ${y} <span>${years[y]}</span></button>`).join("")}
    </div>
    <div class="vault-table" role="table">
      <div class="vrow vhead" role="row"><span>Album</span><span>Songs</span><span>Plays</span><span>Added</span><span>Rating</span><span></span></div>
      ${list.slice(0, VAULT.shown).map((a) => {
        const have = owned.get(a.k);
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

// ------------------------------------------------------------------ playlists: hide, copy, rebuild on YouTube

const VAULT_PREFS_DEFAULT = { hiddenPlaylists: ["BL△CK H•LES", "GR▲V_ST▲TIC", "THE▲FUTURE▲VOID"] };
function vaultPrefs() { return { ...VAULT_PREFS_DEFAULT, ...(S.raw?.meta?.vault || {}) }; }
function vaultPref(key, fallback) { const v = vaultPrefs()[key]; return v === undefined ? fallback : v; }
function setVaultPref(patch) { return write(() => Store.set("meta", "vault", { ...vaultPrefs(), ...patch })); }
const hiddenPlaylists = () => new Set(vaultPrefs().hiddenPlaylists || []);

/** A search phrase for a song from messy old tags: drop junk, and skip "artists" that are really mix names. */
function songQuery(r, playlist) {
  // Curly braces held remix names in these tags, so they become normal brackets.
  const clean = (s) => String(s || "").replace(/\{([^}]*)\}/g, "($1)").replace(/\[(HQ|video|official.*?)\]/gi, "").replace(/\s+--?\s+/g, " - ").replace(/\s+/g, " ").trim();
  const name = clean(r[1]), artist = clean(r[2]);
  const mixName = !artist || norm(playlist).includes(norm(artist)) || norm(artist).includes(norm(playlist)) || /future void|gr▲v/i.test(artist);
  return mixName ? name : `${artist} ${name}`;
}

function tracklistText(p, byId) {
  return [p.name, ...p.items.map((id) => byId.get(id)).filter(Boolean).map((r, i) => `${i + 1}. ${songQuery(r, p.name)}`)].join("\n");
}

function vaultPlaylists(d) {
  const byId = new Map(d.tracks.map((r) => [r[0], r]));
  const hidden = hiddenPlaylists();
  const row = (p, i) => `
    <details class="howto" ${VAULT.open === i ? "open" : ""} data-vpl="${i}">
      <summary>${esc(p.name)} <span class="meta">${p.items.length} songs${p.smart ? " · smart playlist" : ""}</span></summary>
      <div class="pl-actions">
        <button class="btn" data-pl-copy="${i}">Copy tracklist</button>
        <button class="btn primary" data-pl-rebuild="${i}">Rebuild in YouTube Music</button>
        <button class="link" data-pl-hide="${i}">${hidden.has(p.name) ? "Unhide" : "Hide this playlist"}</button>
        <span class="meta" id="pl-status-${i}"></span>
      </div>
      <ol class="pl-tracks">${p.items.map((id) => byId.get(id)).filter(Boolean)
        .map((r) => `<li>${esc(r[1])} <span class="meta">${esc(r[2])}${r[4] ? " · " + esc(r[4]) : ""}</span></li>`).join("")}</ol>
    </details>`;
  const shown = d.playlists.map((p, i) => [p, i]).filter(([p]) => !hidden.has(p.name));
  const tucked = d.playlists.map((p, i) => [p, i]).filter(([p]) => hidden.has(p.name));
  return `<div class="vault-pls">${shown.map(([p, i]) => row(p, i)).join("") || `<div class="empty">No playlists in this library.</div>`}
    ${tucked.length ? `<h2 class="section-label">Hidden playlists</h2><p class="meta" style="text-transform:none;letter-spacing:0">Their songs are left out of the album list.</p>${tucked.map(([p, i]) => row(p, i)).join("")}` : ""}</div>`;
}

/** Makes a private YouTube playlist with the best match for each song. Uses the account's daily YouTube allowance. */
async function rebuildOnYouTube(i) {
  const d = VAULT.data, p = d.playlists[i];
  const byId = new Map(d.tracks.map((r) => [r[0], r]));
  const status = (t) => { const el = document.getElementById(`pl-status-${i}`); if (el) el.textContent = t; };
  status("Waiting for Google sign-in…");
  let token;
  try { token = await Store.youtubeToken({ write: true }); }
  catch (e) { status(""); toast(/popup-closed|cancelled/.test(e.code || "") ? "Sign-in was closed before it finished." : "Google sign-in didn't finish."); return; }
  const wait = (ms) => new Promise((r) => setTimeout(r, ms));
  // YouTube often answers "busy" (409 SERVICE_UNAVAILABLE, or 5xx) when items are added quickly
  // to a new playlist; those are retried with growing pauses.
  const yt = async (path, opts = {}, tries = 5) => {
    for (let attempt = 0; ; attempt++) {
      const res = await fetch("https://www.googleapis.com/youtube/v3/" + path, { ...opts, headers: { Authorization: "Bearer " + token, "Content-Type": "application/json" } });
      const body = await res.json().catch(() => ({}));
      if (res.ok) return body;
      const reason = body?.error?.errors?.[0]?.reason || body?.error?.status || "";
      const busy = res.status === 409 || res.status >= 500 || /SERVICE_UNAVAILABLE|backendError/i.test(reason);
      if (busy && attempt < tries) { status(`YouTube is busy, retrying… (${attempt + 1} of ${tries})`); await wait(1500 * 2 ** attempt); continue; }
      const err = new Error(reason === "quotaExceeded" ? "YouTube's daily limit for Crate is used up. Click Rebuild again tomorrow to finish; it picks up where it stopped."
        : `YouTube said no (${res.status}${reason ? ", " + reason : ""}). Click Rebuild again to pick up where it stopped.`);
      err.busy = busy; err.fatal = reason === "quotaExceeded" || res.status === 401 || res.status === 403;
      throw err;
    }
  };
  const missing = [];
  const songs = p.items.map((id) => byId.get(id)).filter(Boolean);
  const done = { ...(vaultPref("ytRebuilt", {})[p.name] || {}) }; // { playlistId, added: number of songs handled }
  let dupNote = "";
  const save = () => setVaultPref({ ytRebuilt: { ...vaultPref("ytRebuilt", {}), [p.name]: { ...done } } });
  try {
    // Reuse the playlist from an earlier, unfinished run instead of making a duplicate.
    if (!done.playlistId) {
      // Match by name only (an earlier run may predate Crate's description), keeping the fullest one.
      let page = "", all = [];
      for (let k = 0; k < 5; k++) {
        const mine = await yt("playlists?" + new URLSearchParams({ part: "snippet,contentDetails", mine: "true", maxResults: "50", ...(page ? { pageToken: page } : {}) }));
        all = all.concat(mine.items || []);
        if (!(page = mine.nextPageToken)) break;
      }
      const same = all.filter((x) => (x.snippet?.title || "").trim().toLowerCase() === p.name.trim().toLowerCase())
        .sort((a, b) => (b.contentDetails?.itemCount || 0) - (a.contentDetails?.itemCount || 0));
      if (same[0]) Object.assign(done, { playlistId: same[0].id, added: same[0].contentDetails?.itemCount || 0 });
      if (same.length > 1) dupNote = ` You have ${same.length} playlists named “${p.name}” on YouTube; Crate filled the fullest one, so delete the others.`;
    }
    if (!done.playlistId) {
      const list = await yt("playlists?part=snippet,status", { method: "POST", body: JSON.stringify({
        snippet: { title: p.name, description: "Rebuilt by Crate from an old iTunes playlist." }, status: { privacyStatus: "private" } }) });
      Object.assign(done, { playlistId: list.id, added: 0 });
      await wait(1500); // give a brand-new playlist a moment before filling it
    }
    await save();
    let added = 0;
    for (let n = done.added || 0; n < songs.length; n++) {
      status(`Adding ${n + 1} of ${songs.length}…`);
      const q = songQuery(songs[n], p.name);
      const found = await yt("search?" + new URLSearchParams({ part: "snippet", type: "video", maxResults: "5", q }));
      // Prefer YouTube Music's own uploads ("Artist - Topic"), then the other results in order.
      const items = found.items || [];
      const candidates = [...items.filter((x) => / - Topic$/.test(x.snippet?.channelTitle || "")), ...items.filter((x) => !/ - Topic$/.test(x.snippet?.channelTitle || ""))];
      let ok = false;
      for (const c of candidates.slice(0, 3)) {
        try {
          await yt("playlistItems?part=snippet", { method: "POST", body: JSON.stringify({
            snippet: { playlistId: done.playlistId, resourceId: { kind: "youtube#video", videoId: c.id.videoId } } }) }, 2);
          ok = true;
          break;
        } catch (e) {
          if (e.fatal) throw e;
          // YouTube keeps refusing this particular video; try the next match instead.
        }
      }
      if (ok) added++;
      else missing.push(items.length ? `${q} (YouTube wouldn't add it)` : q);
      done.added = n + 1;
      await save();
      await wait(800);
    }
    status(`Done: ${songs.length - missing.length} of ${songs.length} songs in the playlist${missing.length ? `. Not found: ${missing.join("; ")}` : ""}.${dupNote}`);
    toast(`“${p.name}” is in your YouTube Music library (private). Check matches, especially remixes.`, {
      label: "Open", run: () => window.open(`https://music.youtube.com/playlist?list=${done.playlistId}`, "_blank", "noopener"),
    });
  } catch (e) {
    status(e.message + (missing.length ? ` Not found so far: ${missing.join("; ")}` : ""));
  }
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
  document.getElementById("vault-worship")?.addEventListener("click", () => { VAULT.showWorship = !VAULT.showWorship; render(); });
  const hs = document.getElementById("vault-hide-sorted");
  if (hs) hs.onchange = () => setVaultPref({ hideSorted: hs.checked }).then(render);
  document.getElementById("vault-backup")?.addEventListener("click", downloadBackup);
  document.getElementById("vault-original")?.addEventListener("click", downloadOriginal);
  document.getElementById("vault-redo")?.addEventListener("click", () => { VAULT.data = null; VAULT.verified = false; VAULT.checked = true; VAULT.fileOnly = null; view.innerHTML = `<h1 class="page-title">Old hard drive</h1>${vaultImport()}`; wireVault(); });
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

view.addEventListener("click", async (e) => {
  const copy = e.target.closest("[data-pl-copy]");
  if (copy) {
    const d = VAULT.data, p = d.playlists[Number(copy.dataset.plCopy)];
    const text = tracklistText(p, new Map(d.tracks.map((r) => [r[0], r])));
    try { await navigator.clipboard.writeText(text); toast(`Copied the “${p.name}” tracklist`); }
    catch { toast("Couldn't copy. Select the tracklist below and copy it instead."); }
    return;
  }
  const rb = e.target.closest("[data-pl-rebuild]");
  if (rb) { rb.disabled = true; await rebuildOnYouTube(Number(rb.dataset.plRebuild)); rb.disabled = false; return; }
  const hide = e.target.closest("[data-pl-hide]");
  if (hide) {
    const name = VAULT.data.playlists[Number(hide.dataset.plHide)].name;
    const set = hiddenPlaylists();
    set.has(name) ? set.delete(name) : set.add(name);
    await setVaultPref({ hiddenPlaylists: [...set] });
    render();
    return;
  }
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
