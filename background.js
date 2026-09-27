// Service worker — all capture logic. No chrome.debugger (blocked on managed
// profiles); everything works with scripting + host access.
//
//   full      -> detect what scrolls: an inner panel, the document, OR a big
//                cross-origin iframe (Shopify theme editor, embedded previews).
//                Scroll it tile by tile and capture each viewport. Fixed
//                elements are hidden after the first tile; sticky headers and
//                footers are found from the DOM and by comparing neighbouring
//                tiles, and trimmed where tiles overlap. Then stitch.
//   visible   -> single capture of the current viewport.
//   selection -> capture the viewport, crop to a user-dragged rectangle.
//
// Results are handed to an extension-owned preview tab (Download / Copy) via
// IndexedDB, or saved straight to Downloads through a page-injected link.

importScripts("idb.js");

const MAX_DIM = 32767; // Chrome's canvas limit per side
const MAX_AREA = 120e6; // pixels; bounds encode memory (~480 MB RGBA)
const MAX_TILES = 150;
const MIN_CAPTURE_GAP = 520; // ms — captureVisibleTab allows 2 calls/second
const MIN_SETTLE = 250; // ms between scrolling and capturing a tile
const PAGE_TIMEOUT = 15000; // ms for any single call into the page
const SELECTION_TIMEOUT = 3 * 60 * 1000; // stays under the worker's 5-minute API-call limit

const RESTRICTED_PREFIXES = [
  "chrome://",
  "chrome-untrusted://",
  "chrome-search://",
  "devtools://",
  "edge://",
  "brave://",
  "opera://",
  "vivaldi://",
  "about:",
  "view-source:",
  "chrome-extension://",
  "moz-extension://",
  "https://chrome.google.com/webstore",
  "https://chromewebstore.google.com",
  "https://microsoftedge.microsoft.com/addons",
];

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const errText = (e) => String((e && e.message) || e);

class Cancelled extends Error {}

function withTimeout(promise, ms, message) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(message)), ms);
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

// ===========================================================================
// State, popup messaging and toolbar badge.
// ===========================================================================

let job = null; // the running capture, if any
let lastState = { phase: "idle", at: 0 };
let badgeTimer = 0;

function setState(state) {
  lastState = { ...state, at: Date.now() };
  chrome.runtime.sendMessage({ type: "CAPTURE_STATE", state: lastState }).catch(() => {});
  updateBadge(lastState);
  // Keep the outcome around for a popup opened later (the worker may restart).
  if (["done", "error", "cancelled"].includes(state.phase)) {
    chrome.storage.session.set({ lastState }).catch(() => {});
  }
}

function setProgress(percent, phase = "capturing") {
  setState({ phase, percent: Math.round(clamp(percent, 0, 100)), mode: job && job.mode, target: job && job.target });
}

function updateBadge(s) {
  clearTimeout(badgeTimer);
  const set = (text, color, title) => {
    chrome.action.setBadgeText({ text }).catch(() => {});
    if (color) chrome.action.setBadgeBackgroundColor({ color }).catch(() => {});
    chrome.action.setTitle({ title: title || "Full Page Screenshot" }).catch(() => {});
  };
  switch (s.phase) {
    case "capturing":
    case "saving":
      return set(`${s.percent || 0}%`, "#6366f1");
    case "selecting":
      return set("SEL", "#6366f1", "Full Page Screenshot — drag on the page to select (Esc cancels)");
    case "waiting":
      return set(String(s.seconds), "#6366f1", "Full Page Screenshot — capturing in " + s.seconds + " s");
    case "done":
      set("✓", "#16a34a");
      badgeTimer = setTimeout(() => set(""), 4000);
      return;
    case "error":
      // Stays until the popup has shown the message (or the next capture).
      return set("!", "#dc2626", "Full Page Screenshot — " + s.message);
    default:
      return set("");
  }
}

// ===========================================================================
// Chrome API helpers.
// ===========================================================================

let lastCaptureAt = 0;

async function captureVisible(windowId, opts = { format: "png" }) {
  for (let attempt = 0; attempt < 6; attempt++) {
    const wait = lastCaptureAt + MIN_CAPTURE_GAP - Date.now();
    if (wait > 0) await sleep(wait);
    lastCaptureAt = Date.now();
    try {
      return await withTimeout(
        chrome.tabs.captureVisibleTab(windowId, opts),
        10000,
        "Chrome didn't return a screenshot — keep the window visible and try again."
      );
    } catch (e) {
      const msg = errText(e);
      if (msg.includes("MAX_CAPTURE") || msg.toLowerCase().includes("quota")) {
        await sleep(600 * (attempt + 1));
        continue;
      }
      throw e;
    }
  }
  throw new Error("Screen capture was rate-limited — please try again.");
}

async function dataUrlToBlob(dataUrl) {
  return (await fetch(dataUrl)).blob();
}

async function blobToBase64(blob) {
  const buf = new Uint8Array(await blob.arrayBuffer());
  let bin = "";
  const CHUNK = 0x8000;
  for (let i = 0; i < buf.length; i += CHUNK) bin += String.fromCharCode.apply(null, buf.subarray(i, i + CHUNK));
  return btoa(bin);
}

// Where to inject: a specific document when we know it (so a navigation makes
// the call fail instead of silently running in the new page), else a frame.
function target(tabId, frameId = 0, documentId) {
  return documentId ? { tabId, documentIds: [documentId] } : { tabId, frameIds: [frameId] };
}

async function execRaw(tgt, func, args = [], timeout = PAGE_TIMEOUT) {
  const call = chrome.scripting.executeScript({ target: tgt, func, args });
  const results = await (timeout
    ? withTimeout(call, timeout, "The page stopped responding — close any open dialog on it and try again.")
    : call);
  return results && results[0];
}

async function exec(tgt, func, args, timeout) {
  const res = await execRaw(tgt, func, args, timeout);
  return res ? res.result : undefined;
}

function makeFilename(tab, format) {
  let host = "page";
  try {
    host = new URL(tab.url).hostname || "page";
  } catch (_) {}
  const d = new Date();
  const p = (n) => String(n).padStart(2, "0");
  const stamp = `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}_${p(d.getHours())}-${p(d.getMinutes())}-${p(d.getSeconds())}`;
  return `screenshot-${host}-${stamp}.${format === "jpeg" ? "jpg" : "png"}`;
}

async function blockedReason(tab) {
  if (!tab || tab.id == null) return "No active tab to capture.";
  const url = tab.url || tab.pendingUrl || "";
  if (RESTRICTED_PREFIXES.some((p) => url.startsWith(p))) {
    return "Chrome doesn't let extensions capture this page (browser, Web Store or extension pages).";
  }
  if (url.startsWith("file:") && !(await chrome.extension.isAllowedFileSchemeAccess())) {
    return "To capture local files, turn on “Allow access to file URLs” for this extension in chrome://extensions.";
  }
  return null;
}

function friendlyError(e) {
  const msg = errText(e);
  if (/ExtensionsSettings policy|blocked by (the )?(administrator|policy)/i.test(msg)) {
    return "Your administrator blocks extensions on this site.";
  }
  if (/showing error page/i.test(msg)) return "The page didn't load, so there's nothing to capture.";
  if (/Cannot access|cannot be scripted|chrome:\/\/ URL|Missing host permission/i.test(msg)) {
    return "Chrome doesn't let extensions capture this page.";
  }
  if (/No tab with id|Frame with ID|No frame with id|No document with id|was removed|Tab was closed/i.test(msg)) {
    return "The page navigated or closed during the capture.";
  }
  if (/view is invisible|not visible|minimi[sz]ed/i.test(msg)) {
    return "Keep the browser window visible (not minimized) while capturing.";
  }
  return msg;
}

// Throws if the user cancelled or moved to another tab — captureVisibleTab
// always grabs whatever tab is showing, so a switch would stitch the wrong page.
async function assertStillCapturable(j) {
  if (j.cancelled) throw new Cancelled();
  const t = await chrome.tabs.get(j.tab.id).catch(() => null);
  if (!t) throw new Error("The tab was closed during the capture.");
  if (!t.active || t.windowId !== j.tab.windowId) {
    throw new Error("Capture stopped — the tab was switched. Stay on the page until it finishes.");
  }
}

// ===========================================================================
// Page-injected functions (serialized). Fully self-contained.
// ===========================================================================

