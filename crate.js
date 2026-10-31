"use strict";
// Crate 20261031155653. Built from config.js, catalog.js, store.js, app.js, crates.js, history.js, landing.js, vault.js by bump.py; edit those files, not this one.

// ===== config.js =====
// Firebase web config is public by design; access is controlled by firestore.rules.
// The YouTube key (optional) should be restricted to this site in Google Cloud.
window.CRATE_CONFIG = {
  firebase: {
    apiKey: "AIzaSyBxFZkKExomBIjTy85SAUBu5TOPwh4Na1k",
    authDomain: "crate-feca1.firebaseapp.com",
    projectId: "crate-feca1",
    storageBucket: "crate-feca1.firebasestorage.app",
    messagingSenderId: "659698829538",
    appId: "1:659698829538:web:18033114f6f914477d76bb",
  },
  youtubeApiKey: "",
};

// ===== catalog.js =====
// Catalog lookups, live from the browser.
// Deezer's public API (no key) supplies album search, covers, discographies and
// related artists. Deezer sends no CORS headers, so calls go through JSONP.
"use strict";

const Catalog = (() => {
  const TTL = 7 * 24 * 3600 * 1000;
  const GAP = 120; // ms between calls; Deezer allows 50 per 5 seconds
  let seq = 0, last = 0, chain = Promise.resolve();

  const cacheGet = (k, ttl = TTL) => {
    try {
      const v = JSON.parse(localStorage.getItem("dz:" + k));
      return v && Date.now() - v.t < ttl ? v.d : null;
    } catch { return null; }
  };
  const cachePut = (k, d) => {
    try { localStorage.setItem("dz:" + k, JSON.stringify({ t: Date.now(), d })); }
    catch { try { for (const key of Object.keys(localStorage)) if (key.startsWith("dz:")) localStorage.removeItem(key); } catch {} }
  };

  function jsonp(path, params = {}) {
    return new Promise((resolve, reject) => {
      const cb = `__dz${++seq}`;
      const s = document.createElement("script");
      const done = () => { clearTimeout(timer); delete window[cb]; s.remove(); };
      const timer = setTimeout(() => { done(); reject(new Error("The music catalog took too long to answer.")); }, 12000);
      window[cb] = (d) => { done(); resolve(d); };
      s.onerror = () => { done(); reject(new Error("Couldn't reach the music catalog.")); };
      s.src = `https://api.deezer.com${path}?${new URLSearchParams({ ...params, output: "jsonp", callback: cb })}`;
      document.head.append(s);
    });
  }

  // Serialize calls with a small gap, retrying when Deezer says we're too fast.
  function call(path, params = {}, { cache = true, ttl } = {}) {
    const key = path + "?" + new URLSearchParams(params);
    const hit = cache && cacheGet(key, ttl);
    if (hit) return Promise.resolve(hit);
    const run = async () => {
      for (let attempt = 0; attempt < 3; attempt++) {
        const wait = last + GAP - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        last = Date.now();
        const d = await jsonp(path, params);
        if (d?.error?.code === 4) { await new Promise((r) => setTimeout(r, 1500 * (attempt + 1))); continue; }
        if (d?.error) return null;
        if (cache) cachePut(key, d);
        return d;
      }
      return null;
    };
    const p = chain.then(run, run);
    chain = p.catch(() => {});
    return p;
  }

  // Fold accents so "jose gonzalez" matches "José González".
  const fold = (s) => String(s || "").normalize("NFD").replace(/[\u0300-\u036f]/g, "");
  const norm = (s) => fold(s).toLowerCase()
    .replace(/\s*[\(\[][^)\]]*(deluxe|edition|remaster|anniversary|expanded|bonus|explicit|reissue|version)[^)\]]*[\)\]]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  const clean = (t) => String(t || "").replace(/\s*[\(\[][^)\]]*(deluxe|edition|remaster|anniversary|expanded|bonus|explicit|reissue)[^)\]]*[\)\]]/gi, "").trim() || t;
  const SKIP = /\b(live|acoustic|instrumental|karaoke|commentary|tribute|greatest|hitz|best of|collection|essential|anthology|playlist|addendum|play your old stuff|workout|favou?rites?|favs|deep cuts|sessions?|remix(es|ed)?|reimagined|re-?recorded|redux|covers|singles|demos?|rarities|b-sides|unplugged|anniversary)\b|\b\d\.0\b|\bvol(ume)?\.? ?\d/i;

  function album(a, artist) {
    artist = artist || a.artist || {};
    const y = (a.release_date || "").slice(0, 4);
    return {
      deezerId: a.id, title: clean(a.title), artist: artist.name || "", artistId: artist.id ?? null,
      year: /^\d{4}$/.test(y) ? Number(y) : null, released: a.release_date || "", cover: a.cover_big || a.cover_medium || "",
      type: a.record_type || "album", fans: a.fans || 0,
    };
  }

  // ---------------------------------------------------------------- fuzzy matching

  function bigrams(s) {
    const out = new Map();
    for (let i = 0; i < s.length - 1; i++) { const g = s.slice(i, i + 2); out.set(g, (out.get(g) || 0) + 1); }
    return out;
  }
  /** 0..1 likeness of two names, ignoring case, accents and punctuation. */
  function sim(a, b) {
    a = norm(a); b = norm(b);
    if (!a || !b) return 0;
    if (a === b) return 1;
    if (a.length > 3 && b.length > 3 && (a.includes(b) || b.includes(a))) return 0.9;
    const A = bigrams(a), B = bigrams(b);
    let both = 0;
    for (const [g, n] of A) both += Math.min(n, B.get(g) || 0);
    return (2 * both) / (Math.max(1, a.length - 1) + Math.max(1, b.length - 1));
  }
  const words = (s) => fold(s).toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
  /** Share of the typed words found in the candidate, allowing small typos. */
  function coverage(q, a) {
    const qw = words(q), cw = words(`${a.artist} ${a.title} ${a.viaTrack || ""}`);
    if (!qw.length) return 0;
    let hit = 0;
    for (const w of qw) if (cw.some((c) => c === w || (w.length > 3 && (c.startsWith(w) || sim(c, w) >= 0.8)))) hit++;
    return hit / qw.length;
  }
  function splitTyped(q) {
    const m = q.match(/^(.+?)\s+[-–—]\s+(.+)$/);
    return m ? { artist: m[1].trim(), title: m[2].trim() } : null;
  }

  // ---------------------------------------------------------------- search sources

  const itunesSeen = new Map();
  async function itunes(term, limit = 15) {
    if (itunesSeen.has(term)) return itunesSeen.get(term);
    const p = new URLSearchParams({ term, entity: "album", limit: String(limit), country: "US" });
    const res = await fetch("https://itunes.apple.com/search?" + p).catch(() => null);
    const d = res?.ok ? await res.json().catch(() => null) : null;
    const out = (d?.results || [])
      .filter((r) => r.collectionName && !(/ - Single$/.test(r.collectionName) && (r.trackCount || 0) < 4))
      .map((r) => ({
        itunesId: r.collectionId, deezerId: null, artistId: null,
        title: clean(r.collectionName.replace(/ - (Single|EP)$/, "")), artist: r.artistName,
        year: Number(String(r.releaseDate || "").slice(0, 4)) || null,
        cover: String(r.artworkUrl100 || "").replace("100x100bb", "600x600bb"), type: "album", fans: 0,
      }));
    itunesSeen.set(term, out);
    return out;
  }

  async function deezerAlbums(q) {
    const d = await call("/search/album", { q, limit: 40 }, { cache: false });
    return (d?.data || []).filter((a) => !(a.record_type === "single" && (a.nb_tracks || 1) < 4)).map((a) => album(a));
  }

  // Songs whose names match: offer the album each one is on.
  async function deezerTrackAlbums(q) {
    const d = await call("/search", { q, limit: 15 }, { cache: false });
    return (d?.data || []).filter((t) => t.album).map((t) => ({
      deezerId: t.album.id, title: clean(t.album.title), artist: t.artist?.name || "", artistId: t.artist?.id ?? null,
      year: null, cover: t.album.cover_big || t.album.cover_medium || "", type: "album", fans: 0, viaTrack: t.title,
    }));
  }

  // "Artist - Album": find the artist, then look through their albums.
  async function byArtist(artistText, titleText) {
    const d = await call("/search/artist", { q: artistText, limit: 5 });
    const best = (d?.data || []).map((a) => [sim(a.name, artistText), a]).sort((x, y) => y[0] - x[0])[0];
    if (!best || best[0] < 0.75) return [];
    const albums = await artistAlbums(best[1].id);
    return titleText ? albums.filter((a) => sim(a.title, titleText) >= 0.5 || coverage(titleText, { ...a, artist: "" }) >= 0.6) : albums;
  }

  async function search(q, limit = 20) {
    const typed = splitTyped(q);
    const plain = fold(q).replace(/\s+[-–—]\s+/g, " ").replace(/(\w)-(\w)/g, "$1 $2").trim();
    const jobs = [deezerAlbums(plain), deezerTrackAlbums(plain)];
    if (typed) jobs.push(byArtist(typed.artist, typed.title));
    let pool = (await Promise.all(jobs.map((j) => j.catch(() => [])))).flat();
    const score = (a) => coverage(q, a) + (typed ? (sim(a.artist, typed.artist) + sim(a.title, typed.title)) / 4 : 0) - (a.viaTrack ? 0.05 : 0);
    // Apple's catalog is more forgiving with spelling; ask it when Deezer has nothing convincing.
    if (!pool.some((a) => coverage(q, a) >= 0.99)) pool = pool.concat(await itunes(plain).catch(() => []));
    const ranked = pool.map((a) => [score(a), a]).filter(([s]) => s >= 0.5).sort((x, y) => y[0] - x[0]);
    const seen = new Map(), out = [];
    for (const [, a] of ranked) {
      const k = norm(a.title) + "|" + norm(a.artist);
      const prev = seen.get(k);
      if (prev) { if (!prev.deezerId && a.deezerId) Object.assign(prev, { deezerId: a.deezerId, artistId: a.artistId }); continue; }
      const item = { ...a };
      seen.set(k, item);
      out.push(item);
      if (out.length >= limit) break;
    }
    return out;
  }

  /** Best single match for an artist and album name, for adding a whole list at once. */
  async function find(artist, title) {
    const results = await search(`${artist} - ${title}`, 12);
    let best = null, bestScore = 0;
    for (const a of results) {
      const as = sim(a.artist, artist);
      const ts = Math.max(sim(a.title, title), a.viaTrack ? sim(a.viaTrack, title) * 0.95 : 0);
      if (as < 0.7 || ts < 0.7) continue;
      const s = as + ts + (a.viaTrack ? 0 : 0.1);
      if (s > bestScore) { best = a; bestScore = s; }
    }
    return best;
  }

  /** Fill in catalog ids for an album found only on Apple, so suggestions work for it. */
  async function toDeezer(a) {
    const albums = await byArtist(a.artist, "").catch(() => []);
    const match = albums.map((x) => [sim(x.title, a.title), x]).sort((x, y) => y[0] - x[0])[0];
    if (match && match[0] >= 0.8) return { ...match[1], cover: match[1].cover || a.cover };
    const d = await call("/search/artist", { q: a.artist, limit: 3 });
    const art = (d?.data || []).find((x) => sim(x.name, a.artist) >= 0.85);
    return art ? { ...a, artistId: art.id } : a;
  }

  async function detail(id) {
    const a = await call(`/album/${id}`);
    return a ? album(a) : null;
  }

  // Discographies are re-checked daily so new releases show up quickly.
  async function artistAlbums(artistId, { name, types = ["album"] } = {}) {
    const [d, artist] = await Promise.all([
      call(`/artist/${artistId}/albums`, { limit: 100 }, { ttl: 24 * 3600 * 1000 }),
      name ? { id: artistId, name } : call(`/artist/${artistId}`),
    ]);
    const seen = new Set(), out = [];
    for (const a of d?.data || []) {
      if (!types.includes(a.record_type) || SKIP.test(a.title)) continue;
      const k = norm(a.title);
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(album(a, artist || { id: artistId }));
    }
    return out;
  }

  async function related(artistId) {
    const d = await call(`/artist/${artistId}/related`, { limit: 10 });
    return d?.data || [];
  }

  function rng(seed) {
    let h = 2166136261;
    for (const c of String(seed)) h = Math.imul(h ^ c.charCodeAt(0), 16777619);
    return () => { h += 0x6d2b79f5; let t = h; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
  }
  function shuffle(arr, r) {
    const a = [...arr];
    for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; }
    return a;
  }

  /** Deeper cuts from the shelf's artists plus well-known albums by related bands. */
  // ---------------------------------------------------------------- one album, many editions

  const EDITION = "deluxe|remaster(ed)?|expanded|special|anniversary|bonus|explicit|clean|reissue|edition|version|collector'?s|super|platinum|complete|legacy|tour";
  /** "Take Care - Deluxe" and "Take Care (Remastered 2011)" are both "Take Care". */
  function baseTitle(t) {
    let s = String(t || "");
    for (let i = 0; i < 3; i++) {
      s = s.replace(new RegExp(`\\s*[\\(\\[][^)\\]]*\\b(${EDITION})\\b[^)\\]]*[\\)\\]]\\s*$`, "i"), "")
           .replace(new RegExp(`\\s+[-–—:]\\s+[^-–—:]*\\b(${EDITION})\\b[^-–—:]*$`, "i"), "");
    }
    return s.trim() || String(t || "");
  }
  const albumKey = (title, artist) => norm(baseTitle(title)) + "|" + norm(artist);

  // ---------------------------------------------------------------- worship filter
  // Deliberately narrow: explicit worship/praise acts and titles, not "Christian" in general,
  // so bands from that scene (Underoath, mewithoutYou, P.O.D., Switchfoot...) stay in.

  const WORSHIP_ARTISTS = new Set([
    "hillsong", "hillsongunited", "hillsongworship", "hillsongyoungfree", "bethelmusic", "elevationworship", "jesusculture", "passion",
    "maverickcity", "maverickcitymusic", "christomlin", "philwickham", "karijobe", "shaneshane", "shaneandshane", "davidcrowderband",
    "crowder", "allsonsdaughters", "housefires", "verticalworship", "upperroom", "planetshakers", "mattredman", "michaelwsmith",
    "brandonlake", "coryasbury", "redrocksworship", "gatewayworship", "worshipcentral", "rendcollective", "sovereigngracemusic",
    "keithkristyngetty", "citizenssaints", "leeland", "kimwalkersmith", "steffanygretzinger", "amandacook", "darlenezschech",
    "israelhoughton", "tashacobbs", "traviscottrell", "thebelongingco", "castingcrowns", "mercyme", "lincolnbrewster",
    "paulbaloche", "timhughes", "charliehall", "mattmaher", "jeremyriddle", "newlifeworship", "northpointworship", "chrisquilala",
    "forkingcountry", "laurendaigle", "tobymac", "thirdday", "tenthavenuenorth", "jeremycamp", "zachwilliams", "dannygokey",
    "kutless", "sanctusreal", "audreyassad", "gungor", "starfield", "desperationband",
    "shanebarnard", "davidcrowder", "craigdeanphillips", "darrellevans", "eoghanheaslip", "delirious", "toddagnew",
    "aaronshust", "brentonbrown", "davidruis", "jeffdeyo", "kristianstanfill", "drawmeclosetoyou", "vineyardworship",
    "sonicflood", "jasonupton", "reubenmorgan", "jamismith", "christforthenationsmusic", "briandoerksen", "kevinprosch",
    "carltuttle", "kathrynscott", "tommywalker", "mariebarnett", "terrybutler", "craigmusseau", "kellycarpenter", "andypark",
    "hillsonglive", "enterworshipcircle", "pinecoveworship", "integritys hosanna music".replace(/ /g, ""), "maranathamusic", "wowworship",
  ]);
  // Title words only where they almost always mean worship ("Rhythm & Hymns" by Mattafix is trip-hop).
  const WORSHIP_TITLE = /\b(worship\w*|praise and worship|praise & worship)\b/i;

  const worshipName = (s) => { const n = norm(s); return WORSHIP_ARTISTS.has(n) || /worship|hillsong|bethelmusic|wowhits|vineyard/.test(n); };

  function isWorship(a) {
    // Old libraries sometimes have artist and album swapped, so both are checked as names.
    return worshipName(a.artist) || worshipName(a.title) || WORSHIP_TITLE.test(a.title || "") ||
      /\bsermons?\b/i.test(a.title || "") || /worship|praise/i.test(a.genre || "");
  }

  /** Names of bands Deezer lists as related to this shelf's artists (normalized). */
  async function relatedNames(shelfAlbums, max = 6) {
    const ids = [...new Set(shelfAlbums.map((a) => a.artistId).filter(Boolean))].slice(0, max);
    const out = new Set();
    for (const id of ids) for (const x of (await related(id).catch(() => [])).slice(0, 10)) out.add(norm(x.name));
    return out;
  }

  /** Deezer's artist for a name, when the match is close. */
  async function findArtist(name) {
    const d = await call("/search/artist", { q: name, limit: 3 });
    const best = (d?.data || []).map((a) => [sim(a.name, name), a]).sort((x, y) => y[0] - x[0])[0];
    return best && best[0] >= 0.85 ? { id: best[1].id, name: best[1].name } : null;
  }

  async function suggest(shelfAlbums, { n = 8, seed = "0", owned = () => false, libraryArtists = new Set(), favorites = new Map(), favoriteLabel = new Map() } = {}) {
    const r = rng(seed);
    const artists = new Map();
    for (const a of shelfAlbums) if (a.artistId) artists.set(a.artistId, a.artist);
    if (!artists.size) return [];
    const seeds = shuffle([...artists], r).slice(0, 4);

    const deep = [], rel = [];
    for (const [id, name] of seeds) {
      for (const a of await artistAlbums(id)) if (!owned(a) && !isWorship(a)) deep.push({ ...a, reason: `More ${name}` });
      for (const x of (await related(id)).slice(0, 6)) if (!libraryArtists.has(x.id)) rel.push([x, name]);
    }
    // Bands you played a lot in your old library come first, most-played first.
    const favPlays = ([x]) => favorites.get(norm(x.name)) || 0;
    const ordered = [
      ...shuffle(rel.filter((t) => favPlays(t)), r).sort((a, b) => favPlays(b) - favPlays(a)),
      ...shuffle(rel.filter((t) => !favPlays(t)), r),
    ];
    const picked = [], seenArtists = new Set();
    for (const [x, name] of ordered) {
      if (seenArtists.has(x.id)) continue;
      seenArtists.add(x.id);
      picked.push([x, name]);
      if (picked.length >= n) break;
    }
    const similar = [];
    for (const [x, name] of picked) {
      const albums = (await artistAlbums(x.id)).filter((a) => !owned(a)).sort((a, b) => b.fans - a.fans);
      const plays = favorites.get(norm(x.name));
      const pool = albums.filter((a) => !isWorship(a));
      if (pool.length) similar.push({ ...pool[Math.floor(r() * Math.min(2, pool.length))], reason: plays ? favoriteLabel.get(norm(x.name)) || `If you like ${name}` : `If you like ${name}` });
    }
    const d = shuffle(deep, r);
    const nDeep = Math.min(d.length, Math.max(2, Math.floor(n / 3)));
    let out = [...d.slice(0, nDeep), ...similar.slice(0, n - nDeep)];
    if (out.length < n) out = out.concat(d.slice(nDeep, nDeep + n - out.length));
    return shuffle(out, r);
  }

  // ---------------------------------------------------------------- new releases

  /** Albums and EPs from these artists released on or after `since` (YYYY-MM-DD), newest first. */
  async function newFrom(artists, since) {
    const out = [];
    for (const [id, name] of artists) {
      for (const a of await artistAlbums(id, { name, types: ["album", "ep"] }).catch(() => [])) {
        if (a.released >= since && !isWorship(a)) out.push(a);
      }
    }
    return out.sort((a, b) => b.released.localeCompare(a.released));
  }

  /**
   * Recent albums by bands related to the library but not in it. Bands related to
   * several of your artists rank first, then the ones with the biggest followings.
   */
  async function newNearby(artists, since, { limitArtists = 45 } = {}) {
    const near = new Map(); // id -> { name, fans, because: [names] }
    for (const [id, name] of artists) {
      for (const x of (await related(id).catch(() => [])).slice(0, 10)) {
        if (artists.has(x.id)) continue;
        const e = near.get(x.id) || { name: x.name, fans: x.nb_fan || 0, because: [] };
        if (!e.because.includes(name)) e.because.push(name);
        near.set(x.id, e);
      }
    }
    const top = [...near].sort((a, b) => b[1].because.length - a[1].because.length || b[1].fans - a[1].fans).slice(0, limitArtists);
    const out = [];
    for (const [id, e] of top) {
      // One release per band, its newest, so a busy band can't fill the page.
      const fresh = (await artistAlbums(id, { name: e.name }).catch(() => [])).filter((a) => a.released >= since && !isWorship(a))
        .sort((a, b) => b.released.localeCompare(a.released));
      if (fresh.length) out.push({ ...fresh[0], because: e.because, weight: e.because.length });
    }
    return out.sort((a, b) => b.weight - a.weight || b.fans - a.fans);
  }

  // ---------------------------------------------------------------- YouTube Music links

  const ytSearchUrl = (a) => "https://music.youtube.com/search?q=" + encodeURIComponent(`${a.artist} ${a.title}`);

  /** Exact album page through the YouTube Data API, when a key is configured. */
  async function resolveYouTube(a, key) {
    if (!key) return null;
    const p = new URLSearchParams({ part: "snippet", type: "playlist", maxResults: "8", q: `${a.artist} ${a.title} album`, key });
    const res = await fetch("https://www.googleapis.com/youtube/v3/search?" + p);
    if (!res.ok) throw new Error(`YouTube lookup failed (${res.status})`);
    const d = await res.json();
    const want = norm(a.title);
    for (const it of d.items || []) {
      const id = it.id?.playlistId || "";
      // Album playlists on YouTube Music have OLAK5uy_ ids.
      if (id.startsWith("OLAK5uy_") && norm(it.snippet?.title).includes(want)) return `https://music.youtube.com/playlist?list=${id}`;
    }
    return "";
  }

  return { search, find, toDeezer, sim, detail, newFrom, newNearby, isWorship, relatedNames, findArtist, baseTitle, albumKey, artistAlbums, related, suggest, norm, ytSearchUrl, resolveYouTube, rng, shuffle };
})();

