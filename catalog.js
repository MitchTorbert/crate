// Catalog lookups, live from the browser.
// Deezer's public API (no key) supplies album search, covers, discographies and
// related artists. Deezer sends no CORS headers, so calls go through JSONP.
"use strict";

const Catalog = (() => {
  const TTL = 7 * 24 * 3600 * 1000;
  const GAP = 120; // ms between calls; Deezer allows 50 per 5 seconds
  let seq = 0, last = 0, chain = Promise.resolve();

  const cacheGet = (k) => {
    try {
      const v = JSON.parse(localStorage.getItem("dz:" + k));
      return v && Date.now() - v.t < TTL ? v.d : null;
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
  function call(path, params = {}, { cache = true } = {}) {
    const key = path + "?" + new URLSearchParams(params);
    const hit = cache && cacheGet(key);
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

  const norm = (s) => String(s || "").toLowerCase()
    .replace(/\s*[\(\[][^)\]]*(deluxe|edition|remaster|anniversary|expanded|bonus|explicit|reissue|version)[^)\]]*[\)\]]/g, "")
    .replace(/[^a-z0-9]+/g, "");
  const clean = (t) => String(t || "").replace(/\s*[\(\[][^)\]]*(deluxe|edition|remaster|anniversary|expanded|bonus|explicit|reissue)[^)\]]*[\)\]]/gi, "").trim() || t;
  const SKIP = /\b(live|acoustic|instrumental|karaoke|commentary|tribute|greatest|hitz|best of|collection|essential|anthology|playlist|addendum|play your old stuff)\b/i;

  function album(a, artist) {
    artist = artist || a.artist || {};
    const y = (a.release_date || "").slice(0, 4);
    return {
      deezerId: a.id, title: clean(a.title), artist: artist.name || "", artistId: artist.id ?? null,
      year: /^\d{4}$/.test(y) ? Number(y) : null, cover: a.cover_big || a.cover_medium || "",
      type: a.record_type || "album", fans: a.fans || 0,
    };
  }

  async function search(q, limit = 20) {
    const d = await call("/search/album", { q, limit: 40 }, { cache: false });
    const seen = new Set(), out = [];
    for (const a of d?.data || []) {
      if (a.record_type === "single" && (a.nb_tracks || 1) < 4) continue;
      const k = norm(a.title) + "|" + a.artist?.id;
      if (seen.has(k)) continue;
      seen.add(k);
      out.push(album(a));
      if (out.length >= limit) break;
    }
    return out;
  }

  async function detail(id) {
    const a = await call(`/album/${id}`);
    return a ? album(a) : null;
  }

  async function artistAlbums(artistId) {
    const [d, artist] = await Promise.all([call(`/artist/${artistId}/albums`, { limit: 100 }), call(`/artist/${artistId}`)]);
    const seen = new Set(), out = [];
    for (const a of d?.data || []) {
      if (a.record_type !== "album" || SKIP.test(a.title)) continue;
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

  return { search, detail, artistAlbums, related, suggest, norm, ytSearchUrl, resolveYouTube, rng, shuffle };
})();
