// Listening history from Spotify's "Extended streaming history" export.
// The export is read in the browser. Crate keeps every music play in a compact form
// (song, when, how long, skipped or not) and drops the rest: IP addresses, locations,
// devices, podcasts. A small summary of every album with real listening time is what
// the rest of Crate uses (suggestions, Sorting chores, New releases).
"use strict";

const HIST = { summary: null, loading: false, checked: false, status: "", year: "", shown: 50, covers: new Map(), found: new Map(), showWorship: false, making: false };
const MIN_EPOCH = Date.UTC(2006, 0, 1) / 60000; // plays are stored as minutes since 2006

function loadJsZip() {
  if (window.JSZip) return Promise.resolve();
  return new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = "https://cdnjs.cloudflare.com/ajax/libs/jszip/3.10.1/jszip.min.js";
    s.onload = res; s.onerror = () => rej(new Error("Couldn't load the zip reader. Check your connection and try again."));
    document.head.append(s);
  });
}

// ------------------------------------------------------------------ reading the export

async function readSpotifyFiles(files) {
  const texts = [];
  for (const f of files) {
    if (/\.zip$/i.test(f.name)) {
      await loadJsZip();
      const zip = await JSZip.loadAsync(f);
      const names = Object.keys(zip.files).filter((n) => /Streaming_?History.*\.json$/i.test(n) && !/Video/i.test(n));
      for (const [i, n] of names.entries()) {
        setHistStatus(`Reading ${i + 1} of ${names.length} files…`);
        texts.push(await zip.files[n].async("string"));
      }
    } else if (/\.json$/i.test(f.name)) {
      texts.push(await f.text());
    }
  }
  if (!texts.length) throw new Error("No listening history was found. Pick the my_spotify_data.zip file Spotify sent you.");

  const index = new Map(), tracks = [], plays = [];
  for (const text of texts) {
    let rows;
    try { rows = JSON.parse(text); } catch { continue; }
    if (!Array.isArray(rows)) continue;
    for (const r of rows) {
      // Extended history ("master_metadata_…") or the older short export ("trackName", "artistName").
      const name = r.master_metadata_track_name ?? r.trackName;
      const artist = r.master_metadata_album_artist_name ?? r.artistName;
      if (!name || !artist) continue; // podcasts, audiobooks, local gaps
      const album = r.master_metadata_album_album_name || "";
      const uri = r.spotify_track_uri || "";
      const key = uri || `${name}|${artist}|${album}`;
      let i = index.get(key);
      if (i === undefined) { i = tracks.length; index.set(key, i); tracks.push([uri.replace("spotify:track:", ""), name, artist, album]); }
      const when = Date.parse(r.ts || (r.endTime ? r.endTime.replace(" ", "T") + "Z" : ""));
      if (!when) continue;
      const ms = r.ms_played ?? r.msPlayed ?? 0;
      const flags = (r.skipped || r.reason_end === "fwdbtn" ? 1 : 0) | (r.shuffle ? 2 : 0) | (r.offline ? 4 : 0);
      plays.push([i, Math.round(when / 60000 - MIN_EPOCH), Math.round(ms / 1000), flags]);
    }
  }
  if (!plays.length) throw new Error("That file didn't contain any music plays.");
  plays.sort((a, b) => a[1] - b[1]);
  return { tracks, plays };
}

// ------------------------------------------------------------------ summary used across Crate

const playDate = (m) => new Date((m + MIN_EPOCH) * 60000);

function summarize({ tracks, plays }) {
  const albums = new Map(), artists = new Map(), years = {};
  for (const [i, t, secs] of plays) {
    const [, , artist, album] = tracks[i];
    const y = playDate(t).getUTCFullYear();
    const min = secs / 60;
    years[y] = (years[y] || 0) + min;
    const ar = artists.get(norm(artist)) || { name: artist, min: 0 };
    ar.min += min;
    artists.set(norm(artist), ar);
    if (!album) continue;
    const k = Catalog.albumKey(album, artist);
    const a = albums.get(k) || { title: album, artist, min: 0, plays: 0, first: t, last: t, years: {} };
    a.min += min;
    if (secs >= 30) a.plays++; // Spotify counts a stream after 30 seconds
    a.first = Math.min(a.first, t); a.last = Math.max(a.last, t);
    a.years[y] = (a.years[y] || 0) + min;
    albums.set(k, a);
  }
  // Keep albums with real listening: half an hour, or ten full plays.
  const kept = [...albums.values()].filter((a) => a.min >= 30 || a.plays >= 10).sort((x, y) => y.min - x.min)
    .map((a) => [a.title, a.artist, Math.round(a.min), a.plays, a.first, a.last,
      Object.fromEntries(Object.entries(a.years).map(([y, m]) => [y, Math.round(m)]).filter(([, m]) => m > 0))]);
  const topArtists = [...artists.values()].sort((x, y) => y.min - x.min).slice(0, 2000).map((a) => [a.name, Math.round(a.min)]);
  const totalMin = plays.reduce((n, p) => n + p[2] / 60, 0);
  return {
    albums: JSON.stringify(kept), artists: JSON.stringify(topArtists),
    years: Object.fromEntries(Object.entries(years).map(([y, m]) => [y, Math.round(m)])),
    totals: { plays: plays.length, minutes: Math.round(totalMin), tracks: tracks.length, first: plays[0][1], last: plays[plays.length - 1][1] },
  };
}

