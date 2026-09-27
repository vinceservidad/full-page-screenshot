const $ = (id) => document.getElementById(id);

const formatSel = $("format");
const afterSel = $("after");
const delaySel = $("delay");
const delayRow = $("delayRow");
const qualityRow = $("qualityRow");
const quality = $("quality");
const qualityVal = $("qualityVal");
const btn = $("capture");
const cancelBtn = $("cancel");
const status = $("status");
const pct = $("pct");
const bar = $("bar");
const barWrap = $("barWrap");
const modeHint = $("modeHint");
const modeButtons = Array.from(document.querySelectorAll(".modes button"));
const previewLink = $("openPreview");

const RUNNING = ["starting", "capturing", "saving", "selecting", "waiting"];

let mode = "full";
let phase = "idle";
let jobMode = null; // mode of the capture the worker is running
let live = false; // a live state arrived, so a slower GET_STATUS reply is stale
let previewId = null;
let blocked = null;

const MODE_META = {
  full: {
    label: "Capture Full Page",
    hint: "Scrolls the page — or the app panel / embedded preview that scrolls — and stitches one tall image.",
  },
  visible: {
    label: "Capture Visible Area",
    hint: "Captures only what's currently on screen.",
  },
  selection: {
    label: "Select Area to Capture",
    hint: "Drag a rectangle on the page to capture just that region.",
  },
};

// Show the shortcut Chrome actually assigned (it skips suggested keys that
// clash with another extension, and users can rebind them).
chrome.commands.getAll().then((cmds) => {
  const cmd = cmds.find((c) => c.name === "capture-full-page");
  const el = $("shortcut");
  el.textContent = "";
  if (cmd && cmd.shortcut) {
    const kbd = document.createElement("kbd");
    kbd.textContent = cmd.shortcut;
    el.append(kbd, " captures the full page.");
  } else {
    el.textContent = "No shortcut is set for full-page capture.";
  }
});

function syncUI() {
  const running = RUNNING.includes(phase);
  qualityRow.hidden = formatSel.value !== "jpeg";
  delayRow.hidden = mode !== "visible";
  qualityVal.textContent = Math.round(parseFloat(quality.value) * 100) + "%";
  modeHint.textContent = MODE_META[mode].hint;
  modeButtons.forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.mode === mode)));
  // While a full-page capture scrolls, the main button stops it early and
  // keeps what's been captured (handy on infinite-scroll feeds).
  const canStop = phase === "capturing" && jobMode === "full";
  btn.textContent = canStop ? "Stop & save" : MODE_META[mode].label;
  btn.disabled = canStop ? false : running || !!blocked;
  cancelBtn.hidden = !running;
}

function setStatus(text, kind) {
  // Only touch the live region when the message changes, so screen readers
  // hear phase changes rather than every percent.
  if (status.textContent !== (text || "")) status.textContent = text || "";
  status.parentElement.className = "statusRow " + (kind || "");
}

// Mirrors the service worker's capture state (also used when the popup is
// reopened mid-capture).
function render(state) {
  state = state || { phase: "idle" };
  phase = state.phase || "idle";
  jobMode = state.mode || null;
  const showBar = phase === "capturing" || phase === "saving";
  barWrap.style.display = showBar ? "block" : "none";
  bar.style.width = (state.percent || 0) + "%";
  barWrap.setAttribute("aria-valuenow", String(state.percent || 0));
  pct.textContent = showBar ? `${state.percent || 0}%` : "";

  const what = state.target && state.target !== "page" ? ` ${state.target}` : "";
  // After a capture the active tab may be one that can't be captured (the
  // preview itself) — say why the button is disabled.
  const tail = blocked ? " " + blocked : "";
  if (phase === "capturing") setStatus(`Capturing${what}…`);
  else if (phase === "saving") setStatus("Saving image…");
  else if (phase === "selecting") setStatus("Drag on the page to select an area (Esc cancels).");
  else if (phase === "waiting") setStatus(`Capturing in ${state.seconds} s…`);
  else if (phase === "done") setStatus("✓ " + (state.message || "Done.") + tail, blocked ? "err" : "ok");
  else if (phase === "error") setStatus("Error: " + (state.message || "capture failed") + tail, "err");
  else if (phase === "cancelled") setStatus((state.message || "Cancelled.") + tail, blocked ? "err" : "");
  else if (blocked) setStatus(blocked, "err");
  else setStatus("");
  previewId = phase === "done" ? state.previewId || null : null;
  previewLink.hidden = !previewId;
  syncUI();
}