// ===== store.js =====
// Where the library lives.
// Without sign-in, everything is saved in this browser. With Firebase configured
// (config.js) and the person signed in with Google, it syncs through Firestore
// under users/<uid>/ so the Mac, iPhone and PC all see the same shelves.
"use strict";

const Store = (() => {
  const COLS = ["shelves", "albums", "images", "meta"];
  const LOCAL_KEY = "crate:library";
  let state = { shelves: {}, albums: {}, images: {}, meta: {} };
  let listener = () => {};
  let mode = "local"; // local | cloud
  let fs = null, uid = null, unsubs = [];
  const authListeners = [];

  const emit = () => listener(state);

  // ---------------------------------------------------------------- local

  function loadLocal() {
    try { return JSON.parse(localStorage.getItem(LOCAL_KEY)); } catch { return null; }
  }
  function saveLocal() {
    try { localStorage.setItem(LOCAL_KEY, JSON.stringify(state)); }
    catch { toastFn?.("This browser is out of room to save your library. Sign in to sync instead."); }
  }

  async function startLocal() {
    mode = "local";
    const saved = loadLocal();
    if (saved?.shelves) state = { shelves: {}, albums: {}, images: {}, meta: {}, ...saved };
    else {
      const seed = await fetch("seed.json").then((r) => r.json()).catch(() => ({}));
      state = { shelves: seed.shelves || {}, albums: seed.albums || {}, images: {}, meta: {} };
      saveLocal();
    }
    emit();
  }

  // ---------------------------------------------------------------- cloud

  const loadScript = (src) => new Promise((res, rej) => {
    const s = document.createElement("script");
    s.src = src; s.onload = res; s.onerror = () => rej(new Error("Couldn't load sign-in. Check your connection."));
    document.head.append(s);
  });

  async function loadFirebase(config) {
    if (window.firebase?.apps?.length) return;
    const v = "10.12.2";
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await Promise.all([
      loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`),
      loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`),
    ]);
    firebase.initializeApp(config);
    fs = firebase.firestore();
  }

  async function initFirebase(config) {
    const v = "10.12.2";
    await loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-app-compat.js`);
    await Promise.all([
      loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-auth-compat.js`),
      loadScript(`https://www.gstatic.com/firebasejs/${v}/firebase-firestore-compat.js`),
    ]);
    firebase.initializeApp(config);
    fs = firebase.firestore();
    firebase.auth().getRedirectResult().catch(() => {});
    firebase.auth().onAuthStateChanged(async (user) => {
      if (user) await startCloud(user);
      else if (mode === "cloud") { stopCloud(); await startLocal(); }
      authListeners.forEach((f) => f(user));
    });
  }

  const userCol = (c) => fs.collection("users").doc(uid).collection(c);

  async function startCloud(user) {
    uid = user.uid;
    // First sign-in: carry this device's library up to the account.
    const existing = await userCol("shelves").limit(1).get();
    if (existing.empty) {
      const local = Object.keys(state.shelves).length ? state : (loadLocal() || state);
      const writes = [];
      for (const c of COLS) for (const [id, d] of Object.entries(local[c] || {})) writes.push([c, id, d]);
      for (let i = 0; i < writes.length; i += 400) {
        const batch = fs.batch();
        for (const [c, id, d] of writes.slice(i, i + 400)) batch.set(userCol(c).doc(id), d);
        await batch.commit();
      }
    }
    mode = "cloud";
    state = { shelves: {}, albums: {}, images: {}, meta: {} };
    unsubs = COLS.map((c) => userCol(c).onSnapshot((snap) => {
      const next = {};
      snap.forEach((d) => { next[d.id] = d.data(); });
      state = { ...state, [c]: next };
      emit();
    }, (e) => toastFn?.("Lost the connection to your synced library. Reload the page to reconnect.")));
  }

  function stopCloud() {
    unsubs.forEach((u) => u());
    unsubs = []; uid = null;
  }

  // ---------------------------------------------------------------- writes

  async function set(c, id, data) {
    if (mode === "cloud") return userCol(c).doc(id).set(data);
    state = { ...state, [c]: { ...state[c], [id]: data } }; saveLocal(); emit();
  }
  async function update(c, id, patch) {
    if (mode === "cloud") return userCol(c).doc(id).update(patch);
    if (!state[c][id]) return;
    state = { ...state, [c]: { ...state[c], [id]: { ...state[c][id], ...patch } } }; saveLocal(); emit();
  }
  async function remove(c, id) {
    if (mode === "cloud") return userCol(c).doc(id).delete();
    const next = { ...state[c] }; delete next[id];
    state = { ...state, [c]: next }; saveLocal(); emit();
  }

  let toastFn = null;

  return {
    // ---------------------------------------------------------------- shared, read-only copies
    // shares/<id> holds a snapshot of the owner's crates (and shares/<id>/images their uploaded
    // covers). Anyone with the link can read it; only the owner can change it (firestore.rules).

    /** For a visitor: show a shared copy, live, without signing in. */
    async startShared(shareId, onChange) {
      listener = onChange;
      mode = "shared";
      await loadFirebase(window.CRATE_CONFIG.firebase);
      const ref = fs.collection("shares").doc(shareId);
      let doc = null, imgs = {};
      const push = () => {
        if (!doc) return;
        const images = {};
        for (const [id, c] of Object.entries(doc.covers || {})) images[id] = c.uploaded ? { ...c, data: imgs[id]?.data || "" } : c;
        state = { shelves: doc.shelves || {}, albums: doc.albums || {}, images, meta: { share: { by: doc.by || "", updatedAt: doc.updatedAt } } };
        emit();
      };
      await new Promise((resolve, reject) => {
        ref.onSnapshot((snap) => {
          if (!snap.exists) { reject(new Error("This shared link doesn't exist any more.")); return; }
          doc = snap.data(); push(); resolve();
        }, reject);
        ref.collection("images").onSnapshot((snap) => { imgs = {}; snap.forEach((d) => { imgs[d.id] = d.data(); }); push(); }, () => {});
      });
    },

    /** For the owner: write (or refresh) the shared copy. */
    async publishShare(shareId, snapshot, changedImages = {}, removedImageIds = []) {
      if (mode !== "cloud") throw new Error("Sign in to Crate to share your crates.");
      const ref = fs.collection("shares").doc(shareId);
      await ref.set({ ...snapshot, owner: uid, updatedAt: Math.floor(Date.now() / 1000) });
      for (const [id, data] of Object.entries(changedImages)) await ref.collection("images").doc(id).set(data);
      for (const id of removedImageIds) await ref.collection("images").doc(id).delete();
    },

    async unpublishShare(shareId, imageIds = []) {
      if (mode !== "cloud") return;
      const ref = fs.collection("shares").doc(shareId);
      for (const id of imageIds) await ref.collection("images").doc(id).delete().catch(() => {});
      await ref.delete();
    },

    displayName: () => (window.firebase?.auth?.().currentUser?.displayName || ""),

    async start(onChange, { toast } = {}) {
      listener = onChange; toastFn = toast;
      await startLocal();
      const cfg = window.CRATE_CONFIG?.firebase;
      if (cfg?.apiKey) initFirebase(cfg).catch((e) => toast?.(e.message));
      else authListeners.forEach((f) => f(null));
    },
    onAuth(f) { authListeners.push(f); },
    canSync: () => !!window.CRATE_CONFIG?.firebase?.apiKey,
    async signIn() {
      const provider = new firebase.auth.GoogleAuthProvider();
      try { await firebase.auth().signInWithPopup(provider); }
      catch (e) {
        if (/popup/.test(e.code || "")) return firebase.auth().signInWithRedirect(provider);
        throw e;
      }
    },
    signOut: () => firebase.auth().signOut(),
    /**
     * A short-lived, read-only YouTube token. Uses a separate sign-in so the person can
     * pick whichever Google account their YouTube Music is on, without changing who is
     * signed in to Crate.
     */
    async youtubeToken({ write = false } = {}) {
      const app = firebase.apps.find((a) => a.name === "youtube") || firebase.initializeApp(window.CRATE_CONFIG.firebase, "youtube");
      const provider = new firebase.auth.GoogleAuthProvider();
      // Reading likes needs read-only access; building playlists needs permission to manage them.
      provider.addScope(write ? "https://www.googleapis.com/auth/youtube" : "https://www.googleapis.com/auth/youtube.readonly");
      provider.setCustomParameters({ prompt: "select_account" });
      const res = await app.auth().signInWithPopup(provider);
      const token = res.credential?.accessToken;
      app.auth().signOut().catch(() => {});
      return token;
    },
    mode: () => mode,

    // ---------------------------------------------------------------- old library archive
    // Kept under users/<uid>/vault, outside the live listeners, and read only on request.
    // Large lists are split into documents under Firestore's 1 MB limit.

    canArchive: () => mode === "cloud" && !!uid,

    async saveVault(docs, onProgress, collection = "vault") {
      if (mode !== "cloud") throw new Error("Sign in to Crate first so the archive is saved to your account.");
      const col = userCol(collection);
      const old = await col.get();
      const keep = new Set(Object.keys(docs));
      let i = 0;
      for (const [id, data] of Object.entries(docs)) {
        await col.doc(id).set(data);
        onProgress?.(++i, keep.size);
      }
      for (const d of old.docs) if (!keep.has(d.id)) await d.ref.delete();
    },

    /** One document from an archive collection, or null. */
    async getVaultDoc(collection, id, { fromServer = false } = {}) {
      if (mode !== "cloud") return null;
      const snap = await userCol(collection).doc(id).get(fromServer ? { source: "server" } : undefined);
      return snap.exists ? snap.data() : null;
    },

    /** Reads the archive back from the server (not this device's cache). */
    async loadVault({ fromServer = false, collection = "vault" } = {}) {
      if (mode !== "cloud") return null;
      const snap = await userCol(collection).get(fromServer ? { source: "server" } : undefined);
      const out = {};
      snap.forEach((d) => { out[d.id] = d.data(); });
      return out;
    },
    set, update, remove,
  };
})();