function pageSaveRaw(base64, mime, filename) {
  // Sandboxed documents (no allow-same-origin) silently refuse downloads.
  if (self.origin === "null") return false;
  // An XHTML anchor works in SVG/XML documents too.
  const a = document.createElementNS("http://www.w3.org/1999/xhtml", "a");
  if (typeof a.click !== "function") return false;
  const bin = atob(base64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  const url = URL.createObjectURL(new Blob([bytes], { type: mime }));
  try {
    a.href = url;
    a.download = filename;
    a.style.display = "none";
    // Keep page-level click handlers (SPA routers) from swallowing the click.
    a.addEventListener("click", (e) => e.stopImmediatePropagation());
    (document.body || document.documentElement).appendChild(a);
    a.click();
    a.remove();
  } catch (_) {
    URL.revokeObjectURL(url);
    return false;
  }
  setTimeout(() => URL.revokeObjectURL(url), 60000);
  return true;
}

// Resolves {rect}, {cancelled: true} or {unsupported: true}. For a rect the
// overlay stays up, invisible, until pageRemoveOverlay runs after the
// screenshot, so the element under the pointer doesn't turn :hover. The rect
// is in layout-viewport CSS px as captured (pinch zoom applied), with the
// viewport width it was measured against.
function pageSelectRegion(timeoutMs) {
  return new Promise((resolve) => {
    const XHTML = "http://www.w3.org/1999/xhtml";
    if (!document.documentElement || document.documentElement.namespaceURI !== XHTML) {
      return resolve({ unsupported: true }); // SVG / XML documents
    }
    const vw = window.innerWidth;
    const vh = window.innerHeight;
    const shadowOf = (el) => {
      try {
        return el.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot(el)) || null;
      } catch (_) {
        return null;
      }
    };

    // A closed shadow root keeps page CSS off the overlay; as a popover it sits
    // in the top layer, above modal dialogs and fullscreen content.
    const host = document.createElement("div");
    host.setAttribute("popover", "manual");
    host.style.cssText =
      "all:initial;position:fixed;inset:0;width:100vw;height:100vh;margin:0;padding:0;border:0;background:transparent;z-index:2147483647;display:block;overflow:visible";
    const root = host.attachShadow({ mode: "closed" });
    const style = document.createElement("style");
    style.textContent =
      ".layer{position:fixed;inset:0;cursor:crosshair;background:rgba(15,23,42,.35);user-select:none;touch-action:none}" +
      ".layer.dragging,.layer.done{background:transparent}" +
      ".layer.done{cursor:default}" +
      ".box{position:fixed;display:none;border:1.5px solid #22d3ee;box-shadow:0 0 0 100vmax rgba(15,23,42,.35);pointer-events:none}" +
      ".size{position:absolute;right:-1px;bottom:-26px;font:600 11px/1 system-ui,sans-serif;color:#fff;background:#111827;padding:5px 7px;border-radius:5px;white-space:nowrap}" +
      ".hint{position:fixed;top:14px;left:50%;transform:translateX(-50%);background:#111827;color:#fff;padding:7px 12px;border-radius:8px;font:13px system-ui,sans-serif;pointer-events:none;box-shadow:0 4px 16px rgba(0,0,0,.3)}";
    const layer = document.createElement("div");
    layer.className = "layer";
    const box = document.createElement("div");
    box.className = "box";
    const size = document.createElement("span");
    size.className = "size";
    const hint = document.createElement("div");
    hint.className = "hint";
    hint.textContent = "Drag to select an area · Esc to cancel";
    box.appendChild(size);
    layer.append(box, hint);
    root.append(style, layer);

    // While a modal dialog is open everything outside it is inert, so the
    // overlay has to live inside the active one — which may be in a shadow
    // root. Try candidates until the centre of the screen hits the overlay.
    const modals = [];
    const collect = (scope) => {
      for (const d of scope.querySelectorAll("dialog")) if (d.matches(":modal")) modals.push(d);
      for (const e of scope.querySelectorAll("*")) {
        const sr = shadowOf(e);
        if (sr) collect(sr);
      }
    };
    collect(document);
    // Hit-test within the overlay's own tree scope (document or the
    // component's shadow root), where it's either the top hit or it's inert.
    const hitsHost = () => {
      const scope = host.getRootNode();
      return !!scope.elementFromPoint && scope.elementFromPoint(vw / 2, vh / 2) === host;
    };
    const containers = [...modals.reverse(), document.documentElement];
    for (const c of containers) {
      c.appendChild(host);
      try {
        host.showPopover();
      } catch (_) {}
      if (c === document.documentElement || hitsHost()) break;
      try {
        host.hidePopover();
      } catch (_) {}
      host.remove();
    }
    const inShadow = host.getRootNode() !== document;

    let sx = 0, sy = 0, drag = false, done = false;
    const within = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
    const pt = (e) => ({ x: within(e.clientX, 0, vw), y: within(e.clientY, 0, vh) });
    const calc = (e) => {
      const p = pt(e);
      return { x: Math.min(sx, p.x), y: Math.min(sy, p.y), w: Math.abs(p.x - sx), h: Math.abs(p.y - sy) };
    };
    const draw = (r) => {
      box.style.left = r.x + "px";
      box.style.top = r.y + "px";
      box.style.width = r.w + "px";
      box.style.height = r.h + "px";
      size.textContent = `${Math.round(r.w)} × ${Math.round(r.h)}`;
      const inside = r.y + r.h > vh - 32; // keep the label on screen
      size.style.bottom = inside ? "4px" : "-26px";
      size.style.right = inside ? "4px" : "-1px";
    };
    const frame = () =>
      new Promise((r) => {
        const t = setTimeout(r, 100);
        requestAnimationFrame(() => {
          clearTimeout(t);
          r();
        });
      });

    // Pointer input is handled at window capture phase and swallowed there, so
    // page "click outside" handlers don't close the menu being captured. (When
    // the overlay had to go inside a closed shadow tree, the window can't see
    // it; a listener on the host itself covers that case.)
    const POINTER = ["pointerdown", "pointermove", "pointerup", "mousedown", "mouseup", "click", "dblclick", "auxclick", "contextmenu"];
    const handled = new WeakSet();
    const ours = (e) => e.target === host || (inShadow && e.composedPath().includes(host));
    const onPointer = (e) => {
      if (handled.has(e) || !(e.currentTarget === host || ours(e))) return;
      handled.add(e);
      e.preventDefault();
      e.stopImmediatePropagation();
      if (done) return;
      if (e.type === "pointerdown" && e.button === 0) {
        try {
          host.setPointerCapture(e.pointerId); // keep the drag if the pointer leaves the window
        } catch (_) {}
        drag = true;
        ({ x: sx, y: sy } = pt(e));
        layer.classList.add("dragging");
        box.style.display = "block";
        hint.style.display = "none";
        draw(calc(e));
      } else if (e.type === "pointermove" && drag) {
        draw(calc(e));
      } else if (e.type === "pointerup" && drag) {
        drag = false;
        const r = calc(e);
        if (r.w < 5 || r.h < 5) {
          // A click, not a drag — let the user try again.
          layer.classList.remove("dragging");
          box.style.display = "none";
          hint.style.display = "";
          return;
        }
        const vv = window.visualViewport || { offsetLeft: 0, offsetTop: 0, scale: 1 };
        finish({
          left: (r.x - vv.offsetLeft) * vv.scale,
          top: (r.y - vv.offsetTop) * vv.scale,
          width: r.w * vv.scale,
          height: r.h * vv.scale,
          vw,
        });
      }
    };
    const teardown = () => {
      clearTimeout(removeTimer);
      for (const t of POINTER) {
        window.removeEventListener(t, onPointer, true);
        host.removeEventListener(t, onPointer, true);
      }
      window.removeEventListener("__fps_remove_overlay", teardown);
      host.remove();
    };
    let removeTimer = 0;
    const finish = (val) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      window.removeEventListener("keydown", onKey, true);
      window.removeEventListener("__fps_cancel_selection", onCancel);
      window.removeEventListener("pagehide", onCancel);
      if (!val) {
        teardown();
        return resolve({ cancelled: true });
      }
      // Invisible but still on top (so nothing underneath turns :hover) until
      // the screenshot is taken; the worker removes it, or this timer does.
      layer.classList.add("done");
      box.style.display = "none";
      hint.style.display = "none";
      window.addEventListener("__fps_remove_overlay", teardown);
      removeTimer = setTimeout(teardown, 4000);
      frame().then(frame).then(() => setTimeout(() => resolve({ rect: val }), 30));
    };
    const onKey = (e) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      e.stopPropagation();
      finish(null);
    };
    const onCancel = () => finish(null);
    const timer = setTimeout(() => finish(null), timeoutMs);

    for (const t of POINTER) {
      window.addEventListener(t, onPointer, true);
      host.addEventListener(t, onPointer, true);
    }
    window.addEventListener("keydown", onKey, true);
    window.addEventListener("__fps_cancel_selection", onCancel);
    // Navigating away (or into the back/forward cache) ends the selection.
    window.addEventListener("pagehide", onCancel);
  });
}

function pageCancelSelection() {
  window.dispatchEvent(new Event("__fps_cancel_selection"));
  window.dispatchEvent(new Event("__fps_remove_overlay"));
  return true;
}

function pageRemoveOverlay() {
  window.dispatchEvent(new Event("__fps_remove_overlay"));
  return true;
}

