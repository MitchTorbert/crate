"use strict";

const PALETTE = ["#8a4bd6", "#2f7fd1", "#d46a1f", "#23a07a", "#c8344a", "#c99a1c", "#3a9fb0", "#b8487f", "#5d6b7a", "#6aa121"];
const HOME_LIMIT = 12;

const S = {
  raw: null,
  lib: { shelves: [] },
  route: { name: "home" },
  homeSeed: Math.random().toString(36).slice(2), // a new shelf order on every visit
  seeds: {},
  sugg: {},          // shelfId -> { key, items, loading }
  lastShelf: null,
  query: "",
  pendingShelf: null,
  user: null,
};

const $ = (s, el = document) => el.querySelector(s);
const view = $("#view");
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const norm = Catalog.norm;
const newId = (p) => p + Math.random().toString(36).slice(2, 10);
const now = () => Math.floor(Date.now() / 1000);

// ------------------------------------------------------------------ data

function rebuild() {
  const raw = S.raw;
  const byShelf = {};
  for (const [id, a] of Object.entries(raw.albums)) (byShelf[a.shelfId] ||= []).push({ id, ...a });
  const shelves = Object.entries(raw.shelves).map(([id, s]) => ({ id, ...s }))
    .sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  S.lib = {
    shelves: shelves.map((s, i) => ({
      ...s, note: s.note || "", color: s.color || PALETTE[i % PALETTE.length],
      image: raw.images[s.id]?.data || "",
      albums: (byShelf[s.id] || []).sort((a, b) => a.pos - b.pos),
    })),
  };
}

const liveOpen = () => [...document.querySelectorAll("form.live .live-list")].some((l) => !l.hidden);

function onData(raw) {
  S.raw = raw;
  rebuild();
  applyPendingYtLinks();
  renderRail();
  // Leave an open search dropdown alone so several albums can be added in a row.
  if (liveOpen()) { S.dirty = true; return; }
  const f = document.activeElement;
  if (f && view.contains(f) && /INPUT|TEXTAREA|SELECT/.test(f.tagName)) return;
  if (dragId || !menu.hidden) return;
  render();
  resolveLinksSoon();
}

async function write(fn) {
  try { await fn(); return true; }
  catch (e) { toast("Couldn't save that change. Check your connection and try again."); return false; }
}

function posAt(list, index) {
  if (!list.length) return 0;
  if (index <= 0) return list[0].pos - 1;
  if (index >= list.length) return list[list.length - 1].pos + 1;
  return (list[index - 1].pos + list[index].pos) / 2;
}

async function addAlbum(a, shelfId) {
  const s = shelfById(shelfId);
  if (!a.deezerId && a.itunesId) a = await Catalog.toDeezer(a).catch(() => a);
  if (a.deezerId && (!a.year || !a.cover)) {
    const d = await Catalog.detail(a.deezerId).catch(() => null);
    if (d) a = { ...d, ...Object.fromEntries(Object.entries(a).filter(([, v]) => v)) , year: a.year || d.year, cover: a.cover || d.cover };
  }
  const dupe = allAlbums().find((x) => (a.deezerId && x.deezerId === a.deezerId) || (norm(x.title) === norm(a.title) && norm(x.artist) === norm(a.artist)));
  if (dupe) { toast(`${dupe.title} is already on ${dupe.shelf.name}.`); return null; }
  const body = {
    shelfId, pos: posAt(s.albums, 0), title: a.title, artist: a.artist, artistId: a.artistId ?? null,
    year: a.year ?? null, deezerId: a.deezerId ?? null, cover: a.cover || "", addedAt: now(),
  };
  const id = newId("a");
  return (await write(() => Store.set("albums", id, body))) ? id : null;
}

function addedToast(title, shelfId, id) {
  toast(`Added ${title} to ${shelfById(shelfId).name}`, { label: "Undo", run: () => write(() => Store.remove("albums", id)) });
}

function moveAlbum(id, shelfId, index) {
  const list = shelfById(shelfId).albums.filter((a) => a.id !== id);
  return write(() => Store.update("albums", id, { shelfId, pos: posAt(list, index) }));
}

function restoreAlbum(a) {
  const { id, shelf, ...body } = a;
  return write(() => Store.set("albums", id, body));
}

// ------------------------------------------------------------------ helpers

const shelfById = (id) => S.lib.shelves.find((s) => s.id === id);
const allAlbums = () => S.lib.shelves.flatMap((s) => s.albums.map((a) => ({ ...a, shelf: s })));
const ytUrl = (a) => a.ytUrl || Catalog.ytSearchUrl(a);
const dismissed = () => new Set(S.raw?.meta?.dismissed?.ids || []);

function ownedCheck() {
  const ids = new Set(), keys = new Set();
  for (const a of allAlbums()) { if (a.deezerId) ids.add(a.deezerId); keys.add(norm(a.title) + "|" + norm(a.artist)); }
  const dis = dismissed();
  return (p) => ids.has(p.deezerId) || dis.has(p.deezerId) || keys.has(norm(p.title) + "|" + norm(p.artist));
}

function span(albums) {
  const ys = albums.map((a) => a.year).filter(Boolean);
  if (!ys.length) return "";
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}
const discs = (n) => `${n} ${n === 1 ? "disc" : "discs"}`;

function ago(ts) {
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return "Today";
  if (d < 2) return "Yesterday";
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

let toastTimer;
function toast(msg, action) {
  const t = $("#toast");
  t.innerHTML = `<span>${esc(msg)}</span>`;
  if (action) {
    const b = document.createElement("button");
    b.textContent = action.label;
    b.onclick = () => { t.hidden = true; action.run(); };
    t.append(b);
  }
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), action ? 6000 : 3500);
}

function parseTyped(text) {
  const t = text.trim();
  let m = t.match(/^(.+?)\s+[-–—]\s+(.+)$/);
  if (m) return { artist: m[1].trim(), title: m[2].trim() };
  m = t.match(/^(.+)\s+by\s+(.+)$/i);
  if (m) return { title: m[1].trim(), artist: m[2].trim() };
  return null;
}

// ------------------------------------------------------------------ rail & account

// ------------------------------------------------------------------ staying up to date

const FILES = ["./", "index.html", "style.css", "app.js", "catalog.js", "store.js", "vault.js", "config.js", "manifest.webmanifest", "version.json"];

/** Re-download every file past the browser's cache, then reload. */
async function hardRefresh() {
  const btn = $("#refresh");
  if (btn) { btn.disabled = true; btn.textContent = "Refreshing…"; }
  await Promise.all(FILES.map((f) => fetch(f, { cache: "reload" }).catch(() => {})));
  location.reload();
}

/** Show a notice when a newer version has been published. */
async function checkForUpdate() {
  try {
    const live = await fetch("version.json", { cache: "no-store" }).then((r) => r.json());
    if (live.v && window.CRATE_VERSION && live.v !== window.CRATE_VERSION && !$("#update-bar")) {
      document.body.insertAdjacentHTML("beforeend",
        `<div id="update-bar" class="toast" role="status"><span>A newer version of Crate is ready.</span><button id="update-now">Refresh</button></div>`);
      $("#update-now").onclick = hardRefresh;
    }
  } catch {}
}
checkForUpdate();
document.addEventListener("visibilitychange", () => { if (!document.hidden) checkForUpdate(); });

function wireTheme() {
  $("#refresh").onclick = hardRefresh;
  $("#theme").onclick = () => {
    const order = Object.keys(THEMES);
    const next = order[(order.indexOf(themeNow()) + 1) % order.length];
    try { localStorage.setItem("crate:theme", next); } catch {}
    document.documentElement.dataset.theme = next;
    renderAccount();
  };
}

function renderRail() {
  $("#shelf-nav").innerHTML = S.lib.shelves.map((s) => `
    <a class="rail-link" href="#shelf-${s.id}" data-shelf="${s.id}">
      <span class="rail-name"><i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}</span><span class="count">${s.albums.length}</span>
    </a>`).join("");
  markActive();
}

const THEMES = { dark: "Dark", light: "Light", auto: "Match Mac" };
function themeNow() { try { return localStorage.getItem("crate:theme") || "dark"; } catch { return "dark"; } }

function renderAccount() {
  const el = $("#account");
  const theme = `<button class="btn" id="refresh" title="Load the latest version of Crate" aria-label="Refresh Crate">↻ Refresh</button><button class="btn" id="theme" title="Switch between dark, light, and your device's setting">${THEMES[themeNow()]}</button>`;
  if (!Store.canSync()) { el.innerHTML = `${theme}<span class="meta">Saved on this device</span>`; wireTheme(); return; }
  el.innerHTML = theme + (S.user
    ? `<span class="meta" title="${esc(S.user.email || "")}">Synced</span><button class="link" id="sign-out">Sign out</button>`
    : `<button class="btn" id="sign-in">Sign in to sync</button>`);
  wireTheme();
  $("#sign-in")?.addEventListener("click", () => Store.signIn().catch(() => toast("Sign-in didn't finish. Try again.")));
  $("#sign-out")?.addEventListener("click", () => Store.signOut());
}

