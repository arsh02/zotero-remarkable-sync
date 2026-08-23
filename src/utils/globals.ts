// rmapi-js relies on ambient Web API globals (`fetch`, `crypto.subtle`,
// `TextEncoder`). Zotero's bootstrap sandbox does not reliably expose them, so
// we source them from the main Zotero window. That window is privileged
// (chrome), so its `fetch` performs cross-origin requests without CORS issues —
// exactly what we need to reach the reMarkable cloud.

let ensured = false;

// Abort a single reMarkable HTTP request after this long (per request, not per
// sync). Uploads of large PDFs are chunked, so no single request should approach
// this.
const FETCH_TIMEOUT_MS = 90_000;

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
    const rawFetch = win.fetch.bind(win);
    // The reMarkable cloud occasionally accepts a connection then never replies;
    // rmapi-js has no per-request timeout, so a single stalled request hangs the
    // whole sync ("Resolving reMarkable folder…" forever). Abort after a generous
    // window so a stall surfaces as an error we can report and retry.
    g.fetch = (input: any, init: any = {}) => {
      if (init?.signal) return rawFetch(input, init); // caller manages its own
      const ctrl = new win.AbortController();
      const timer = win.setTimeout(() => ctrl.abort(), FETCH_TIMEOUT_MS);
      return rawFetch(input, { ...init, signal: ctrl.signal }).finally(() =>
        win.clearTimeout(timer),
      );
    };
    g.Headers = win.Headers;
    g.Request = win.Request;
    g.Response = win.Response;
    g.Blob = win.Blob;
    g.AbortController = win.AbortController;
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

/**
 * DOMParser/XMLSerializer are natively global in Zotero 7+'s bootstrap scope
 * (Firefox 102+), but fall back to the main window's for safety — mirrors the
 * defensive sourcing above for fetch/crypto.
 */
export function getDOMParser(): typeof DOMParser {
  const g = globalThis as any;
  if (typeof g.DOMParser !== "undefined") return g.DOMParser;
  const win = Zotero.getMainWindow() as any;
  if (win?.DOMParser) return win.DOMParser;
  throw new Error("reMarkable Sync: no DOMParser available");
}

export function getXMLSerializer(): typeof XMLSerializer {
  const g = globalThis as any;
  if (typeof g.XMLSerializer !== "undefined") return g.XMLSerializer;
  const win = Zotero.getMainWindow() as any;
  if (win?.XMLSerializer) return win.XMLSerializer;
  throw new Error("reMarkable Sync: no XMLSerializer available");
}
