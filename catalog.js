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
  async function suggest(shelfAlbums, { n = 8, seed = "0", owned = () => false, libraryArtists = new Set() } = {}) {
    const r = rng(seed);
    const artists = new Map();
    for (const a of shelfAlbums) if (a.artistId) artists.set(a.artistId, a.artist);
    if (!artists.size) return [];
    const seeds = shuffle([...artists], r).slice(0, 4);

    const deep = [], rel = [];
    for (const [id, name] of seeds) {
      for (const a of await artistAlbums(id)) if (!owned(a)) deep.push({ ...a, reason: `More ${name}` });
      for (const x of (await related(id)).slice(0, 6)) if (!libraryArtists.has(x.id)) rel.push([x, name]);
    }
    const picked = [], seenArtists = new Set();
    for (const [x, name] of shuffle(rel, r)) {
      if (seenArtists.has(x.id)) continue;
      seenArtists.add(x.id);
      picked.push([x, name]);
      if (picked.length >= n) break;
    }
    const similar = [];
    for (const [x, name] of picked) {
      const albums = (await artistAlbums(x.id)).filter((a) => !owned(a)).sort((a, b) => b.fans - a.fans);
      if (albums.length) similar.push({ ...albums[Math.floor(r() * Math.min(2, albums.length))], reason: `If you like ${name}` });
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
        if (a.released >= since) out.push(a);
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
      const fresh = (await artistAlbums(id, { name: e.name }).catch(() => [])).filter((a) => a.released >= since)
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

  return { search, find, toDeezer, sim, detail, newFrom, newNearby, artistAlbums, related, suggest, norm, ytSearchUrl, resolveYouTube, rng, shuffle };
})();
