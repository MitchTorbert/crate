// The home page: quick ways into music you already love.
//  1. Easy picks: albums you know (in your crates or listened to a lot), a random handful.
//  2. New from artists you love: recent-ish albums from your most-played artists.
//  3. Worth revisiting: albums you played a lot, but not for a long time.
"use strict";

const LAND = { seeds: { easy: 1, fresh: 1, revisit: 1 }, covers: new Map(), freshCache: new Map() };
const LAND_N = 10;

function landingHeard(taste, sp) {
  const heard = new Map(); // key -> { title, artist, cover?, label, inCrate? }
  for (const a of allAlbums()) {
    const k = Catalog.albumKey(a.title, a.artist);
    if (!heard.has(k)) heard.set(k, { k, title: a.title, artist: a.artist, cover: a.cover, ytUrl: a.ytUrl, label: `In ${a.shelf.name}`, crate: a });
  }
  for (const a of (taste?.albums || []).slice(0, 80)) if (!heard.has(a.k)) heard.set(a.k, { k: a.k, title: a.title, artist: a.artist, label: a.label });
  return heard;
}

function listenCard(a) {
  const cover = a.cover || LAND.covers.get(a.k);
  const href = a.ytUrl || Catalog.ytSearchUrl(a);
  return `
  <div class="album land-card" data-lk="${esc(a.k)}">
    <a class="cover ${cover ? "" : "burned"}" href="${esc(href)}" target="_blank" rel="noopener" title="Open in YouTube Music">
      ${cover ? `<img src="${esc(cover)}" alt="" loading="lazy">` : discArt(a)}
      <span class="play" aria-hidden="true">▶</span>
    </a>
    <div class="album-title">${esc(a.title)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span></div>
    ${a.label ? `<div class="reason" title="${esc(a.label)}">${esc(a.label)}</div>` : ""}
  </div>`;
}

function landSection(id, title, sub) {
  return `
  <section class="land-sec" data-land="${id}">
    <div class="suggest-head"><h2 class="section-label">${esc(title)}</h2><span class="meta">${esc(sub)}</span>
      <button class="btn" data-land-shuffle="${id}">Shuffle</button></div>
    <div class="strip land-items">${skeletons(6)}</div>
  </section>`;
}

function renderLanding() {
  // Catalog requests share one line, so covers for the other sections wait until new releases are found.
  let done;
  LAND.freshDone = new Promise((r) => (done = r));
  LAND.release = done;
  setTimeout(done, 20000);
  view.innerHTML = `
    ${landSection("easy", "Easy picks", "Albums you know. Something to put on right now.")}
    ${landSection("fresh", "New from artists you love", "Newer albums from the artists you've played most")}
    ${landSection("revisit", "Worth revisiting", "You played these a lot, a long time ago")}`;
  fillLanding("fresh").finally(done);
  fillLanding("easy"); fillLanding("revisit");
}

function landItems(id, html, empty) {
  const box = view.querySelector(`[data-land="${id}"] .land-items`);
  if (!box || S.route.name !== "home") return null;
  box.className = html ? "strip land-items" : "land-items";
  box.innerHTML = html || `<div class="empty">${empty}</div>`;
  return box;
}

async function fillLanding(id) {
  const taste = await tasteData().catch(() => null);
  const sp = await spotifyHistory().catch(() => null);
  const r = Catalog.rng(`${id}-${LAND.seeds[id]}`);
  if (id === "easy") {
    const pool = [...landingHeard(taste, sp).values()].filter((a) => !Catalog.isWorship(a));
    const pick = Catalog.shuffle(pool, r).slice(0, LAND_N);
    if (landItems(id, pick.map(listenCard).join(""), "Add albums to a crate and they'll show up here.")) loadLandCovers(pick, "easy");
  } else if (id === "revisit") {
    const pick = Catalog.shuffle(revisitPool(sp), r).slice(0, LAND_N);
    if (landItems(id, pick.map(listenCard).join(""), "Bring in your Spotify history or your old iTunes library to see albums worth coming back to.")) loadLandCovers(pick, "revisit");
  } else if (id === "fresh") {
    await fillFresh(taste, r);
  }
}

