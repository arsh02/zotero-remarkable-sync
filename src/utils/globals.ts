// rmapi-js relies on ambient `fetch` / `crypto.subtle` / `TextEncoder`.
// Zotero's plugin sandbox `fetch` is CORS-restricted on Zotero 9. Route
// requests through an XMLHttpRequest constructed on the chrome main window
// (privileged principal, no CORS). JSON POSTs also need an explicit
// Content-Type: application/json — Zotero.HTTP.request otherwise sends
// them as form-urlencoded, which makes device registration fail. Fall back
// to Zotero.HTTP.request if the chrome XHR returns status 0.

import { log } from "./log";

let ensured = false;

// Abort a single reMarkable HTTP request after this long (per request, not per
// sync). Uploads of large PDFs are chunked, so no single request should approach
// this.
const FETCH_TIMEOUT_MS = 90_000;

const WRAPPED = "__rmsFetchWrapped";

export function ensureNetworkGlobals(): void {
  if (ensured) return;
  const g = globalThis as any;
  const win = Zotero.getMainWindow() as any;
  if (!win) {
    throw new Error(
      "reMarkable Sync: no Zotero main window available to source network globals",
    );
  }

  if (!g[WRAPPED]) {
    g.fetch = zoteroFetch;
    g[WRAPPED] = true;
  }
  if (win.Headers) g.Headers = win.Headers;
  if (win.Request) g.Request = win.Request;
  if (win.Blob) g.Blob = win.Blob;
  if (win.AbortController) g.AbortController = win.AbortController;

  if (typeof g.crypto === "undefined" && win.crypto) {
    g.crypto = win.crypto;
  }
  if (typeof g.TextEncoder === "undefined" && win.TextEncoder) {
    g.TextEncoder = win.TextEncoder;
    g.TextDecoder = win.TextDecoder;
  }
  ensured = true;
}

/** Minimal Fetch `Response` so rmapi-js can call `.ok` / `.text()` / etc. */
class HttpResponse {
  readonly status: number;
  readonly statusText: string;
  readonly ok: boolean;
  readonly url: string;
  readonly headers: { get(name: string): string | null };
  private readonly buf: ArrayBuffer;

  constructor(
    buf: ArrayBuffer,
    status: number,
    statusText: string,
    headerMap: Record<string, string>,
    url: string,
  ) {
    this.buf = buf;
    this.status = status;
    this.statusText = statusText;
    this.ok = status >= 200 && status < 300;
    this.url = url;
    this.headers = {
      get(name: string) {
        return headerMap[name.toLowerCase()] ?? null;
      },
    };
  }

  async arrayBuffer(): Promise<ArrayBuffer> {
    return this.buf;
  }

  async text(): Promise<string> {
    return new TextDecoder().decode(this.buf);
  }

  async json(): Promise<unknown> {
    const t = await this.text();
    return t ? JSON.parse(t) : null;
  }
}

async function zoteroFetch(
  input: unknown,
  init: Record<string, unknown> = {},
): Promise<HttpResponse> {
  const url = describeUrl(input);
  const method = String(init.method || "GET").toUpperCase();
  const headers = headersToObject(init.headers);
  const body = await normalizeBody(init.body);
  // rmapi-js POSTs JSON with no Content-Type. Native fetch then sends
  // text/plain; Zotero.HTTP.request defaults to form-urlencoded and the
  // auth endpoint rejects the body — Connect looks like a bad one-time
  // code. Always mark JSON strings as application/json.
  applyJsonContentType(headers, body);
  if (Zotero.HTTP.browserIsOffline?.()) {
    throw new Error(`Zotero is offline; cannot reach reMarkable (${url})`);
  }
  try {
    let xhr = await chromeWindowRequest(method, url, headers, body);
    if (xhr.status === 0) {
      log(
        `zoteroFetch: chrome XHR status 0 for ${method} ${url}; trying Zotero.HTTP`,
      );
      xhr = await zoteroHttpRequest(method, url, headers, body);
    }
    if (xhr.status === 0) {
      throw new Error(
        `No HTTP response from ${url} (status 0). DNS, TLS, firewall, or proxy blocked the host — not a bad one-time code.`,
      );
    }
    logIfError(method, url, xhr);
    return responseFromXhr(xhr, url);
  } catch (e) {
    const xmlhttp = (e as { xmlhttp?: XMLHttpRequest }).xmlhttp;
    if (xmlhttp && xmlhttp.status > 0) {
      logIfError(method, url, xmlhttp);
      return responseFromXhr(xmlhttp, url);
    }
    throw rewriteFetchError(e, url);
  }
}