// ===== app.js =====
"use strict";

// Set by bump.py to match index.html. A browser that kept an old copy of the page would
// run new code against old markup (missing scripts), so it refreshes itself once instead.
const APP_BUILD = "20261031155653";
(function selfHeal() {
  if (!window.CRATE_VERSION || window.CRATE_VERSION === APP_BUILD || APP_BUILD === "dev") return;
  let tried = false;
  try { tried = sessionStorage.getItem("crate:healed") === APP_BUILD; sessionStorage.setItem("crate:healed", APP_BUILD); } catch {}
  if (tried) return;
  Promise.all(["./", "index.html"].map((f) => fetch(f, { cache: "reload" }).catch(() => {}))).then(() => location.reload());
  throw new Error("Crate is updating. Reloading…");
})();

// If anything fails, say so (with details to copy) instead of leaving a blank page.
function showCrash(err) {
  const msg = String(err?.message || err || "Something went wrong.");
  if (/Crate is updating/.test(msg) || document.getElementById("crash")) return;
  const where = String(err?.stack || "").split("\n").find((l) => /\.js/.test(l)) || "";
  const details = `${msg}\n${where.trim()}\nVersion ${window.CRATE_VERSION || "?"} · ${navigator.userAgent}`;
  const clean = (s) => s.replace(/[<>&]/g, "");
  document.body.insertAdjacentHTML("beforeend", `<div id="crash" class="toast" role="alert" style="top:16px;bottom:auto;flex-wrap:wrap;max-width:min(640px,calc(100vw - 32px))">
    <span>Crate hit a problem: ${clean(msg)}</span><button id="crash-copy">Copy details</button><button id="crash-reload">Reload</button></div>`);
  document.getElementById("crash-reload").onclick = () => (typeof hardRefresh === "function" ? hardRefresh() : location.reload());
  document.getElementById("crash-copy").onclick = () => navigator.clipboard?.writeText(details).then(() => { document.getElementById("crash-copy").textContent = "Copied"; }, () => prompt("Copy these details:", details));
}
window.addEventListener("error", (e) => showCrash(e.error || e.message));
window.addEventListener("unhandledrejection", (e) => showCrash(e.reason));

const PALETTE = ["#8a4bd6", "#2f7fd1", "#d46a1f", "#23a07a", "#c8344a", "#c99a1c", "#3a9fb0", "#b8487f", "#5d6b7a", "#6aa121"];

const S = {
  raw: null,
  lib: { shelves: [] },
  route: { name: "home" },
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
  S.copies = new Map(); // album key -> shelf ids it's on, so an album can live on several shelves
  for (const [id, a] of Object.entries(raw.albums)) {
    const k = Catalog.albumKey(a.title, a.artist);
    S.copies.set(k, [...(S.copies.get(k) || []), a.shelfId]);
  }
  S.lib = {
    shelves: shelves.map((s, i) => ({
      ...s, note: s.note || "", color: s.color || PALETTE[i % PALETTE.length],
      image: raw.images[s.id]?.data || "",
      cover: raw.images[s.id] || null,
      albums: (byShelf[s.id] || []).sort((a, b) => a.pos - b.pos),
    })),
  };
}

const liveOpen = () => [...document.querySelectorAll("form.live .live-list")].some((l) => !l.hidden);

function onData(raw) {
  try { applyData(raw); } catch (e) { showCrash(e); }
}

