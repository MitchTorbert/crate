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

function crateCard(s, { tag = "a", cls = "crate-card", title = "span", count = true, draggable = false } = {}) {
  ensureFonts([s.font]);
  const href = tag === "a" ? ` href="#shelf-${s.id}"` : "";
  return `<${tag} class="${cls}"${href} data-shelf="${s.id}"${draggable ? ' draggable="true"' : ""} style="--shelf:${esc(s.color)}">
    ${coverHtml(s)}<span class="cc-scrim"></span>
    <${title} class="cc-title" style="${fontStyle(s)}">${esc(s.name || "Untitled")}</${title}>
    ${count ? `<span class="cc-count">${(s.albums || []).length}</span>` : ""}
  </${tag}>`;
}

// ------------------------------------------------------------------ the "Edit crate" dialog

const ED = { shelfId: null, name: "", note: "", color: "", mode: "auto", src: "", data: "", size: 100, x: 50, y: 50, font: "", ratio: 1, shown: [], armed: false };
const FONT_GRID = 12;

function openCrateEditor(shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  const c = s.cover || {};
  Object.assign(ED, {
    shelfId, name: s.name || "", note: s.note || "", color: s.color, mode: c.src || c.data ? "image" : "auto",
    src: c.src || "", data: c.data || "", size: c.size || 100, x: c.x ?? 50, y: c.y ?? 50,
    font: s.font || FONTS[0].id, ratio: 1, armed: false,
  });
  ED.shown = [ED.font, ...Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => id !== ED.font), Catalog.rng(Math.random())).slice(0, FONT_GRID - 1)];
  let dlg = $("#cover-editor");
  if (!dlg) {
    document.body.insertAdjacentHTML("beforeend", `<dialog id="cover-editor" class="cover-editor" aria-label="Edit crate"></dialog>`);
    dlg = $("#cover-editor");
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  drawEditor();
  dlg.showModal();
  measureImage();
}
const openCoverEditor = openCrateEditor; // older callers

function editorCrate() {
  const s = shelfById(ED.shelfId);
  return { ...s, name: ED.name || s.name, color: ED.color, font: ED.font, cover: ED.mode === "image" ? { src: ED.src, data: ED.data, size: ED.size, x: ED.x, y: ED.y } : null };
}

function drawEditor() {
  const s = shelfById(ED.shelfId);
  const dlg = $("#cover-editor");
  const covers = [...new Map(s.albums.filter((a) => a.cover).map((a) => [a.cover, a])).values()];
  const shownFonts = ED.shown.map((id) => FONTS.find((f) => f.id === id)).filter(Boolean);
  previewFonts(shownFonts, ED.name || s.name);
  dlg.innerHTML = `
    <form method="dialog" class="ce-body">
      <div class="ce-head"><h2>Edit crate</h2><button class="link" value="cancel">Close</button></div>
      <div class="ce-preview">
        <div class="crop-frame ${ED.mode === "image" ? "can-pan" : ""}" id="crop-frame">${crateCard(editorCrate(), { tag: "div", cls: "crate-card ce-card", count: false })}</div>
        ${ED.mode === "image" ? `
          <label class="ce-zoom"><span class="meta">Zoom</span><input type="range" id="ce-zoom" min="100" max="400" step="1" value="${ED.size}"></label>
          <p class="meta ce-hint">Drag the picture to choose what shows.</p>` : ""}
      </div>
      <div class="ce-fields">
        <label class="ce-field"><span class="label">Name</span><input id="ce-name" value="${esc(ED.name)}" autocomplete="off" maxlength="80"></label>
        <label class="ce-field"><span class="label">Description</span>
          <textarea id="ce-note" rows="2" placeholder="What this crate is: the years, the car, the friends…">${esc(ED.note)}</textarea></label>
      </div>
      <div class="ce-section">
        <div class="label">Color</div>
        <div class="ce-colors">
          ${PALETTE.map((c) => `<button type="button" class="sw ${c === ED.color ? "on" : ""}" data-ce-color="${c}" style="background:${c}" aria-label="Use ${c}"></button>`).join("")}
          <input type="color" id="ce-color" value="${esc(ED.color)}" aria-label="Any color">
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
          <button type="button" class="btn" id="ce-shuffle" title="Keep the selected font, swap all the others">Shuffle fonts</button>
          <span class="meta">${FONTS.length} fonts</span></div>
        <div class="ce-fonts">${shownFonts.map((f) => `<button type="button" class="ce-font ${ED.font === f.id ? "on" : ""}" data-ce-font="${f.id}" title="${esc(f.name)}"
          style="${fontCss(f)}"><span>${esc(ED.name || s.name)}</span><small>${esc(f.name)}</small></button>`).join("")}</div>
      </div>
      <div class="ce-foot"><button class="btn" value="cancel">Cancel</button><button type="button" class="btn primary" id="ce-save">Save</button></div>
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

function wireEditor() {
  const dlg = $("#cover-editor");
  $("#ce-name").oninput = (e) => {
    ED.name = e.target.value;
    refreshPreview();
    dlg.querySelectorAll(".ce-font span").forEach((x) => (x.textContent = ED.name || "Untitled"));
  };
  $("#ce-name").onchange = () => previewFonts(ED.shown.map((id) => FONTS.find((f) => f.id === id)), ED.name);
  $("#ce-note").oninput = (e) => { ED.note = e.target.value; };
  dlg.querySelectorAll("[data-ce-color]").forEach((b) => (b.onclick = () => {
    ED.color = b.dataset.ceColor;
    dlg.querySelectorAll("[data-ce-color]").forEach((x) => x.classList.toggle("on", x === b));
    $("#ce-color").value = ED.color;
    refreshPreview();
  }));
  $("#ce-color").oninput = (e) => { ED.color = e.target.value; dlg.querySelectorAll("[data-ce-color]").forEach((x) => x.classList.remove("on")); refreshPreview(); };
  dlg.querySelector("[data-ce-auto]").onclick = () => { ED.mode = "auto"; drawEditor(); };
  dlg.querySelectorAll("[data-ce-src]").forEach((b) => (b.onclick = () => {
    Object.assign(ED, { mode: "image", src: b.dataset.ceSrc, data: "", size: 100, x: 50, y: 50 });
    drawEditor(); measureImage();
  }));
  dlg.querySelectorAll("[data-ce-font]").forEach((b) => (b.onclick = () => {
    ED.font = b.dataset.ceFont;
    ensureFonts([ED.font]);
    dlg.querySelectorAll("[data-ce-font]").forEach((x) => x.classList.toggle("on", x === b));
    refreshPreview();
  }));
  $("#ce-shuffle").onclick = () => {
    // Keep the selected font where it is; replace every other slot with fonts not on screen.
    const keep = new Set(ED.shown);
    const fresh = Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => !keep.has(id)), Catalog.rng(Math.random()));
    const pool = fresh.length >= FONT_GRID - 1 ? fresh : Catalog.shuffle(FONTS.map((f) => f.id).filter((id) => id !== ED.font), Catalog.rng(Math.random()));
    let n = 0;
    ED.shown = ED.shown.map((id) => (id === ED.font ? id : pool[n++]));
    drawEditor();
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
  if (ED.color !== s.color) patch.color = ED.color;
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