function choreCount() {
  const c = S.raw?.meta?.chores;
  if (!c?.items) return 0;
  return choreItems().filter((i) => CHORES.singles || i.count > 1).length;
}

function markActive() {
  const n = choreCount();
  const el = $("#chores-count");
  if (el) el.textContent = n ? n : "";
  const r = S.route;
  document.querySelectorAll(".rail-link").forEach((a) => {
    a.classList.toggle("active", (a.dataset.route && a.dataset.route === r.name) || (r.name === "shelf" && a.dataset.shelf === r.id));
  });
}

$("#new-shelf").addEventListener("submit", async (e) => {
  e.preventDefault();
  const input = $("#new-shelf-name");
  const name = input.value.trim();
  if (!name) { input.focus(); return; }
  const id = newId("s");
  const order = Math.max(0, ...S.lib.shelves.map((s) => s.order ?? 0)) + 1;
  const used = new Set(S.lib.shelves.map((s) => s.color));
  const color = PALETTE.find((c) => !used.has(c)) || PALETTE[S.lib.shelves.length % PALETTE.length];
  S.pendingShelf = id;
  if (await write(() => Store.set("shelves", id, { name, note: "", order, color }))) {
    input.value = "";
    input.blur();
    location.hash = `shelf-${id}`;
  }
});

// ------------------------------------------------------------------ cards

const discArt = (a) => `<span class="disc"></span><span class="ink">${esc(a.title)}<small>${esc(a.artist)}</small></span>`;
const coverArt = (a) => (a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : discArt(a));

function albumCard(a, { draggable = false } = {}) {
  return `
  <div class="album" data-id="${a.id}" ${draggable ? 'draggable="true"' : ""}>
    <a class="cover ${a.cover ? "" : "burned"}" href="${esc(ytUrl(a))}" target="_blank" rel="noopener" title="Open in YouTube Music">
      ${coverArt(a)}
      <span class="play" aria-hidden="true">▶</span>
    </a>
    <button class="more" data-menu="${a.id}" aria-label="Options for ${esc(a.title)}" aria-haspopup="menu" aria-expanded="false">⋯</button>
    <div class="album-title">${esc(a.title)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span><span class="yr">${a.year ?? ""}</span></div>
  </div>`;
}

const shelfOptions = (selected) =>
  S.lib.shelves.map((s) => `<option value="${s.id}" ${s.id === selected ? "selected" : ""}>${esc(s.name)}</option>`).join("");

// Suggestions and search results share one card; data lives in a lookup by catalog id.
const found = new Map();
const keyOf = (a) => (a.deezerId ? String(a.deezerId) : "it" + a.itunesId);
function remember(list) { for (const a of list) found.set(keyOf(a), a); return list; }
const foundNote = (a) => (a.viaTrack ? `Has “${a.viaTrack}”` : a.reason || "");

function suggestionCard(a, target) {
  return `
  <div class="album sug" data-dz="${keyOf(a)}">
    <a class="cover" href="${esc(Catalog.ytSearchUrl(a))}" target="_blank" rel="noopener" title="Preview in YouTube Music">
      ${coverArt(a)}
      <span class="play" aria-hidden="true">▶</span>
    </a>
    ${a.reason ? `<button class="dismiss" data-dismiss="${keyOf(a)}" aria-label="Not for me: hide ${esc(a.title)}" title="Not for me">×</button>` : ""}
    <div class="album-title">${esc(a.title)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span><span class="yr">${a.year ?? ""}</span></div>
    ${foundNote(a) ? `<div class="reason" title="${esc(foundNote(a))}">${esc(foundNote(a))}</div>` : ""}
    <div class="add-row">
      <select aria-label="Shelf to add ${esc(a.title)} to">${shelfOptions(target)}</select>
      <button class="btn primary" data-add="${keyOf(a)}">Add</button>
    </div>
  </div>`;
}

const skeletons = (n) => Array.from({ length: n }, () =>
  `<div class="album skeleton"><div class="cover"></div><div class="bar"></div><div class="bar" style="width:55%"></div></div>`).join("");

// ------------------------------------------------------------------ the old iTunes library, as a source of taste

let oldLoad = null;
/** Albums from the saved old library with their play counts, or null when there isn't one. */
function oldLibrary() {
  if (!Store.canArchive()) return Promise.resolve(null);
  if (!oldLoad) {
    oldLoad = (VAULT.data ? Promise.resolve(VAULT.data) : Store.loadVault().then(unpackArchive))
      .then((d) => {
        if (!d) { oldLoad = null; return null; }
        VAULT.data = VAULT.data || d;
        const albums = albumsOf(d).filter((x) => x.title !== "(no album)" && x.plays > 0 && !Catalog.isWorship(x));
        const artistPlays = new Map();
        for (const x of albums) artistPlays.set(norm(x.artist), (artistPlays.get(norm(x.artist)) || 0) + x.plays);
        return { albums, artistPlays };
      })
      .catch(() => { oldLoad = null; return null; });
  }
  return oldLoad;
}

/** Old-library albums that fit a shelf: same artists or bands related to them, most-played first. */
async function oldPicksFor(shelf, count, seed) {
  const old = await oldLibrary();
  if (!old || !count) return [];
  const mine = new Set(shelf.albums.map((x) => norm(x.artist)));
  const near = await Catalog.relatedNames(shelf.albums).catch(() => new Set());
  const owned = ownedCheck();
  const dismissedOld = new Set(S.raw?.meta?.dismissed?.old || []);
  const fits = old.albums
    .filter((x) => (mine.has(norm(x.artist)) || near.has(norm(x.artist))) && !owned(x) && !dismissedOld.has(x.k))
    .sort((x, y) => y.plays - x.plays);
  // Mostly the top of the list, with Shuffle bringing in others from near the top.
  const pool = Catalog.shuffle(fits.slice(0, count * 3), Catalog.rng(seed)).slice(0, count).sort((x, y) => y.plays - x.plays);
  const out = [];
  for (const x of pool) {
    const hit = await Catalog.find(x.artist, x.title).catch(() => null);
    const base = hit || { deezerId: null, title: x.title, artist: x.artist, year: x.year, cover: "" };
    out.push({ ...base, itunesId: hit ? base.itunesId : x.k, oldKey: x.k, reason: `${x.plays.toLocaleString()} plays in your iTunes` });
  }
  return out;
}

// ------------------------------------------------------------------ suggestions

function suggestKey(shelf) {
  return `${S.seeds[shelf.id] || 0}|${shelf.albums.map((a) => a.artistId).filter(Boolean).sort().join(",")}`;
}

function suggestBlock(shelf, title, n, layout) {
  return `
  <section class="suggest" data-suggest="${shelf.id}" data-n="${n}" data-layout="${layout}">
    <div class="suggest-head">
      <h3>${esc(title)}</h3>
      <span class="meta">From artists on this shelf and the bands around them</span>
      <button class="btn" data-refresh="${shelf.id}">Shuffle</button>
    </div>
    ${liveBox({ shelfId: shelf.id, placeholder: `Have one in mind? Search to add it to ${shelf.name}` })}
    <div class="sug-items ${layout}">${skeletons(Math.min(n, 6))}</div>
  </section>`;
}

async function fillSuggestions() {
  for (const box of view.querySelectorAll("[data-suggest]")) {
    const shelf = shelfById(box.dataset.suggest);
    if (!shelf) continue;
    const n = Number(box.dataset.n), layout = box.dataset.layout;
    const items = box.querySelector(".sug-items");
    const key = suggestKey(shelf) + "|" + n;
    let entry = S.sugg[shelf.id];
    if (!entry || entry.key !== key) {
      entry = S.sugg[shelf.id] = { key, items: null };
      try {
        const owned = ownedCheck();
        const libArtists = new Set(allAlbums().map((a) => a.artistId).filter(Boolean));
        const seed = `${shelf.id}-${S.seeds[shelf.id] || 0}`;
        const old = await oldLibrary();
        const nOld = old ? Math.ceil(n / 3) : 0;
        const [fresh, mine] = await Promise.all([
          Catalog.suggest(shelf.albums, { n, seed, owned, libraryArtists: libArtists, favorites: old?.artistPlays }),
          oldPicksFor(shelf, nOld, seed),
        ]);
        // Every third card is from the old library, starting with the first.
        const merged = [], rest = fresh.filter((x) => !mine.some((m) => m.deezerId && m.deezerId === x.deezerId));
        while ((mine.length || rest.length) && merged.length < n) merged.push(merged.length % 3 === 0 && mine.length ? mine.shift() : rest.shift() || mine.shift());
        entry.items = remember(merged);
      } catch (e) {
        entry.items = null;
        if (box.isConnected) items.innerHTML = `<div class="empty">${esc(e.message)} Use Shuffle to try again.</div>`;
        continue;
      }
    }
    const hasArtists = shelf.albums.some((a) => a.artistId);
    // An empty answer for a shelf with artists means the catalog didn't respond; try again next time.
    if (!entry.items?.length && hasArtists) delete S.sugg[shelf.id];
    if (!box.isConnected) continue;
    const owned = ownedCheck();
    const list = (entry.items || []).filter((a) => !owned(a) && !Catalog.isWorship(a));
    items.className = `sug-items ${list.length ? layout : ""}`;
    items.innerHTML = list.length
      ? list.map((a) => suggestionCard(a, shelf.id)).join("")
      : hasArtists
        ? `<div class="empty">Couldn't load suggestions just now. Use Shuffle to try again.</div>`
        : `<div class="empty">Suggestions come from the artists on this shelf. Search above to add the first few.</div>`;
  }
}