function applyData(raw) {
  S.raw = raw;
  rebuild();
  syncShare();
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
  const same = (x) => (a.deezerId && x.deezerId === a.deezerId) || Catalog.albumKey(x.title, x.artist) === Catalog.albumKey(a.title, a.artist);
  // An album can sit on several shelves, but only once per shelf.
  if (s.albums.some(same)) { toast(`${a.title} is already in ${s.name}.`); return null; }
  const other = allAlbums().find(same); // reuse what another copy already knows (cover, album link)
  const body = {
    shelfId, pos: posAt(s.albums, 0), title: other?.title || a.title, artist: other?.artist || a.artist, artistId: a.artistId ?? other?.artistId ?? null,
    year: a.year ?? other?.year ?? null, deezerId: a.deezerId ?? other?.deezerId ?? null, cover: a.cover || other?.cover || "", addedAt: now(),
    ...(other?.ytUrl ? { ytUrl: other.ytUrl } : {}),
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
  for (const a of allAlbums()) { if (a.deezerId) ids.add(a.deezerId); keys.add(Catalog.albumKey(a.title, a.artist)); }
  const dis = dismissed();
  return (p) => ids.has(p.deezerId) || dis.has(p.deezerId) || keys.has(Catalog.albumKey(p.title, p.artist));
}

function span(albums) {
  const ys = albums.map((a) => a.year).filter(Boolean);
  if (!ys.length) return "";
  const lo = Math.min(...ys), hi = Math.max(...ys);
  return lo === hi ? `${lo}` : `${lo}–${hi}`;
}
/** A small "(2015)" after an album title, when the year is known. */
const yearTag = (a) => (a?.year ? ` <span class="yr-t">(${esc(a.year)})</span>` : "");
const discs = (n) => `${n} ${n === 1 ? "disc" : "discs"}`;

function ago(ts) {
  const d = (Date.now() / 1000 - ts) / 86400;
  if (d < 1) return "Today";
  if (d < 2) return "Yesterday";
  if (d < 30) return `${Math.floor(d)} days ago`;
  return new Date(ts * 1000).toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" });
}

// Every change that offers Undo can also be undone later with Cmd+Z (Ctrl+Z), newest first.
const undoStack = [];
document.addEventListener("keydown", async (e) => {
  if (!(e.metaKey || e.ctrlKey) || e.shiftKey || e.altKey || e.key.toLowerCase() !== "z") return;
  if (e.target.closest?.("input, textarea, select, [contenteditable]") || $("#cover-editor")?.open) return;
  const last = undoStack.pop();
  if (!last) return;
  e.preventDefault();
  await last.run();
  toast(`Undid: ${last.msg}`);
});

let toastTimer;
function toast(msg, action) {
  if (action?.label === "Undo") {
    const entry = { msg, run: action.run };
    undoStack.push(entry);
    if (undoStack.length > 50) undoStack.shift();
    const run = action.run;
    action = { ...action, run: () => { const i = undoStack.indexOf(entry); if (i >= 0) undoStack.splice(i, 1); return run(); } };
  }
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

const FILES = ["./", "index.html", "style.css", "crate.js", "manifest.webmanifest", "version.json"];

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
  // The same two controls live in the phone menu.
  const rr = $("#rail-refresh"), rt = $("#rail-theme");
  if (rr) rr.onclick = hardRefresh;
  if (rt) { rt.textContent = THEMES[themeNow()]; rt.onclick = () => $("#theme").click(); }
  $("#theme").onclick = () => {
    const order = Object.keys(THEMES);
    const next = order[(order.indexOf(themeNow()) + 1) % order.length];
    try { localStorage.setItem("crate:theme", next); } catch {}
    document.documentElement.dataset.theme = next;
    renderAccount();
  };
}

function renderRail() {
  // Plain links if the cover-card code didn't load, so the crates are still reachable.
  $("#shelf-nav").innerHTML = S.lib.shelves.map((s) => (typeof crateCard === "function" ? crateCard(s, { draggable: !S.visitor })
    : `<a class="rail-link" href="#shelf-${s.id}" data-shelf="${s.id}"><span>${esc(s.name)}</span><span class="count">${s.albums.length}</span></a>`)).join("");
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
  document.querySelectorAll(".rail-link, .crate-card[href]").forEach((a) => {
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
    <div class="album-title">${esc(a.title)}${yearTag(a)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span>${alsoOn(a)}</div>
  </div>`;
}

/** Small dots for the other shelves an album is on. */
function alsoOn(a) {
  const others = (S.copies?.get(Catalog.albumKey(a.title, a.artist)) || []).filter((id) => id !== a.shelfId).map(shelfById).filter(Boolean);
  if (!others.length) return "";
  return `<span class="also" title="Also in ${esc(others.map((s) => s.name).join(", "))}">${others.map((s) => `<i class="dot" style="background:${esc(s.color)}"></i>`).join("")}</span>`;
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
    <div class="album-title">${esc(a.title)}${yearTag(a)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span></div>
    ${foundNote(a) ? `<div class="reason" title="${esc(foundNote(a))}">${esc(foundNote(a))}</div>` : ""}
    <div class="add-row">
      <select aria-label="Crate to add ${esc(a.title)} to">${shelfOptions(target)}</select>
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
        // Leave out handmade mixes you've hidden on the Old hard drive page.
        const hiddenIds = new Set(d.playlists.filter((p) => hiddenPlaylists().has(p.name)).flatMap((p) => p.items));
        const albums = albumsOf(d).filter((x) => x.title !== "(no album)" && x.plays > 0 && !Catalog.isWorship(x) && !x.ids.every((id) => hiddenIds.has(id)));
        const artistPlays = new Map();
        for (const x of albums) artistPlays.set(norm(x.artist), (artistPlays.get(norm(x.artist)) || 0) + x.plays);
        return { albums, artistPlays };
      })
      .catch(() => { oldLoad = null; return null; });
  }
  return oldLoad;
}

/** Albums you've listened to a lot (old iTunes, Spotify) that fit a shelf: same artists or related bands, most-listened first. */
async function oldPicksFor(shelf, count, seed) {
  const old = await tasteData();
  if (!old || !count) return [];
  const mine = new Set(shelf.albums.map((x) => norm(x.artist)));
  const near = await Catalog.relatedNames(shelf.albums).catch(() => new Set());
  const owned = ownedCheck();
  const dismissedOld = new Set(S.raw?.meta?.dismissed?.old || []);
  const fits = old.albums
    .filter((x) => (mine.has(norm(x.artist)) || near.has(norm(x.artist))) && !owned(x) && !dismissedOld.has(x.k))
    .sort((x, y) => y.score - x.score);
  // Mostly the top of the list, with Shuffle bringing in others from near the top.
  const pool = Catalog.shuffle(fits.slice(0, count * 3), Catalog.rng(seed)).slice(0, count).sort((x, y) => y.score - x.score);
  const out = [];
  for (const x of pool) {
    const hit = await Catalog.find(x.artist, x.title).catch(() => null);
    const base = hit || { deezerId: null, title: x.title, artist: x.artist, year: null, cover: "" };
    out.push({ ...base, itunesId: hit ? base.itunesId : x.k, oldKey: x.k, reason: x.label });
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
      <span class="meta">From artists in this crate and the bands around them</span>
      <button class="btn" data-refresh="${shelf.id}">Shuffle</button>
    </div>
    <div class="sug-tools">
      ${liveBox({ shelfId: shelf.id, placeholder: `Have one in mind? Search to add it to ${shelf.name}` })}
      ${S.route.name === "shelf" ? `<button class="btn" data-act="list">Add a list</button>` : ""}
    </div>
    ${S.list?.shelfId === shelf.id && S.route.name === "shelf" ? listForm(shelf) : ""}
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
        const taste = await tasteData();
        const nOld = taste ? Math.ceil(n / 3) : 0;
        const [fresh, mine] = await Promise.all([
          Catalog.suggest(shelf.albums, { n, seed, owned, libraryArtists: libArtists, favorites: taste?.artistScore, favoriteLabel: taste?.artistLabel }),
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
        : `<div class="empty">Suggestions come from the artists in this crate. Search above to add the first few.</div>`;
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
            : `<div class="live-head">Add to <select class="live-shelf" aria-label="Crate to add to">${shelfOptions(target)}</select></div>`}
    ${results.map((a) => {
      const have = owned(a);
      return `
      <div class="live-item">
        <img src="${esc(a.cover)}" alt="" loading="lazy">
        <span class="live-text"><b>${esc(a.title)}${yearTag(a)}</b><small>${esc(a.artist)}${a.viaTrack ? ` · has “${esc(a.viaTrack)}”` : ""}</small></span>
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

/** The crate's cover banner, or a plain big title if the cover code didn't load. */
function heroOf(s, opts) {
  if (typeof crateCard === "function") return crateCard(s, opts);
  const t = opts.title || "h2";
  return `<${t} class="shelf-title cc-title">${opts.tag === "div" ? esc(s.name) : `<a href="#shelf-${s.id}">${esc(s.name)}</a>`}</${t}>`;
}

function shelfAttrs(s) {
  return `class="shelf" style="--shelf:${esc(s.color)}"`;
}
const swatch = (s) => `<button class="swatch" data-color-for="${s.id}" aria-label="Color, cover and font for ${esc(s.name)}" title="Color, cover and font"></button>`;

function recentList(albums) {
  return `<div class="list">${albums.map((a) => `
    <a class="row" href="${esc(ytUrl(a))}" target="_blank" rel="noopener">
      ${a.cover ? `<img src="${esc(a.cover)}" alt="" loading="lazy">` : `<span class="mini burned"><span class="disc"></span></span>`}
      <div style="min-width:0"><div class="t">${esc(a.title)}${yearTag(a)}</div><div class="s">${esc(a.artist)}</div></div>
      <div class="when"><span class="chip"><i class="dot" style="background:${esc(a.shelf.color)}"></i>${esc(a.shelf.name)}</span><div class="meta" style="margin-top:4px">${ago(a.addedAt)}</div></div>
    </a>`).join("")}</div>`;
}

// Phones get a simpler Crate: home is the stack of crate covers, and the menu sits behind ☰.
const isPhone = () => window.matchMedia("(max-width: 760px)").matches;
window.matchMedia("(max-width: 760px)").addEventListener?.("change", () => S.route.name === "home" && render());
function setMenu(open) {
  document.body.classList.toggle("menu-open", open);
  $("#menu-toggle")?.setAttribute("aria-expanded", String(open));
}
$("#menu-toggle")?.addEventListener("click", () => setMenu(!document.body.classList.contains("menu-open")));
$("#menu-close")?.addEventListener("click", () => setMenu(false));
window.addEventListener("hashchange", () => setMenu(false));
document.addEventListener("keydown", (e) => { if (e.key === "Escape") setMenu(false); });

/** All crates: just their covers, in your order. Visitors to a shared link land here. */
function renderCrates() {
  if (!S.lib.shelves.length) {
    view.innerHTML = S.visitor ? `<div class="empty offline">There's nothing in these crates yet.</div>`
      : `<div class="empty offline">No crates yet. Name your first one in “New crate…”.</div>`;
    return;
  }
  const by = S.raw?.meta?.share?.by;
  view.innerHTML = `
    <div class="crates-head">
      <h1 class="page-title">${S.visitor ? esc(by ? `${by}'s crates` : "Shared crates") : "All crates"}</h1>
      ${S.visitor ? "" : `<button class="btn" id="share-toggle">Share</button>`}
    </div>
    ${S.visitor ? `<p class="meta visitor-note">Shared from Crate. Tap an album to play it in YouTube Music.</p>` : `<div id="share-panel" ${S.sharePanel ? "" : "hidden"}>${sharePanel()}</div>`}
    <div class="crate-grid">
      ${S.lib.shelves.map((s) => (typeof crateCard === "function" ? crateCard(s) : `<a class="rail-link" href="#shelf-${s.id}">${esc(s.name)}</a>`)).join("")}
    </div>`;
  if (!S.visitor) wireSharePanel();
}

// ------------------------------------------------------------------ sharing a read-only copy

const shareState = () => S.raw?.meta?.share || {};
const shareUrl = (id) => `${location.origin}${location.pathname}?share=${id}`;

function sharePanel() {
  if (!Store.canArchive()) return `<div class="share-box"><p class="note">Sign in to Crate (top right) to share your crates.</p></div>`;
  const sh = shareState();
  if (!sh.on) {
    return `<div class="share-box">
      <p class="note">Make a link anyone can open, no sign-in needed. They'll see your crates, covers and albums, and can play albums in YouTube Music.
        Your notes, listening history and old library stay private. The link keeps up with your changes.</p>
      <button class="btn primary" id="share-create">Create a share link</button></div>`;
  }
  return `<div class="share-box">
    <div class="share-row"><input id="share-link" readonly value="${esc(shareUrl(sh.id))}" aria-label="Share link"><button class="btn primary" id="share-copy">Copy link</button></div>
    <p class="meta share-status" id="share-status">${esc(S.shareStatus || "Anyone with this link can see your crates. It updates by itself when you change them.")}</p>
    <button class="link danger-link" id="share-stop">Stop sharing</button></div>`;
}

function wireSharePanel() {
  $("#share-toggle")?.addEventListener("click", () => { S.sharePanel = !S.sharePanel; render(); });
  $("#share-create")?.addEventListener("click", async () => {
    const id = Array.from(crypto.getRandomValues(new Uint8Array(9)), (b) => "abcdefghijkmnpqrstuvwxyz23456789"[b % 32]).join("");
    S.shareStatus = "Creating your link…";
    if (await write(() => Store.set("meta", "share", { id, on: true }))) await syncShare(true);
  });
  $("#share-copy")?.addEventListener("click", async () => {
    const input = $("#share-link");
    try { await navigator.clipboard.writeText(input.value); toast("Copied the share link"); }
    catch { input.select(); toast("Select the link and copy it"); }
  });
  $("#share-stop")?.addEventListener("click", async () => {
    const sh = shareState();
    try { await Store.unpublishShare(sh.id, Object.keys(S.shareImages || {})); } catch {}
    S.shareImages = {}; S.lastShareJson = ""; S.shareStatus = "";
    await write(() => Store.set("meta", "share", { id: null, on: false }));
    toast("Stopped sharing. The old link no longer works.");
  });
}

/** What a shared link shows: crates, their covers and albums. No notes or history. */
function shareSnapshot() {
  const shelves = {}, albums = {}, covers = {}, images = {};
  for (const s of S.lib.shelves) {
    shelves[s.id] = { name: s.name, order: s.order ?? 0, font: s.font || "", titleColor: s.titleColor || "", color: s.color };
    const c = s.cover;
    if (c?.src) covers[s.id] = { src: c.src, size: c.size || 100, x: c.x ?? 50, y: c.y ?? 50 };
    else if (c?.data) { covers[s.id] = { uploaded: true, size: c.size || 100, x: c.x ?? 50, y: c.y ?? 50 }; images[s.id] = { data: c.data }; }
    for (const a of s.albums) {
      albums[a.id] = { shelfId: s.id, pos: a.pos, title: a.title || "", artist: a.artist || "", year: a.year ?? null, cover: a.cover || "", ytUrl: a.ytUrl || "" };
    }
  }
  const by = (Store.displayName() || "").split(" ")[0];
  return { snapshot: { shelves, albums, covers, by }, images };
}

let shareTimer = null;
/** Keep the shared copy current: a few seconds after changes settle, write only what changed. */
async function syncShare(now = false) {
  const sh = shareState();
  if (S.visitor || !sh.on || !sh.id || !Store.canArchive()) return;
  clearTimeout(shareTimer);
  if (!now) { shareTimer = setTimeout(() => syncShare(true), 3000); return; }
  const { snapshot, images } = shareSnapshot();
  const json = JSON.stringify(snapshot);
  const sig = (d) => `${d.data.length}:${d.data.slice(-64)}`;
  const prev = S.shareImages || {};
  const changed = Object.fromEntries(Object.entries(images).filter(([id, d]) => prev[id] !== sig(d)));
  const removed = Object.keys(prev).filter((id) => !(id in images));
  if (json === S.lastShareJson && !Object.keys(changed).length && !removed.length) return;
  try {
    await Store.publishShare(sh.id, snapshot, changed, removed);
    S.lastShareJson = json;
    S.shareImages = Object.fromEntries(Object.entries(images).map(([id, d]) => [id, sig(d)]));
    S.shareStatus = `Shared copy updated ${new Date().toLocaleTimeString([], { hour: "numeric", minute: "2-digit" })}. Anyone with this link can see your crates.`;
  } catch (e) {
    S.shareStatus = /permission/i.test(e.code || e.message || "")
      ? "Firebase refused to save the shared copy. Update the database rules in Firebase (see Claude's instructions), then try again."
      : `Couldn't update the shared copy: ${e.message}`;
  }
  const st = $("#share-status");
  if (st) st.textContent = S.shareStatus;
}

function renderShelf(id) {
  const s = shelfById(id);
  if (!s) {
    if (S.pendingShelf === id) { view.innerHTML = `<div class="empty offline">Setting up your crate…</div>`; return; }
    location.hash = "home";
    return;
  }
  if (S.pendingShelf === id) S.pendingShelf = null;
  S.lastShelf = s.id;
  const i = S.lib.shelves.indexOf(s);
  view.innerHTML = `
    <section ${shelfAttrs(s)}>
      <div class="shelf-head" id="shelf-head">
        ${heroOf(s, { tag: "div", cls: "crate-card crate-hero", title: "h1", count: false })}
        <span class="meta">${discs(s.albums.length)}${s.albums.length ? " · " + span(s.albums) : ""}</span>
        ${S.visitor ? "" : `<div class="head-actions">
          <button class="btn" data-act="edit">Edit</button>
        </div>`}
      </div>
      ${s.albums.length
        ? `<div class="grid" id="shelf-grid">${s.albums.map((a) => albumCard(a, { draggable: !S.visitor })).join("")}</div>
           <p class="meta" style="margin-top:18px">Drag covers to reorder, or drop one in a crate in the sidebar to move it.</p>`
        : `<div class="empty">This crate is empty. Search below to add the first album.</div>`}
      ${S.visitor ? "" : suggestBlock(s, `Suggested for ${s.name}`, 18, "grid")}
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
    <p class="meta" style="margin-bottom:18px">Albums matching your search · pick a crate on each one</p>
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
  else if (h === "history") S.route = { name: "history" };
  else if (h === "crates") S.route = { name: "crates" };
  else if (h.startsWith("ytlinks=")) { receiveYtLinks(h.slice(8)); return; }
  else if (h === "search" && S.query) S.route = { name: "search" };
  else S.route = { name: "home" };
  render();
  window.scrollTo(0, 0);
  // Opening a crate from its card: the card grows into the banner and the albums tumble out.
  if (S.flip && S.route.name === "shelf" && S.flip.id === S.route.id) animateCrateOpen(S.flip.rect);
  S.flip = null;
}

document.addEventListener("click", (e) => {
  const card = e.target.closest?.("a.crate-card[href]");
  if (card) S.flip = { id: card.dataset.shelf, rect: card.getBoundingClientRect() };
}, true);

function animateCrateOpen(from) {
  if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
  const hero = view.querySelector(".crate-hero");
  if (!hero?.animate) return;
  const to = hero.getBoundingClientRect();
  if (!to.width) return;
  const dx = from.left - to.left, dy = from.top - to.top, s = from.width / to.width;
  hero.style.transformOrigin = "top left";
  hero.animate([{ transform: `translate(${dx}px, ${dy}px) scale(${s})` }, { transform: "none" }], { duration: 560, easing: "cubic-bezier(.2,.85,.25,1)" });
  const rest = [...view.querySelectorAll("#shelf-head > :not(.crate-hero)")];
  rest.forEach((el) => el.animate([{ opacity: 0 }, { opacity: 1 }], { duration: 300, delay: 380, fill: "backwards" }));
  // Albums drop out of the bottom of the banner, with a little bounce and spin.
  [...view.querySelectorAll("#shelf-grid .album")].slice(0, 36).forEach((el, i) => {
    const r = el.getBoundingClientRect();
    const fromY = to.bottom - r.top - r.height * 0.6;
    const spin = (i % 3 - 1) * 7;
    el.animate([
      { transform: `translateY(${fromY}px) scale(.55) rotate(${spin}deg)`, opacity: 0 },
      { opacity: 1, offset: 0.35 },
      { transform: "none", opacity: 1 },
    ], { duration: 700, delay: 330 + i * 45, easing: "cubic-bezier(.34,1.56,.64,1)", fill: "backwards" });
  });
}

function render() {
  try { renderView(); } catch (e) {
    view.innerHTML = `<div class="empty offline">This page couldn't be shown (${esc(e.message)}). Your crates are safe; use the sidebar or Reload.</div>`;
    showCrash(e);
  }
}

function renderView() {
  if (!S.raw) return;
  if (S.visitor && !["shelf", "crates", "home"].includes(S.route.name)) S.route = { name: "crates" };
  closeMenu();
  const r = S.route;
  if (r.name === "shelf") renderShelf(r.id);
  else if (r.name === "recent") renderRecent();
  else if (r.name === "new") renderNew();
  else if (r.name === "links") renderLinks();
  else if (r.name === "chores") renderChores();
  else if (r.name === "vault") renderVault();
  else if (r.name === "history") renderHistory();
  else if (r.name === "crates") renderCrates();
  else if (r.name === "search") renderSearch();
  else if (typeof renderLanding === "function" && !isPhone() && !S.visitor) renderLanding();
  else renderCrates();
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
  const on = new Set(S.copies.get(Catalog.albumKey(a.title, a.artist)) || []);
  const elsewhere = S.lib.shelves.filter((s) => !on.has(s.id));
  menu.innerHTML = `
    <div class="label">Move to</div>
    ${S.lib.shelves.map((s) => `<button data-move="${s.id}" ${s.id === a.shelf.id ? "disabled" : ""}><i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}${s.id === a.shelf.id ? " · here" : on.has(s.id) ? " · also here" : ""}</button>`).join("")}
    ${elsewhere.length ? `<hr><div class="label">Also put in</div>
    ${elsewhere.map((s) => `<button data-copy="${s.id}"><i class="dot" style="background:${esc(s.color)}"></i>${esc(s.name)}</button>`).join("")}` : ""}
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
    <button data-remove="1">${on.size > 1 ? `Remove from ${esc(a.shelf.name)}` : "Remove from library"}</button>`;
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
  if (await setYtOnCopies(a, url)) toast(`${a.title} now opens its album page`);
}

/** Every copy of an album (on any shelf) shares one YouTube Music link. */
async function setYtOnCopies(a, url) {
  const k = Catalog.albumKey(a.title, a.artist);
  let ok = true;
  for (const x of allAlbums()) if (x.id === a.id || Catalog.albumKey(x.title, x.artist) === k) ok = (await write(() => Store.update("albums", x.id, { ytUrl: url }))) && ok;
  return ok;
}

function openColorMenu(btn, shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  menuFor = { kind: "color", id: shelfId };
  btn.setAttribute("aria-expanded", "true");
  menu.innerHTML = `
    <div class="label">Crate color</div>
    <div class="swatches">${PALETTE.map((c) => `<button class="sw ${c === s.color ? "on" : ""}" data-pick="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}</div>
    <form class="hexrow" id="hex-form">
      <input type="color" id="c-pick" value="${esc(s.color)}" aria-label="Pick any color">
      <input id="c-hex" value="${esc(s.color)}" maxlength="7" spellcheck="false" aria-label="Hex color">
      <button class="btn">Set</button>
    </form>
    <hr>
    <button data-cover="1">Cover &amp; font…</button>`;
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
    else if (b.dataset.cover) { closeMenu(); openCoverEditor(id); }
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
  if (b.dataset.ytclear) { setYtOnCopies(a, ""); return; }
  if (b.dataset.copy) {
    const id = await addAlbum({ ...a }, b.dataset.copy);
    if (id) toast(`Also in ${shelfById(b.dataset.copy).name} now`, { label: "Undo", run: () => write(() => Store.remove("albums", id)) });
    return;
  }
  if (b.dataset.move) {
    const there = shelfById(b.dataset.move).albums.find((x) => Catalog.albumKey(x.title, x.artist) === Catalog.albumKey(a.title, a.artist));
    if (there) { // already on that shelf: moving just means taking it off this one
      if (await write(() => Store.remove("albums", a.id))) toast(`It was already in ${shelfById(b.dataset.move).name}, so it's now only there`, { label: "Undo", run: () => restoreAlbum(a) });
      return;
    }
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
  const editBtn = t.closest("[data-edit-crate]");
  if (editBtn) { if (typeof openCrateEditor === "function") openCrateEditor(editBtn.dataset.editCrate); return; }
  const act = t.closest("[data-act]");
  if (act && S.route.name === "shelf") shelfAction(act.dataset.act);
});