function unpackSummary(doc) {
  if (!doc?.albums) return null;
  // Editions of one album ("Take Care", "Take Care - Deluxe") are merged into one entry.
  const merged = new Map();
  for (const [title, artist, min, plays, first, last, years] of JSON.parse(doc.albums)) {
    const k = Catalog.albumKey(title, artist);
    const a = merged.get(k);
    if (!a) { merged.set(k, { k, title: Catalog.baseTitle(title), artist, min, plays, first, last, years: { ...years }, editions: 1 }); continue; }
    a.min += min; a.plays += plays; a.first = Math.min(a.first, first); a.last = Math.max(a.last, last); a.editions++;
    for (const [y, m] of Object.entries(years)) a.years[y] = (a.years[y] || 0) + m;
  }
  const albums = [...merged.values()].sort((x, y) => y.min - x.min);
  const artists = new Map(JSON.parse(doc.artists).map(([name, min]) => [norm(name), { name, min }]));
  return { albums, artists, years: doc.years, totals: doc.totals, importedAt: doc.importedAt };
}

let spotifyLoad = null;
/** The saved Spotify summary, or null. Loaded once, small enough for phones. */
function spotifyHistory() {
  if (HIST.summary) return Promise.resolve(HIST.summary);
  if (!Store.canArchive()) return Promise.resolve(null);
  if (!spotifyLoad) {
    spotifyLoad = Store.getVaultDoc("spotify", "summary").then((d) => (HIST.summary = unpackSummary(d)))
      .catch(() => null).finally(() => { if (!HIST.summary) spotifyLoad = null; });
  }
  return spotifyLoad;
}

// ------------------------------------------------------------------ saving

async function saveSpotify(parsed, onProgress) {
  const docs = {};
  const trackRows = parsed.tracks.map((t) => JSON.stringify(t));
  chunkBy(trackRows, 600000).forEach((rows, i) => { docs[`tracks-${String(i).padStart(3, "0")}`] = { rows }; });
  const playText = parsed.plays.map((p) => p.join(",")).join(";");
  for (let i = 0, n = 0; i < playText.length; i += 600000, n++) docs[`plays-${String(n).padStart(3, "0")}`] = { p: playText.slice(i, i + 600000) };
  const summary = summarize(parsed);
  docs.summary = { ...summary, importedAt: Math.floor(Date.now() / 1000) };
  docs.info = { tracks: parsed.tracks.length, plays: parsed.plays.length, playsHash: await sha256(utf8.encode(playText)), fields: "plays: track,minutesSince2006,seconds,flags(1 skipped,2 shuffle,4 offline)" };
  await Store.saveVault(docs, onProgress, "spotify");
  // Read everything back from the server and compare before saying it's safe.
  setHistStatus("Checking the saved copy…");
  const back = await Store.loadVault({ fromServer: true, collection: "spotify" });
  const backPlays = Object.keys(back).filter((k) => k.startsWith("plays-")).sort().map((k) => back[k].p).join("");
  const backTracks = Object.keys(back).filter((k) => k.startsWith("tracks-")).reduce((n, k) => n + back[k].rows.length, 0);
  if (backTracks !== parsed.tracks.length || (await sha256(utf8.encode(backPlays))) !== docs.info.playsHash) {
    throw new Error("The saved copy didn't match. Try the import again.");
  }
  return unpackSummary(back.summary);
}

function setHistStatus(text) {
  HIST.status = text;
  const el = document.getElementById("hist-status");
  if (el) el.textContent = text;
}

