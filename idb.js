// Tiny IndexedDB store shared by the service worker (importScripts) and the
// preview page (<script src>). Captures are handed from the worker to the
// preview tab as Blobs here — no base64 round-trips, no size limits from
// messaging or data: URLs.

const FPS_DB_NAME = "fps-captures";
const FPS_STORE = "captures";
const FPS_KEEP = 5; // newest captures kept for re-opening a preview tab

function fpsOpenDb() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(FPS_DB_NAME, 1);
    req.onupgradeneeded = () => req.result.createObjectStore(FPS_STORE, { keyPath: "id" });
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function fpsTx(mode, fn) {
  const db = await fpsOpenDb();
  try {
    return await new Promise((resolve, reject) => {
      const tx = db.transaction(FPS_STORE, mode);
      const store = tx.objectStore(FPS_STORE);
      let result;
      Promise.resolve(fn(store)).then((r) => (result = r), reject);
      tx.oncomplete = () => resolve(result);
      tx.onerror = () => reject(tx.error);
      tx.onabort = () => reject(tx.error || new Error("Storage transaction aborted."));
    });
  } finally {
    db.close();
  }
}

function fpsReq(req) {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function fpsPutCapture(record) {
  return fpsTx("readwrite", (store) => fpsReq(store.put(record)));
}

function fpsGetCapture(id) {
  return fpsTx("readonly", (store) => fpsReq(store.get(id)));
}

// Drop everything but the newest FPS_KEEP captures.
function fpsPruneCaptures() {
  return fpsTx("readwrite", async (store) => {
    const all = await fpsReq(store.getAll());
    all.sort((a, b) => b.createdAt - a.createdAt);
    for (const rec of all.slice(FPS_KEEP)) store.delete(rec.id);
  });
}