// ------------------------------------------------------------------ live search

function liveBox({ shelfId = "", placeholder }) {
  return `
  <form class="live" data-live="${shelfId}" autocomplete="off" role="search">
    <input class="live-input" type="search" placeholder="${esc(placeholder)}" aria-label="${esc(placeholder)}">
    <div class="live-list" hidden></div>
  </form>`;
}

let liveTimer, liveSeq = 0;
function onLiveInput(form) {
  clearTimeout(liveTimer);
  const q = form.querySelector(".live-input").value.trim();
  const list = form.querySelector(".live-list");
  if (q.length < 2) { list.hidden = true; return; }
  list.hidden = false;
  if (!list.innerHTML) list.innerHTML = `<div class="live-hint">Searching…</div>`;
  liveTimer = setTimeout(async () => {
    const seq = ++liveSeq;
    let results;
    try { results = remember(await Catalog.search(q, 8)); }
    catch (e) { if (seq === liveSeq) list.innerHTML = `<div class="live-hint">${esc(e.message)}</div>`; return; }
    if (seq !== liveSeq || !form.isConnected) return;
    renderLiveList(form, results, q);
  }, 280);
}

function renderLiveList(form, results, q) {
  const list = form.querySelector(".live-list");
  const fixed = form.dataset.live;
  const target = fixed || S.lastShelf || S.lib.shelves[0]?.id;
  const owned = ownedCheck();
  const typed = parseTyped(q);
  list.innerHTML = `
    ${fixed ? `<div class="live-head">Adding to <b>${esc(shelfById(fixed)?.name)}</b></div>`
            : `<div class="live-head">Add to <select class="live-shelf" aria-label="Shelf to add to">${shelfOptions(target)}</select></div>`}
    ${results.map((a) => {
      const have = owned(a);
      return `
      <div class="live-item">
        <img src="${esc(a.cover)}" alt="" loading="lazy">
        <span class="live-text"><b>${esc(a.title)}</b><small>${esc(a.artist)}${a.year ? " · " + a.year : ""}${a.viaTrack ? ` · has “${esc(a.viaTrack)}”` : ""}</small></span>
        <a class="link" href="${esc(Catalog.ytSearchUrl(a))}" target="_blank" rel="noopener" title="Listen first in YouTube Music">Listen</a>
        ${have ? `<span class="meta">Added</span>` : `<button type="button" class="btn primary" data-live-add="${keyOf(a)}">Add</button>`}
      </div>`;
    }).join("") || `<div class="live-hint">No albums found for “${esc(q)}”.</div>`}
    ${typed ? `<button type="button" class="live-manual" data-live-manual="1">Not listed? Add “${esc(typed.title)}” by ${esc(typed.artist)} as a blank CD</button>`
            : `<div class="live-hint">Not listed? Type it as Artist - Album to add it by hand.</div>`}
    ${fixed ? "" : `<button type="button" class="live-manual" data-live-all="1">See all results →</button>`}`;
}

async function liveAdd(form, a) {
  const shelfId = form.dataset.live || form.querySelector(".live-shelf")?.value;
  if (!shelfId) return;
  const id = await addAlbum(a, shelfId);
  if (!id) return;
  addedToast(a.title, shelfId, id);
  const btn = form.querySelector(`[data-live-add="${keyOf(a)}"]`);
  if (btn) btn.outerHTML = `<span class="meta">Added</span>`;
  S.lastShelf = shelfId;
  form.querySelector(".live-input").focus({ preventScroll: true });
}

// Catch up on changes that arrived while a dropdown was open.
function afterLiveClosed() {
  if (S.dirty && !liveOpen()) { S.dirty = false; render(); }
}

function closeLive(form) {
  form.querySelector(".live-list").hidden = true;
}

document.addEventListener("input", (e) => {
  const form = e.target.closest?.("form.live");
  if (form) onLiveInput(form);
});

document.addEventListener("click", async (e) => {
  const form = e.target.closest("form.live");
  document.querySelectorAll("form.live .live-list:not([hidden])").forEach((l) => { if (!l.parentElement.contains(e.target)) l.hidden = true; });
  afterLiveClosed();
  if (!form) return;
  const add = e.target.closest("[data-live-add]");
  if (add) { add.disabled = true; await liveAdd(form, found.get(add.dataset.liveAdd)); return; }
  if (e.target.closest("[data-live-manual]")) {
    const typed = parseTyped(form.querySelector(".live-input").value);
    if (typed) await liveAdd(form, typed);
    form.querySelector(".live-input").value = ""; closeLive(form);
    if (S.route.name !== "search") render();
    return;
  }
  if (e.target.closest("[data-live-all]")) { goSearch(form.querySelector(".live-input").value); return; }
  if (e.target.closest(".live-input")) onLiveInput(form);
});

document.addEventListener("submit", (e) => {
  const form = e.target.closest("form.live");
  if (!form) return;
  e.preventDefault();
  const q = form.querySelector(".live-input").value.trim();
  if (!form.dataset.live && q) goSearch(q);
});

document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") { document.querySelectorAll("form.live .live-list").forEach((l) => (l.hidden = true)); closeMenu(); afterLiveClosed(); }
});

function goSearch(q) {
  if (!q.trim()) return;
  S.query = q.trim();
  document.querySelectorAll("form.live .live-list").forEach((l) => (l.hidden = true));
  document.activeElement?.blur();
  if (location.hash === "#search") render(); else location.hash = "search";
}

// ------------------------------------------------------------------ views

function shelfAttrs(s) {
  const style = `--shelf:${esc(s.color)};${s.image ? `--img:url('${s.image}')` : ""}`;
  return `class="shelf${s.image ? " has-image" : ""}" style="${style}"`;
}
const swatch = (s) => `<button class="swatch" data-color-for="${s.id}" aria-label="Change color or image for ${esc(s.name)}" title="Color or image"></button>`;

function recentList(albums) {
  return `<div class="list">${albums.map((a) => `
    <a class="row" href="${esc(ytUrl(a))}" target="_blank" rel="noopener">
      ${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : `<span class="mini burned"><span class="disc"></span></span>`}
      <div style="min-width:0"><div class="t">${esc(a.title)}</div><div class="s">${esc(a.artist)}${a.year ? " · " + a.year : ""}</div></div>
      <div class="when"><span class="chip"><i class="dot" style="background:${esc(a.shelf.color)}"></i>${esc(a.shelf.name)}</span><div class="meta" style="margin-top:4px">${ago(a.addedAt)}</div></div>
    </a>`).join("")}</div>`;
}

function renderHome() {
  if (!S.lib.shelves.length) {
    view.innerHTML = `<div class="empty offline">No shelves yet. Name your first one in “New shelf…”.</div>`;
    return;
  }
  const recent = allAlbums().sort((a, b) => b.addedAt - a.addedAt).slice(0, 8);
  const order = Catalog.shuffle(S.lib.shelves, Catalog.rng(S.homeSeed));
  view.innerHTML = `
    ${order.map((s) => `
      <section ${shelfAttrs(s)}>
        <div class="shelf-head">
          <h2 class="shelf-title"><a href="#shelf-${s.id}">${esc(s.name)}</a></h2>
          ${swatch(s)}
          <span class="meta">${discs(s.albums.length)}${s.albums.length ? " · " + span(s.albums) : ""}</span>
          ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
          ${s.albums.length > HOME_LIMIT ? `<a class="see-all" href="#shelf-${s.id}">All ${s.albums.length} →</a>` : ""}
        </div>
        ${s.albums.length
          ? `<div class="grid">${s.albums.slice(0, HOME_LIMIT).map((a) => albumCard(a)).join("")}</div>`
          : `<div class="empty">Nothing here yet. Search below to add the first album.</div>`}
        ${suggestBlock(s, `Fits on ${s.name}`, 8, "strip")}
      </section>`).join("")}
    ${recent.length ? `
      <section class="shelf plain">
        <div class="shelf-head"><h2 class="shelf-title"><a href="#recent">Recently added</a></h2></div>
        ${recentList(recent)}
      </section>` : ""}`;
  fillSuggestions();
}