async function importSpotify(files) {
  if (!Store.canArchive()) { toast("Sign in to Crate first so your history is saved to your account."); return; }
  HIST.loading = true;
  setHistStatus("Opening the export…");
  render();
  try {
    const parsed = await readSpotifyFiles([...files]);
    setHistStatus(`Found ${parsed.plays.length.toLocaleString()} plays. Saving to your account…`);
    HIST.summary = await saveSpotify(parsed, (i, n) => setHistStatus(`Saving to your account… ${i} of ${n}`));
    HIST.saved = true;
    oldLoad = null; tasteLoad = null; // let suggestions pick up the new history
    S.sugg = {};
  } catch (e) {
    toast(e.message || "Couldn't read that export.");
  }
  HIST.loading = false;
  setHistStatus("");
  render();
}

// ------------------------------------------------------------------ the page

const hours = (min) => (min >= 600 ? Math.round(min / 60).toLocaleString() : (min / 60).toFixed(1).replace(/\.0$/, ""));
const monthYear = (m) => playDate(m).toLocaleDateString(undefined, { month: "short", year: "numeric" });

function renderHistory() {
  if (!HIST.summary && !HIST.loading && !HIST.checked && Store.canArchive()) {
    HIST.loading = true;
    HIST.status = "Loading your listening history…";
    spotifyHistory().finally(() => { HIST.loading = false; HIST.checked = true; HIST.status = ""; if (S.route.name === "history") render(); });
  }
  const h = HIST.summary;
  view.innerHTML = `<h1 class="page-title">Listening history</h1>${h ? histBrowse(h) : histImport()}`;
  wireHistory();
}

function histImport() {
  if (!Store.canArchive()) return `<div class="empty" style="margin-top:16px">Sign in to Crate first (top right), so your history is saved to your account.</div>`;
  return `
    <p class="note">Bring in your Spotify listening history: every song you've played, when, and for how long. Crate keeps the music plays and leaves out the
      IP addresses, locations, and devices that are also in Spotify's file.</p>
    <section class="import">
      <div class="drop">
        ${HIST.loading ? `<b id="hist-status">${esc(HIST.status || "Working…")}</b>` : `
        <b>Pick the file Spotify sent you</b>
        <span class="note">It's called <b>my_spotify_data.zip</b>. No need to unzip it. This works best on a computer; the file is large for a phone.</span>
        <div class="import-btns"><label class="btn primary">Choose the Spotify file<input type="file" id="hist-file" accept=".zip,.json" multiple hidden></label></div>`}
      </div>
    </section>`;
}

function histAlbums(h) {
  const owned = new Map(allAlbums().map((x) => [Catalog.albumKey(x.title, x.artist), x]));
  const y = HIST.year;
  let list = h.albums.map((a) => ({ ...a, min: y ? a.years[y] || 0 : a.min })).filter((a) => a.min > 0);
  const sorted = list.filter((a) => owned.has(a.k)).length;
  if (vaultPref("historyHideSorted", true)) list = list.filter((a) => !owned.has(a.k));
  const worship = list.filter((a) => Catalog.isWorship(a)).length;
  if (!HIST.showWorship) list = list.filter((a) => !Catalog.isWorship(a));
  list.sort((a, b) => b.min - a.min);
  return { list, owned, worship, sorted };
}