// Decides what to scroll in THIS frame: an inner panel, the document, or (top
// frame only) a big embedded iframe. Found by sampling points across the
// viewport and walking up through shadow roots, so it only considers visible
// scrollers and finds ones inside web components. The chosen panel is
// remembered in the isolated world for pagePrepScroll.
function pageAnalyzeTop() {
  const de = document.documentElement;
  const se = document.scrollingElement || de;
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  // scrollingElement's client size is the viewport minus scrollbars in both
  // standards and quirks mode.
  const viewW = (se && se.clientWidth) || vw;
  const viewH = (se && se.clientHeight) || vh;
  const docRange = se ? se.scrollHeight - viewH : 0;
  const docScrolls = docRange > 4;
  const vv = window.visualViewport;
  const visibleArea = (r) =>
    Math.max(0, Math.min(r.right, viewW) - Math.max(r.left, 0)) *
    Math.max(0, Math.min(r.bottom, viewH) - Math.max(r.top, 0));
  const area = viewW * viewH;
  const base = {
    vw,
    dpr: window.devicePixelRatio || 1,
    // Chrome's PDF viewer — not just any page with a PDF embedded in it.
    pdf:
      document.contentType === "application/pdf" ||
      (!docScrolls &&
        [...document.querySelectorAll('embed[type="application/pdf"]')].some(
          (e) => visibleArea(e.getBoundingClientRect()) > area * 0.6
        )),
    pinch: !!vv && Math.abs(vv.scale - 1) > 0.01,
  };
  window.__fpsTarget = null;

  const shadowOf = (el) => {
    try {
      return el.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot(el)) || null;
    } catch (_) {
      return null;
    }
  };
  // Topmost elements at a point, descending into shadow roots.
  const hitsAt = (x, y) => {
    let hits = document.elementsFromPoint(x, y).slice(0, 3);
    for (let depth = 0; depth < 8 && hits.length; depth++) {
      const sr = shadowOf(hits[0]);
      if (!sr || !sr.elementsFromPoint) break;
      const inner = sr.elementsFromPoint(x, y).filter((e) => e !== hits[0]).slice(0, 3);
      if (!inner.length) break;
      hits = inner.concat(hits);
    }
    return hits;
  };
  // Flat-tree parent: slot (found by hand in closed roots, where assignedSlot
  // is hidden), then parent, then shadow host.
  const up = (el) => {
    if (el.assignedSlot) return el.assignedSlot;
    const parent = el.parentElement;
    if (parent) {
      const sr = !parent.shadowRoot && shadowOf(parent);
      if (sr) {
        for (const s of sr.querySelectorAll("slot")) {
          if (s.assignedNodes({ flatten: true }).includes(el)) return s;
        }
      }
      return parent;
    }
    const r = el.getRootNode();
    return r && r.host ? r.host : null;
  };
  const scrollable = new Map();
  const isScroller = (el) => {
    let v = scrollable.get(el);
    if (v === undefined) {
      v =
        el !== de &&
        el.clientHeight >= 120 &&
        el.scrollHeight > el.clientHeight + 20 &&
        /^(auto|scroll|overlay)$/.test(getComputedStyle(el).overflowY);
      scrollable.set(el, v);
    }
    return v;
  };

  const GRID = 7;
  const counts = new Map();
  let centre = null;
  for (let gy = 0; gy < GRID; gy++) {
    for (let gx = 0; gx < GRID; gx++) {
      const x = ((gx + 0.5) * viewW) / GRID;
      const y = ((gy + 0.5) * viewH) / GRID;
      const seen = new Set();
      for (const hit of hitsAt(x, y)) {
        for (let el = hit, d = 0; el && d < 60; el = up(el), d++) {
          if (seen.has(el)) break;
          seen.add(el);
          if (isScroller(el)) counts.set(el, (counts.get(el) || 0) + 1);
        }
      }
      if (gx === 3 && gy === 3) centre = seen;
    }
  }
  let best = null;
  let bestCount = 0;
  for (const [el, n] of counts) {
    if (n > bestCount) {
      best = el;
      bestCount = n;
    }
  }
  const share = bestCount / (GRID * GRID);

  // A big iframe that dominates a (nearly) non-scrolling page → scroll the iframe.
  let bigIf = null;
  let ifArea = 0;
  for (const f of document.querySelectorAll("iframe, frame")) {
    const r = f.getBoundingClientRect();
    if (r.width < 200 || r.height < 200) continue;
    const a = visibleArea(r);
    if (a > ifArea) {
      ifArea = a;
      bigIf = f;
    }
  }
  if (bigIf && ifArea > area * 0.3 && ifArea >= share * area && docRange < viewH * 0.25) {
    let r = bigIf.getBoundingClientRect();
    if (docScrolls && (r.top < -1 || r.bottom > viewH + 1)) {
      // Bring all of it on screen (the page is restored afterwards).
      window.__fpsTopScroll = { x: window.scrollX, y: window.scrollY };
      bigIf.scrollIntoView({ block: r.height <= viewH ? "nearest" : "start", inline: "nearest", behavior: "instant" });
      r = bigIf.getBoundingClientRect();
    }
    const cs = getComputedStyle(bigIf);
    const px = (v) => parseFloat(v) || 0;
    const scale = bigIf.offsetWidth ? r.width / bigIf.offsetWidth : 1; // CSS transform
    return {
      ...base,
      type: "iframe",
      scale,
      viewW,
      viewH,
      contentLeft: r.left + (bigIf.clientLeft + px(cs.paddingLeft)) * scale,
      contentTop: r.top + (bigIf.clientTop + px(cs.paddingTop)) * scale,
      // The child frame's expected innerWidth/innerHeight, to identify it.
      frameWidth: bigIf.clientWidth - px(cs.paddingLeft) - px(cs.paddingRight),
      frameHeight: bigIf.clientHeight - px(cs.paddingTop) - px(cs.paddingBottom),
    };
  }

  // An inner panel wins when the page itself doesn't scroll and the panel is a
  // real part of it — or, when the page does scroll, only if the panel holds
  // the middle of the screen, covers most of it and scrolls further (a docs
  // site's scrollable sidebar must not beat the article).
  const dominant = docScrolls
    ? share >= 0.5 && centre && centre.has(best) && best.scrollHeight > se.scrollHeight
    : share >= 0.2;
  if (best && dominant) {
    window.__fpsTarget = best;
    return { ...base, type: "element" };
  }
  return { ...base, type: "document" };
}

// Reports each frame's metrics — used to find the embedded preview frame.
function pageFrameInfo() {
  const se = document.scrollingElement || document.documentElement;
  let childOfTop = false;
  try {
    childOfTop = window !== window.top && window.parent === window.top;
  } catch (_) {}
  return {
    isTop: window === window.top,
    childOfTop,
    innerWidth: window.innerWidth,
    innerHeight: window.innerHeight,
    scrollHeight: se ? se.scrollHeight : 0,
    clientHeight: se ? se.clientHeight : window.innerHeight,
  };
}

// Esc anywhere on the page — including inside iframes that have focus —
// cancels. Injected into every frame for the duration of a capture.
function pageEsc(on) {
  if (window.__fpsEsc) window.removeEventListener("keydown", window.__fpsEsc, true);
  window.__fpsEsc = null;
  if (!on) return true;
  window.__fpsEsc = (e) => {
    if (e.key === "Escape") chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }).catch(() => {});
  };
  window.addEventListener("keydown", window.__fpsEsc, true);
  return true;
}

