const $ = (id) => document.getElementById(id);

const shot = $("shot");
const meta = $("meta");
const note = $("note");
const toast = $("toast");
const empty = $("empty");
const copyBtn = $("copy");
const downloadBtn = $("download");

const isMac = /Mac|iPhone|iPad/.test(navigator.platform);
$("copyKbd").textContent = isMac ? "⌘C" : "Ctrl+C";
$("saveKbd").textContent = isMac ? "⌘S" : "Ctrl+S";

let record = null;
let objectUrl = null;
let toastTimer = 0;

function showToast(text, kind) {
  toast.textContent = text;
  toast.className = kind || "";
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => {
    toast.textContent = "";
    toast.className = "";
  }, 3500);
}

function formatBytes(n) {
  if (n < 1024) return n + " B";
  if (n < 1024 * 1024) return (n / 1024).toFixed(0) + " KB";
  return (n / (1024 * 1024)).toFixed(1) + " MB";
}

function showMissing(text) {
  meta.textContent = "";
  shot.style.display = "none";
  empty.hidden = false;
  empty.textContent = text;
}

function download() {
  if (!record) return;
  const a = document.createElement("a");
  a.href = objectUrl;
  a.download = record.filename;
  document.body.appendChild(a);
  a.click();
  a.remove();
  showToast("Saved to Downloads", "ok");
}

// The clipboard only accepts PNG, so JPEG captures are converted first. The
// ClipboardItem takes a promise so the write stays inside the click gesture.
async function toPng(blob) {
  if (blob.type === "image/png") return blob;
  const bmp = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  canvas.getContext("2d").drawImage(bmp, 0, 0);
  bmp.close();
  return canvas.convertToBlob({ type: "image/png" });
}

async function copy() {
  if (!record) return;
  copyBtn.disabled = true;
  try {
    await navigator.clipboard.write([new ClipboardItem({ "image/png": toPng(record.blob) })]);
    showToast("Copied to clipboard", "ok");
  } catch (e) {
    showToast("Copy failed: " + ((e && e.message) || e), "err");
  } finally {
    copyBtn.disabled = false;
  }
}

async function load() {
  const id = new URLSearchParams(location.search).get("id");
  if (!id) return showMissing("No screenshot selected.");
  try {
    record = await fpsGetCapture(id);
  } catch (e) {
    return showMissing("Couldn't read the screenshot: " + ((e && e.message) || e));
  }
  if (!record) {
    return showMissing("This screenshot is no longer available — only the 5 most recent captures are kept.");
  }

  objectUrl = URL.createObjectURL(record.blob);
  shot.src = objectUrl;
  shot.style.display = "block";

  let host = "";
  try {
    host = new URL(record.url).hostname;
  } catch (_) {}
  document.title = "Screenshot — " + (record.title || host || record.filename);

  const kind = record.blob.type === "image/jpeg" ? "JPEG" : "PNG";
  meta.textContent = `${record.width} × ${record.height} px · ${formatBytes(record.blob.size)} · ${kind}`;
  if (record.url) {
    meta.append(" · ");
    const link = document.createElement("a");
    link.href = record.url;
    link.textContent = record.title || host || record.url;
    link.target = "_blank";
    link.rel = "noopener";
    meta.append(link);
  }
  if (record.notes && record.notes.length) {
    note.textContent = record.notes.join(" ");
    note.style.display = "block";
  }
  copyBtn.disabled = false;
  downloadBtn.disabled = false;
}

shot.addEventListener("click", () => shot.classList.toggle("actual"));
copyBtn.addEventListener("click", copy);
downloadBtn.addEventListener("click", download);
document.addEventListener("keydown", (e) => {
  const mod = isMac ? e.metaKey : e.ctrlKey;
  if (!mod || e.altKey || e.shiftKey) return;
  const key = e.key.toLowerCase();
  if (key === "s") {
    e.preventDefault();
    download();
  } else if (key === "c" && !String(getSelection())) {
    e.preventDefault();
    copy();
  }
});
load();