function renderShelf(id) {
  const s = shelfById(id);
  if (!s) {
    if (S.pendingShelf === id) { view.innerHTML = `<div class="empty offline">Setting up your shelf…</div>`; return; }
    location.hash = "home";
    return;
  }
  if (S.pendingShelf === id) S.pendingShelf = null;
  S.lastShelf = s.id;
  const i = S.lib.shelves.indexOf(s);
  view.innerHTML = `
    <section ${shelfAttrs(s)}>
      <div class="shelf-head" id="shelf-head">
        <h1 class="shelf-title">${esc(s.name)}</h1>
        ${swatch(s)}
        <span class="meta">${discs(s.albums.length)}${s.albums.length ? " · " + span(s.albums) : ""}</span>
        <div class="head-actions">
          <button class="btn" data-act="list">Add a list</button>
          <button class="btn" data-act="rename">Rename</button>
          <button class="btn" data-act="note">${s.note ? "Edit note" : "Add a note"}</button>
          <button class="btn" data-act="up" ${i === 0 ? "disabled" : ""} aria-label="Move shelf up">↑</button>
          <button class="btn" data-act="down" ${i === S.lib.shelves.length - 1 ? "disabled" : ""} aria-label="Move shelf down">↓</button>
          <button class="btn danger" data-act="delete">Delete shelf</button>
        </div>
        ${s.note ? `<p class="note">${esc(s.note)}</p>` : ""}
      </div>
      ${S.list?.shelfId === s.id ? listForm(s) : ""}
      ${s.albums.length
        ? `<div class="grid" id="shelf-grid">${s.albums.map((a) => albumCard(a, { draggable: true })).join("")}</div>
           <p class="meta" style="margin-top:18px">Drag covers to reorder, or drop one on a shelf in the sidebar to move it.</p>`
        : `<div class="empty">This shelf is empty. Search below to add the first album.</div>`}
      ${suggestBlock(s, `Suggested for ${s.name}`, 18, "grid")}
    </section>`;
  fillSuggestions();
  if (S.list?.shelfId === s.id) wireListForm(s);
}

function listForm(s) {
  return `
    <form id="list-form" class="list-form">
      <label for="list-input" class="meta">One album per line, written Artist - Album. Separate several albums by the same artist with commas.</label>
      <textarea id="list-input" rows="6" placeholder="Local Natives - Gorilla Manor, Sunlit Youth&#10;José González - Veneer" ${S.list.busy ? "disabled" : ""}></textarea>
      <div class="list-actions">
        <button class="btn primary" ${S.list.busy ? "disabled" : ""}>${S.list.busy ? "Adding…" : `Add to ${esc(s.name)}`}</button>
        <button type="button" class="btn" id="list-cancel">Close</button>
      </div>
      <ul id="list-report" class="list-report">${S.list.report}</ul>
    </form>`;
}

function wireListForm(s) {
  $("#list-cancel").onclick = () => { S.list = null; render(); };
  $("#list-form").onsubmit = (e) => { e.preventDefault(); if (!S.list.busy) addList(s.id, $("#list-input").value); };
}

function renderRecent() {
  const albums = allAlbums().sort((a, b) => b.addedAt - a.addedAt);
  view.innerHTML = `
    <h1 class="page-title">Recently added</h1>
    <p class="meta" style="margin-bottom:18px">${discs(albums.length)}, newest first</p>
    ${recentList(albums)}`;
}

async function renderSearch() {
  const q = S.query;
  const target = S.lastShelf || S.lib.shelves[0]?.id;
  view.innerHTML = `
    <h1 class="page-title">${esc(q)}</h1>
    <p class="meta" style="margin-bottom:18px">Albums matching your search · pick a shelf on each one</p>
    <div class="grid" id="results">${skeletons(6)}</div>`;
  let results;
  try { results = remember(await Catalog.search(q, 40)); }
  catch (e) { $("#results").innerHTML = `<div class="empty">${esc(e.message)}</div>`; return; }
  if (S.route.name !== "search" || S.query !== q) return;
  const owned = ownedCheck();
  const list = results.filter((a) => !owned(a));
  const typed = parseTyped(q);
  $("#results").innerHTML = list.length ? list.map((a) => suggestionCard(a, target)).join("")
    : `<div class="empty">No albums found for “${esc(q)}”. Try just the artist name.${typed ? "" : " To add one by hand, search for it as Artist - Album."}</div>`;
  if (typed && !list.length) {
    $("#results").insertAdjacentHTML("afterend", `<button class="btn" id="manual-add" style="margin-top:16px">Add “${esc(typed.title)}” by ${esc(typed.artist)} as a blank CD</button>`);
    $("#manual-add").onclick = async () => { const id = await addAlbum(typed, target); if (id) addedToast(typed.title, target, id); };
  }
}

function route() {
  const h = location.hash.slice(1);
  if (h.startsWith("shelf-")) S.route = { name: "shelf", id: h.slice(6) };
  else if (h === "recent") S.route = { name: "recent" };
  else if (h === "new") S.route = { name: "new" };
  else if (h === "links") S.route = { name: "links" };
  else if (h === "chores") S.route = { name: "chores" };
  else if (h === "vault") S.route = { name: "vault" };
  else if (h.startsWith("ytlinks=")) { receiveYtLinks(h.slice(8)); return; }
  else if (h === "search" && S.query) S.route = { name: "search" };
  else S.route = { name: "home" };
  render();
  window.scrollTo(0, 0);
}

function render() {
  if (!S.raw) return;
  closeMenu();
  const r = S.route;
  if (r.name === "shelf") renderShelf(r.id);
  else if (r.name === "recent") renderRecent();
  else if (r.name === "new") renderNew();
  else if (r.name === "links") renderLinks();
  else if (r.name === "chores") renderChores();
  else if (r.name === "vault") renderVault();
  else if (r.name === "search") renderSearch();
  else renderHome();
  markActive();
}

// ------------------------------------------------------------------ popover menus

const menu = $("#menu");
let menuFor = null;

function closeMenu() {
  menu.hidden = true;
  document.querySelectorAll('[aria-expanded="true"]').forEach((b) => b.setAttribute("aria-expanded", "false"));
  menuFor = null;
}

function placeMenu(btn, alignRight) {
  menu.hidden = false;
  const r = btn.getBoundingClientRect();
  const w = menu.offsetWidth, h = menu.offsetHeight;
  const left = alignRight ? r.right - w : r.left;
  menu.style.left = Math.max(16, Math.min(left, innerWidth - w - 16)) + "px";
  menu.style.top = (r.bottom + 6 + h > innerHeight ? Math.max(16, r.top - h - 6) : r.bottom + 6) + "px";
}

function openMenu(btn, albumId) {
  const a = allAlbums().find((x) => x.id === albumId);
  if (!a) return;
  menuFor = { kind: "album", id: albumId };
  btn.setAttribute("aria-expanded", "true");
  menu.innerHTML = `
    <div class="label">Move to</div>
    ${S.lib.shelves.map((s) => `<button data-move="${s.id}" ${s.id === a.shelf.id ? "disabled" : ""}><i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}${s.id === a.shelf.id ? " · here" : ""}</button>`).join("")}
    <hr>
    <div class="label">YouTube Music link</div>
    <div class="menu-note">${a.ytUrl ? "Opens the album page" : "Opens a search for the album"}</div>
    <form class="yt-form" id="yt-form">
      <input id="yt-input" placeholder="Paste the album's share link" autocomplete="off" spellcheck="false" aria-label="YouTube Music album link">
      <button class="btn primary">Save</button>
    </form>
    ${navigator.clipboard?.readText ? `<button data-ytpaste="1">Paste link from clipboard</button>` : ""}
    ${a.ytUrl ? `<button data-ytclear="1">Go back to opening a search</button>` : ""}
    <hr>
    <button data-remove="1">Remove from library</button>`;
  placeMenu(btn, true);
  $("#yt-form").onsubmit = (e) => { e.preventDefault(); saveYtLink(a, $("#yt-input").value); };
}

/** Accepts YouTube Music / YouTube album links; returns a clean music.youtube.com URL or "". */
function cleanYtLink(text) {
  const m = String(text).match(/https?:\/\/[^\s]+/);
  if (!m) return "";
  let u;
  try { u = new URL(m[0]); } catch { return ""; }
  if (!/(^|\.)youtube\.com$|^youtu\.be$/.test(u.hostname)) return "";
  const list = u.searchParams.get("list");
  if (list) return `https://music.youtube.com/playlist?list=${encodeURIComponent(list)}`;
  const browse = u.pathname.match(/^\/browse\/([\w-]+)/);
  if (browse) return `https://music.youtube.com/browse/${browse[1]}`;
  return "";
}

async function saveYtLink(a, text) {
  const url = cleanYtLink(text);
  if (!url) { toast("That isn't an album link. In YouTube Music, open the album, tap Share, then Copy link."); return; }
  closeMenu();
  if (await write(() => Store.update("albums", a.id, { ytUrl: url }))) toast(`${a.title} now opens its album page`);
}