// Scroll helpers — injected into whichever frame owns the scroller (the top
// frame, or the embedded frame in iframe mode). State lives on the
// extension's isolated-world window between injections.
//
// Prepares the scroller and returns the capture geometry in this frame's CSS
// px, measured after the capture styles are in place.
function pagePrepScroll(useElement) {
  const prior = window.__fps;
  if (prior) {
    window.removeEventListener("keydown", prior.onKey, true);
    window.removeEventListener("wheel", prior.onScrollInput, true);
    window.removeEventListener("touchmove", prior.onScrollInput, true);
  }
  for (const id of ["__fps-style", "__fps-nohover"]) {
    const old = document.getElementById(id);
    if (old) old.remove();
  }

  const de = document.documentElement;
  const se = document.scrollingElement || de;
  const el = useElement ? window.__fpsTarget : null;
  if (useElement && (!el || !el.isConnected)) return null;
  const isHtml = de.namespaceURI === "http://www.w3.org/1999/xhtml";
  // pageAnalyzeTop may already have scrolled the page to show an iframe.
  const orig = window.__fpsTopScroll || { x: window.scrollX, y: window.scrollY };
  const st = {
    el,
    origin: 0,
    prevTop: el ? el.scrollTop : 0,
    prevX: orig.x,
    prevY: orig.y,
    ancestors: [],
    cancelled: false,
    hidden: [],
    hiddenSet: new Set(),
    fixedCandidates: null,
    noHover: null,
  };
  // Esc cancels; wheel/touch/scroll keys are blocked so the user can't move
  // the page between "scrolled to here" and the screenshot.
  const SCROLL_KEYS = ["ArrowUp", "ArrowDown", "PageUp", "PageDown", "Home", "End", " "];
  st.onKey = (e) => {
    if (e.key === "Escape") {
      st.cancelled = true;
      chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }).catch(() => {});
    } else if (SCROLL_KEYS.includes(e.key)) {
      e.preventDefault();
    }
  };
  st.onScrollInput = (e) => e.preventDefault();
  window.addEventListener("keydown", st.onKey, true);
  window.addEventListener("wheel", st.onScrollInput, { capture: true, passive: false });
  window.addEventListener("touchmove", st.onScrollInput, { capture: true, passive: false });
  window.__fps = st;

  if (isHtml) {
    // Overlay scrollbars (macOS default) take no space but flash a thumb on
    // every programmatic scroll — hide them. Classic scrollbars are left
    // alone: hiding them would reflow the page, and the crop excludes them.
    const probe = document.createElement("div");
    probe.style.cssText = "position:absolute;top:-999px;width:100px;height:100px;overflow:scroll;visibility:hidden";
    de.appendChild(probe);
    const overlayBars = probe.offsetWidth - probe.clientWidth === 0;
    probe.remove();

    const style = document.createElement("style");
    style.id = "__fps-style";
    style.textContent =
      "*,*::before,*::after{scroll-behavior:auto!important;scroll-snap-type:none!important}" +
      (overlayBars ? "*{scrollbar-width:none!important}::-webkit-scrollbar{display:none!important}" : "");
    (document.head || de).appendChild(style);
    // Nothing is hoverable while capturing, so a resting pointer doesn't
    // light up rows, tooltips or hover cards as content scrolls under it.
    const noHover = document.createElement("style");
    noHover.id = "__fps-nohover";
    noHover.textContent = "*{pointer-events:none!important}";
    (document.head || de).appendChild(noHover);
    st.noHover = noHover;
  }

  const viewW = (se && se.clientWidth) || window.innerWidth;
  const viewH = (se && se.clientHeight) || window.innerHeight;

  let crop = { left: 0, top: 0, width: viewW, height: viewH };
  let unit = 1;
  let cut = 0;
  if (el) {
    let r = el.getBoundingClientRect();
    if (r.top < 0 || r.left < 0 || r.bottom > viewH + 1 || r.right > viewW + 1) {
      // scrollIntoView also scrolls ancestors — even overflow:hidden app
      // shells the user can't scroll back — so remember them all.
      const up = (n) => n.assignedSlot || n.parentElement || (n.getRootNode() && n.getRootNode().host) || null;
      for (let n = up(el); n && n !== se && n !== de; n = up(n)) {
        if (n.scrollTop || n.scrollLeft || n.scrollHeight > n.clientHeight || n.scrollWidth > n.clientWidth) {
          st.ancestors.push([n, n.scrollTop, n.scrollLeft]);
        }
      }
      el.scrollIntoView({ block: "start", inline: "nearest", behavior: "instant" });
      r = el.getBoundingClientRect();
    }
    // column-reverse panels (chat UIs) scroll through negative scrollTop;
    // find the true top and measure from there.
    el.scrollTo({ top: -1e9, behavior: "instant" });
    st.origin = Math.min(0, el.scrollTop);
    const k = el.offsetWidth ? r.width / el.offsetWidth : 1; // CSS transform/zoom on the panel
    unit = Math.abs(k - 1) < 0.005 ? 1 : k;
    // Padding box (inside borders, excluding scrollbars), clipped to the viewport.
    const left = Math.max(0, r.left + el.clientLeft * unit);
    const top = Math.max(0, r.top + el.clientTop * unit);
    crop = {
      left,
      top,
      width: Math.max(0, Math.min(r.left + (el.clientLeft + el.clientWidth) * unit, viewW) - left),
      height: Math.max(0, Math.min(r.top + (el.clientTop + el.clientHeight) * unit, viewH) - top),
    };
    cut = Math.max(0, el.clientHeight * unit - crop.height);
  } else {
    window.scrollTo({ top: 0, left: window.scrollX, behavior: "instant" });
  }
  return {
    vw: window.innerWidth,
    vh: window.innerHeight,
    crop,
    unit,
    cut, // panel rows that never fit on screen (CSS px)
    scrollHeight: el ? el.scrollHeight : se.scrollHeight,
  };
}

// Scrolls to `target`, lets the page settle, and reports where it landed plus
// the extent of sticky/fixed bars pinned to the top/bottom of `opts.edges`.
// opts.preHide (first tile): hide fixed widgets that reach below the first
// seam, which would otherwise be cut in half. opts.hideFixed (later tiles):
// hide all fixed widgets, so they appear once instead of in every tile.
async function pageScrollTo(target, opts) {
  const st = window.__fps || { hidden: [], hiddenSet: new Set(), origin: 0 };
  const el = st.el;
  if (el && !el.isConnected) return { lost: true };
  const t0 = performance.now();
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  const frame = () =>
    new Promise((r) => {
      const t = setTimeout(r, 120);
      requestAnimationFrame(() => {
        clearTimeout(t);
        r();
      });
    });
  // Hit-testing needs pointer events back on; toggled synchronously, so no
  // frame (and no hover change) happens in between.
  const hitTest = (fn) => {
    if (st.noHover && st.noHover.sheet) st.noHover.sheet.disabled = true;
    try {
      return fn();
    } finally {
      if (st.noHover && st.noHover.sheet) st.noHover.sheet.disabled = false;
    }
  };
  const shadowOf = (e) => {
    try {
      return e.shadowRoot || (chrome.dom && chrome.dom.openOrClosedShadowRoot(e)) || null;
    } catch (_) {
      return null;
    }
  };
  // Shadow-including ancestor test (Node.contains stops at shadow roots).
  const holds = (a, b) => {
    for (let n = b; n; n = n.parentNode || n.host) if (n === a) return true;
    return false;
  };
  const vw = window.innerWidth;
  const vh = window.innerHeight;
  const edges = opts.edges || { left: 0, top: 0, width: vw, height: vh };
  const sc = el || document.scrollingElement || document.documentElement;

  const hideFixed = (belowY) => {
    const checked = new Set();
    let n = 0;
    const consider = (e) => {
      if (checked.has(e) || st.hiddenSet.has(e) || !e.style) return;
      checked.add(e);
      const cs = getComputedStyle(e);
      if (cs.position !== "fixed" || cs.visibility === "hidden" || cs.display === "none") return;
      // Inside a transformed ancestor "fixed" scrolls with the content.
      if (e.offsetParent) return;
      if (el && holds(e, el)) return;
      const r = e.getBoundingClientRect();
      if (r.width * r.height > vw * vh * 0.6) return; // backgrounds, app shells
      if (belowY != null && r.bottom <= belowY) return;
      st.hidden.push([e, e.style.getPropertyValue("visibility"), e.style.getPropertyPriority("visibility")]);
      st.hiddenSet.add(e);
      e.style.setProperty("visibility", "hidden", "important");
      n++;
    };
    if (!st.fixedCandidates) {
      // One full scan (into shadow roots too); remember every fixed element,
      // even hidden ones, so later calls can re-check them cheaply.
      st.fixedCandidates = [];
      const scan = (scope) => {
        for (const e of scope.querySelectorAll("*")) {
          if (getComputedStyle(e).position === "fixed") st.fixedCandidates.push(e);
          const sr = shadowOf(e);
          if (sr) scan(sr);
        }
      };
      scan(document.body || document.documentElement);
    }
    for (const e of st.fixedCandidates) if (e.isConnected) consider(e);
    // Hit-testing is slow on huge DOMs (~10 ms/point), so sample sparsely for
    // widgets added later, weighted to the edges and corners.
    hitTest(() => {
      const root = document.scrollingElement || document.documentElement;
      const w = root.clientWidth || vw; // inside any scrollbars
      const h = root.clientHeight || vh;
      const pts = [];
      const edgeXs = [12, 48, w * 0.25, w * 0.5, w * 0.75, w - 48, w - 12];
      for (const y of [2, 48, h - 48, h - 3]) for (const x of edgeXs) pts.push([x, y]);
      for (const y of [h * 0.25, h * 0.5, h * 0.75]) for (const x of [12, w * 0.5, w - 12]) pts.push([x, y]);
      for (const [x, y] of pts) {
        let hits = document.elementsFromPoint(x, y).slice(0, 4);
        const sr = hits[0] && shadowOf(hits[0]);
        if (sr && sr.elementsFromPoint) hits = sr.elementsFromPoint(x, y).slice(0, 4).concat(hits);
        for (const hit of hits) {
          for (let e = hit, d = 0; e && e !== document.body && e !== document.documentElement && d < 15; e = e.parentElement || (e.getRootNode() && e.getRootNode().host), d++) {
            consider(e);
          }
        }
      }
    });
    return n;
  };

  if (opts.preHide && sc.scrollHeight - sc.clientHeight > 2) {
    hideFixed(edges.top + edges.height * 0.5 - 1);
  } else if (opts.hideFixed && !st.hiddenAll) {
    st.hiddenAll = true;
    hideFixed(); // before this tile's scroll, so it paints without them
  }
  if (el) el.scrollTo({ top: st.origin + target, behavior: "instant" });
  else window.scrollTo({ top: target, left: window.scrollX, behavior: "instant" });

  // Let the page paint, and wait out JS smooth-scroll libraries that move the
  // content with transforms after the native scroll (until nothing moves for
  // two frames, at most 1.5 s).
  await frame();
  await frame();
  const probes = hitTest(() => {
    const out = [];
    for (const fx of [0.25, 0.5, 0.75]) {
      const hit = document.elementFromPoint(edges.left + edges.width * fx, edges.top + edges.height / 2);
      if (hit && hit !== document.body && hit !== document.documentElement) out.push(hit);
    }
    return out;
  });
  let before = probes.map((p) => p.getBoundingClientRect().top);
  const settleBy = performance.now() + 1500;
  for (let still = 0; probes.length && still < 2 && performance.now() < settleBy; ) {
    await frame();
    const now = probes.map((p) => p.getBoundingClientRect().top);
    still = now.every((v, i) => Math.abs(v - before[i]) < 0.5) ? still + 1 : 0;
    before = now;
  }

  // Give on-screen lazy images a moment to arrive.
  const loading = () => {
    for (const img of document.images) {
      if (img.complete) continue;
      const r = img.getBoundingClientRect();
      if (r.width > 0 && r.bottom > 0 && r.top < vh && r.right > 0 && r.left < vw) return true;
    }
    return false;
  };
  const deadline = performance.now() + 900;
  while (performance.now() < deadline && loading()) await sleep(100);
  // Scroll handlers may have just shown a back-to-top button or switched a
  // header to position:fixed.
  if (opts.hideFixed && hideFixed()) {
    await frame();
    await frame();
  }
  const rest = opts.settle - (performance.now() - t0);
  if (rest > 0) await sleep(rest);

  // Sticky/fixed bars pinned to the crop edges (catches translucent headers
  // that pixel comparison misses).
  const pinnedCache = new Map();
  const isPinned = (e) => {
    let v = pinnedCache.get(e);
    if (v === undefined) {
      const p = getComputedStyle(e).position;
      v = p === "sticky" || (p === "fixed" && !e.offsetParent);
      pinnedCache.set(e, v);
    }
    return v;
  };
  const pinned = (y, fromTop) => {
    const bottomEdge = edges.top + edges.height;
    let ext = 0;
    for (let i = 1; i <= 7; i++) {
      const x = edges.left + (edges.width * i) / 8;
      for (const hit of document.elementsFromPoint(x, y).slice(0, 4)) {
        for (let e = hit, d = 0; e && e !== document.body && e !== document.documentElement && d < 12; e = e.parentElement, d++) {
          if (!isPinned(e)) continue;
          if (el && holds(e, el)) break;
          const r = e.getBoundingClientRect();
          if (r.width < edges.width * 0.5 || r.height > edges.height * 0.4) continue;
          if (fromTop && r.top <= edges.top + 2 && r.bottom > edges.top) ext = Math.max(ext, r.bottom - edges.top);
          if (!fromTop && r.bottom >= bottomEdge - 2 && r.top < bottomEdge) ext = Math.max(ext, bottomEdge - r.top);
        }
      }
    }
    return ext;
  };
  const pins = hitTest(() => ({
    pinTop: pinned(edges.top + 1, true),
    pinBottom: pinned(edges.top + edges.height - 1, false),
  }));

  if (el && !el.isConnected) return { lost: true };
  return {
    top: el ? el.scrollTop - st.origin : window.scrollY,
    maxTop: sc.scrollHeight - sc.clientHeight,
    scrollHeight: sc.scrollHeight,
    cancelled: !!st.cancelled,
    vw,
    vh,
    ...pins,
  };
}