async function shelfAction(act) {
  const s = shelfById(S.route.id);
  if (!s) return;
  if (act === "edit") {
    if (typeof openCrateEditor === "function") openCrateEditor(s.id);
  } else if (act === "list") {
    if (!S.list || S.list.shelfId !== s.id) S.list = { shelfId: s.id, report: "", busy: false };
    render();
    $("#list-input")?.focus();
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
  const owned = allAlbums().find((x) => (a.deezerId && x.deezerId === a.deezerId) || Catalog.albumKey(x.title, x.artist) === Catalog.albumKey(a.title, a.artist));
  remember([a]);
  return `
  <div class="album sug" data-dz="${keyOf(a)}">
    <a class="cover" href="${esc(owned ? ytUrl(owned) : Catalog.ytSearchUrl(a))}" target="_blank" rel="noopener" title="Open in YouTube Music">
      ${coverArt(a)}<span class="play" aria-hidden="true">▶</span>
    </a>
    <div class="album-title">${esc(a.title)}${yearTag(a)}</div>
    <div class="album-sub"><span class="artist">${esc(a.artist)}</span><span class="yr">${a.type === "ep" ? "EP" : ""}</span></div>
    <div class="reason" title="${esc(note)}">${esc(note)}</div>
    ${owned ? `<div class="meta on-shelf"><i class="dot" style="background:${esc(owned.shelf.color)}"></i>On ${esc(owned.shelf.name)}</div>` : `
    <div class="add-row">
      <select aria-label="Crate to add ${esc(a.title)} to">${shelfOptions(target)}</select>
      <button class="btn primary" data-add="${keyOf(a)}">Add</button>
    </div>`}
  </div>`;
}

function renderNew() {
  view.innerHTML = `
    <h1 class="page-title">New releases</h1>
    <p class="note" style="margin-bottom:8px">Albums and EPs from the last 12 months, newest first.</p>
    <section class="new-sec">
      <h2 class="section-label">From artists in your crates</h2>
      <div class="grid" id="new-mine">${skeletons(6)}</div>
    </section>
    <section class="new-sec" id="new-old-sec" hidden>
      <h2 class="section-label">From artists you've played most</h2>
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
    const taste = await tasteData();
    if (taste) {
      $("#new-old-sec") && ($("#new-old-sec").hidden = false);
      const shelfNames = new Set([...artists.values()].map(norm));
      const top = [...taste.artistScore].filter(([n]) => !shelfNames.has(n) && !Catalog.isWorship({ artist: taste.names.get(n) || n }))
        .sort((x, y) => y[1] - x[1]).slice(0, 30);
      const ids = new Map(), labelOf = new Map();
      for (const [n] of top) {
        const hit = await Catalog.findArtist(taste.names.get(n) || n).catch(() => null);
        if (hit && !artists.has(hit.id)) { ids.set(hit.id, hit.name); labelOf.set(hit.id, taste.artistLabel.get(n)); }
      }
      const fromOld = await Catalog.newFrom(ids, since);
      fill("#new-old", fromOld.map((a) => newCard(a, "", `Released ${monthDay(a.released)} · ${labelOf.get(a.artistId) || ""}`)).join(""),
        "Nothing new from the artists you've played most.");
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
      const k = Catalog.albumKey(album, artist);
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

const SPOTIFY_CHORE_MIN = 180; // three hours of listening

/** YouTube Music likes and Spotify albums with 3+ hours, merged, minus anything shelved or skipped. */
function choreItems() {
  const c = S.raw?.meta?.chores || {};
  const skipped = new Set(c.skipped || []);
  const owned = new Set(allAlbums().map((a) => Catalog.albumKey(a.title, a.artist)));
  const byKey = new Map();
  // Likes saved before editions were merged carry older keys, so re-key them here.
  for (const i of c.items || []) { const k = Catalog.albumKey(i.title, i.artist); byKey.set(k, { ...i, k, likes: i.count }); }
  for (const a of HIST.summary?.albums || []) {
    if (a.min < SPOTIFY_CHORE_MIN) continue;
    const e = byKey.get(a.k) || { k: a.k, title: a.title, artist: a.artist, songs: [], likes: 0 };
    byKey.set(a.k, { ...e, min: a.min, plays: a.plays });
  }
  // Rank by listening: an hour on Spotify counts about the same as one liked song.
  const score = (i) => (i.min || 0) / 60 + (i.likes || 0);
  return [...byKey.values()].map((i) => ({ ...i, count: Math.max(i.likes || 0, i.min ? 2 : 0) }))
    .filter((i) => !skipped.has(i.k) && !owned.has(i.k) && !Catalog.isWorship(i))
    .sort((x, y) => score(y) - score(x));
}

function choreWhy(i) {
  const parts = [];
  if (i.min) parts.push(`${hours(i.min)} hours on Spotify`);
  if (i.likes) parts.push(`${i.likes} liked ${i.likes === 1 ? "song" : "songs"}${i.songs?.length ? ` (${i.songs.join(", ")}${i.likes > i.songs.length ? "…" : ""})` : ""}`);
  return parts.join(" · ");
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
  if (!HIST.summary && !HIST.checkedChores) { HIST.checkedChores = true; spotifyHistory().then((h) => h && S.route.name === "chores" && render()); }
  const c = S.raw?.meta?.chores;
  const all = choreItems();
  const items = all.filter((i) => CHORES.singles || i.count > 1);
  const when = c?.updatedAt ? ago(c.updatedAt).toLowerCase() : "";
  view.innerHTML = `
    <h1 class="page-title">Sorting chores</h1>
    <p class="note">Albums you've listened to a lot (3+ hours on Spotify) or liked songs from on YouTube Music, that aren't in a crate yet. Most-listened first.</p>
    <div class="chores-bar">
      ${Store.canSync() && S.user
        ? `<button class="btn primary" id="chores-refresh" ${CHORES.busy ? "disabled" : ""}>${c ? "Check YouTube Music again" : "Connect YouTube Music"}</button>`
        : `<span class="meta">Sign in to Crate first</span>`}
      <span class="meta" id="chores-status">${esc(CHORES.busy || (c ? `Checked ${when} · ${c.liked} liked songs` : ""))}</span>
      ${c ? `<label class="meta"><input type="checkbox" id="chores-singles" ${CHORES.singles ? "checked" : ""}> Include albums with one liked song</label>` : ""}
    </div>
    ${!c && !HIST.summary ? `<div class="empty" style="margin-top:20px">Connect YouTube Music, or bring in your Spotify history on the Listening history page, to see the albums you've been living with. Crate only reads your likes; it can't change anything in your account.</div>`
      : !items.length ? `<div class="empty" style="margin-top:20px">All caught up. Every album you've liked songs from is in a crate${all.length ? ", apart from ones with a single liked song" : ""}.</div>`
      : `<div class="inbox-list">${items.slice(0, CHORES.shown).map((i) => `
        <div class="inbox-row" data-k="${esc(i.k)}">
          <a class="ib-cover" href="${esc(Catalog.ytSearchUrl(i))}" target="_blank" rel="noopener" title="Open in YouTube Music">
            ${CHORES.covers.get(i.k) ? `<img src="${esc(CHORES.covers.get(i.k))}" alt="">` : `<span class="mini burned"><span class="disc"></span></span>`}
          </a>
          <div style="min-width:0">
            <div class="t">${esc(i.title)}${yearTag(CHORES.found.get(i.k))}</div><div class="s">${esc(i.artist)}</div>
            <div class="meta">${esc(choreWhy(i))}</div>
          </div>
          <div class="ib-actions">
            <select aria-label="Crate for ${esc(i.title)}"><option value="">Pick a crate…</option>${shelfOptions(guessShelfFor(i))}</select>
            <button class="btn primary" data-chore="add">Add to crate</button>
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
    const t = a?.year && view.querySelector(`.inbox-row[data-k="${CSS.escape(i.k)}"] .t`);
    if (t && !t.querySelector(".yr-t")) t.insertAdjacentHTML("beforeend", yearTag(a));
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
  const c = S.raw?.meta?.chores || {};
  const item = choreItems().find((x) => x.k === k);
  if (!item) return;
  if (b.dataset.chore === "add") {
    const shelfId = row.querySelector("select").value;
    if (!shelfId) { toast("Pick a crate first."); row.querySelector("select").focus(); return; }
    b.disabled = true; b.textContent = "…";
    // Reuse the match the cover lookup already made; otherwise look it up now.
    coverJob++;
    const found = CHORES.found.get(k) || await Catalog.find(item.artist, item.title).catch(() => null);
    const id = await addAlbum(found ? { ...found } : { title: item.title, artist: item.artist }, shelfId);
    if (id) { row.remove(); addedToast(found?.title || item.title, shelfId, id); }
    else { b.disabled = false; b.textContent = "Add to crate"; }
  } else if (b.dataset.chore === "skip") {
    row.remove();
    const skipped = [...new Set([...(c.skipped || []), k])];
    await write(() => Store.set("meta", "chores", { ...c, skipped }));
    toast(`Skipped ${item.title}`, { label: "Undo", run: () => write(() => Store.set("meta", "chores", { ...(S.raw?.meta?.chores || {}), skipped: skipped.filter((x) => x !== k) })) });
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
  const a = allAlbums().find((x) => x.id === id);
  if (a && shelfById(to).albums.some((x) => Catalog.albumKey(x.title, x.artist) === Catalog.albumKey(a.title, a.artist))) {
    // Already on that shelf: dropping it there just takes it off this one.
    if (await write(() => Store.remove("albums", id))) toast(`It was already in ${shelfById(to).name}, so it's now only there`, { label: "Undo", run: () => restoreAlbum(a) });
    return;
  }
  if (await moveAlbum(id, to, 0)) toast(`Moved to ${shelfById(to).name}`);
});

// ------------------------------------------------------------------ boot

// Starts Crate. Called at the very end of crate.js (see bump.py), once every part of the app
// has been set up; starting earlier could draw crates before the cover code exists.
function bootCrate() {
  window.addEventListener("hashchange", route);
  const shareId = new URLSearchParams(location.search).get("share");
  if (shareId) {
    S.visitor = true;
    document.body.classList.add("visitor");
    window.__crateBooted = true;
    view.innerHTML = `<div class="empty offline">Opening the shared crates…</div>`;
    Store.startShared(shareId, onData)
      .then(() => { try { route(); } catch (e) { showCrash(e); } })
      .catch((e) => { view.innerHTML = `<div class="empty offline">${esc(e.message || "This shared link couldn't be opened.")}</div>`; });
    return;
  }
  $("#top-search").innerHTML = liveBox({ placeholder: "Search any album or artist to add" });
  Store.onAuth((user) => { S.user = user; renderAccount(); });
  renderAccount();
  window.__crateBooted = true;
  Store.start(onData, { toast }).catch(showCrash).finally(() => { try { route(); } catch (e) { showCrash(e); } });
}

// ===== crates.js =====
// Crates: cover cards, title fonts, and the "Edit crate" dialog.
// A crate's cover is either its first three album covers side by side (the default; 3:1
// fits three squares exactly) or one image, an album cover from the crate or an upload,
// cropped with a pan and a zoom. The crop is kept as CSS background numbers, so album art
// stays a link to the image rather than a copy.
"use strict";

// Free Google Fonts, loaded by Crate itself so they look the same on Mac, PC and iPhone.
// q: the family as Google Fonts spells it (with weight), scale: size adjustment for very
// wide or narrow faces, upper: set in capitals.
const FONTS = [
  // the classics
  { id: "big-shoulders", name: "Big Shoulders", q: "Big Shoulders Display:wght@900", weight: 900, upper: true },
  { id: "anton", name: "Anton", q: "Anton", upper: true },
  { id: "bebas", name: "Bebas Neue", q: "Bebas Neue", upper: true, scale: 1.1 },
  { id: "oswald", name: "Oswald", q: "Oswald:wght@700", weight: 700, upper: true },
  { id: "archivo-black", name: "Archivo Black", q: "Archivo Black" },
  { id: "unbounded", name: "Unbounded", q: "Unbounded:wght@800", weight: 800, scale: 0.85 },
  { id: "syne", name: "Syne", q: "Syne:wght@800", weight: 800 },
  { id: "space-grotesk", name: "Space Grotesk", q: "Space Grotesk:wght@700", weight: 700 },
  { id: "abril", name: "Abril Fatface", q: "Abril Fatface" },
  { id: "dm-serif", name: "DM Serif Display", q: "DM Serif Display" },
  { id: "fraunces", name: "Fraunces", q: "Fraunces:opsz,wght@9..144,900", weight: 900 },
  { id: "righteous", name: "Righteous", q: "Righteous" },
  { id: "bungee", name: "Bungee", q: "Bungee", upper: true, scale: 0.85 },
  { id: "rubik-mono", name: "Rubik Mono One", q: "Rubik Mono One", upper: true, scale: 0.75 },
  { id: "marker", name: "Permanent Marker", q: "Permanent Marker" },
  // display and poster
  { id: "alfa-slab", name: "Alfa Slab One", q: "Alfa Slab One" },
  { id: "ultra", name: "Ultra", q: "Ultra", scale: 0.85 },
  { id: "gloock", name: "Gloock", q: "Gloock" },
  { id: "yeseva", name: "Yeseva One", q: "Yeseva One" },
  { id: "staatliches", name: "Staatliches", q: "Staatliches", upper: true, scale: 1.1 },
  { id: "six-caps", name: "Six Caps", q: "Six Caps", upper: true, scale: 1.5 },
  { id: "limelight", name: "Limelight", q: "Limelight" },
  { id: "poiret", name: "Poiret One", q: "Poiret One", scale: 1.05 },
  { id: "gruppo", name: "Gruppo", q: "Gruppo", upper: true, scale: 1.05 },
  { id: "bowlby", name: "Bowlby One SC", q: "Bowlby One SC", scale: 0.85 },
  { id: "shrikhand", name: "Shrikhand", q: "Shrikhand" },
  { id: "bagel", name: "Bagel Fat One", q: "Bagel Fat One" },
  { id: "climate-crisis", name: "Climate Crisis", q: "Climate Crisis", upper: true, scale: 0.75 },
  { id: "tilt-warp", name: "Tilt Warp", q: "Tilt Warp" },
  // future and machine
  { id: "orbitron", name: "Orbitron", q: "Orbitron:wght@900", weight: 900, upper: true, scale: 0.8 },
  { id: "michroma", name: "Michroma", q: "Michroma", upper: true, scale: 0.75 },
  { id: "syncopate", name: "Syncopate", q: "Syncopate:wght@700", weight: 700, upper: true, scale: 0.75 },
  { id: "audiowide", name: "Audiowide", q: "Audiowide", scale: 0.9 },
  { id: "russo", name: "Russo One", q: "Russo One" },
  { id: "tektur", name: "Tektur", q: "Tektur:wght@800", weight: 800 },
  { id: "black-ops", name: "Black Ops One", q: "Black Ops One", scale: 0.9 },
  { id: "wallpoet", name: "Wallpoet", q: "Wallpoet", scale: 0.9 },
  { id: "major-mono", name: "Major Mono Display", q: "Major Mono Display", scale: 0.75 },
  { id: "monoton", name: "Monoton", q: "Monoton", upper: true, scale: 0.75 },
  { id: "codystar", name: "Codystar", q: "Codystar", scale: 0.85 },
  { id: "faster-one", name: "Faster One", q: "Faster One", scale: 0.85 },
  // pixels and terminals
  { id: "press-start", name: "Press Start 2P", q: "Press Start 2P", upper: true, scale: 0.55 },
  { id: "vt323", name: "VT323", q: "VT323", scale: 1.3 },
  { id: "silkscreen", name: "Silkscreen", q: "Silkscreen", upper: true, scale: 0.75 },
  { id: "sixtyfour", name: "Sixtyfour", q: "Sixtyfour", scale: 0.65 },
  { id: "workbench", name: "Workbench", q: "Workbench", scale: 0.85 },
  { id: "jacquard", name: "Jacquard 24", q: "Jacquard 24", scale: 1.1 },
  { id: "special-elite", name: "Special Elite", q: "Special Elite", scale: 0.9 },
  // heavy and metal
  { id: "unifraktur", name: "UnifrakturMaguntia", q: "UnifrakturMaguntia" },
  { id: "pirata", name: "Pirata One", q: "Pirata One", scale: 1.1 },
  { id: "grenze-gotisch", name: "Grenze Gotisch", q: "Grenze Gotisch:wght@800", weight: 800 },
  { id: "fruktur", name: "Fruktur", q: "Fruktur" },
  { id: "metal-mania", name: "Metal Mania", q: "Metal Mania", scale: 1.05 },
  { id: "new-rocker", name: "New Rocker", q: "New Rocker", scale: 1.05 },
  // horror and goo
  { id: "creepster", name: "Creepster", q: "Creepster", scale: 1.05 },
  { id: "nosifer", name: "Nosifer", q: "Nosifer", scale: 0.75 },
  { id: "butcherman", name: "Butcherman", q: "Butcherman", scale: 0.9 },
  { id: "eater", name: "Eater", q: "Eater", scale: 0.9 },
  { id: "frijole", name: "Frijole", q: "Frijole", scale: 0.85 },
  { id: "rubik-wet-paint", name: "Rubik Wet Paint", q: "Rubik Wet Paint", scale: 0.9 },
  { id: "rubik-glitch", name: "Rubik Glitch", q: "Rubik Glitch", scale: 0.9 },
  { id: "rubik-distressed", name: "Rubik Distressed", q: "Rubik Distressed", scale: 0.9 },
  { id: "rubik-beastly", name: "Rubik Beastly", q: "Rubik Beastly", scale: 0.9 },
  { id: "rubik-puddles", name: "Rubik Puddles", q: "Rubik Puddles", scale: 0.9 },
  { id: "rubik-microbe", name: "Rubik Microbe", q: "Rubik Microbe", scale: 0.9 },
  { id: "rubik-moonrocks", name: "Rubik Moonrocks", q: "Rubik Moonrocks", scale: 0.9 },
  { id: "rubik-vinyl", name: "Rubik Vinyl", q: "Rubik Vinyl", scale: 0.9 },
  // loud, playful, layered
  { id: "nabla", name: "Nabla (color)", q: "Nabla", scale: 0.85 },
  { id: "honk", name: "Honk (color)", q: "Honk", scale: 0.85 },
  { id: "bungee-spice", name: "Bungee Spice (color)", q: "Bungee Spice", upper: true, scale: 0.85 },
  { id: "bungee-shade", name: "Bungee Shade", q: "Bungee Shade", upper: true, scale: 0.8 },
  { id: "bungee-outline", name: "Bungee Outline", q: "Bungee Outline", upper: true, scale: 0.85 },
  { id: "kablammo", name: "Kablammo", q: "Kablammo", scale: 0.9 },
  { id: "rampart", name: "Rampart One", q: "Rampart One", scale: 0.85 },
  { id: "train-one", name: "Train One", q: "Train One", scale: 0.85 },
  { id: "zen-tokyo-zoo", name: "Zen Tokyo Zoo", q: "Zen Tokyo Zoo", scale: 0.85 },
  { id: "moirai", name: "Moirai One", q: "Moirai One", scale: 0.9 },
  { id: "foldit", name: "Foldit", q: "Foldit:wght@700", weight: 700, scale: 0.9 },
  { id: "monofett", name: "Monofett", q: "Monofett", scale: 0.9 },
  { id: "plaster", name: "Plaster", q: "Plaster", scale: 0.8 },
  { id: "ewert", name: "Ewert", q: "Ewert", scale: 0.85 },
  { id: "fascinate", name: "Fascinate", q: "Fascinate" },
  { id: "londrina-shadow", name: "Londrina Shadow", q: "Londrina Shadow", scale: 1.1 },
  { id: "kumar-outline", name: "Kumar One Outline", q: "Kumar One Outline", scale: 0.8 },
  { id: "akronim", name: "Akronim", q: "Akronim", scale: 1.1 },
  { id: "bangers", name: "Bangers", q: "Bangers", upper: true, scale: 1.05 },
  { id: "luckiest-guy", name: "Luckiest Guy", q: "Luckiest Guy" },
  { id: "chewy", name: "Chewy", q: "Chewy" },
  { id: "henny-penny", name: "Henny Penny", q: "Henny Penny", scale: 0.9 },
  { id: "barrio", name: "Barrio", q: "Barrio", scale: 0.9 },
  { id: "bahianita", name: "Bahianita", q: "Bahianita", upper: true, scale: 1.3 },
  // western and retro
  { id: "rye", name: "Rye", q: "Rye", scale: 0.9 },
  { id: "smokum", name: "Smokum", q: "Smokum", scale: 1.1 },
  { id: "diplomata", name: "Diplomata SC", q: "Diplomata SC", scale: 0.6 },
  // hand, script and spray
  { id: "lobster", name: "Lobster", q: "Lobster" },
  { id: "pacifico", name: "Pacifico", q: "Pacifico", scale: 0.85 },
  { id: "yesteryear", name: "Yesteryear", q: "Yesteryear" },
  { id: "rock-salt", name: "Rock Salt", q: "Rock Salt", scale: 0.75 },
  { id: "homemade-apple", name: "Homemade Apple", q: "Homemade Apple", scale: 0.8 },
  { id: "sedgwick", name: "Sedgwick Ave Display", q: "Sedgwick Ave Display", scale: 1.1 },
  { id: "knewave", name: "Knewave", q: "Knewave" },
  { id: "lacquer", name: "Lacquer", q: "Lacquer" },
  // more from the Google Fonts catalog: display, handwriting and a few serifs, sized by their width
  { id: "nova-flat", name: "Nova Flat", q: "Nova Flat", scale: 0.95 },
  { id: "changa-one", name: "Changa One", q: "Changa One", scale: 0.95 },
  { id: "syne-tactile", name: "Syne Tactile", q: "Syne Tactile", scale: 0.9 },
  { id: "comfortaa", name: "Comfortaa", q: "Comfortaa:wght@700", weight: 700, scale: 0.88 },
  { id: "lilita-one", name: "Lilita One", q: "Lilita One", scale: 0.95 },
  { id: "lobster-two", name: "Lobster Two", q: "Lobster Two:wght@700", weight: 700 },
  { id: "comic-relief", name: "Comic Relief", q: "Comic Relief:wght@700", weight: 700, scale: 0.9 },
  { id: "gravitas-one", name: "Gravitas One", q: "Gravitas One", scale: 0.78 },
  { id: "titan-one", name: "Titan One", q: "Titan One", scale: 0.88 },
  { id: "oxanium", name: "Oxanium", q: "Oxanium:wght@800", weight: 800, scale: 0.9 },
  { id: "concert-one", name: "Concert One", q: "Concert One", scale: 0.95 },
  { id: "patua-one", name: "Patua One", q: "Patua One", scale: 0.95 },
  { id: "balsamiq-sans", name: "Balsamiq Sans", q: "Balsamiq Sans:wght@700", weight: 700, scale: 0.9 },
  { id: "oleo-script", name: "Oleo Script", q: "Oleo Script:wght@700", weight: 700 },
  { id: "rammetto-one", name: "Rammetto One", q: "Rammetto One", scale: 0.88 },
  { id: "cabin-sketch", name: "Cabin Sketch", q: "Cabin Sketch:wght@700", weight: 700, scale: 0.95 },
  { id: "forum", name: "Forum", q: "Forum" },
  { id: "racing-sans-one", name: "Racing Sans One", q: "Racing Sans One", scale: 0.95 },
  { id: "goldman", name: "Goldman", q: "Goldman:wght@700", weight: 700, scale: 0.9 },
  { id: "rowdies", name: "Rowdies", q: "Rowdies:wght@700", weight: 700, scale: 0.9 },
  { id: "caprasimo", name: "Caprasimo", q: "Caprasimo", scale: 0.9 },
  { id: "iceberg", name: "Iceberg", q: "Iceberg" },
  { id: "fugaz-one", name: "Fugaz One", q: "Fugaz One", scale: 0.88 },
  { id: "funnel-display", name: "Funnel Display", q: "Funnel Display:wght@800", weight: 800, scale: 0.9 },
  { id: "grandstander", name: "Grandstander", q: "Grandstander:wght@900", weight: 900, scale: 0.9 },
  { id: "passion-one", name: "Passion One", q: "Passion One:wght@900", weight: 900, scale: 0.95 },
  { id: "bowlby-one", name: "Bowlby One", q: "Bowlby One", scale: 0.88 },
  { id: "chelsea-market", name: "Chelsea Market", q: "Chelsea Market", scale: 0.88 },
  { id: "carter-one", name: "Carter One", q: "Carter One", scale: 0.95 },
  { id: "chango", name: "Chango", q: "Chango", scale: 0.78 },
  { id: "gabarito", name: "Gabarito", q: "Gabarito:wght@900", weight: 900, scale: 0.9 },
  { id: "skranji", name: "Skranji", q: "Skranji:wght@700", weight: 700, scale: 0.88 },
  { id: "love-ya-like-a-sister", name: "Love Ya Like A Sister", q: "Love Ya Like A Sister", scale: 0.95 },
  { id: "galindo", name: "Galindo", q: "Galindo", scale: 0.88 },
  { id: "squada-one", name: "Squada One", q: "Squada One" },
  { id: "cinzel-decorative", name: "Cinzel Decorative", q: "Cinzel Decorative:wght@900", weight: 900, scale: 0.78 },
  { id: "boogaloo", name: "Boogaloo", q: "Boogaloo" },
  { id: "poller-one", name: "Poller One", q: "Poller One", scale: 0.88 },
  { id: "stardos-stencil", name: "Stardos Stencil", q: "Stardos Stencil:wght@700", weight: 700, scale: 0.95 },
  { id: "playball", name: "Playball", q: "Playball" },
  { id: "vina-sans", name: "Vina Sans", q: "Vina Sans", scale: 0.9 },
  { id: "phudu", name: "Phudu", q: "Phudu:wght@900", weight: 900, scale: 0.9 },
  { id: "corben", name: "Corben", q: "Corben:wght@700", weight: 700, scale: 0.78 },
  { id: "fredericka-the-great", name: "Fredericka the Great", q: "Fredericka the Great", scale: 0.95 },
  { id: "kranky", name: "Kranky", q: "Kranky", scale: 0.95 },
  { id: "dynapuff", name: "DynaPuff", q: "DynaPuff:wght@700", weight: 700, scale: 0.9 },
  { id: "calistoga", name: "Calistoga", q: "Calistoga", scale: 0.9 },
  { id: "milonga", name: "Milonga", q: "Milonga", scale: 0.95 },
  { id: "anybody", name: "Anybody", q: "Anybody:wght@900", weight: 900, scale: 0.9 },
  { id: "ruslan-display", name: "Ruslan Display", q: "Ruslan Display", scale: 0.88 },
  { id: "atomic-age", name: "Atomic Age", q: "Atomic Age", scale: 0.88 },
  { id: "unica-one", name: "Unica One", q: "Unica One", scale: 0.95 },
  { id: "metamorphous", name: "Metamorphous", q: "Metamorphous", scale: 0.88 },
  { id: "sigmar-one", name: "Sigmar One", q: "Sigmar One", scale: 0.88 },
  { id: "red-rose", name: "Red Rose", q: "Red Rose:wght@700", weight: 700, scale: 0.9 },
  { id: "averia-serif-libre", name: "Averia Serif Libre", q: "Averia Serif Libre:wght@700", weight: 700, scale: 0.95 },
  { id: "overlock", name: "Overlock", q: "Overlock:wght@900", weight: 900, scale: 0.95 },
  { id: "alkatra", name: "Alkatra", q: "Alkatra:wght@700", weight: 700, scale: 0.9 },
  { id: "amarante", name: "Amarante", q: "Amarante", scale: 0.95 },
  { id: "pixelify-sans", name: "Pixelify Sans", q: "Pixelify Sans:wght@700", weight: 700, scale: 0.9 },
  { id: "bubblegum-sans", name: "Bubblegum Sans", q: "Bubblegum Sans" },
  { id: "sniglet", name: "Sniglet", q: "Sniglet:wght@800", weight: 800, scale: 0.88 },
  { id: "rubik-doodle-shadow", name: "Rubik Doodle Shadow", q: "Rubik Doodle Shadow", scale: 0.9 },
  { id: "bungee-inline", name: "Bungee Inline", q: "Bungee Inline", scale: 0.88 },
  { id: "big-shoulders-text", name: "Big Shoulders Text", q: "Big Shoulders:wght@900", weight: 900, scale: 0.9 },
  { id: "turret-road", name: "Turret Road", q: "Turret Road:wght@800", weight: 800, scale: 0.9 },
  { id: "mclaren", name: "McLaren", q: "McLaren", scale: 0.88 },
  { id: "museomoderno", name: "MuseoModerno", q: "MuseoModerno:wght@900", weight: 900, scale: 0.9 },
  { id: "flamenco", name: "Flamenco", q: "Flamenco:wght@400" },
  { id: "sancreek", name: "Sancreek", q: "Sancreek", scale: 0.95 },
  { id: "modern-antiqua", name: "Modern Antiqua", q: "Modern Antiqua", scale: 0.88 },
  { id: "autour-one", name: "Autour One", q: "Autour One", scale: 0.88 },
  { id: "zen-dots", name: "Zen Dots", q: "Zen Dots", scale: 0.9 },
  { id: "revalia", name: "Revalia", q: "Revalia", scale: 0.78 },
  { id: "macondo", name: "Macondo", q: "Macondo", scale: 0.95 },
  { id: "sansita-swashed", name: "Sansita Swashed", q: "Sansita Swashed:wght@900", weight: 900, scale: 0.9 },
  { id: "original-surfer", name: "Original Surfer", q: "Original Surfer", scale: 0.95 },
  { id: "coda", name: "Coda", q: "Coda:wght@800", weight: 800, scale: 0.88 },
  { id: "londrina-solid", name: "Londrina Solid", q: "Londrina Solid:wght@900", weight: 900, scale: 0.9 },
  { id: "barriecito", name: "Barriecito", q: "Barriecito", scale: 0.9 },
  { id: "sarina", name: "Sarina", q: "Sarina", scale: 0.88 },
  { id: "croissant-one", name: "Croissant One", q: "Croissant One", scale: 0.88 },
  { id: "freeman", name: "Freeman", q: "Freeman", scale: 0.9 },
  { id: "aboreto", name: "Aboreto", q: "Aboreto", scale: 0.9 },
  { id: "coiny", name: "Coiny", q: "Coiny", scale: 0.9 },
  { id: "redaction-100", name: "Redaction 100", q: "Redaction 100:wght@700", weight: 700, scale: 0.9 },
  { id: "arima", name: "Arima", q: "Arima:wght@700", weight: 700, scale: 0.9 },
  { id: "rubik-bubbles", name: "Rubik Bubbles", q: "Rubik Bubbles", scale: 0.9 },
  { id: "averia-sans-libre", name: "Averia Sans Libre", q: "Averia Sans Libre:wght@700", weight: 700, scale: 0.95 },
  { id: "slackey", name: "Slackey", q: "Slackey", scale: 0.88 },
  { id: "orelega-one", name: "Orelega One", q: "Orelega One", scale: 0.9 },
  { id: "prosto-one", name: "Prosto One", q: "Prosto One", scale: 0.88 },
  { id: "shojumaru", name: "Shojumaru", q: "Shojumaru", scale: 0.78 },
  { id: "dynalight", name: "Dynalight", q: "Dynalight", scale: 1.05 },
  { id: "averia-libre", name: "Averia Libre", q: "Averia Libre:wght@700", weight: 700, scale: 0.95 },
  { id: "single-day", name: "Single Day", q: "Single Day", scale: 0.9 },
  { id: "germania-one", name: "Germania One", q: "Germania One" },
  { id: "road-rage", name: "Road Rage", q: "Road Rage", scale: 0.9 },
  { id: "protest-strike", name: "Protest Strike", q: "Protest Strike", scale: 0.9 },
  { id: "zen-loop", name: "Zen Loop", q: "Zen Loop", scale: 0.9 },
  { id: "oregano", name: "Oregano", q: "Oregano", scale: 1.05 },
  { id: "elsie", name: "Elsie", q: "Elsie:wght@900", weight: 900, scale: 0.88 },
  { id: "uncial-antiqua", name: "Uncial Antiqua", q: "Uncial Antiqua", scale: 0.88 },
  { id: "unlock", name: "Unlock", q: "Unlock", scale: 0.88 },
  { id: "trade-winds", name: "Trade Winds", q: "Trade Winds", scale: 0.88 },
  { id: "snowburst-one", name: "Snowburst One", q: "Snowburst One", scale: 0.88 },
  { id: "big-shoulders-inline", name: "Big Shoulders Inline", q: "Big Shoulders Inline:wght@900", weight: 900, scale: 0.9 },
  { id: "bellota", name: "Bellota", q: "Bellota:wght@700", weight: 700, scale: 0.9 },
  { id: "allan", name: "Allan", q: "Allan:wght@700", weight: 700, scale: 1.05 },
  { id: "protest-riot", name: "Protest Riot", q: "Protest Riot", scale: 0.9 },
  { id: "caesar-dressing", name: "Caesar Dressing", q: "Caesar Dressing", scale: 0.95 },
  { id: "dancing-script", name: "Dancing Script", q: "Dancing Script:wght@700", weight: 700 },
  { id: "zeyada", name: "Zeyada", q: "Zeyada" },
  { id: "caveat", name: "Caveat", q: "Caveat:wght@700", weight: 700, scale: 1.25 },
  { id: "satisfy", name: "Satisfy", q: "Satisfy" },
  { id: "delius", name: "Delius", q: "Delius", scale: 0.95 },
  { id: "allura", name: "Allura", q: "Allura", scale: 1.05 },
  { id: "kaushan-script", name: "Kaushan Script", q: "Kaushan Script" },
  { id: "shadows-into-light", name: "Shadows Into Light", q: "Shadows Into Light" },
  { id: "berkshire-swash", name: "Berkshire Swash", q: "Berkshire Swash", scale: 0.95 },
  { id: "great-vibes", name: "Great Vibes", q: "Great Vibes", scale: 1.05 },
  { id: "patrick-hand", name: "Patrick Hand", q: "Patrick Hand" },
  { id: "sacramento", name: "Sacramento", q: "Sacramento", scale: 1.05 },
  { id: "alex-brush", name: "Alex Brush", q: "Alex Brush", scale: 1.05 },
  { id: "indie-flower", name: "Indie Flower", q: "Indie Flower", scale: 0.95 },
  { id: "gloria-hallelujah", name: "Gloria Hallelujah", q: "Gloria Hallelujah", scale: 0.88 },
  { id: "yellowtail", name: "Yellowtail", q: "Yellowtail", scale: 1.05 },
  { id: "nothing-you-could-do", name: "Nothing You Could Do", q: "Nothing You Could Do", scale: 0.88 },
  { id: "mr-dafoe", name: "Mr Dafoe", q: "Mr Dafoe" },
  { id: "mrs-saint-delafield", name: "Mrs Saint Delafield", q: "Mrs Saint Delafield", scale: 1.15 },
  { id: "comic-neue", name: "Comic Neue", q: "Comic Neue:wght@700", weight: 700, scale: 0.9 },
  { id: "amatic-sc", name: "Amatic SC", q: "Amatic SC:wght@700", weight: 700, scale: 1.35 },
  { id: "bad-script", name: "Bad Script", q: "Bad Script" },
  { id: "courgette", name: "Courgette", q: "Courgette", scale: 0.95 },
  { id: "pangolin", name: "Pangolin", q: "Pangolin", scale: 0.9 },
  { id: "waiting-for-the-sunrise", name: "Waiting for the Sunrise", q: "Waiting for the Sunrise" },
  { id: "pinyon-script", name: "Pinyon Script", q: "Pinyon Script" },
  { id: "cedarville-cursive", name: "Cedarville Cursive", q: "Cedarville Cursive", scale: 0.95 },
  { id: "la-belle-aurore", name: "La Belle Aurore", q: "La Belle Aurore", scale: 0.95 },
  { id: "architects-daughter", name: "Architects Daughter", q: "Architects Daughter", scale: 0.95 },
  { id: "neucha", name: "Neucha", q: "Neucha" },
  { id: "instrument-serif", name: "Instrument Serif", q: "Instrument Serif", scale: 0.9 },
  { id: "cinzel", name: "Cinzel", q: "Cinzel:wght@900", weight: 900, scale: 0.88 },
  { id: "slabo-27px", name: "Slabo 27px", q: "Slabo 27px" },
  { id: "slabo-13px", name: "Slabo 13px", q: "Slabo 13px", scale: 0.95 },
  { id: "marcellus", name: "Marcellus", q: "Marcellus", scale: 0.95 },
  { id: "volkhov", name: "Volkhov", q: "Volkhov:wght@700", weight: 700, scale: 0.88 },
  { id: "unifrakturcook", name: "UnifrakturCook", q: "UnifrakturCook:wght@700", weight: 700 },
];
const fontOf = (s) => FONTS.find((f) => f.id === s?.font) || FONTS[0];
const fontCss = (f) => `font-family:'${f.q.split(":")[0]}','Arial Narrow',sans-serif;font-weight:${f.weight || 400};text-transform:${f.upper ? "uppercase" : "none"};--fs:${f.scale || 1}`;
const fontStyle = (s) => fontCss(fontOf(s));

// ------------------------------------------------------------------ fonts load when needed

const loadedFonts = new Set(["big-shoulders", "marker"]); // already in index.html
/** Full font files for the fonts crates actually use. */
function ensureFonts(ids) {
  const want = [...new Set(ids)].filter((id) => id && !loadedFonts.has(id)).map((id) => FONTS.find((f) => f.id === id)).filter(Boolean);
  if (!want.length) return;
  want.forEach((f) => loadedFonts.add(f.id));
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = "https://fonts.googleapis.com/css2?" + want.map((f) => "family=" + f.q.replace(/ /g, "+")).join("&") + "&display=swap";
  document.head.append(link);
}
/** Tiny previews: only the letters of the crate's name, for the font picker. */
const previewed = new Set();
function previewFonts(fonts, text) {
  const key = (f) => f.id + "|" + text;
  const want = fonts.filter((f) => !loadedFonts.has(f.id) && !previewed.has(key(f)));
  for (let i = 0; i < want.length; i += 15) {
    const batch = want.slice(i, i + 15);
    batch.forEach((f) => previewed.add(key(f)));
    const link = document.createElement("link");
    link.rel = "stylesheet";
    link.href = "https://fonts.googleapis.com/css2?" + batch.map((f) => "family=" + f.q.replace(/ /g, "+")).join("&") +
      "&text=" + encodeURIComponent(text + text.toUpperCase()) + "&display=swap";
    document.head.append(link);
  }
}

// ------------------------------------------------------------------ cards

/** The cover art for a crate, as an element that fills its 3:1 box. */
function coverHtml(s) {
  const img = s.cover;
  if (img && (img.src || img.data)) {
    const size = img.size || 100, x = img.x ?? 50, y = img.y ?? 50;
    return `<span class="cover-art" style="background-image:url('${esc(img.src || img.data)}');background-size:${size}% auto;background-position:${x}% ${y}%"></span>`;
  }
  const covers = (s.albums || []).map((a) => a.cover).filter(Boolean).slice(0, 3);
  if (!covers.length) return `<span class="cover-art cover-empty"></span>`;
  while (covers.length < 3) covers.push(covers[covers.length % covers.length]);
  return `<span class="cover-art collage">${covers.map((c) => `<img src="${esc(c)}" alt="" loading="lazy">`).join("")}</span>`;
}

// Title colors. Dark ones get a light glow behind them instead of a dark one.
const TITLE_COLORS = ["#ffffff", "#f3ead7", "#111111", "#f0b44c", "#ff5a4f", "#ff7ac6", "#5ee0ff", "#a6ff5c", "#b18cff", "#ffe14d"];
function isDark(hex) {
  const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex || "");
  if (!m) return false;
  const [r, g, b] = m.slice(1).map((x) => parseInt(x, 16) / 255);
  return 0.2126 * r + 0.7152 * g + 0.0722 * b < 0.45;
}

function crateCard(s, { tag = "a", cls = "crate-card", title = "span", count = true, draggable = false } = {}) {
  ensureFonts([s.font]);
  const href = tag === "a" ? ` href="#shelf-${s.id}"` : "";
  const ink = s.titleColor || "#ffffff";
  return `<${tag} class="${cls}${isDark(ink) ? " ink-dark" : ""}"${href} data-shelf="${s.id}"${draggable ? ' draggable="true"' : ""}>
    ${coverHtml(s)}<span class="cc-scrim"></span>
    <${title} class="cc-title" style="${fontStyle(s)};color:${esc(ink)}">${esc(s.name || "Untitled")}</${title}>
    ${count ? `<span class="cc-count">${(s.albums || []).length}</span>` : ""}
  </${tag}>`;
}

// ------------------------------------------------------------------ the "Edit crate" dialog

const ED = { query: "", shelfId: null, name: "", note: "", titleColor: "#ffffff", mode: "auto", src: "", data: "", size: 100, x: 50, y: 50, font: "", ratio: 1, shown: [], armed: false };
const FONT_GRID = 12;

function openCrateEditor(shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  const c = s.cover || {};
  Object.assign(ED, {
    shelfId, name: s.name || "", note: s.note || "", titleColor: s.titleColor || "#ffffff", mode: c.src || c.data ? "image" : "auto",
    src: c.src || "", data: c.data || "", size: c.size || 100, x: c.x ?? 50, y: c.y ?? 50,
    font: s.font || FONTS[0].id, ratio: 1, armed: false,
  });
  ED.initial = editorSnapshot();
  ED.query = "";
  ED.shown = [ED.font, ...Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => id !== ED.font), Catalog.rng(Math.random())).slice(0, FONT_GRID - 1)];
  let dlg = $("#cover-editor");
  if (!dlg) {
    document.body.insertAdjacentHTML("beforeend", `<dialog id="cover-editor" class="cover-editor" aria-label="Edit crate"></dialog>`);
    dlg = $("#cover-editor");
    dlg.addEventListener("click", (e) => { if (e.target === dlg) tryCloseEditor(); });
    // Esc asks too, when there are changes.
    dlg.addEventListener("cancel", (e) => { e.preventDefault(); tryCloseEditor(); });
  }
  drawEditor();
  dlg.showModal();
  measureImage();
}
const openCoverEditor = openCrateEditor; // older callers