/** Played for 2+ hours (or 25+ iTunes plays), last played over two years ago. */
function revisitPool(sp) {
  const cutoffMin = Date.now() / 60000 - 2 * 365 * 1440 - MIN_EPOCH;
  const out = new Map();
  for (const a of sp?.albums || []) {
    if (a.min >= 120 && a.last < cutoffMin && !Catalog.isWorship(a)) {
      out.set(a.k, { k: a.k, title: a.title, artist: a.artist, score: a.min, label: `${hours(a.min)} hours · last played ${playDate(a.last).getUTCFullYear()}` });
    }
  }
  const hiddenIds = VAULT.data ? new Set(VAULT.data.playlists.filter((p) => hiddenPlaylists().has(p.name)).flatMap((p) => p.items)) : new Set();
  const old = VAULT.data ? albumsOf(VAULT.data).filter((a) => !a.ids.every((id) => hiddenIds.has(id))) : [];
  for (const a of old) {
    if (a.plays >= 25 && a.title !== "(no album)" && !Catalog.isWorship(a) && !out.has(a.k)) {
      const year = (a.last || "").slice(0, 4);
      out.set(a.k, { k: a.k, title: a.title, artist: a.artist, score: a.plays * 4, label: `${a.plays} iTunes plays${year ? ` · last played ${year}` : ""}` });
    }
  }
  return [...out.values()].sort((a, b) => b.score - a.score).slice(0, 80);
}

/** Newest album from a shuffled handful of your most-played artists that you haven't heard yet. */
async function fillFresh(taste, r) {
  const known = new Set([...allAlbums().map((a) => Catalog.albumKey(a.title, a.artist)), ...(taste?.albums || []).map((a) => a.k)]);
  const top = taste ? [...taste.artistScore].sort((a, b) => b[1] - a[1]).slice(0, 40) : [];
  const crateArtists = [...new Map(allAlbums().filter((a) => a.artistId).map((a) => [norm(a.artist), a])).values()];
  const names = [...new Set([...top.map(([n]) => taste.names.get(n) || n), ...crateArtists.map((a) => a.artist)])].filter((n) => !Catalog.isWorship({ artist: n }));
  const picks = Catalog.shuffle(names, r).slice(0, 14);
  const since = new Date(Date.now() - 4 * 365 * 864e5).toISOString().slice(0, 10);
  const found = [];
  for (const name of picks) {
    if (S.route.name !== "home" || found.length >= LAND_N) break;
    let entry = LAND.freshCache.get(name);
    if (!entry) {
      const crate = crateArtists.find((a) => norm(a.artist) === norm(name));
      const artist = crate ? { id: crate.artistId, name: crate.artist } : await Catalog.findArtist(name).catch(() => null);
      const albums = artist ? await Catalog.artistAlbums(artist.id, { name: artist.name }).catch(() => []) : [];
      entry = albums.filter((a) => a.released >= since && !Catalog.isWorship(a)).sort((a, b) => b.released.localeCompare(a.released));
      LAND.freshCache.set(name, entry);
    }
    const a = entry.find((x) => !known.has(Catalog.albumKey(x.title, x.artist)));
    if (!a) continue;
    const label = taste?.artistLabel.get(norm(name));
    if (found.length === 5) LAND.release?.(); // enough to look at; let the covers start
    found.push({ ...a, reason: `${new Date(a.released + "T12:00:00").toLocaleDateString(undefined, { month: "short", year: "numeric" })}${label ? ` · ${label}` : ""}` });
    landItems("fresh", remember(found).map((x) => suggestionCard(x, S.lastShelf || S.lib.shelves[0]?.id)).join(""), "");
  }
  if (!found.length) landItems("fresh", "", "Nothing new turned up from your top artists. Try Shuffle.");
}

const landCoverJobs = {};
async function loadLandCovers(items, id) {
  const job = (landCoverJobs[id] = (landCoverJobs[id] || 0) + 1);
  await LAND.freshDone;
  for (const a of items) {
    if (job !== landCoverJobs[id] || S.route.name !== "home") return;
    if (a.cover || LAND.covers.has(a.k)) continue;
    const hit = await Catalog.find(a.artist, a.title).catch(() => null);
    LAND.covers.set(a.k, hit?.cover || "");
    if (hit?.cover) view.querySelectorAll(`.land-card[data-lk="${CSS.escape(a.k)}"] .cover`).forEach((el) => {
      el.classList.remove("burned");
      el.innerHTML = `<img src="${esc(hit.cover)}" alt=""><span class="play" aria-hidden="true">▶</span>`;
    });
  }
}

view.addEventListener("click", (e) => {
  const b = e.target.closest("[data-land-shuffle]");
  if (!b) return;
  const id = b.dataset.landShuffle;
  LAND.seeds[id]++;
  const box = view.querySelector(`[data-land="${id}"] .land-items`);
  if (box) { box.className = "strip land-items"; box.innerHTML = skeletons(6); }
  fillLanding(id);
});