function applyJsonContentType(
  headers: Record<string, string>,
  body: string | Uint8Array | undefined,
): void {
  if (typeof body !== "string") return;
  if (Object.keys(headers).some((k) => k.toLowerCase() === "content-type")) {
    return;
  }
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{") || trimmed.startsWith("[")) {
    headers["Content-Type"] = "application/json";
  }
}

/**
 * XHR constructed on Zotero's chrome window inherits that window's
 * privileged principal, so it is not CORS-limited the way sandbox `fetch`
 * is. This is the path that originally succeeded for device registration.
 */
function chromeWindowRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array | undefined,
): Promise<XMLHttpRequest> {
  const win = Zotero.getMainWindow() as any;
  if (!win?.XMLHttpRequest) {
    return Promise.reject(
      new Error("reMarkable Sync: no chrome window XMLHttpRequest"),
    );
  }
  return new Promise((resolve, reject) => {
    const xhr = new win.XMLHttpRequest();
    xhr.open(method, url, true);
    xhr.timeout = FETCH_TIMEOUT_MS;
    xhr.responseType = "arraybuffer";
    for (const [key, value] of Object.entries(headers)) {
      try {
        xhr.setRequestHeader(key, value);
      } catch (e) {
        log(`zoteroFetch: setRequestHeader(${key}) failed:`, e);
      }
    }
    xhr.onloadend = () => resolve(xhr);
    xhr.ontimeout = () =>
      reject(
        new Error(
          `reMarkable request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${url})`,
        ),
      );
    try {
      xhr.send(body ?? null);
    } catch (e) {
      reject(e);
    }
  });
}

async function zoteroHttpRequest(
  method: string,
  url: string,
  headers: Record<string, string>,
  body: string | Uint8Array | undefined,
): Promise<XMLHttpRequest> {
  if (typeof Zotero.HTTP?.request !== "function") {
    throw new Error(
      "reMarkable Sync: Zotero.HTTP.request is unavailable; cannot reach the cloud",
    );
  }
  const options: Parameters<typeof Zotero.HTTP.request>[2] = {
    headers,
    timeout: FETCH_TIMEOUT_MS,
    successCodes: false,
    errorDelayMax: 0,
    noCache: true,
    responseType: "arraybuffer",
  };
  if (body !== undefined) options.body = body;
  return Zotero.HTTP.request(method, url, options);
}

/**
 * The exception rmapi-js throws for a non-2xx response only carries the
 * status/statusText/body-derived message — never the request method, the
 * response headers, or a body preview. Log all of that ourselves so Help →
 * Debug Output Logging has the full picture even when the caller's error
 * object is thin (e.g. an empty body on a 401/403 reads as a blank error).
 */
function logIfError(method: string, url: string, xhr: XMLHttpRequest): void {
  if (xhr.status >= 200 && xhr.status < 300) return;
  // Zotero.HTTP.request with successCodes:false resolves rather than rejects
  // even when no HTTP response was ever received (DNS failure, connection
  // refused, TLS error) — that shows up as status 0, not as a thrown
  // exception. Flag it plainly: this is a connectivity/firewall problem, not
  // an application-level error from the reMarkable API.
  if (xhr.status === 0) {
    log(
      `zoteroFetch: ${method} ${url} -> status 0 (no HTTP response received` +
        " — DNS failure, connection refused, TLS error, or blocked by a" +
        " firewall/proxy, not a reMarkable API error)",
    );
    return;
  }
  let bodyPreview = "";
  try {
    bodyPreview = xhrToArrayBuffer(xhr).byteLength
      ? new TextDecoder().decode(xhrToArrayBuffer(xhr)).slice(0, 500)
      : "(empty body)";
  } catch {
    bodyPreview = "(unreadable body)";
  }
  log(
    `zoteroFetch: ${method} ${url} -> ${xhr.status} ${xhr.statusText || ""}`.trim(),
    `body: ${bodyPreview}`,
  );
}