function openColorMenu(btn, shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  menuFor = { kind: "color", id: shelfId };
  btn.setAttribute("aria-expanded", "true");
  menu.innerHTML = `
    <div class="label">Shelf color</div>
    <div class="swatches">${PALETTE.map((c) => `<button class="sw ${c === s.color ? "on" : ""}" data-pick="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}</div>
    <form class="hexrow" id="hex-form">
      <input type="color" id="c-pick" value="${esc(s.color)}" aria-label="Pick any color">
      <input id="c-hex" value="${esc(s.color)}" maxlength="7" spellcheck="false" aria-label="Hex color">
      <button class="btn">Set</button>
    </form>
    <hr>
    <button data-upload="1">${s.image ? "Replace" : "Add"} a header image…</button>
    ${s.image ? `<button data-clearimg="1">Remove the image</button>` : ""}
    <input type="file" id="c-file" accept="image/*" hidden>`;
  placeMenu(btn, false);
  const pick = $("#c-pick"), hex = $("#c-hex");
  pick.oninput = () => { hex.value = pick.value; previewColor(shelfId, pick.value); };
  pick.onchange = () => setColor(shelfId, pick.value);
  $("#hex-form").onsubmit = (e) => {
    e.preventDefault();
    const v = hex.value.trim().replace(/^([0-9a-f]{6})$/i, "#$1");
    if (!/^#[0-9a-f]{6}$/i.test(v)) { toast("Use a 6-digit hex color like #8a4bd6."); return; }
    setColor(shelfId, v.toLowerCase());
  };
  $("#c-file").onchange = (e) => e.target.files[0] && setHeader(shelfId, e.target.files[0]);
}

function previewColor(shelfId, color) {
  document.querySelectorAll(`[data-color-for="${shelfId}"]`).forEach((b) => b.closest(".shelf")?.style.setProperty("--shelf", color));
}

async function setColor(shelfId, color) {
  previewColor(shelfId, color);
  closeMenu();
  await write(() => Store.update("shelves", shelfId, { color }));
}

async function setHeader(shelfId, file) {
  closeMenu();
  try {
    const bmp = await createImageBitmap(file);
    const scale = Math.min(1, 1400 / Math.max(bmp.width, bmp.height));
    const c = document.createElement("canvas");
    c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
    c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
    let q = 0.82, data = c.toDataURL("image/jpeg", q);
    while (data.length > 700000 && q > 0.4) { q -= 0.12; data = c.toDataURL("image/jpeg", q); }
    if (await write(() => Store.set("images", shelfId, { data }))) toast(`New header image on ${shelfById(shelfId).name}`);
  } catch {
    toast("That image couldn't be used. Try a JPG or PNG.");
  }
}

menu.addEventListener("click", async (e) => {
  const b = e.target.closest("button");
  if (!b || !menuFor) return;
  if (menuFor.kind === "color") {
    const id = menuFor.id;
    if (b.dataset.pick) setColor(id, b.dataset.pick);
    else if (b.dataset.upload) $("#c-file").click();
    else if (b.dataset.clearimg) { closeMenu(); write(() => Store.remove("images", id)); }
    return;
  }
  const a = allAlbums().find((x) => x.id === menuFor.id);
  if (b.closest("#yt-form")) return;
  if (b.dataset.ytpaste) {
    try { saveYtLink(a, await navigator.clipboard.readText()); }
    catch { toast("Couldn't read the clipboard. Paste the link into the box instead."); }
    return;
  }
  closeMenu();
  if (!a) return;
  if (b.dataset.ytclear) { write(() => Store.update("albums", a.id, { ytUrl: "" })); return; }
  if (b.dataset.move) {
    if (await moveAlbum(a.id, b.dataset.move, 0)) toast(`Moved to ${shelfById(b.dataset.move).name}`, { label: "Undo", run: () => restoreAlbum(a) });
  } else if (b.dataset.remove) {
    if (await write(() => Store.remove("albums", a.id))) toast(`Removed ${a.title}`, { label: "Undo", run: () => restoreAlbum(a) });
  }
});

document.addEventListener("click", (e) => {
  if (!menu.hidden && !menu.contains(e.target) && !e.target.closest("[data-menu],[data-color-for]")) { closeMenu(); S.raw && onData(S.raw); }
});

// ------------------------------------------------------------------ clicks in the page

view.addEventListener("click", async (e) => {
  const t = e.target;
  const more = t.closest("[data-menu]");
  if (more) {
    if (menuFor?.id === more.dataset.menu) closeMenu(); else { closeMenu(); openMenu(more, more.dataset.menu); }
    return;
  }
  const sw = t.closest("[data-color-for]");
  if (sw) {
    e.preventDefault();
    if (menuFor?.id === sw.dataset.colorFor) closeMenu(); else { closeMenu(); openColorMenu(sw, sw.dataset.colorFor); }
    return;
  }
  const add = t.closest("[data-add]");
  if (add) {
    const card = add.closest(".sug");
    const shelfId = card.querySelector("select").value;
    const a = found.get(add.dataset.add);
    if (!a) return;
    add.disabled = true; add.textContent = "…";
    const id = await addAlbum(a, shelfId);
    if (id) { addedToast(a.title, shelfId, id); card.remove(); }
    else { add.disabled = false; add.textContent = "Add"; }
    return;
  }
  const dismiss = t.closest("[data-dismiss]");
  if (dismiss) {
    const card = dismiss.closest(".sug");
    const item = found.get(card?.dataset.dz || "");
    card?.remove();
    const prev = S.raw?.meta?.dismissed || {};
    const ids = item?.deezerId ? [...new Set([...dismissed(), item.deezerId])] : [...dismissed()];
    const old = item?.oldKey ? [...new Set([...(prev.old || []), item.oldKey])] : prev.old || [];
    write(() => Store.set("meta", "dismissed", { ids, old }));
    return;
  }
  const refresh = t.closest("[data-refresh]");
  if (refresh) {
    const id = refresh.dataset.refresh;
    S.seeds[id] = (S.seeds[id] || 0) + 1;
    const box = refresh.closest("[data-suggest]");
    box.querySelector(".sug-items").innerHTML = skeletons(6);
    fillSuggestions();
    return;
  }
  const act = t.closest("[data-act]");
  if (act && S.route.name === "shelf") shelfAction(act.dataset.act);
});

async function shelfAction(act) {
  const s = shelfById(S.route.id);
  const head = $("#shelf-head");
  if (act === "rename") {
    head.querySelector(".shelf-title").outerHTML =
      `<form class="shelf-title" id="rename-form"><input class="rename" id="rename-input" value="${esc(s.name)}" aria-label="Shelf name"></form>`;
    const input = $("#rename-input");
    input.focus(); input.select();
    let done = false;
    const finish = async (save) => {
      if (done) return; done = true;
      const name = input.value.trim();
      input.blur();
      if (save && name && name !== s.name) await write(() => Store.update("shelves", s.id, { name }));
      render();
    };
    $("#rename-form").onsubmit = (e) => { e.preventDefault(); finish(true); };
    input.onblur = () => finish(true);
    input.onkeydown = (e) => { if (e.key === "Escape") finish(false); };
  } else if (act === "note") {
    head.querySelector(".note")?.remove();
    head.insertAdjacentHTML("beforeend", `
      <form id="note-form" style="flex:1 1 100%;display:flex;flex-direction:column;gap:8px">
        <textarea class="note-edit" id="note-input" rows="2" placeholder="What this shelf is about: the years, the car, the friends…">${esc(s.note)}</textarea>
        <div><button class="btn primary">Save note</button></div>
      </form>`);
    $("#note-input").focus();
    $("#note-form").onsubmit = async (e) => {
      e.preventDefault();
      const note = $("#note-input").value.trim();
      $("#note-input").blur();
      await write(() => Store.update("shelves", s.id, { note }));
      render();
    };
  } else if (act === "list") {
    if (!S.list || S.list.shelfId !== s.id) S.list = { shelfId: s.id, report: "", busy: false };
    render();
    $("#list-input")?.focus();
  } else if (act === "up" || act === "down") {
    const list = S.lib.shelves;
    const i = list.indexOf(s), j = act === "up" ? i - 1 : i + 1;
    const order = list.map((x) => x.id);
    [order[i], order[j]] = [order[j], order[i]];
    for (const [k, id] of order.entries()) {
      if ((shelfById(id).order ?? -1) !== k) await write(() => Store.update("shelves", id, { order: k }));
    }
  } else if (act === "delete") {
    if (s.albums.length) { toast(`Move or remove the ${discs(s.albums.length)} on ${s.name} first.`); return; }
    const btn = head.querySelector('[data-act="delete"]');
    if (btn.dataset.armed) {
      if (await write(() => Store.remove("shelves", s.id))) { write(() => Store.remove("images", s.id)); location.hash = "home"; }
    } else {
      btn.dataset.armed = "1"; btn.textContent = "Click again to delete";
      setTimeout(() => { if (btn.isConnected) { delete btn.dataset.armed; btn.textContent = "Delete shelf"; } }, 4000);
    }
  }
}

// ------------------------------------------------------------------ add a whole list

function parseList(text) {
  const out = [];
  for (let line of text.split(/\n+/)) {
    line = line.replace(/^\s*([•*·▪◦-]|\d+[.)])\s*/, "").trim();
    const m = line.match(/^(.+?)\s+[-–—:]\s+(.+)$/);
    if (!m) { if (line) out.push({ line, artist: "", titles: [] }); continue; }
    out.push({ line, artist: m[1].trim(), titles: [m[2].trim()] });
  }
  return out;
}

async function addList(shelfId, text) {
  const items = parseList(text);
  if (!items.length) { $("#list-input").focus(); return; }
  const list = S.list;
  list.busy = true; list.report = "";
  render();
  const line = (cls, html) => {
    list.report += `<li class="${cls}">${html}</li>`;
    const r = $("#list-report");
    if (r && S.list === list) r.innerHTML = list.report;
  };
  let added = 0;
  for (const it of items) {
    if (!it.artist) { line("miss", `Couldn't read “${esc(it.line)}”. Write it as Artist - Album.`); continue; }
    // "Gorilla Manor, Sunlit Youth": try the whole thing first, then each part.
    let jobs = [it.titles[0]];
    let first = await Catalog.find(it.artist, jobs[0]).catch(() => null);
    // Keep a comma title only when it is one album's exact name ("Brother, Sister").
    if (/,/.test(jobs[0]) && !(first && Catalog.sim(first.title, jobs[0]) >= 0.97)) {
      jobs = jobs[0].split(/\s*,\s*/).filter(Boolean);
      first = null;
    }
    for (const title of jobs) {
      const a = first && jobs.length === 1 ? first : await Catalog.find(it.artist, title).catch(() => null);
      if (!a) { line("miss", `Couldn't find <b>${esc(title)}</b> by ${esc(it.artist)}. Try the search box with a different spelling.`); continue; }
      const id = await addAlbum({ ...a }, shelfId);
      const note = a.viaTrack && Catalog.sim(a.viaTrack, title) > Catalog.sim(a.title, title)
        ? ` (“${esc(title)}” is a song on this album)` : "";
      if (id) { added++; line("ok", `Added <b>${esc(a.title)}</b> by ${esc(a.artist)}${note}`); }
      else line("miss", `<b>${esc(a.title)}</b> by ${esc(a.artist)} is already in your library.`);
    }
  }
  list.busy = false;
  if (S.list === list && S.route.name === "shelf") render();
  if (added) toast(`Added ${added} ${added === 1 ? "album" : "albums"} to ${shelfById(shelfId)?.name}`);
}