function pageScrollPos() {
  const st = window.__fps;
  if (st && st.el && !st.el.isConnected) return null;
  return st && st.el ? st.el.scrollTop - st.origin : window.scrollY;
}

// Top frame, iframe mode: undo pageAnalyzeTop's scroll to show the frame.
function pageTopRestore() {
  const s = window.__fpsTopScroll;
  window.__fpsTopScroll = null;
  if (s) window.scrollTo({ top: s.y, left: s.x, behavior: "instant" });
  return true;
}

function pageRestoreScroll() {
  const st = window.__fps;
  window.__fpsTopScroll = null;
  if (!st) return false;
  delete window.__fps;
  window.__fpsTarget = null;
  window.removeEventListener("keydown", st.onKey, true);
  window.removeEventListener("wheel", st.onScrollInput, true);
  window.removeEventListener("touchmove", st.onScrollInput, true);
  for (const [e, value, priority] of st.hidden) {
    if (value) e.style.setProperty("visibility", value, priority);
    else e.style.removeProperty("visibility");
    if (e.getAttribute("style") === "") e.removeAttribute("style");
  }
  if (st.el) st.el.scrollTo({ top: st.prevTop, behavior: "instant" });
  for (const [n, top, left] of st.ancestors || []) n.scrollTo({ top, left, behavior: "instant" });
  window.scrollTo({ top: st.prevY, left: st.prevX, behavior: "instant" });
  for (const id of ["__fps-style", "__fps-nohover"]) {
    const style = document.getElementById(id);
    if (style) style.remove();
  }
  return true;
}

// ===========================================================================
// Tiling and stitching (service-worker side; no chrome.* calls so it can be
// exercised with fakes).
// ===========================================================================

const SAMPLE_COLS = 32;
const BAND_TOLERANCE = 16; // per channel
const BAND_MATCH = 0.8; // fraction of sampled columns that must match

// Crop rectangle (CSS px) → device-pixel rectangle inside a captured bitmap.
function deviceRect(crop, s, bmp) {
  const x = clamp(Math.round(crop.left * s), 0, bmp.width - 1);
  const y = clamp(Math.round(crop.top * s), 0, bmp.height - 1);
  return {
    x,
    y,
    w: clamp(Math.round(crop.width * s), 1, bmp.width - x),
    h: clamp(Math.round(crop.height * s), 1, bmp.height - y),
  };
}

// A thin fingerprint of a tile: SAMPLE_COLS one-pixel columns of the crop.
function sampleColumns(bmp, dev) {
  const n = Math.min(SAMPLE_COLS, dev.w);
  const canvas = new OffscreenCanvas(n, dev.h);
  const ctx = canvas.getContext("2d", { willReadFrequently: true });
  for (let i = 0; i < n; i++) {
    const sx = dev.x + Math.floor(((i + 0.5) * dev.w) / n);
    ctx.drawImage(bmp, sx, dev.y, 1, dev.h, i, 0, 1, dev.h);
  }
  return { n, h: dev.h, data: ctx.getImageData(0, 0, n, dev.h).data };
}

function pixelDiffers(a, pa, b, pb) {
  return (
    Math.abs(a[pa] - b[pb]) > BAND_TOLERANCE ||
    Math.abs(a[pa + 1] - b[pb + 1]) > BAND_TOLERANCE ||
    Math.abs(a[pa + 2] - b[pb + 2]) > BAND_TOLERANCE
  );
}

function rowMatches(a, b, row) {
  const base = row * a.n * 4;
  let ok = 0;
  for (let i = 0; i < a.n; i++) if (!pixelDiffers(a.data, base + i * 4, b.data, base + i * 4)) ok++;
  return ok >= a.n * BAND_MATCH;
}

// Rows at the top/bottom of the crop that are identical in two tiles taken at
// different scroll positions — sticky headers and footers.
function matchBands(a, b) {
  const limit = Math.floor(a.h * 0.45);
  let top = 0;
  while (top < limit && rowMatches(a, b, top)) top++;
  let bottom = 0;
  while (bottom < limit && rowMatches(a, b, a.h - 1 - bottom)) bottom++;
  return { top, bottom };
}

