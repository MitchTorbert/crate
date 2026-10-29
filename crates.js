// Crate covers and title fonts.
// A crate's cover is either its first three album covers side by side (the default; 3:1
// fits three squares exactly) or one image, an album cover from the crate or an upload,
// cropped with a pan and a zoom. The crop is kept as CSS background numbers, so album art
// stays a link to the image rather than a copy.
"use strict";

// Free Google Fonts: Crate loads them itself, so they look the same on Mac, PC and iPhone.
const FONTS = [
  { id: "big-shoulders", name: "Big Shoulders", family: "'Big Shoulders Display'", weight: 900, upper: true },
  { id: "anton", name: "Anton", family: "'Anton'", weight: 400, upper: true },
  { id: "bebas", name: "Bebas Neue", family: "'Bebas Neue'", weight: 400, upper: true },
  { id: "oswald", name: "Oswald", family: "'Oswald'", weight: 700, upper: true },
  { id: "archivo-black", name: "Archivo Black", family: "'Archivo Black'", weight: 400, upper: false },
  { id: "unbounded", name: "Unbounded", family: "'Unbounded'", weight: 800, upper: false },
  { id: "syne", name: "Syne", family: "'Syne'", weight: 800, upper: false },
  { id: "space-grotesk", name: "Space Grotesk", family: "'Space Grotesk'", weight: 700, upper: false },
  { id: "abril", name: "Abril Fatface", family: "'Abril Fatface'", weight: 400, upper: false },
  { id: "dm-serif", name: "DM Serif Display", family: "'DM Serif Display'", weight: 400, upper: false },
  { id: "fraunces", name: "Fraunces", family: "'Fraunces'", weight: 900, upper: false },
  { id: "righteous", name: "Righteous", family: "'Righteous'", weight: 400, upper: false },
  { id: "bungee", name: "Bungee", family: "'Bungee'", weight: 400, upper: true },
  { id: "rubik-mono", name: "Rubik Mono One", family: "'Rubik Mono One'", weight: 400, upper: true },
  { id: "marker", name: "Permanent Marker", family: "'Permanent Marker'", weight: 400, upper: false },
];
const fontOf = (s) => FONTS.find((f) => f.id === s?.font) || FONTS[0];
const fontStyle = (s) => { const f = fontOf(s); return `font-family:${f.family},'Arial Narrow',sans-serif;font-weight:${f.weight};text-transform:${f.upper ? "uppercase" : "none"}`; };

/** The cover art for a crate, as an element that fills its 3:1 box. */
function coverHtml(s) {
  const img = s.cover;
  if (img && (img.src || img.data)) {
    const size = img.size || 100, x = img.x ?? 50, y = img.y ?? 50;
    return `<span class="cover-art" style="background-image:url('${esc(img.src || img.data)}');background-size:${size}% auto;background-position:${x}% ${y}%"></span>`;
  }
  const covers = s.albums.map((a) => a.cover).filter(Boolean).slice(0, 3);
  if (!covers.length) return `<span class="cover-art cover-empty"></span>`;
  while (covers.length < 3) covers.push(covers[covers.length % covers.length]);
  return `<span class="cover-art collage">${covers.map((c) => `<img src="${esc(c)}" alt="" loading="lazy">`).join("")}</span>`;
}

function crateCard(s, { tag = "a", cls = "crate-card", title = "span", count = true } = {}) {
  const href = tag === "a" ? ` href="#shelf-${s.id}"` : "";
  return `<${tag} class="${cls}"${href} data-shelf="${s.id}" style="--shelf:${esc(s.color)}">
    ${coverHtml(s)}<span class="cc-scrim"></span>
    <${title} class="cc-title" style="${fontStyle(s)}">${esc(s.name)}</${title}>
    ${count ? `<span class="cc-count">${s.albums.length}</span>` : ""}
  </${tag}>`;
}

// ------------------------------------------------------------------ cover editor

const ED = { shelfId: null, mode: "auto", src: "", data: "", size: 100, x: 50, y: 50, font: "", ratio: 1 };

function openCoverEditor(shelfId) {
  const s = shelfById(shelfId);
  if (!s) return;
  const c = s.cover || {};
  Object.assign(ED, { shelfId, mode: c.src || c.data ? "image" : "auto", src: c.src || "", data: c.data || "", size: c.size || 100, x: c.x ?? 50, y: c.y ?? 50, font: s.font || FONTS[0].id, ratio: 1 });
  let dlg = $("#cover-editor");
  if (!dlg) {
    document.body.insertAdjacentHTML("beforeend", `<dialog id="cover-editor" class="cover-editor" aria-label="Crate cover"></dialog>`);
    dlg = $("#cover-editor");
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
  }
  drawEditor();
  dlg.showModal();
  measureImage();
}