// ------------------------------------------------------------------ new releases

const monthDay = (d) => new Date(d + "T12:00:00").toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
const NEW = { data: null, loading: false, at: 0 };

function newCard(a, target, note) {
  const owned = allAlbums().find((x) => (a.deezerId && x.deezerId === a.deezerId) || (norm(x.title) === norm(a.title) && norm(x.artist) === norm(a.artist)));
  remember([a]);
  return `
  <div class="album sug" data-dz="${keyOf(a)}">
    <a class="cover" href="${esc(owned ? ytUrl(owned) : Catalog.ytSearchUrl(a))}" target="_blank" rel="noopener" title="Open in YouTube Music">
      ${coverArt(a)}<span class="play" aria-hidden="true">▶</span>
    </a>
    <div class="album-title">${esc(a.title)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span><span class="yr">${a.type === "ep" ? "EP" : ""}</span></div>
    <div class="reason" title="${esc(note)}">${esc(note)}</div>
    ${owned ? `<div class="meta on-shelf"><i class="dot" style="background:${esc(owned.shelf.color)}"></i>On ${esc(owned.shelf.name)}</div>` : `
    <div class="add-row">
      <select aria-label="Shelf to add ${esc(a.title)} to">${shelfOptions(target)}</select>
      <button class="btn primary" data-add="${keyOf(a)}">Add</button>
    </div>`}
  </div>`;
}

function renderNew() {
  view.innerHTML = `
    <h1 class="page-title">New releases</h1>
    <p class="note" style="margin-bottom:8px">Albums and EPs from the last 12 months, newest first.</p>
    <section class="new-sec">
      <h2 class="section-label">From artists on your shelves</h2>
      <div class="grid" id="new-mine">${skeletons(6)}</div>
    </section>
    <section class="new-sec" id="new-old-sec" hidden>
      <h2 class="section-label">From artists you played most on iTunes</h2>
      <div class="grid" id="new-old">${skeletons(6)}</div>
    </section>
    <section class="new-sec">
      <h2 class="section-label">New from bands you might like</h2>
      <p class="meta" style="margin-bottom:14px">Bands closely related to several of your artists come first</p>
      <div class="grid" id="new-near">${skeletons(6)}</div>
    </section>`;
  loadNew();
}

async function loadNew() {
  const since = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
  const artists = new Map(), shelfOf = new Map();
  for (const a of allAlbums()) if (a.artistId && !artists.has(a.artistId)) { artists.set(a.artistId, a.artist); shelfOf.set(a.artistId, a.shelf.id); }
  const byName = new Map([...artists].map(([id, n]) => [n, shelfOf.get(id)]));
  const fill = (id, html, empty) => { const el = $(id); if (el && S.route.name === "new") el.innerHTML = html || `<div class="empty">${empty}</div>`; };
  try {
    const mine = await Catalog.newFrom(artists, since);
    fill("#new-mine", mine.map((a) => newCard(a, shelfOf.get(a.artistId), `Released ${monthDay(a.released)}`)).join(""),
      "None of your artists have released anything in the last 12 months.");
    const old = await oldLibrary();
    if (old) {
      $("#new-old-sec") && ($("#new-old-sec").hidden = false);
      const shelfNames = new Set([...artists.values()].map(norm));
      const top = [...old.artistPlays].filter(([n]) => !shelfNames.has(n)).sort((x, y) => y[1] - x[1]).slice(0, 30);
      const names = new Map(old.albums.map((x) => [norm(x.artist), x.artist]));
      const ids = new Map(), playsOf = new Map();
      for (const [n, plays] of top) {
        const hit = await Catalog.findArtist(names.get(n)).catch(() => null);
        if (hit && !artists.has(hit.id)) { ids.set(hit.id, hit.name); playsOf.set(hit.id, plays); }
      }
      const fromOld = await Catalog.newFrom(ids, since);
      fill("#new-old", fromOld.map((a) => newCard(a, "", `Released ${monthDay(a.released)} · ${playsOf.get(a.artistId)?.toLocaleString()} old plays`)).join(""),
        "Nothing new from the artists you played most.");
    }
    const near = (await Catalog.newNearby(artists, since)).slice(0, 24);
    fill("#new-near", near.map((a) => newCard(a, byName.get(a.because[0]),
      `Like ${a.because.slice(0, 2).join(" & ")}${a.because.length > 2 ? ` +${a.because.length - 2}` : ""} · ${monthDay(a.released)}`)).join(""),
      "Nothing new from related bands right now.");
  } catch (e) {
    fill("#new-mine", "", esc(e.message));
  }
}

// ------------------------------------------------------------------ sorting chores: liked albums not on a shelf yet

const CHORES = { covers: new Map(), found: new Map(), busy: "", shown: 40, singles: false };

/** Pull every liked video from YouTube and group the YouTube Music tracks by album. */
async function fetchYouTubeLikes(token) {
  const albums = new Map();
  let page = "", n = 0, rank = 0;
  do {
    const p = new URLSearchParams({ myRating: "like", part: "snippet", maxResults: "50" });
    if (page) p.set("pageToken", page);
    const res = await fetch("https://www.googleapis.com/youtube/v3/videos?" + p, { headers: { Authorization: "Bearer " + token } });
    if (!res.ok) {
      const body = await res.json().catch(() => ({}));
      const reason = body?.error?.errors?.[0]?.reason || "";
      throw new Error(reason === "accessNotConfigured" || reason === "SERVICE_DISABLED"
        ? "The YouTube Data API is turned off for your Crate project. Turn it on in Google Cloud and try again."
        : `YouTube didn't share your likes (error ${res.status}).`);
    }
    const d = await res.json();
    for (const v of d.items || []) {
      rank++;
      // Tracks from YouTube Music carry "Provided to YouTube by …", then "Song · Artist", then the album name.
      const lines = String(v.snippet?.description || "").split("\n").map((l) => l.trim()).filter(Boolean);
      if (!/^Provided to YouTube by/i.test(lines[0] || "") || lines.length < 3) continue;
      const [song, ...artists] = lines[1].split(" · ");
      const album = lines[2];
      const artist = (v.snippet.channelTitle || "").replace(/ - Topic$/, "") || artists[0] || "";
      if (!album || /^℗|^©|^Released on/.test(album)) continue;
      const k = norm(album) + "|" + norm(artist);
      const e = albums.get(k) || { k, title: album, artist, count: 0, songs: [], recent: rank };
      e.count++;
      if (e.songs.length < 3) e.songs.push(song);
      albums.set(k, e);
    }
    page = d.nextPageToken || "";
    CHORES.busy = `Reading your likes… ${rank} songs so far`;
    const el = $("#chores-status"); if (el) el.textContent = CHORES.busy;
  } while (page && ++n < 80);
  return { albums: [...albums.values()], liked: rank };
}