function histBrowse(h) {
  const t = h.totals;
  const { list, owned, worship, sorted } = histAlbums(h);
  const yearsList = Object.keys(h.years).sort();
  const y = HIST.year;
  const canMake = y && list.some((a) => !owned.has(a.k));
  return `
    <p class="note">${HIST.saved ? "<b>Saved and checked.</b> " : ""}${t.plays.toLocaleString()} plays · ${hours(t.minutes)} hours of music ·
      ${monthYear(t.first)} to ${monthYear(t.last)}. Most-listened albums first.</p>
    <div class="year-chips">
      <button class="chip ${y ? "" : "on"}" data-hyear="">All time</button>
      ${yearsList.map((yr) => `<button class="chip ${y === yr ? "on" : ""}" data-hyear="${yr}">${yr} <span>${hours(h.years[yr])}h</span></button>`).join("")}
    </div>
    ${y ? `<div class="hist-make">
        <button class="btn primary" id="hist-make" ${canMake && !HIST.making ? "" : "disabled"}>${HIST.making ? "Making the crate…" : `Make a crate from ${y}`}</button>
        <span class="meta" id="hist-make-status">Takes your 12 most-played albums from ${y} that aren't in a crate yet. Rename it to the period of your life it was.</span>
      </div>` : ""}
    <label class="meta vault-check"><input type="checkbox" id="hist-hide-sorted" ${vaultPref("historyHideSorted", true) ? "checked" : ""}> Hide albums already in a crate (${sorted})</label>
    ${worship ? `<p class="meta" style="text-transform:none;letter-spacing:0;margin:0 0 10px">${HIST.showWorship ? `Showing ${worship} worship albums.` : `${worship} worship albums hidden.`}
      <button class="link" id="hist-worship">${HIST.showWorship ? "Hide them" : "Show them"}</button></p>` : ""}
    <div class="hist-list">
      ${list.slice(0, HIST.shown).map((a, n) => {
        const have = owned.get(a.k);
        return `
        <div class="inbox-row hist-row" data-hk="${esc(a.k)}">
          <a class="ib-cover" href="${esc(have ? ytUrl(have) : Catalog.ytSearchUrl(a))}" target="_blank" rel="noopener" title="Open in YouTube Music">
            ${HIST.covers.get(a.k) ? `<img src="${esc(HIST.covers.get(a.k))}" alt="">` : `<span class="mini burned"><span class="disc"></span></span>`}
          </a>
          <div style="min-width:0">
            <div class="t"><span class="rank">${n + 1}</span>${esc(a.title)}${a.editions > 1 ? ` <span class="meta" title="Plays from ${a.editions} editions are combined">${a.editions} editions</span>` : ""}</div><div class="s">${esc(a.artist)}</div>
            <div class="meta">${hours(a.min)} hours${y ? ` in ${y}` : ""} · ${a.plays.toLocaleString()} plays all time · ${monthYear(a.first)}–${monthYear(a.last)}</div>
          </div>
          <div class="ib-actions">${have ? `<span class="meta"><i class="dot" style="background:${esc(have.shelf.color)}"></i>${esc(have.shelf.name)}</span>`
            : `<select aria-label="Crate for ${esc(a.title)}"><option value="">Add to…</option>${shelfOptions("")}</select>`}</div>
        </div>`;
      }).join("")}
    </div>
    ${list.length > HIST.shown ? `<button class="btn" id="hist-more" style="margin-top:14px">Show more</button>` : ""}
    <p class="meta" style="margin-top:24px;text-transform:none;letter-spacing:0">Imported ${ago(h.importedAt).toLowerCase()}.
      <button class="link" id="hist-redo">Import a newer export</button></p>`;
}

function wireHistory() {
  const f = document.getElementById("hist-file");
  if (f) f.onchange = () => f.files.length && importSpotify(f.files);
  document.getElementById("hist-more")?.addEventListener("click", () => { HIST.shown += 50; render(); });
  document.getElementById("hist-worship")?.addEventListener("click", () => { HIST.showWorship = !HIST.showWorship; render(); });
  document.getElementById("hist-make")?.addEventListener("click", makeYearShelf);
  const hs = document.getElementById("hist-hide-sorted");
  if (hs) hs.onchange = () => setVaultPref({ historyHideSorted: hs.checked }).then(render);
  document.getElementById("hist-redo")?.addEventListener("click", () => {
    view.innerHTML = `<h1 class="page-title">Listening history</h1>${histImport()}`;
    wireHistory();
  });
  if (HIST.summary) loadHistCovers(histAlbums(HIST.summary).list.slice(0, HIST.shown));
}

let histCoverJob = 0;
async function loadHistCovers(items) {
  const job = ++histCoverJob;
  for (const a of items) {
    if (job !== histCoverJob || S.route.name !== "history") return;
    if (HIST.covers.has(a.k)) continue;
    const hit = await Catalog.find(a.artist, a.title).catch(() => null);
    HIST.covers.set(a.k, hit?.cover || "");
    if (hit) HIST.found.set(a.k, hit);
    if (hit?.cover) {
      const el = view.querySelector(`.hist-row[data-hk="${CSS.escape(a.k)}"] .ib-cover`);
      if (el) el.innerHTML = `<img src="${esc(hit.cover)}" alt="">`;
    }
  }
}