function editorCrate() {
  const s = shelfById(ED.shelfId);
  return { ...s, font: ED.font, cover: ED.mode === "image" ? { src: ED.src, data: ED.data, size: ED.size, x: ED.x, y: ED.y } : null };
}

function drawEditor() {
  const s = shelfById(ED.shelfId);
  const dlg = $("#cover-editor");
  const covers = [...new Map(s.albums.filter((a) => a.cover).map((a) => [a.cover, a])).values()];
  dlg.innerHTML = `
    <form method="dialog" class="ce-body">
      <div class="ce-head"><h2>Cover for ${esc(s.name)}</h2><button class="link" value="cancel" aria-label="Close">Close</button></div>
      <div class="ce-preview">
        <div class="crop-frame ${ED.mode === "image" ? "can-pan" : ""}" id="crop-frame">${crateCard(editorCrate(), { tag: "div", cls: "crate-card ce-card", count: false })}</div>
        ${ED.mode === "image" ? `
          <label class="ce-zoom"><span class="meta">Zoom</span><input type="range" id="ce-zoom" min="100" max="400" step="1" value="${ED.size}"></label>
          <p class="meta ce-hint">Drag the picture to choose what shows.</p>` : `<p class="meta ce-hint">Using the first three covers in this crate. Pick one below, or upload your own image.</p>`}
      </div>
      <div class="ce-section">
        <div class="label">Picture</div>
        <div class="ce-sources">
          <button type="button" class="btn ${ED.mode === "auto" ? "primary" : ""}" data-ce-auto="1">First three covers</button>
          <label class="btn">Upload an image…<input type="file" id="ce-file" accept="image/*" hidden></label>
        </div>
        ${covers.length ? `<div class="ce-thumbs">${covers.map((a) => `<button type="button" class="ce-thumb ${ED.mode === "image" && ED.src === a.cover ? "on" : ""}" data-ce-src="${esc(a.cover)}" title="${esc(a.title)}"><img src="${esc(a.cover)}" alt="${esc(a.title)}" loading="lazy"></button>`).join("")}</div>` : ""}
      </div>
      <div class="ce-section">
        <div class="label">Title font</div>
        <div class="ce-fonts">${FONTS.map((f) => `<button type="button" class="ce-font ${ED.font === f.id ? "on" : ""}" data-ce-font="${f.id}" title="${esc(f.name)}"
          style="font-family:${f.family},sans-serif;font-weight:${f.weight};text-transform:${f.upper ? "uppercase" : "none"}">${esc(s.name)}</button>`).join("")}</div>
      </div>
      <div class="ce-foot"><button class="btn" value="cancel">Cancel</button><button type="button" class="btn primary" id="ce-save">Save</button></div>
    </form>`;
  wireEditor();
}

/** Redraw only the preview card, so dragging stays smooth. */
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
  dlg.querySelector("[data-ce-auto]").onclick = () => { ED.mode = "auto"; drawEditor(); };
  dlg.querySelectorAll("[data-ce-src]").forEach((b) => (b.onclick = () => {
    Object.assign(ED, { mode: "image", src: b.dataset.ceSrc, data: "", size: 100, x: 50, y: 50 });
    drawEditor(); measureImage();
  }));
  dlg.querySelectorAll("[data-ce-font]").forEach((b) => (b.onclick = () => {
    ED.font = b.dataset.ceFont;
    dlg.querySelectorAll("[data-ce-font]").forEach((x) => x.classList.toggle("on", x === b));
    refreshPreview();
  }));
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
  $("#ce-save").onclick = saveCover;
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

async function saveCover() {
  const id = ED.shelfId, s = shelfById(id);
  const btn = $("#ce-save");
  btn.disabled = true; btn.textContent = "Saving…";
  let ok = true;
  if (ED.mode === "image") {
    const img = { size: Math.round(ED.size), x: Math.round(ED.x * 10) / 10, y: Math.round(ED.y * 10) / 10, ...(ED.data ? { data: ED.data } : { src: ED.src }) };
    ok = await write(() => Store.set("images", id, img));
  } else if (s.cover) {
    ok = await write(() => Store.remove("images", id));
  }
  if (ok && ED.font !== (s.font || FONTS[0].id)) ok = await write(() => Store.update("shelves", id, { font: ED.font }));
  $("#cover-editor").close();
  if (ok) toast(`Saved the cover for ${s.name}`);
}