// Scrolling usually moves content by exactly the scroll delta, but layout
// shifts (a header switching to position:fixed, content above collapsing)
// don't. Compare a strip just below tile b's header with where it should sit
// in tile a; if it's clearly misplaced and clearly matches nearby, return the
// correction in device px. Flat or repeating content never triggers this.
function registerShift(a, b, expected, topBand, prevBottomBand) {
  const n = a.n;
  const h = a.h;
  const r0 = topBand + 4;
  const lim = h - prevBottomBand;
  const maxD = Math.round(h * 0.12);
  const cost = (d) => {
    const pr = r0 + expected + d;
    // Compare as much of the overlap as is available, up to 64 rows.
    const L = Math.min(64, lim - pr, h - r0);
    if (L < 12 || pr < 0) return Infinity;
    let bad = 0;
    for (let r = 0; r < L; r++) {
      const pa = (pr + r) * n * 4;
      const pb = (r0 + r) * n * 4;
      for (let i = 0; i < n; i++) if (pixelDiffers(a.data, pa + i * 4, b.data, pb + i * 4)) bad++;
    }
    return bad / (L * n);
  };
  const c0 = cost(0);
  if (!(c0 > 0.3) || c0 === Infinity) return 0;
  let best = 0;
  let bestCost = c0;
  const good = [];
  for (let d = -maxD; d <= maxD; d++) {
    if (d === 0) continue;
    const c = cost(d);
    if (c <= 0.02) good.push(d);
    if (c < bestCost) {
      bestCost = c;
      best = d;
    }
  }
  if (bestCost > 0.02 || good.some((d) => Math.abs(d - best) > 2)) return 0;
  return best;
}

// env: { scrollTo(y, tileIndex) -> page info (see pageScrollTo), capture() -> Blob,
//        position?() -> scroll position (null if the scroller is gone),
//        shouldStop?() -> bool, progress(fraction) }
// geo: { crop: {left, top, width, height} top-frame CSS px, vw: top innerWidth,
//        unit: top-frame CSS px per scroller px, viewScroll: visible scroller
//        height in scroller px, dpr?: top devicePixelRatio, pinUnit?: top CSS
//        px per scroller-frame CSS px, localVw/localVh?: scroller frame's
//        viewport at the start }
async function captureTiles(env, geo) {
  const tiles = [];
  let prevSig = null;
  let dev = null;
  let size = null;
  let s = 1;
  let u = 1; // device px per scroller px
  let pinU = 1; // device px per scroller-frame CSS px
  const recentBands = []; // device px, last few tile pairs
  let step = geo.viewScroll * 0.5;
  let y = 0;
  let last = null;
  let retries = 0;
  let truncated = null;
  let reached = 100;
  const hasMore = (info) =>
    info.maxTop != null ? info.top < info.maxTop - 2 : info.top + geo.viewScroll < info.scrollHeight - 2;

  while (tiles.length < MAX_TILES) {
    if (tiles.length && env.shouldStop && env.shouldStop()) {
      truncated = "stopped";
      break;
    }
    const info = await env.scrollTo(y, tiles.length);
    if (!info) throw new Error("The page navigated or closed during the capture.");
    if (info.lost) throw new Error("The page changed during the capture — try again.");
    if (info.cancelled) throw new Cancelled();
    if (geo.localVw && info.vw != null && (info.vw !== geo.localVw || info.vh !== geo.localVh)) {
      throw new Error("The window was resized or zoomed during the capture — try again.");
    }
    const prev = tiles[tiles.length - 1];
    if (prev && info.top <= prev.top + 0.5) {
      // Scrolling stopped. At the bottom that's the normal end; short of it
      // (or if the page just reset — a popup locking scroll), something's in
      // the way.
      if (hasMore(info) || hasMore(last)) {
        truncated = "stalled";
        const ref = hasMore(info) ? info : last;
        reached = Math.round(clamp((prev.top + geo.viewScroll) / Math.max(1, ref.scrollHeight), 0, 1) * 100);
      }
      break;
    }

    const blob = await env.capture();
    if (env.position) {
      // The pixels must match the position we recorded; if the page (or the
      // user) scrolled meanwhile, take this tile again.
      const now = await env.position();
      if (now === null) throw new Error("The page changed during the capture — try again.");
      if (now !== undefined && Math.abs(now - info.top) > 1) {
        if (++retries > 3) {
          throw new Error("The page kept scrolling during the capture — try again without scrolling.");
        }
        continue;
      }
    }
    retries = 0;
    last = info;

    const bmp = await createImageBitmap(blob);
    if (!dev) {
      // innerWidth is an integer, so bitmap/innerWidth is slightly off at
      // fractional scales; use the real DPR when it agrees.
      const ratio = bmp.width / geo.vw;
      s = geo.dpr && Math.abs(ratio - geo.dpr) <= geo.dpr / geo.vw + 1e-3 ? geo.dpr : ratio;
      u = s * geo.unit;
      pinU = s * (geo.pinUnit || 1);
      dev = deviceRect(geo.crop, s, bmp);
      size = [bmp.width, bmp.height];
    } else if (bmp.width !== size[0] || bmp.height !== size[1]) {
      bmp.close();
      throw new Error("The window was resized during the capture — try again.");
    }
    const sig = sampleColumns(bmp, dev);
    bmp.close();

    const Tnom = Math.round(info.top * u);
    const tile = {
      blob,
      top: info.top,
      Tnom,
      T: Tnom,
      pinTop: Math.round((info.pinTop || 0) * pinU), // DOM-confirmed bars
      pinBottom: Math.round((info.pinBottom || 0) * pinU),
    };
    tile.bandTop = tile.pinTop;
    tile.bandBottom = tile.pinBottom;
    if (prev) {
      const bands = matchBands(prevSig, sig);
      // A band that runs all the way to the search limit is plain background,
      // not a bar — ignore it.
      const lim = Math.floor(sig.h * 0.45);
      tile.bandTop = Math.max(tile.pinTop, bands.top >= lim ? 0 : bands.top);
      prev.bandBottom = Math.max(prev.pinBottom, bands.bottom >= lim ? 0 : bands.bottom);
      const expected = Tnom - prev.Tnom;
      tile.T = prev.T + expected + registerShift(prevSig, sig, expected, tile.bandTop, prev.bandBottom);
      recentBands.push(tile.bandTop + prev.bandBottom);
      if (recentBands.length > 3) recentBands.shift();
    }
    tiles.push(tile);
    prevSig = sig;
    env.progress(clamp((info.top + geo.viewScroll) / Math.max(1, info.scrollHeight), 0, 1));

    // Canvas limit: MAX_DIM rows, which at s > 1 means MAX_DIM CSS px once
    // scaled to CSS resolution.
    if (hasMore(info) && tile.T + dev.h >= MAX_DIM * Math.max(1, s)) {
      truncated = "height";
      break;
    }

    if (tiles.length >= 2) {
      // Overlap must cover the bands seen recently, plus a margin for floating
      // widgets; within that, take the biggest step we can. (A window, not a
      // running max: blank page areas look like bands too.)
      const bandsScroll = Math.max(...recentBands) / u;
      step = clamp(geo.viewScroll * 0.88 - bandsScroll, geo.viewScroll * 0.35, geo.viewScroll * 0.8);
    }
    y = info.top + step;
  }

  if (!truncated && tiles.length >= MAX_TILES && last && hasMore(last)) truncated = "tiles";
  return { tiles, dev, s, truncated, reached };
}

// Which rows of each tile to keep. Tile i shows canvas rows [T[i], T[i]+h);
// the first keeps its header, the last its footer; in between, drop the
// repeating bars — DOM-confirmed ones first, then pixel-matched extras —
// never more than the overlap with the neighbour, so nothing is lost.
function planRows(tiles, h) {
  const T = tiles.map((t) => t.T);
  const from = tiles.map(() => 0);
  const to = tiles.map(() => h);
  for (let i = 1; i < tiles.length; i++) {
    const t = tiles[i];
    const p = tiles[i - 1];
    const ov = Math.max(0, T[i - 1] + h - T[i]);
    const dT = clamp(t.pinTop || 0, 0, ov);
    const dB = clamp(p.pinBottom || 0, 0, ov - dT);
    const xT = clamp((t.bandTop || 0) - dT, 0, ov - dT - dB);
    const xB = clamp((p.bandBottom || 0) - dB, 0, ov - dT - dB - xT);
    from[i] = dT + xT;
    to[i - 1] = h - (dB + xB);
  }
  return { T, from, to, total: Math.max(...T.map((t) => t + h)) };
}