function currentOptions() {
  return {
    mode,
    format: formatSel.value,
    quality: parseFloat(quality.value),
    after: afterSel.value,
    delay: parseInt(delaySel.value, 10) || 0,
  };
}

function saveOptions() {
  chrome.storage.local.set({ options: currentOptions() });
}

async function init() {
  const { options } = await chrome.storage.local.get(["options"]);
  if (options) {
    if (MODE_META[options.mode]) mode = options.mode;
    if (options.format) formatSel.value = options.format;
    if (options.quality != null) quality.value = options.quality;
    if (options.after) afterSel.value = options.after;
    if (options.delay != null) delaySel.value = String(options.delay);
  }
  syncUI();
  try {
    const res = await chrome.runtime.sendMessage({ type: "GET_STATUS" });
    if (live) return;
    blocked = res && res.blocked;
    render(res ? res.state : null);
  } catch (_) {
    render(null);
  }
}

modeButtons.forEach((b) =>
  b.addEventListener("click", () => {
    mode = b.dataset.mode;
    syncUI();
    saveOptions();
  })
);
for (const el of [formatSel, afterSel, delaySel]) {
  el.addEventListener("change", () => {
    syncUI();
    saveOptions();
  });
}
quality.addEventListener("input", () => {
  syncUI();
  saveOptions();
});

chrome.runtime.onMessage.addListener((msg) => {
  if (!msg || msg.type !== "CAPTURE_STATE") return;
  live = true;
  if (RUNNING.includes(msg.state.phase)) blocked = null;
  render(msg.state);
  // Seen here, so the worker needn't show it (or its badge) again.
  if (msg.state.phase === "error") chrome.runtime.sendMessage({ type: "ERROR_SEEN", at: msg.state.at }).catch(() => {});
});

btn.addEventListener("click", async () => {
  if (phase === "capturing" && jobMode === "full") {
    chrome.runtime.sendMessage({ type: "STOP_CAPTURE" }).catch(() => {});
    btn.disabled = true;
    return;
  }
  saveOptions();
  const opts = currentOptions();
  live = true;
  phase = "starting";
  syncUI();
  setStatus(mode === "selection" ? "Switch to the page and drag to select…" : "Starting…");
  try {
    const res = await chrome.runtime.sendMessage({ type: "START_CAPTURE", options: opts });
    if (!res || !res.ok) {
      render({ phase: "error", message: (res && res.error) || "could not start" });
      return;
    }
    // Get out of the way so the page can take the drag (or the menu the user
    // wants to open during the delay) right away.
    if (mode === "selection" || (mode === "visible" && opts.delay > 0)) window.close();
  } catch (e) {
    render({ phase: "error", message: (e && e.message) || String(e) });
  }
});

cancelBtn.addEventListener("click", () => {
  chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }).catch(() => {});
});

// Esc in the popup cancels a running capture (the page's own Esc handler only
// sees keys while the page has focus).
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape" && RUNNING.includes(phase)) {
    e.preventDefault();
    chrome.runtime.sendMessage({ type: "CANCEL_CAPTURE" }).catch(() => {});
  }
});

previewLink.addEventListener("click", (e) => {
  e.preventDefault();
  if (previewId) chrome.tabs.create({ url: chrome.runtime.getURL(`viewer.html?id=${encodeURIComponent(previewId)}`) });
});

$("shortcuts").addEventListener("click", (e) => {
  e.preventDefault();
  chrome.tabs.create({ url: "chrome://extensions/shortcuts" });
});

init();
