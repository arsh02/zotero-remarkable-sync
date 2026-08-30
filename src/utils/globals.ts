// rmapi-js relies on ambient `fetch` / `crypto.subtle` / `TextEncoder`.
// Zotero's plugin sandbox `fetch` (and even the chrome-window copy) is
// CORS-restricted on Zotero 9 and fails with
// "NetworkError when attempting to fetch resource" against
// eu.tectonic.remarkable.com. Route every request through Zotero.HTTP, which
// uses the privileged XMLHttpRequest stack (proxies, certs, no CORS).

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
  if (typeof Zotero.HTTP?.request !== "function") {
    throw new Error(
      "reMarkable Sync: Zotero.HTTP.request is unavailable; cannot reach the cloud",
    );
  }
  if (Zotero.HTTP.browserIsOffline?.()) {
    throw new Error(`Zotero is offline; cannot reach reMarkable (${url})`);
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
  try {
    const xhr = await Zotero.HTTP.request(method, url, options);
    return responseFromXhr(xhr, url);
  } catch (e) {
    const xmlhttp = (e as { xmlhttp?: XMLHttpRequest }).xmlhttp;
    if (xmlhttp && xmlhttp.status > 0) return responseFromXhr(xmlhttp, url);
    throw rewriteFetchError(e, url);
  }
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
  const a = e as any;
  const name = typeof a?.name === "string" ? a.name : "";
  const raw =
    typeof a?.message === "string" && a.message
      ? a.message
      : typeof e === "string"
        ? e
        : String(e ?? "unknown error");
  const url = describeUrl(input);
  if (name === "AbortError" || /abort/i.test(raw) || /timeout/i.test(raw)) {
    return new Error(
      `reMarkable request timed out after ${FETCH_TIMEOUT_MS / 1000}s (${url})`,
    );
  }
  return new Error(`Network error reaching reMarkable (${url}): ${raw}`);
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