function choreItems() {
  const c = S.raw?.meta?.chores;
  if (!c?.items) return [];
  const skipped = new Set(c.skipped || []);
  const owned = new Set(allAlbums().map((a) => norm(a.title) + "|" + norm(a.artist)));
  return c.items.filter((i) => !skipped.has(i.k) && !owned.has(i.k) && !Catalog.isWorship(i));
}

async function refreshChores() {
  CHORES.busy = "Waiting for Google sign-in…";
  render();
  try {
    const token = await Store.youtubeToken();
    if (!token) throw new Error("Google didn't grant access to your YouTube likes.");
    const { albums, liked } = await fetchYouTubeLikes(token);
    const items = albums.sort((a, b) => b.count - a.count || a.recent - b.recent).slice(0, 400);
    const prev = S.raw?.meta?.chores || {};
    await Store.set("meta", "chores", { items, skipped: prev.skipped || [], updatedAt: now(), liked });
    CHORES.busy = "";
    toast(`Read ${liked} liked songs from ${items.length} albums`);
  } catch (e) {
    CHORES.busy = "";
    const msg = /popup-closed|cancelled/.test(e.code || "") ? "Sign-in was closed before it finished." : e.message;
    toast(msg || "Couldn't read your YouTube likes.");
  }
  render();
}

function guessShelfFor(i) {
  const a = norm(i.artist);
  for (const s of S.lib.shelves) if (s.albums.some((x) => norm(x.artist) === a)) return s.id;
  return "";
}

function renderChores() {
  const c = S.raw?.meta?.chores;
  const all = choreItems();
  const items = all.filter((i) => CHORES.singles || i.count > 1);
  const when = c?.updatedAt ? ago(c.updatedAt).toLowerCase() : "";
  view.innerHTML = `
    <h1 class="page-title">Sorting chores</h1>
    <p class="note">Albums you've liked songs from on YouTube Music that aren't on a shelf yet, most-liked first.</p>
    <div class="chores-bar">
      ${Store.canSync() && S.user
        ? `<button class="btn primary" id="chores-refresh" ${CHORES.busy ? "disabled" : ""}>${c ? "Check YouTube Music again" : "Connect YouTube Music"}</button>`
        : `<span class="meta">Sign in to Crate first</span>`}
      <span class="meta" id="chores-status">${esc(CHORES.busy || (c ? `Checked ${when} · ${c.liked} liked songs` : ""))}</span>
      ${c ? `<label class="meta"><input type="checkbox" id="chores-singles" ${CHORES.singles ? "checked" : ""}> Include albums with one liked song</label>` : ""}
    </div>
    ${!c ? `<div class="empty" style="margin-top:20px">Connect YouTube Music to see which albums you've been liking. Crate only reads your likes; it can't change anything in your account.</div>`
      : !items.length ? `<div class="empty" style="margin-top:20px">All caught up. Every album you've liked songs from is on a shelf${all.length ? ", apart from ones with a single liked song" : ""}.</div>`
      : `<div class="inbox-list">${items.slice(0, CHORES.shown).map((i) => `
        <div class="inbox-row" data-k="${esc(i.k)}">
          <a class="ib-cover" href="${esc(Catalog.ytSearchUrl(i))}" target="_blank" rel="noopener" title="Open in YouTube Music">
            ${CHORES.covers.get(i.k) ? `<img src="${esc(CHORES.covers.get(i.k))}" alt="">` : `<span class="mini burned"><span class="disc"></span></span>`}
          </a>
          <div style="min-width:0">
            <div class="t">${esc(i.title)}</div><div class="s">${esc(i.artist)}</div>
            <div class="meta">${i.count} liked ${i.count === 1 ? "song" : "songs"} · ${esc(i.songs.join(", "))}${i.count > i.songs.length ? "…" : ""}</div>
          </div>
          <div class="ib-actions">
            <select aria-label="Shelf for ${esc(i.title)}"><option value="">Pick a shelf…</option>${shelfOptions(guessShelfFor(i))}</select>
            <button class="btn primary" data-chore="add">Shelve</button>
            <button class="btn" data-chore="skip">Skip</button>
          </div>
        </div>`).join("")}</div>
        ${items.length > CHORES.shown ? `<button class="btn" data-chore="more" style="margin-top:16px">Show more</button>` : ""}`}`;
  $("#chores-refresh")?.addEventListener("click", refreshChores);
  const sg = $("#chores-singles");
  if (sg) sg.onchange = () => { CHORES.singles = sg.checked; render(); };
  loadChoreCovers(items.slice(0, CHORES.shown));
}

let coverJob = 0;
async function loadChoreCovers(items) {
  const job = ++coverJob;
  for (const i of items) {
    if (job !== coverJob || S.route.name !== "chores") return;
    if (CHORES.covers.has(i.k)) continue;
    const a = await Catalog.find(i.artist, i.title).catch(() => null);
    CHORES.covers.set(i.k, a?.cover || "");
    if (a) CHORES.found.set(i.k, a);
    if (a?.cover) {
      const img = view.querySelector(`.inbox-row[data-k="${CSS.escape(i.k)}"] .ib-cover`);
      if (img) img.innerHTML = `<img src="${esc(a.cover)}" alt="">`;
    }
  }
}

view.addEventListener("click", async (e) => {
  const b = e.target.closest("[data-chore]");
  if (!b) return;
  if (b.dataset.chore === "more") { CHORES.shown += 40; render(); return; }
  const row = b.closest(".inbox-row");
  const k = row.dataset.k;
  const c = S.raw.meta.chores;
  const item = c.items.find((x) => x.k === k);
  if (!item) return;
  if (b.dataset.chore === "add") {
    const shelfId = row.querySelector("select").value;
    if (!shelfId) { toast("Pick a shelf first."); row.querySelector("select").focus(); return; }
    b.disabled = true; b.textContent = "…";
    // Reuse the match the cover lookup already made; otherwise look it up now.
    coverJob++;
    const found = CHORES.found.get(k) || await Catalog.find(item.artist, item.title).catch(() => null);
    const id = await addAlbum(found ? { ...found } : { title: item.title, artist: item.artist }, shelfId);
    if (id) { row.remove(); addedToast(found?.title || item.title, shelfId, id); }
    else { b.disabled = false; b.textContent = "Shelve"; }
  } else if (b.dataset.chore === "skip") {
    row.remove();
    const skipped = [...new Set([...(c.skipped || []), k])];
    await write(() => Store.update("meta", "chores", { skipped }));
    toast(`Skipped ${item.title}`, { label: "Undo", run: () => write(() => Store.update("meta", "chores", { skipped: skipped.filter((x) => x !== k) })) });
  }
});

// ------------------------------------------------------------------ exact album links, found by YouTube Music itself

// Runs as a bookmark on music.youtube.com, in the person's own browser: it asks
// YouTube Music's site for each album and returns the album pages to Crate.
function crateLinksBookmark() {
  const CRATE = "__CRATE__";
  if (!/(^|\.)music\.youtube\.com$/.test(location.hostname)) { alert("Open music.youtube.com in this tab first, then click the Crate bookmark."); return; }
  let raw = "";
  try { raw = decodeURIComponent((location.hash.match(/crate=([^&]+)/) || [])[1] || ""); } catch (e) {}
  if (!raw) raw = prompt("Paste the album list Crate copied for you (Cmd+V), then press OK:") || "";
  let list;
  try { list = JSON.parse(raw); } catch (e) { alert("That isn't Crate's album list. Go back to Crate and click Start again."); return; }
  const box = document.createElement("div");
  box.style.cssText = "position:fixed;z-index:2147483647;left:50%;top:24px;transform:translateX(-50%);background:#101216;color:#ece8e1;padding:14px 20px;border-radius:10px;font:15px/1.4 system-ui,sans-serif;box-shadow:0 10px 30px rgba(0,0,0,.5)";
  document.body.appendChild(box);
  const say = (t) => { box.textContent = t; };
  const cfg = window.ytcfg;
  if (!cfg || !cfg.get) { alert("YouTube Music hasn't finished loading. Wait a moment and click the bookmark again."); box.remove(); return; }
  const key = cfg.get("INNERTUBE_API_KEY"), context = cfg.get("INNERTUBE_CONTEXT");
  const norm = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/\s*[\(\[][^)\]]*[\)\]]/g, "").replace(/[^a-z0-9]+/g, "");
  const textOf = (t) => (t && t.runs ? t.runs.map((r) => r.text).join("") : "");
  async function albumsFor(query, params) {
    const body = { context, query };
    if (params) body.params = params;
    const r = await fetch("/youtubei/v1/search?prettyPrint=false&key=" + key, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    const d = await r.json();
    const hits = [];
    (function walk(o) {
      if (!o || typeof o !== "object") return;
      const id = o.navigationEndpoint && o.navigationEndpoint.browseEndpoint && o.navigationEndpoint.browseEndpoint.browseId;
      if (id && id.indexOf("MPREb_") === 0) {
        const fc = o.flexColumns && o.flexColumns[0] && o.flexColumns[0].musicResponsiveListItemFlexColumnRenderer;
        hits.push([id, o.text || textOf(o.title) || (fc ? textOf(fc.text) : ""), norm(JSON.stringify(o).slice(0, 4000))]);
      }
      for (const k in o) walk(o[k]);
    })(d);
    return hits;
  }
  const found = {};
  (async () => {
    for (let i = 0; i < list.length; i++) {
      const [id, artist, title] = list[i];
      say("Crate: looking up album " + (i + 1) + " of " + list.length + "…");
      try {
        let hits = await albumsFor(artist + " " + title, "EgWKAQIYAWoMEA4QChADEAQQCRAF");
        if (!hits.length) hits = await albumsFor(artist + " " + title);
        const t = norm(title), a = norm(artist);
        const pick = hits.find((h) => norm(h[1]) === t && h[2].indexOf(a) >= 0) || hits.find((h) => norm(h[1]) === t) ||
          hits.find((h) => h[1] && h[2].indexOf(a) >= 0 && (norm(h[1]).indexOf(t) >= 0 || t.indexOf(norm(h[1])) >= 0));
        if (pick) found[id] = pick[0];
      } catch (e) {}
      await new Promise((r) => setTimeout(r, 300));
    }
    say("Crate: found " + Object.keys(found).length + " of " + list.length + " albums. Taking you back…");
    setTimeout(() => { location.href = CRATE + "#ytlinks=" + encodeURIComponent(JSON.stringify(found)); }, 1500);
  })();
}

function bookmarkHref() {
  const home = location.origin + location.pathname;
  return "javascript:" + encodeURIComponent("(" + crateLinksBookmark.toString().replace("__CRATE__", home) + ")()");
}

function needingLinks() {
  return allAlbums().filter((a) => !a.ytUrl).map((a) => [a.id, a.artist, a.title]);
}

function renderLinks() {
  const todo = needingLinks();
  const total = allAlbums().length;
  view.innerHTML = `
    <h1 class="page-title">Album links</h1>
    <p class="note">${total - todo.length} of ${total} albums open straight to their album page. The rest open a search.
      This finds the album pages for all of them at once, using YouTube Music's own website in your browser.</p>
    <ol class="steps">
      <li><b>Use Chrome on your Mac</b> (or any browser where music.youtube.com opens as a normal tab, not your YT Music app), signed in to Crate.</li>
      <li>Show the bookmarks bar (<b>View → Always Show Bookmarks Bar</b>), then drag this button onto it. You only do this once:
        <p><a class="btn primary bookmarklet" href="${esc(bookmarkHref())}" onclick="event.preventDefault(); return false;">⚙︎ Crate album links</a></p></li>
      <li>Click <b>Start</b>. It copies your album list and opens YouTube Music in a new tab.
        <p><button class="btn primary" id="links-start" ${todo.length ? "" : "disabled"}>Start${todo.length ? ` (${todo.length} albums)` : ""}</button></p></li>
      <li>On the YouTube Music tab, click the <b>Crate album links</b> bookmark. If it asks for the list, press Cmd+V and OK.
        It looks up each album, then brings you back here with the links saved.</li>
    </ol>
    <p class="meta">If an album isn't found, use its ⋯ menu to paste the link by hand.</p>`;
  $("#links-start")?.addEventListener("click", async () => {
    const list = JSON.stringify(needingLinks());
    try { await navigator.clipboard.writeText(list); } catch {}
    window.open("https://music.youtube.com/#crate=" + encodeURIComponent(list), "_blank", "noopener");
  });
}