async function stitchTiles(cap, format, quality, onProgress) {
  const { tiles, dev } = cap;
  const plan = planRows(tiles, dev.h);
  // At the height limit, crop the overshoot instead of resampling the image.
  if (cap.truncated === "height") plan.total = Math.min(plan.total, Math.floor(MAX_DIM * Math.max(1, cap.s)));
  const scale = Math.min(1, MAX_DIM / dev.w, MAX_DIM / plan.total, Math.sqrt(MAX_AREA / (dev.w * plan.total)));
  const W = Math.max(1, Math.round(dev.w * scale));
  const H = Math.max(1, Math.round(plan.total * scale));

  const canvas = new OffscreenCanvas(W, H);
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("This page is too large to stitch into one image.");
  if (format === "jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, W, H);
  }
  ctx.imageSmoothingQuality = "high";

  for (let i = 0; i < tiles.length; i++) {
    const rows = plan.to[i] - plan.from[i];
    const y0 = Math.round((plan.T[i] + plan.from[i]) * scale);
    if (rows > 0 && y0 < H) {
      const bmp = await createImageBitmap(tiles[i].blob);
      const y1 = Math.round((plan.T[i] + plan.to[i]) * scale);
      ctx.drawImage(bmp, dev.x, dev.y + plan.from[i], dev.w, rows, 0, y0, W, Math.max(1, y1 - y0));
      bmp.close();
    }
    tiles[i].blob = null;
    onProgress((i + 1) / tiles.length); // may throw to cancel
  }

  const blob = await canvas.convertToBlob(format === "jpeg" ? { type: "image/jpeg", quality } : { type: "image/png" });
  return { blob, width: W, height: H, scale };
}

async function encodeCrop(blob, crop, vw, format, quality) {
  const bmp = await createImageBitmap(blob);
  const dev = deviceRect(crop, bmp.width / vw, bmp);
  const canvas = new OffscreenCanvas(dev.w, dev.h);
  const ctx = canvas.getContext("2d");
  if (format === "jpeg") {
    ctx.fillStyle = "#fff";
    ctx.fillRect(0, 0, dev.w, dev.h);
  }
  ctx.drawImage(bmp, dev.x, dev.y, dev.w, dev.h, 0, 0, dev.w, dev.h);
  bmp.close();
  const out = await canvas.convertToBlob(format === "jpeg" ? { type: "image/jpeg", quality } : { type: "image/png" });
  return { blob: out, width: dev.w, height: dev.h };
}

// ===========================================================================
// Capture modes.
// ===========================================================================

// Esc listeners in every frame (focus may be inside an iframe).
async function escAllFrames(tabId, on) {
  await withTimeout(
    chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageEsc, args: [on] }),
    5000,
    "timeout"
  ).catch(() => {});
}

// The child frame showing the big iframe's document — matched by size, so an
// unrelated frame (an ad, a hidden auth frame) is never mistaken for it.
async function pickPreviewFrame(tabId, probe) {
  let infos;
  try {
    infos = await withTimeout(
      chrome.scripting.executeScript({ target: { tabId, allFrames: true }, func: pageFrameInfo }),
      PAGE_TIMEOUT,
      "The page stopped responding."
    );
  } catch (_) {
    return null;
  }
  const near = (a, b) => Math.abs(a - b) <= Math.max(2, b * 0.01);
  let best = null;
  for (const it of infos || []) {
    const r = it && it.result;
    if (!r || r.isTop || !r.childOfTop) continue;
    if (!(near(r.innerWidth, probe.frameWidth) && near(r.innerHeight, probe.frameHeight))) continue;
    const scrolls = r.scrollHeight > r.clientHeight + 4;
    if (!best || (scrolls && !best.scrolls) || (scrolls === best.scrolls && r.scrollHeight > best.info.scrollHeight)) {
      best = { frameId: it.frameId, documentId: it.documentId, info: r, scrolls };
    }
  }
  return best;
}

async function runFull(j) {
  const { tab } = j;
  setProgress(3);
  // Undo anything an interrupted capture left behind in the page.
  await exec(target(tab.id), pageRestoreScroll, [], 5000).catch(() => {});
  const top = await execRaw(target(tab.id), pageAnalyzeTop);
  const probe = top && top.result;
  if (!probe) throw new Error("Can't read this page's content to capture it.");
  const topTgt = target(tab.id, 0, top.documentId);
  try {
    if (probe.pinch) throw new Error("The page is pinch-zoomed — pinch back out to normal size and try again.");
    if (probe.pdf) {
      const out = await runVisible(j);
      out.notes.push("Chrome's PDF viewer can't be scrolled by extensions, so only the visible part was captured.");
      return out;
    }

    let tgt = topTgt;
    let useElement = probe.type === "element";
    let frameMap = null; // set when scrolling inside an embedded frame
    if (probe.type === "iframe") {
      const frame = await pickPreviewFrame(tab.id, probe);
      if (!frame) {
        const all = await chrome.permissions.contains({ origins: ["<all_urls>"] }).catch(() => true);
        throw new Error(
          all
            ? "The embedded frame on this page can't be scrolled by extensions. Open it in its own tab and capture it there."
            : "Site access is limited, so the extension can't reach the embedded frame. Set Site access to “On all sites” in chrome://extensions → Details."
        );
      }
      const frameTgt = target(tab.id, frame.frameId, frame.documentId);
      // Inside the frame, an app panel may be what scrolls; if neither it nor
      // the frame's document scrolls (a video or map embed), capture the page.
      const inner = await exec(frameTgt, pageAnalyzeTop).catch(() => null);
      if (inner && inner.type === "element") {
        tgt = frameTgt;
        useElement = true;
        frameMap = probe;
      } else if (frame.scrolls) {
        tgt = frameTgt;
        useElement = false;
        frameMap = probe;
      } else {
        useElement = false;
      }
    }
    j.target = frameMap ? "embedded frame" : useElement ? "inner panel" : "page";
    await escAllFrames(tab.id, true);

    const notes = [];
    let cap;
    try {
      const local = await exec(tgt, pagePrepScroll, [useElement]);
      if (!local) throw new Error("The page changed before the capture started — try again.");
      let geo;
      let edges = local.crop;
      let cutPx = local.cut;
      if (frameMap) {
        // Frame-local geometry → top-frame crop (the iframe may be CSS-scaled).
        const k = frameMap.scale || 1;
        const x0 = frameMap.contentLeft + local.crop.left * k;
        const y0 = frameMap.contentTop + local.crop.top * k;
        const left = Math.max(0, x0);
        const topPx = Math.max(0, y0);
        const crop = {
          left,
          top: topPx,
          width: Math.max(0, Math.min(x0 + local.crop.width * k, frameMap.viewW) - left),
          height: Math.max(0, Math.min(y0 + local.crop.height * k, frameMap.viewH) - topPx),
        };
        const unit = k * local.unit;
        geo = { crop, vw: frameMap.vw, unit, viewScroll: crop.height / unit, pinUnit: k };
        edges = {
          left: local.crop.left + (left - x0) / k,
          top: local.crop.top + (topPx - y0) / k,
          width: crop.width / k,
          height: crop.height / k,
        };
        cutPx += local.crop.height * k - crop.height;
      } else {
        geo = { crop: local.crop, vw: local.vw, unit: local.unit, viewScroll: local.crop.height / local.unit };
      }
      geo.dpr = probe.dpr;
      geo.localVw = local.vw;
      geo.localVh = local.vh;
      if (geo.crop.width < 1 || geo.crop.height < 1) throw new Error("Nothing visible to capture on this page.");
      if (cutPx > 2) {
        notes.push(`The scrolling area is taller than the window, so about ${Math.round(cutPx)} px at its bottom edge couldn't be captured.`);
      }

      cap = await captureTiles(
        {
          scrollTo: async (y, index) => {
            if (j.cancelled) throw new Cancelled();
            // Settle while the capture rate limit runs down, not after it.
            const wait = lastCaptureAt + MIN_CAPTURE_GAP - MIN_SETTLE - Date.now();
            if (wait > 0) await sleep(wait);
            return exec(tgt, pageScrollTo, [y, { preHide: index === 0, hideFixed: index > 0, settle: MIN_SETTLE, edges }]);
          },
          capture: async () => {
            await assertStillCapturable(j);
            return dataUrlToBlob(await captureVisible(tab.windowId));
          },
          position: () => exec(tgt, pageScrollPos),
          shouldStop: () => j.stopEarly,
          progress: (f) => setProgress(5 + f * 75),
        },
        geo
      );
    } finally {
      await exec(tgt, pageRestoreScroll, [], 5000).catch(() => {});
      await escAllFrames(tab.id, false);
    }

    setProgress(82, "saving");
    const out = await stitchTiles(cap, j.format, j.quality, (f) => {
      if (j.cancelled) throw new Cancelled();
      setProgress(82 + f * 10, "saving");
    });
    if (j.target === "inner panel") notes.unshift("Captured the page's scrolling panel.");
    if (j.target === "embedded frame") notes.unshift("Captured the embedded frame.");
    if (out.scale < 0.999) {
      notes.push(`Scaled to ${Math.round(out.scale * 100)}% to fit Chrome's maximum image size.`);
    }
    if (cap.truncated === "height") {
      notes.push("The page is taller than Chrome's maximum image size, so it was captured to about 32,000 px.");
    } else if (cap.truncated === "stopped") {
      notes.push("Stopped early — this is everything captured up to that point.");
    } else if (cap.truncated === "stalled") {
      notes.push(
        `The page stopped scrolling about ${cap.reached}% of the way down — close any open dialog or overlay and try again.`
      );
    } else if (cap.truncated === "tiles") {
      notes.push(`Capture stopped after ${MAX_TILES} screens — the page kept growing (infinite scroll).`);
    }
    return { ...out, notes };
  } finally {
    if (probe.type === "iframe") await exec(topTgt, pageTopRestore, [], 5000).catch(() => {});
  }
}

