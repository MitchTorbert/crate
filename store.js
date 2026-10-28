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