function responseFromXhr(xhr: XMLHttpRequest, url: string): HttpResponse {
  return new HttpResponse(
    xhrToArrayBuffer(xhr),
    xhr.status,
    xhr.statusText || "",
    parseResponseHeaders(xhr),
    url,
  );
}

function xhrToArrayBuffer(xhr: XMLHttpRequest): ArrayBuffer {
  const r = xhr.response;
  if (r instanceof ArrayBuffer) return r;
  if (r instanceof Uint8Array) {
    return r.slice().buffer;
  }
  if (typeof r === "string" && r.length) {
    return new TextEncoder().encode(r).buffer;
  }
  return new ArrayBuffer(0);
}

function headersToObject(headers: unknown): Record<string, string> {
  if (!headers) return {};
  const anyH = headers as any;
  if (typeof anyH.forEach === "function") {
    const out: Record<string, string> = {};
    anyH.forEach((value: string, key: string) => {
      out[key] = value;
    });
    return out;
  }
  return { ...(headers as Record<string, string>) };
}

async function normalizeBody(
  body: unknown,
): Promise<string | Uint8Array | undefined> {
  if (body == null) return undefined;
  if (typeof body === "string") return body;
  if (body instanceof Uint8Array) return body;
  if (body instanceof ArrayBuffer) return new Uint8Array(body);
  if (ArrayBuffer.isView(body)) {
    return new Uint8Array(body.buffer, body.byteOffset, body.byteLength);
  }
  const blob = body as { arrayBuffer?: () => Promise<ArrayBuffer> };
  if (typeof blob.arrayBuffer === "function") {
    return new Uint8Array(await blob.arrayBuffer());
  }
  return String(body);
}

function parseResponseHeaders(xhr: XMLHttpRequest): Record<string, string> {
  const raw = xhr.getAllResponseHeaders?.() ?? "";
  const out: Record<string, string> = {};
  for (const line of raw.split(/\r?\n/)) {
    const i = line.indexOf(":");
    if (i < 0) continue;
    out[line.slice(0, i).trim().toLowerCase()] = line.slice(i + 1).trim();
  }
  return out;
}

function rewriteFetchError(e: unknown, input: unknown): Error {
  const url = describeUrl(input);
  const detail = describeException(e);
  if (/abort/i.test(detail) || /timeout/i.test(detail)) {
    return new Error(
      `reMarkable request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${url}): ${detail}`,
    );
  }
  return new Error(`Network error reaching reMarkable (${url}): ${detail}`);
}

/**
 * Pull every scrap of diagnostic info out of a thrown value. Zotero.HTTP's
 * rejections are XPCOM-flavored: `.message` is frequently empty, and the
 * useful bits — HTTP status, the underlying nsresult, the exception's real
 * class name — live on non-enumerable properties that `String(e)` and
 * `JSON.stringify(e)` both drop. Never return an empty string: a message
 * like "unknown error (no message from Zotero.HTTP)" is itself a diagnostic
 * finding, not a failure to report one.
 */
function describeException(e: unknown): string {
  const a = e as any;
  const bits: string[] = [];
  const ctor = a?.constructor?.name;
  if (typeof a?.name === "string" && a.name) bits.push(a.name);
  else if (ctor && ctor !== "Object" && ctor !== "Error") bits.push(ctor);
  if (typeof a?.message === "string" && a.message) bits.push(a.message);

  const xhr = a?.xmlhttp;
  if (xhr) {
    if (typeof xhr.status === "number" && Number.isFinite(xhr.status)) {
      bits.push(`http ${xhr.status} ${xhr.statusText || ""}`.trim());
    }
    const nsresult = xhr.channel?.status;
    if (typeof nsresult === "number" && nsresult) {
      bits.push(`nsresult 0x${(nsresult >>> 0).toString(16)}`);
    }
  }

  if (bits.length === 0) {
    try {
      const s = typeof e === "string" ? e : String(e);
      if (s && s !== "[object Object]" && s !== "undefined") bits.push(s);
    } catch {
      /* ignore */
    }
  }
  return bits.length
    ? bits.join(" — ")
    : "unknown error (no message from Zotero.HTTP)";
}

function describeUrl(input: unknown): string {
  try {
    if (typeof input === "string") return input.split("?")[0] || input;
    const url = (input as any)?.url;
    if (typeof url === "string") return url.split("?")[0] || url;
  } catch {
    /* ignore */
  }
  return "request";
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