async function runVisible(j) {
  for (let left = j.delay; left > 0; left--) {
    if (j.cancelled) throw new Cancelled();
    setState({ phase: "waiting", seconds: left });
    await sleep(1000);
  }
  setProgress(30);
  await assertStillCapturable(j);
  const opts = j.format === "jpeg" ? { format: "jpeg", quality: Math.round(j.quality * 100) } : { format: "png" };
  const blob = await dataUrlToBlob(await captureVisible(j.tab.windowId, opts));
  const bmp = await createImageBitmap(blob);
  const size = { width: bmp.width, height: bmp.height };
  bmp.close();
  return { blob, ...size, notes: [] };
}

async function runSelection(j) {
  setState({ phase: "selecting" });
  j.selecting = true;
  await escAllFrames(j.tab.id, true);
  let res;
  try {
    // The page settles this itself (drag, Esc, its own timeout, navigation);
    // the worker-side timeout and abort cover a page that never answers
    // (e.g. frozen in the back/forward cache).
    const aborted = new Promise((resolve) => {
      j.abortSelection = () => resolve({ cancelled: true });
    });
    const selection = exec(target(j.tab.id), pageSelectRegion, [SELECTION_TIMEOUT], SELECTION_TIMEOUT + 15000).catch(
      (e) => (/stopped responding/.test(errText(e)) ? { cancelled: true } : { error: e })
    );
    res = await Promise.race([selection, aborted]);
    if (res && res.error) throw res.error;
  } finally {
    j.selecting = false;
    j.abortSelection = null;
    await escAllFrames(j.tab.id, false);
  }
  if (!res) throw new Error("Couldn't show the selection overlay on this page.");
  if (res.unsupported) throw new Error("Area selection isn't available on this kind of page — use Visible area instead.");
  if (res.cancelled || j.cancelled) throw new Cancelled();
  setProgress(40);
  let shot;
  try {
    await assertStillCapturable(j);
    shot = await dataUrlToBlob(await captureVisible(j.tab.windowId));
  } finally {
    exec(target(j.tab.id), pageRemoveOverlay, [], 5000).catch(() => {});
  }
  setProgress(70, "saving");
  const out = await encodeCrop(shot, res.rect, res.rect.vw, j.format, j.quality);
  return { ...out, notes: [] };
}

// Opens the preview next to the captured tab — or anywhere, if that tab (or
// its window) is gone or can't host extension pages (incognito).
async function openPreview(tab, url) {
  const cur = await chrome.tabs.get(tab.id).catch(() => null);
  if (cur) {
    try {
      await chrome.tabs.create({ url, windowId: cur.windowId, index: cur.index + 1, openerTabId: cur.id });
      return;
    } catch (_) {}
  }
  await chrome.tabs.create({ url });
}

async function deliver(j, out) {
  const { tab } = j;
  if (j.cancelled) throw new Cancelled();
  const filename = makeFilename(tab, j.format);
  const notes = [...out.notes];
  setProgress(95, "saving");

  // Always keep the capture, so it can still be opened if a download is
  // silently blocked.
  const id = crypto.randomUUID();
  const record = {
    id,
    blob: out.blob,
    filename,
    width: out.width,
    height: out.height,
    url: tab.url || "",
    title: tab.title || "",
    notes,
    createdAt: Date.now(),
  };
  await fpsPutCapture(record);
  fpsPruneCaptures().catch(() => {});
  if (j.cancelled) throw new Cancelled();
  const viewerUrl = chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(id)}`);

  if (j.after === "download") {
    const alive = await chrome.tabs.get(tab.id).then(
      () => true,
      () => false
    );
    let saved = false;
    if (alive) {
      const b64 = await blobToBase64(out.blob);
      if (j.cancelled) throw new Cancelled();
      try {
        saved = (await exec(target(tab.id), pageSaveRaw, [b64, out.blob.type, filename], 60000)) === true;
      } catch (_) {}
    }
    if (saved) {
      return {
        message: [
          "Download started. If nothing appears, Chrome may be asking to allow multiple downloads for this site (address bar).",
          ...notes,
        ].join(" "),
        previewId: id,
      };
    }
    notes.push(
      alive
        ? "This page blocked the direct download, so the capture opened here instead."
        : "The tab was closed, so the capture opened here instead."
    );
    await fpsPutCapture(record);
  }

  await openPreview(tab, viewerUrl);
  return { message: "Opened in a new tab." };
}

async function run(j) {
  try {
    const out =
      j.mode === "visible" ? await runVisible(j) : j.mode === "selection" ? await runSelection(j) : await runFull(j);
    if (j.cancelled) throw new Cancelled();
    const res = await deliver(j, out);
    setState({ phase: "done", percent: 100, message: res.message, previewId: res.previewId });
  } catch (e) {
    if (e instanceof Cancelled) setState({ phase: "cancelled", message: "Capture cancelled." });
    else {
      console.error("Full Page Screenshot:", e);
      setState({ phase: "error", message: friendlyError(e) });
    }
  } finally {
    job = null;
  }
}

async function begin(tab, raw = {}) {
  if (job) {
    return {
      ok: false,
      error: job.selecting ? "Finish or cancel the current selection first (Esc)." : "A capture is already running.",
    };
  }
  // Claim the slot before any await so two triggers can't both start.
  const j = {
    tab,
    mode: ["full", "visible", "selection"].includes(raw.mode) ? raw.mode : "full",
    format: raw.format === "jpeg" ? "jpeg" : "png",
    quality: typeof raw.quality === "number" ? clamp(raw.quality, 0.5, 1) : 0.92,
    after: raw.after === "download" ? "download" : "preview",
    delay: raw.mode === "visible" ? clamp(Math.round(Number(raw.delay) || 0), 0, 10) : 0,
    cancelled: false,
    stopEarly: false,
    selecting: false,
    abortSelection: null,
    target: null,
  };
  job = j;
  const reason = await blockedReason(tab).catch(friendlyError);
  if (reason) {
    job = null;
    setState({ phase: "error", message: reason });
    return { ok: false, error: reason };
  }
  setProgress(1);
  run(j);
  return { ok: true };
}

function cancel() {
  if (!job) return;
  job.cancelled = true;
  if (job.selecting) {
    exec(target(job.tab.id), pageCancelSelection).catch(() => {});
    if (job.abortSelection) job.abortSelection();
  }
}

function markErrorSeen(s) {
  lastState = { ...s, seen: true };
  chrome.storage.session.set({ lastState }).catch(() => {});
  updateBadge({ phase: "idle" });
}

async function activeTab() {
  const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  return tab;
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || sender.id !== chrome.runtime.id) return;
  if (msg.type === "START_CAPTURE") {
    activeTab()
      .then((tab) => begin(tab, msg.options || {}))
      .then(sendResponse, (e) => sendResponse({ ok: false, error: friendlyError(e) }));
    return true;
  }
  if (msg.type === "CANCEL_CAPTURE") {
    cancel();
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "STOP_CAPTURE") {
    if (job) job.stopEarly = true;
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "ERROR_SEEN") {
    // The open popup showed an error live; don't show it (or the badge) again.
    if (!job && lastState.phase === "error" && (!msg.at || msg.at === lastState.at)) markErrorSeen(lastState);
    sendResponse({ ok: true });
    return;
  }
  if (msg.type === "GET_STATUS") {
    (async () => {
      const tab = await activeTab().catch(() => null);
      let s = lastState;
      if (!job && s.phase === "idle") {
        const stored = await chrome.storage.session.get("lastState").catch(() => ({}));
        // A capture may have started while we waited; its live state wins.
        s = job ? lastState : stored.lastState || s;
      }
      const age = Date.now() - (s.at || 0);
      // An unseen error is shown once (then the badge clears); other outcomes
      // only briefly.
      const unseenError = !job && s.phase === "error" && !s.seen;
      const show = !!job || unseenError || (s.phase !== "error" && age < 20000);
      if (unseenError) markErrorSeen(s);
      sendResponse({
        running: !!job,
        state: show ? s : { phase: "idle" },
        blocked: job ? null : await blockedReason(tab).catch(() => null),
      });
    })();
    return true;
  }
});

const COMMAND_MODES = {
  "capture-full-page": "full",
  "capture-visible": "visible",
  "capture-selection": "selection",
};

chrome.commands.onCommand.addListener(async (command, tab) => {
  const mode = COMMAND_MODES[command];
  if (!mode) return;
  const { options = {} } = await chrome.storage.local.get(["options"]);
  await begin(tab && tab.id != null ? tab : await activeTab(), { ...options, mode });
});
