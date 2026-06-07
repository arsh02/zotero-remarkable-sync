// rmapi-js relies on ambient Web API globals (`fetch`, `crypto.subtle`,
// `TextEncoder`). Zotero's bootstrap sandbox does not reliably expose them, so
// we source them from the main Zotero window. That window is privileged
// (chrome), so its `fetch` performs cross-origin requests without CORS issues —
// exactly what we need to reach the reMarkable cloud.

let ensured = false;

export function ensureNetworkGlobals(): void {
  if (ensured) return;
  const g = globalThis as any;
  const win = Zotero.getMainWindow() as any;
  if (!win) {
    throw new Error(
      "reMarkable Sync: no Zotero main window available to source network globals",
    );
  }
  if (typeof g.fetch === "undefined" && win.fetch) {
    // Bind so `this` is the window, otherwise Gecko throws "illegal invocation".
    g.fetch = win.fetch.bind(win);
    g.Headers = win.Headers;
    g.Request = win.Request;
    g.Response = win.Response;
    g.Blob = win.Blob;
  }
  if (typeof g.crypto === "undefined" && win.crypto) {
    g.crypto = win.crypto;
  }
  if (typeof g.TextEncoder === "undefined" && win.TextEncoder) {
    g.TextEncoder = win.TextEncoder;
    g.TextDecoder = win.TextDecoder;
  }
  ensured = true;
}