async function makeYearShelf() {
  const y = HIST.year, h = HIST.summary;
  if (!y || !h || HIST.making) return;
  const { list, owned } = histAlbums(h);
  const picks = list.filter((a) => !owned.has(a.k)).slice(0, 12);
  if (!picks.length) return;
  HIST.making = true;
  histCoverJob++;
  const btn = document.getElementById("hist-make");
  if (btn) { btn.disabled = true; btn.textContent = "Making the crate…"; }
  const id = newId("s");
  const order = Math.max(0, ...S.lib.shelves.map((s) => s.order ?? 0)) + 1;
  const used = new Set(S.lib.shelves.map((s) => s.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[S.lib.shelves.length % PALETTE.length];
  S.pendingShelf = id;
  const ok = await write(() => Store.set("shelves", id, { name: y, note: `What I played most on Spotify in ${y}.`, order, color }));
  if (!ok) { HIST.making = false; render(); return; }
  // In order of listening time, so the most-played album comes first on the shelf.
  let added = 0;
  for (const [n, a] of picks.entries()) {
    const st = document.getElementById("hist-make-status");
    if (st) st.textContent = `Adding ${n + 1} of ${picks.length}: ${a.title}`;
    const hit = HIST.found.get(a.k) || await Catalog.find(a.artist, a.title).catch(() => null);
    const body = hit ? { ...hit } : { title: a.title, artist: a.artist };
    const albumId = newId("a");
    const pos = n;
    if (await write(() => Store.set("albums", albumId, {
      shelfId: id, pos, title: body.title, artist: body.artist, artistId: body.artistId ?? null, year: body.year ?? null,
      deezerId: body.deezerId ?? null, cover: body.cover || "", addedAt: now(),
    }))) added++;
  }
  HIST.making = false;
  toast(`Made a “${y}” crate with ${added} albums. Rename it from its page.`);
  location.hash = `shelf-${id}`;
}

view.addEventListener("click", (e) => {
  const yr = e.target.closest("[data-hyear]");
  if (yr) { HIST.year = yr.dataset.hyear; HIST.shown = 50; render(); }
});

view.addEventListener("change", async (e) => {
  const sel = e.target.closest(".hist-row select");
  if (!sel || !sel.value) return;
  const row = sel.closest(".hist-row");
  const a = HIST.summary.albums.find((x) => x.k === row.dataset.hk);
  if (!a) return;
  sel.disabled = true;
  histCoverJob++;
  const hit = HIST.found.get(a.k) || await Catalog.find(a.artist, a.title).catch(() => null);
  const id = await addAlbum(hit ? { ...hit } : { title: a.title, artist: a.artist }, sel.value);
  if (id) { addedToast(hit?.title || a.title, sel.value, id); render(); }
  else { sel.disabled = false; sel.value = ""; }
});

// ------------------------------------------------------------------ taste: iTunes plays + Spotify time, for the rest of Crate

let tasteLoad = null;
/**
 * Albums and artists weighted by how much you've listened, from the old iTunes library
 * (about 4 minutes per play) and Spotify (minutes listened). Labels say where it came from.
 */
function tasteData() {
  if (!tasteLoad) {
    tasteLoad = Promise.all([oldLibrary(), spotifyHistory()]).then(([old, sp]) => {
      if (!old && !sp) { tasteLoad = null; return null; }
      const albums = new Map(), artistScore = new Map(), artistLabel = new Map();
      const add = (k, title, artist, score, label) => {
        const a = albums.get(k);
        if (!a) albums.set(k, { k, title, artist, score, label, best: score });
        else { a.score += score; if (score > a.best) { a.best = score; a.label = label; } }
      };
      for (const x of old?.albums || []) add(x.k, x.title, x.artist, x.plays * 4, `${x.plays.toLocaleString()} plays in your iTunes`);
      for (const x of sp?.albums || []) if (!Catalog.isWorship(x)) add(x.k, x.title, x.artist, x.min, `${hours(x.min)} hours on Spotify`);
      const bump = (n, score, label) => {
        const prev = artistScore.get(n) || 0;
        artistScore.set(n, prev + score);
        if (!artistLabel.has(n) || score > prev) artistLabel.set(n, label);
      };
      for (const [n, plays] of old?.artistPlays || []) bump(n, plays * 4, `${plays.toLocaleString()} plays in your iTunes`);
      for (const [n, a] of sp?.artists || []) if (a.min >= 30) bump(n, a.min, `${hours(a.min)} hours on Spotify`);
      const names = new Map();
      for (const x of old?.albums || []) names.set(norm(x.artist), x.artist);
      for (const [n, a] of sp?.artists || []) names.set(n, a.name);
      return { albums: [...albums.values()].sort((a, b) => b.score - a.score), artistScore, artistLabel, names };
    }).catch(() => { tasteLoad = null; return null; });
  }
  return tasteLoad;
}