function receiveYtLinks(encoded) {
  try {
    const got = JSON.parse(decodeURIComponent(encoded));
    const prev = JSON.parse(localStorage.getItem("crate:pendingLinks") || "{}");
    localStorage.setItem("crate:pendingLinks", JSON.stringify({ ...prev, ...got }));
  } catch {}
  history.replaceState(null, "", location.pathname + "#links");
  S.route = { name: "links" };
  applyPendingYtLinks();
  render();
}

let applyingLinks = false;
async function applyPendingYtLinks() {
  if (applyingLinks) return;
  // Wait until the synced library is in place, so links land in the account and not just this browser.
  if (Store.canSync() && Store.mode() !== "cloud") return;
  let pending;
  try { pending = JSON.parse(localStorage.getItem("crate:pendingLinks") || "{}"); } catch { return; }
  const ids = Object.keys(pending).filter((id) => S.raw?.albums?.[id]);
  if (!ids.length) return;
  applyingLinks = true;
  for (const id of ids) {
    await write(() => Store.update("albums", id, { ytUrl: "https://music.youtube.com/browse/" + pending[id] }));
    delete pending[id];
  }
  try { localStorage.setItem("crate:pendingLinks", JSON.stringify(pending)); } catch {}
  applyingLinks = false;
  toast(`Saved ${ids.length} album ${ids.length === 1 ? "link" : "links"}. Those covers now open the album page.`);
}

// ------------------------------------------------------------------ exact YouTube Music links (optional)

let resolving = false;
function resolveLinksSoon() {
  const key = window.CRATE_CONFIG?.youtubeApiKey;
  if (!key || resolving) return;
  // Only the owner's synced copy or this device records results; one lookup at a time, a few per visit.
  const todo = allAlbums().filter((a) => !a.ytUrl && !a.ytTried).slice(0, 5);
  if (!todo.length) return;
  resolving = true;
  (async () => {
    for (const a of todo) {
      try {
        const url = await Catalog.resolveYouTube(a, key);
        await Store.update("albums", a.id, url ? { ytUrl: url } : { ytTried: now() });
      } catch { break; }
    }
    resolving = false;
  })();
}

// ------------------------------------------------------------------ drag and drop

let dragId = null;

view.addEventListener("dragstart", (e) => {
  const card = e.target.closest(".album[draggable]");
  if (!card) return;
  dragId = card.dataset.id;
  card.classList.add("dragging");
  e.dataTransfer.effectAllowed = "move";
  e.dataTransfer.setData("text/plain", dragId);
});
document.addEventListener("dragend", () => {
  dragId = null;
  document.querySelectorAll(".dragging, .drop-before, .drop").forEach((el) => el.classList.remove("dragging", "drop-before", "drop"));
});
view.addEventListener("dragover", (e) => {
  if (!dragId) return;
  const card = e.target.closest("#shelf-grid .album");
  if (!card) return;
  e.preventDefault();
  document.querySelectorAll(".drop-before").forEach((el) => el.classList.remove("drop-before"));
  if (card.dataset.id !== dragId) card.classList.add("drop-before");
});
view.addEventListener("drop", async (e) => {
  const card = e.target.closest("#shelf-grid .album");
  if (!dragId || !card || card.dataset.id === dragId) return;
  e.preventDefault();
  const s = shelfById(S.route.id);
  const id = dragId;
  dragId = null;
  const ids = s.albums.map((a) => a.id).filter((x) => x !== id);
  await moveAlbum(id, s.id, ids.indexOf(card.dataset.id));
});
const rail = $("#shelf-nav");
rail.addEventListener("dragover", (e) => {
  const link = e.target.closest("[data-shelf]");
  if (!dragId || !link) return;
  e.preventDefault();
  rail.querySelectorAll(".drop").forEach((el) => el.classList.remove("drop"));
  link.classList.add("drop");
});
rail.addEventListener("dragleave", (e) => e.target.closest("[data-shelf]")?.classList.remove("drop"));
rail.addEventListener("drop", async (e) => {
  const link = e.target.closest("[data-shelf]");
  if (!dragId || !link) return;
  e.preventDefault();
  const id = dragId, to = link.dataset.shelf;
  dragId = null;
  if (to === S.route.id) return;
  if (await moveAlbum(id, to, 0)) toast(`Moved to ${shelfById(to).name}`);
});

// ------------------------------------------------------------------ boot

window.addEventListener("hashchange", route);
$("#top-search").innerHTML = liveBox({ placeholder: "Search any album or artist to add" });
Store.onAuth((user) => { S.user = user; renderAccount(); });
renderAccount();
Store.start(onData, { toast }).then(route);