const editorSnapshot = () => JSON.stringify([ED.name, ED.note, ED.titleColor, ED.mode, ED.src, ED.data.length, ED.size, Math.round(ED.x), Math.round(ED.y), ED.font]);
function tryCloseEditor() {
  if (editorSnapshot() !== ED.initial && !confirm("You have unsaved changes to this crate. Close without saving?")) return;
  $("#cover-editor").close();
}

function editorCrate() {
  const s = shelfById(ED.shelfId);
  return { ...s, name: ED.name || s.name, titleColor: ED.titleColor, font: ED.font, cover: ED.mode === "image" ? { src: ED.src, data: ED.data, size: ED.size, x: ED.x, y: ED.y } : null };
}

function drawEditor() {
  const s = shelfById(ED.shelfId);
  const dlg = $("#cover-editor");
  const covers = [...new Map(s.albums.filter((a) => a.cover).map((a) => [a.cover, a])).values()];

  dlg.innerHTML = `
    <form method="dialog" class="ce-body">
      <div class="ce-sticky">
      <div class="ce-head"><h2>Edit crate</h2><button type="button" class="link" id="ce-close">Close</button></div>
      <div class="ce-preview">
        <div class="crop-frame ${ED.mode === "image" ? "can-pan" : ""}" id="crop-frame">${crateCard(editorCrate(), { tag: "div", cls: "crate-card ce-card", count: false })}</div>
        ${ED.mode === "image" ? `
          <label class="ce-zoom"><span class="meta">Zoom</span><input type="range" id="ce-zoom" min="100" max="400" step="1" value="${ED.size}"></label>
          <p class="meta ce-hint">Drag the picture to choose what shows.</p>` : ""}
      </div>
      </div>
      <div class="ce-fields">
        <label class="ce-field"><span class="label">Name</span><input id="ce-name" value="${esc(ED.name)}" autocomplete="off" maxlength="80"></label>
        <label class="ce-field"><span class="label">Notes</span>
          <textarea id="ce-note" rows="2" placeholder="What this crate is: the years, the car, the friends…">${esc(ED.note)}</textarea></label>
      </div>
      <div class="ce-section">
        <div class="label">Title color</div>
        <div class="ce-colors">
          ${TITLE_COLORS.map((c) => `<button type="button" class="sw ${c === ED.titleColor ? "on" : ""}" data-ce-color="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}
          <input type="color" id="ce-color" value="${esc(ED.titleColor)}" aria-label="Any color">
        </div>
      </div>
      <div class="ce-section">
        <div class="label">Cover picture</div>
        <div class="ce-sources">
          <button type="button" class="btn ${ED.mode === "auto" ? "primary" : ""}" data-ce-auto="1">First three covers</button>
          <label class="btn">Upload an image…<input type="file" id="ce-file" accept="image/*" hidden></label>
        </div>
        ${covers.length ? `<div class="ce-thumbs">${covers.map((a) => `<button type="button" class="ce-thumb ${ED.mode === "image" && ED.src === a.cover ? "on" : ""}" data-ce-src="${esc(a.cover)}" title="${esc(a.title)}"><img src="${esc(a.cover)}" alt="${esc(a.title)}" loading="lazy"></button>`).join("")}</div>` : ""}
      </div>
      <div class="ce-section">
        <div class="ce-font-head"><div class="label">Title font</div>
          <input type="search" id="ce-font-search" placeholder="Search fonts by name" value="${esc(ED.query)}" autocomplete="off" aria-label="Search fonts">
          <button type="button" class="btn" id="ce-shuffle" title="Keep the selected font, swap all the others">Shuffle fonts</button></div>
        <div class="ce-fonts" id="ce-fonts"></div>
      </div>
      <div class="ce-foot"><button type="button" class="btn" id="ce-cancel">Cancel</button><button type="button" class="btn primary" id="ce-save">Save</button></div>
      <div class="ce-danger">
        <button type="button" class="btn danger" id="ce-delete">${ED.armed ? `Click again to delete “${esc(s.name)}”` : "Delete crate"}</button>
        <span class="meta">${s.albums.length ? `Removes the crate and its ${discs(s.albums.length)}. Albums that are also in other crates stay there.` : "This crate is empty."}</span>
      </div>
    </form>`;
  wireEditor();
}

/** Redraw only the preview card, so dragging and typing stay smooth. */
function refreshPreview() {
  const frame = $("#crop-frame");
  if (frame) frame.innerHTML = crateCard(editorCrate(), { tag: "div", cls: "crate-card ce-card", count: false });
}

function measureImage() {
  if (ED.mode !== "image") return;
  const im = new Image();
  im.onload = () => { ED.ratio = im.naturalHeight / im.naturalWidth || 1; };
  im.src = ED.src || ED.data;
}

/** The font grid on its own, so searching doesn't redraw (and unfocus) the rest of the dialog. */
function drawFontGrid() {
  const s = shelfById(ED.shelfId), grid = $("#ce-fonts");
  if (!grid) return;
  const q = ED.query.trim().toLowerCase();
  const list = q
    ? FONTS.filter((f) => f.name.toLowerCase().includes(q) || f.id.includes(q.replace(/\s+/g, "-"))).slice(0, 24)
    : ED.shown.map((id) => FONTS.find((f) => f.id === id)).filter(Boolean);
  const label = ED.name || s.name;
  previewFonts(list, label);
  grid.innerHTML = list.length
    ? list.map((f) => `<button type="button" class="ce-font ${ED.font === f.id ? "on" : ""}" data-ce-font="${f.id}" title="${esc(f.name)}"
        style="${fontCss(f)}"><span>${esc(label)}</span><small>${esc(f.name)}</small></button>`).join("")
    : `<p class="meta ce-hint">No font called “${esc(ED.query)}”.</p>`;
  grid.querySelectorAll("[data-ce-font]").forEach((b) => (b.onclick = () => {
    ED.font = b.dataset.ceFont;
    ensureFonts([ED.font]);
    grid.querySelectorAll("[data-ce-font]").forEach((x) => x.classList.toggle("on", x === b));
    refreshPreview();
  }));
}

function wireEditor() {
  const dlg = $("#cover-editor");
  drawFontGrid();
  $("#ce-font-search").oninput = (e) => { ED.query = e.target.value; drawFontGrid(); };
  $("#ce-name").oninput = (e) => {
    ED.name = e.target.value;
    refreshPreview();
    dlg.querySelectorAll(".ce-font span").forEach((x) => (x.textContent = ED.name || "Untitled"));
  };
  $("#ce-name").onchange = () => drawFontGrid();
  $("#ce-note").oninput = (e) => { ED.note = e.target.value; };
  dlg.querySelectorAll("[data-ce-color]").forEach((b) => (b.onclick = () => {
    ED.titleColor = b.dataset.ceColor;
    dlg.querySelectorAll("[data-ce-color]").forEach((x) => x.classList.toggle("on", x === b));
    $("#ce-color").value = ED.titleColor;
    refreshPreview();
  }));
  $("#ce-color").oninput = (e) => { ED.titleColor = e.target.value; dlg.querySelectorAll("[data-ce-color]").forEach((x) => x.classList.remove("on")); refreshPreview(); };
  $("#ce-close").onclick = $("#ce-cancel").onclick = tryCloseEditor;
  dlg.querySelector("[data-ce-auto]").onclick = () => { ED.mode = "auto"; drawEditor(); };
  dlg.querySelectorAll("[data-ce-src]").forEach((b) => (b.onclick = () => {
    Object.assign(ED, { mode: "image", src: b.dataset.ceSrc, data: "", size: 100, x: 50, y: 50 });
    drawEditor(); measureImage();
  }));
  $("#ce-shuffle").onclick = () => {
    // Keep the selected font where it is; replace every other slot with fonts not on screen.
    if (!ED.shown.includes(ED.font)) ED.shown = [ED.font, ...ED.shown.slice(0, FONT_GRID - 1)];
    const keep = new Set(ED.shown);
    const fresh = Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => !keep.has(id)), Catalog.rng(Math.random()));
    const pool = fresh.length >= FONT_GRID - 1 ? fresh : Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => id !== ED.font), Catalog.rng(Math.random()));
    let n = 0;
    ED.shown = ED.shown.map((id) => (id === ED.font ? id : pool[n++]));
    ED.query = "";
    $("#ce-font-search").value = "";
    drawFontGrid();
    dlg.querySelector(".ce-fonts")?.scrollIntoView({ block: "nearest" });
  };
  $("#ce-file").onchange = async (e) => {
    const f = e.target.files[0];
    if (!f) return;
    try {
      Object.assign(ED, { mode: "image", src: "", data: await shrinkImage(f), size: 100, x: 50, y: 50 });
      drawEditor(); measureImage();
    } catch { toast("That image couldn't be used. Try a JPG or PNG."); }
  };
  const zoom = $("#ce-zoom");
  if (zoom) zoom.oninput = () => { ED.size = Number(zoom.value); refreshPreview(); };
  $("#ce-save").onclick = saveCrate;
  $("#ce-delete").onclick = deleteCrate;
  // Drag to pan: background-position runs opposite to the pointer.
  const frame = $("#crop-frame");
  if (ED.mode === "image") {
    let start = null;
    frame.onpointerdown = (e) => { start = { px: e.clientX, py: e.clientY, x: ED.x, y: ED.y }; frame.setPointerCapture(e.pointerId); };
    frame.onpointermove = (e) => {
      if (!start) return;
      const w = frame.clientWidth, h = frame.clientHeight;
      const imgW = (w * ED.size) / 100, imgH = imgW * ED.ratio;
      const spareX = imgW - w, spareY = imgH - h;
      if (spareX > 1) ED.x = Math.min(100, Math.max(0, start.x - ((e.clientX - start.px) / spareX) * 100));
      if (spareY > 1) ED.y = Math.min(100, Math.max(0, start.y - ((e.clientY - start.py) / spareY) * 100));
      refreshPreview();
    };
    frame.onpointerup = frame.onpointercancel = () => { start = null; };
  }
}

async function shrinkImage(file) {
  const bmp = await createImageBitmap(file);
  const scale = Math.min(1, 1800 / Math.max(bmp.width, bmp.height));
  const c = document.createElement("canvas");
  c.width = Math.round(bmp.width * scale); c.height = Math.round(bmp.height * scale);
  c.getContext("2d").drawImage(bmp, 0, 0, c.width, c.height);
  let q = 0.85, data = c.toDataURL("image/jpeg", q);
  while (data.length > 700000 && q > 0.4) { q -= 0.1; data = c.toDataURL("image/jpeg", q); }
  return data;
}

async function saveCrate() {
  const id = ED.shelfId, s = shelfById(id);
  const name = ED.name.trim();
  if (!name) { toast("Give the crate a name."); $("#ce-name").focus(); return; }
  const btn = $("#ce-save");
  btn.disabled = true; btn.textContent = "Saving…";
  let ok = true;
  if (ED.mode === "image") {
    const img = { size: Math.round(ED.size), x: Math.round(ED.x * 10) / 10, y: Math.round(ED.y * 10) / 10, ...(ED.data ? { data: ED.data } : { src: ED.src }) };
    ok = await write(() => Store.set("images", id, img));
  } else if (s.cover) {
    ok = await write(() => Store.remove("images", id));
  }
  const patch = {};
  if (name !== s.name) patch.name = name;
  if (ED.note.trim() !== (s.note || "")) patch.note = ED.note.trim();
  if (ED.titleColor !== (s.titleColor || "#ffffff")) patch.titleColor = ED.titleColor;
  if (ED.font !== (s.font || FONTS[0].id)) patch.font = ED.font;
  if (ok && Object.keys(patch).length) ok = await write(() => Store.update("shelves", id, patch));
  $("#cover-editor").close();
  if (ok) toast(`Saved ${name}`);
}

async function deleteCrate() {
  const s = shelfById(ED.shelfId);
  if (!ED.armed) { ED.armed = true; drawEditor(); setTimeout(() => { if (ED.armed && ED.shelfId === s.id && $("#cover-editor")?.open) { ED.armed = false; drawEditor(); } }, 5000); return; }
  const btn = $("#ce-delete");
  btn.disabled = true; btn.textContent = "Deleting…";
  for (const a of s.albums) await write(() => Store.remove("albums", a.id));
  await write(() => Store.remove("images", s.id));
  const ok = await write(() => Store.remove("shelves", s.id));
  $("#cover-editor").close();
  if (ok) { toast(`Deleted ${s.name}`); location.hash = "home"; }
}

// ------------------------------------------------------------------ reorder crates by dragging them in the sidebar

let crateDrag = null;
function wireCrateReorder(nav) {
  nav.addEventListener("dragstart", (e) => {
    const card = e.target.closest?.(".crate-card[draggable]");
    if (!card || dragId) return; // album drags are handled elsewhere
    crateDrag = card.dataset.shelf;
    card.classList.add("dragging");
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", "crate:" + crateDrag);
  });
  nav.addEventListener("dragover", (e) => {
    if (!crateDrag) return;
    const card = e.target.closest(".crate-card");
    if (!card || card.dataset.shelf === crateDrag) return;
    e.preventDefault();
    const r = card.getBoundingClientRect();
    const after = window.matchMedia("(max-width: 760px)").matches ? e.clientX > r.left + r.width / 2 : e.clientY > r.top + r.height / 2;
    nav.querySelectorAll(".drop-before, .drop-after").forEach((x) => x.classList.remove("drop-before", "drop-after"));
    card.classList.add(after ? "drop-after" : "drop-before");
  });
  nav.addEventListener("drop", async (e) => {
    if (!crateDrag) return;
    const card = e.target.closest(".crate-card");
    const from = crateDrag;
    crateDrag = null;
    if (!card || card.dataset.shelf === from) return;
    e.preventDefault();
    const after = card.classList.contains("drop-after");
    const ids = S.lib.shelves.map((x) => x.id).filter((id) => id !== from);
    ids.splice(ids.indexOf(card.dataset.shelf) + (after ? 1 : 0), 0, from);
    for (const [k, id] of ids.entries()) {
      if ((shelfById(id)?.order ?? -1) !== k) await write(() => Store.update("shelves", id, { order: k }));
    }
  });
  nav.addEventListener("dragend", () => {
    crateDrag = null;
    nav.querySelectorAll(".dragging, .drop-before, .drop-after").forEach((x) => x.classList.remove("dragging", "drop-before", "drop-after"));
  });
}

// The sidebar is in the page from the start, so reordering can be switched on right away.
wireCrateReorder(document.getElementById("shelf-nav"));

// ===== history.js =====
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
            <div class="t"><span class="rank">${n + 1}</span>${esc(a.title)}${yearTag(HIST.found.get(a.k))}${a.editions > 1 ? ` <span class="meta" title="Plays from ${a.editions} editions are combined">${a.editions} editions</span>` : ""}</div><div class="s">${esc(a.artist)}</div>
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
    const t = hit?.year && view.querySelector(`.hist-row[data-hk="${CSS.escape(a.k)}"] .t`);
    if (t && !t.querySelector(".yr-t")) t.insertAdjacentHTML("beforeend", yearTag(hit));
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

// ===== landing.js =====
// The home page: quick ways into music you already love.
//  1. Easy picks: albums you know (in your crates or listened to a lot), a random handful.
//  2. New from artists you love: recent-ish albums from your most-played artists.
//  3. Worth revisiting: albums you played a lot, but not for a long time.
"use strict";

const LAND = { seeds: { easy: 1, fresh: 1, revisit: 1 }, covers: new Map(), found: new Map(), freshCache: new Map() };
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
    <div class="album-title">${esc(a.title)}${yearTag(a.year ? a : LAND.found?.get(a.k))}</div>
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
    if (hit) LAND.found.set(a.k, hit);
    if (hit?.year) view.querySelectorAll(`.land-card[data-lk="${CSS.escape(a.k)}"] .album-title`).forEach((el) => { if (!el.querySelector(".yr-t")) el.insertAdjacentHTML("beforeend", yearTag(hit)); });
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

// ===== vault.js =====
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
    <label class="meta vault-check"><input type="checkbox" id="vault-hide-sorted" ${hideSorted ? "checked" : ""}> Hide albums already in a crate (${counts.sorted})</label>
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
          <span class="vt"><b>${esc(a.title)}${yearTag(a)}</b><small>${esc(a.artist)}${a.genre ? " · " + esc(a.genre) : ""}</small></span>
          <span class="num">${a.songs}</span><span class="num">${a.plays.toLocaleString()}</span>
          <span class="num">${shortDate(a.added)}</span><span class="stars">${stars(a.stars)}</span>
          <span class="vact">${have ? `<span class="meta"><i class="dot" style="background:${esc(have.shelf.color)}"></i>${esc(have.shelf.name)}</span>`
            : `<select aria-label="Crate for ${esc(a.title)}"><option value="">Add to…</option>${shelfOptions("")}</select>`}</span>
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

// ===== start, now that everything above is set up =====
bootCrate();
