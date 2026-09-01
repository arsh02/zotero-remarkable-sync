// rmapi-js relies on ambient `fetch` / `crypto.subtle` / `TextEncoder`.
// Zotero's plugin sandbox `fetch` (and a chrome-window XMLHttpRequest
// constructed from that sandbox) is CORS-restricted on Zotero 9. Route every
// request through Zotero.HTTP.request, which uses a privileged XMLHttpRequest
// stack and is not CORS-limited. JSON POSTs also need an explicit
// Content-Type: application/json — left unset, requests default to
// form-urlencoded, which makes device registration fail.

import { log } from "./log";
import { BUILD } from "./build";

const Cc = Components.classes as any;
const Ci = Components.interfaces as any;

let ensured = false;

// Abort a single reMarkable HTTP request after this long (per request, not per
// sync). Uploads of large PDFs are chunked, so no single request should approach
// this.
const FETCH_TIMEOUT_MS = 90_000;

const WRAPPED = "__rmsFetchWrapped";

// eu.tectonic.remarkable.com resolves to both an A and an AAAA record. On a
// network where the AAAA route is blackholed (packets silently dropped, no
// RST/ICMP), confirmed here with a raw `curl -6`/`openssl s_client` connection
// to that exact IPv6 address hanging until timeout, Gecko's Happy-Eyeballs
// dual-stack racing can still end up misattributing the failed IPv6 attempt's
// state to the connection, surfacing as a spurious SEC_ERROR_UNKNOWN_ISSUER
// instead of a clean timeout/connection-refused — even though a plain IPv4
// connection (which is all curl used, and all that host actually needs)
// succeeds instantly. webapp-prod.cloud.remarkable.engineering has no AAAA
// record at all, which is exactly why *that* host never hit this. Disabling
// IPv6 DNS resolution network-wide is the standard, documented Firefox fix
// for "IPv6 route exists on paper but doesn't work" networks; it's a global
// preference (Gecko has no smaller-grained knob), so it also protects any
// other Zotero networking that happens to hit an IPv6-enabled host on this
// same broken network — not just reMarkable Sync's own requests.
function ipv6DnsDisabled(): boolean | "unavailable" {
  try {
    const prefs = Cc["@mozilla.org/preferences-service;1"].getService(
      Ci.nsIPrefBranch,
    );
    return !!prefs.getBoolPref("network.dns.disableIPv6", false);
  } catch {
    return "unavailable";
  }
}

function disableBrokenIPv6(): void {
  try {
    const prefs = Cc["@mozilla.org/preferences-service;1"].getService(
      Ci.nsIPrefBranch,
    );
    const alreadySet = prefs.getBoolPref("network.dns.disableIPv6", false);
    if (!alreadySet) {
      prefs.setBoolPref("network.dns.disableIPv6", true);
      log(
        "ensureNetworkGlobals: set network.dns.disableIPv6=true (this network's" +
          " IPv6 route to eu.tectonic.remarkable.com's AAAA address timed out" +
          " with no response, which Necko's dual-stack racing was surfacing as" +
          " a SEC_ERROR_UNKNOWN_ISSUER instead of a clean connection failure)",
      );
    }
    // A DNS entry (including its AAAA record) resolved earlier in this same
    // process — e.g. a prior failed sync attempt before this pref was ever
    // set — can stay cached past the pref flip until its TTL expires.
    // Flushing unconditionally, every time network globals are (re)ensured,
    // means the very next lookup for these hosts is always guaranteed to be
    // IPv4-only rather than depending on when the cache happens to expire.
    try {
      Cc["@mozilla.org/network/dns-service;1"]
        .getService(Ci.nsIDNSService)
        .clearCache(true);
      log("ensureNetworkGlobals: flushed the DNS cache");
    } catch (e) {
      log("ensureNetworkGlobals: could not flush the DNS cache:", e);
    }
  } catch (e) {
    log("ensureNetworkGlobals: could not set network.dns.disableIPv6:", e);
  }
}

export function ensureNetworkGlobals(): void {
  if (ensured) return;
  const g = globalThis as any;
  const win = Zotero.getMainWindow() as any;
  if (!win) {
    throw new Error(
      "reMarkable Sync: no Zotero main window available to source network globals",
    );
  }

  disableBrokenIPv6();

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
    // Firefox XHR often leaves statusText empty. rmapi-js's auth() throws
    // `couldn't fetch auth token: ${resp.statusText}` and nothing else, so
    // an empty statusText is a blank error dialog. Always provide a phrase.
    this.statusText = statusText.trim() || statusPhrase(status);
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

// The real root cause of every "empty body" bug chased through v0.3.14 -
// v0.3.21 (0-char registration token, JSON.parse failures on getRootHash,
// "schema version  not supported" on getEntries): `Zotero.HTTP.request`
// simply does not implement `responseType: "arraybuffer"` at all — per the
// Zotero team directly ( https://groups.google.com/g/zotero-dev/c/gjfM2QK08p4 ,
// forum discussion 120148 ), "We only support the text, json, and document
// responseTypes" — arraybuffer silently produces an empty result for
// *every* request regardless of content, size, or endpoint. Widening a
// URL-pattern allowlist endpoint-by-endpoint (as earlier builds did) could
// never fully fix this, since `/sync/v3/files/{hash}` alone serves both
// small text index files *and* real binary PDF/EPUB bytes behind the exact
// same URL shape — no pattern can tell those apart.
//
// v0.3.22 tried the documented workaround from that same forum thread —
// `responseType: "text"` + `responseCharset: "x-user-defined"` — but passing
// `responseCharset` to `Zotero.HTTP.request` threw `ReferenceError:
// responseCharset is not defined` synchronously, before any network I/O.
// That option is real in the types and in translator-sandbox `request()`,
// but this Zotero build's privileged `Zotero.HTTP.request` hits an internal
// bug (a bare `responseCharset` identifier) when the option is set.
//
// v0.3.23 tried to bypass the wrapper entirely with
// `Cc["@mozilla.org/xmlextras/xmlhttprequest;1"].createInstance(...)`. That
// contract is simply not in the plugin sandbox's `Components.classes`
// (`Cc[...]` is undefined), so Connect failed before any request was sent.
//
// v0.3.24 stays on `Zotero.HTTP.request` (`responseType: "text"`, which we
// already know returns a real body) and applies the x-user-defined charset
// the way the wrapper actually exposes: `requestObserver` runs after
// `xhr.open()`, where `overrideMimeType("text/plain; charset=x-user-defined")`
// is legal. That is the same MIME override `responseCharset` was supposed
// to perform, without touching the broken option. `.charCodeAt(i) & 0xff`
// then recovers each original wire byte — see xhrToArrayBuffer.
const TOKEN_ENDPOINT_RE = /\/token\/json\/2\//;
const ROOT_HASH_RE = /\/sync\/v\d+\/root(?:[/?]|$)/;
const UPLOAD_RESPONSE_RE = /\/doc\/v2\/files(?:[/?]|$)/;

/** Endpoints worth always logging (with bytes/content-length) even on a 2xx, for fast diagnosis if this class of bug ever resurfaces. */
function isDiagnosticTracked(url: string): boolean {
  return (
    TOKEN_ENDPOINT_RE.test(url) ||
    ROOT_HASH_RE.test(url) ||
    UPLOAD_RESPONSE_RE.test(url)
  );
}

// A status-0 failure means the TLS/TCP handshake itself never completed, so
// nothing was sent to the server yet — safe to retry outright. Google's
// anycast edges for these hosts have been observed to occasionally hand a
// client an incomplete certificate chain (NSS does strict path building with
// no AIA-fetching fallback, unlike some other TLS stacks), which is exactly
// the kind of per-connection, per-edge flake a fresh connection attempt
// against a different backend can sidestep.
const NETWORK_RETRY_ATTEMPTS = 3;
const NETWORK_RETRY_DELAY_MS = 700;

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function zoteroFetch(
  input: unknown,
  init: Record<string, unknown> = {},
): Promise<HttpResponse> {
  const url = describeUrl(input);
  const method = String(init.method || "GET").toUpperCase();
  const headers = sanitizeHeaders(headersToObject(init.headers));
  const body = await normalizeBody(init.body);
  // rmapi-js POSTs JSON with no Content-Type. Left unset, XHR.send(string)
  // defaults to text/plain and the auth endpoint rejects the body — Connect
  // looks like a bad one-time code. Always mark JSON strings as
  // application/json.
  applyJsonContentType(headers, body);
  if (Zotero.HTTP.browserIsOffline?.()) {
    throw new Error(`Zotero is offline; cannot reach reMarkable (${url})`);
  }
  let lastZeroStatusDetail = "";
  let lastRawError: unknown;
  for (let attempt = 1; attempt <= NETWORK_RETRY_ATTEMPTS; attempt++) {
    let xhr: XMLHttpRequest;
    try {
      xhr = await zoteroHttpRequest(method, url, headers, body);
    } catch (e) {
      const xmlhttp = (e as { xmlhttp?: XMLHttpRequest }).xmlhttp;
      if (xmlhttp && xmlhttp.status > 0) {
        logRequest(method, url, xmlhttp, headers);
        return responseFromXhr(xmlhttp, url);
      }
      lastRawError = e;
      if (attempt < NETWORK_RETRY_ATTEMPTS) {
        log(
          `zoteroFetch: ${method} ${url} attempt ${attempt}/${NETWORK_RETRY_ATTEMPTS} threw, retrying:`,
          describeException(e),
        );
        await delay(NETWORK_RETRY_DELAY_MS * attempt);
        continue;
      }
      const certInfo = xmlhttp ? describeReceivedCert(xmlhttp) : "no xhr on this exception";
      throw rewriteFetchError(
        new Error(`${describeException(e)} Received cert: [${certInfo}].`),
        url,
      );
    }
    if (xhr.status !== 0) {
      logRequest(method, url, xhr, headers);
      return responseFromXhr(xhr, url);
    }
    lastZeroStatusDetail = describeNsresult(xhr);
    if (attempt < NETWORK_RETRY_ATTEMPTS) {
      log(
        `zoteroFetch: ${method} ${url} -> status 0 (${lastZeroStatusDetail}) attempt ${attempt}/${NETWORK_RETRY_ATTEMPTS}, retrying`,
      );
      await delay(NETWORK_RETRY_DELAY_MS * attempt);
      continue;
    }
    throw rewriteFetchError(
      new Error(
        `No HTTP response from ${url} (status 0) after ${NETWORK_RETRY_ATTEMPTS} attempts: ${lastZeroStatusDetail}. Not a bad one-time code — this host specifically was unreachable from this network. Received cert: [${describeReceivedCert(xhr)}]. (network.dns.disableIPv6=${ipv6DnsDisabled()}, build ${BUILD})`,
      ),
      url,
    );
  }
  // Unreachable — the loop above always returns or throws.
  throw rewriteFetchError(lastRawError ?? new Error(lastZeroStatusDetail), url);
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
    // "arraybuffer" is unimplemented (always empty). Do not pass
    // responseCharset — this Zotero build throws ReferenceError if that
    // option is set. Byte-safe decoding is applied in requestObserver.
    responseType: "text",
    requestObserver: (xhr: XMLHttpRequest) => {
      try {
        xhr.overrideMimeType("text/plain; charset=x-user-defined");
      } catch (e) {
        log(
          `zoteroHttpRequest: ${method} ${url} overrideMimeType rejected:`,
          describeException(e),
        );
      }
    },
  };
  if (body !== undefined) options.body = body;
  return Zotero.HTTP.request(method, url, options);
}

// Full summary of the last request to any small-JSON-body endpoint (token
// register/session, root hash, upload response — see isDiagnosticTracked
// above), so a caller that gets an unexpectedly-empty 2xx body (or a
// downstream JSON.parse failure from rmapi-js, which doesn't get a chance to
// attach this itself) can put the real status/headers directly into its
// error — no separate trip to Help -> Debug Output Logging needed to see
// what the server actually sent.
let lastDiagnosticRequest = "";

export function getLastRequestSummary(): string {
  return lastDiagnosticRequest || "(no diagnostic-tracked request observed yet)";
}

/**
 * Log traffic to every diagnostic-tracked endpoint (see isDiagnosticTracked)
 * and every non-2xx response on any endpoint. rmapi-js errors often carry
 * only statusText, which Firefox XHR leaves empty.
 */
function logRequest(
  method: string,
  url: string,
  xhr: XMLHttpRequest,
  requestHeaders: Record<string, string>,
): void {
  const tracked = isDiagnosticTracked(url);
  const failed = xhr.status < 200 || xhr.status >= 300;
  if (!tracked && !failed) return;
  const bytes = xhrToArrayBuffer(xhr).byteLength;
  const phrase = xhr.statusText?.trim() || statusPhrase(xhr.status);
  const sentAuth = Object.keys(requestHeaders).some(
    (k) => k.toLowerCase() === "authorization",
  );
  if (xhr.status === 0) {
    log(
      `zoteroFetch: ${method} ${url} -> status 0 (no HTTP response received` +
        " — DNS failure, connection refused, TLS error, or blocked by a" +
        " firewall/proxy, not a reMarkable API error)",
    );
    if (tracked) {
      lastDiagnosticRequest = `${method} ${url} -> no HTTP response (status 0)`;
    }
    return;
  }
  let bodyPreview = "";
  if (failed) {
    try {
      bodyPreview = bytes
        ? new TextDecoder().decode(xhrToArrayBuffer(xhr)).slice(0, 500)
        : "(empty body)";
    } catch {
      bodyPreview = "(unreadable body)";
    }
  }
  log(
    `zoteroFetch: ${method} ${url} -> ${xhr.status} ${phrase} bytes=${bytes} requestAuth=${sentAuth}${bodyPreview ? ` body: ${bodyPreview}` : ""}`,
  );
  if (tracked) {
    const respHeaders = parseResponseHeaders(xhr);
    const contentLength = Number(respHeaders["content-length"] ?? "");
    const mismatch =
      Number.isFinite(contentLength) && contentLength > 0 && bytes === 0
        ? " ⚠ content-length says the server sent a body but it read as 0 bytes client-side"
        : "";
    const interesting = [
      "content-length",
      "content-type",
      "server",
      "cf-ray",
      "cf-cache-status",
      "x-cache",
      "date",
    ]
      .map((h) => (respHeaders[h] ? `${h}=${respHeaders[h]}` : null))
      .filter(Boolean)
      .join(" ");
    lastDiagnosticRequest =
      `${method} ${url} -> ${xhr.status} ${phrase} bytes=${bytes}` +
      ` requestAuth=${sentAuth}${interesting ? ` [${interesting}]` : ""}` +
      (bodyPreview ? ` body: ${bodyPreview}` : "") +
      mismatch;
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

function statusPhrase(status: number): string {
  const map: Record<number, string> = {
    400: "Bad Request",
    401: "Unauthorized",
    403: "Forbidden",
    404: "Not Found",
    405: "Method Not Allowed",
    408: "Request Timeout",
    409: "Conflict",
    415: "Unsupported Media Type",
    429: "Too Many Requests",
    500: "Internal Server Error",
    502: "Bad Gateway",
    503: "Service Unavailable",
    504: "Gateway Timeout",
  };
  return map[status] ?? `HTTP ${status}`;
}

/**
 * Recover the exact original response bytes from an XHR sent with
 * `responseType: "text"` and `overrideMimeType("text/plain; charset=x-user-defined")`
 * (see zoteroHttpRequest). Each character of `.responseText` is one raw
 * byte in disguise — `& 0xff` strips the x-user-defined offset for bytes
 * 0x80-0xFF and is a no-op for 0x00-0x7F — so this is byte-for-byte
 * correct for genuine binary content (PDF/EPUB) and for text/JSON alike.
 * Callers that want text decode the recovered bytes afterward
 * (HttpResponse.text() below).
 */
function xhrToArrayBuffer(xhr: XMLHttpRequest): ArrayBuffer {
  let t: string | undefined;
  try {
    t = (xhr as { responseText?: string }).responseText;
  } catch {
    t = undefined;
  }
  if (typeof t !== "string" || !t.length) {
    const r = xhr.response;
    if (r instanceof ArrayBuffer) return r;
    if (r instanceof Uint8Array) return r.slice().buffer;
    if (typeof r === "string" && r.length) t = r;
    else return new ArrayBuffer(0);
  }
  const bytes = new Uint8Array(t.length);
  for (let i = 0; i < t.length; i++) {
    bytes[i] = t.charCodeAt(i) & 0xff;
  }
  return bytes.buffer;
}

/** CR/LF in a header value makes Gecko drop or reject the header (401). */
function sanitizeHeaders(
  headers: Record<string, string>,
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    out[key] = String(value)
      .replace(/[\r\n\0]+/g, "")
      .trim();
  }
  return out;
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

// Necko network-error nsresults, hex value -> plain-English cause. Status 0
// on an XHR means Gecko never got an HTTP response line at all, so the
// generic "DNS, TLS, firewall, or proxy" hint is all we can say without this
// — the channel's nsresult pins down exactly which of those it was.
const NSRESULT_NAMES: Record<number, string> = {
  0x804b000d:
    "NS_ERROR_CONNECTION_REFUSED — nothing accepted the connection (host down, wrong port, or a firewall dropped it)",
  0x804b000e: "NS_ERROR_NET_TIMEOUT — the connection timed out",
  0x804b0010: "NS_ERROR_OFFLINE — Zotero/Firefox network state is offline",
  0x804b0011:
    "NS_ERROR_PORT_ACCESS_NOT_ALLOWED — that port is on Gecko's blocked-port list",
  0x804b0014: "NS_ERROR_NET_RESET — the connection was reset mid-request",
  0x804b001e:
    "NS_ERROR_UNKNOWN_HOST — DNS lookup failed, the hostname did not resolve",
  0x804b002a:
    "NS_ERROR_UNKNOWN_PROXY_HOST — the configured proxy's hostname did not resolve",
  0x804b0047: "NS_ERROR_NET_INTERRUPT — the connection was interrupted",
  0x804b0048:
    "NS_ERROR_PROXY_CONNECTION_REFUSED — the configured proxy refused the connection",
  // NSS/PSM maps its (negative) PRErrorCode into this module's low 16 bits
  // as `-PRErrorCode`, e.g. SEC_ERROR_UNKNOWN_ISSUER = SEC_ERROR_BASE(-0x2000)+13
  // = -8179 = -0x1ff3 -> 0x805a1ff3. Seen in practice on a TLS handshake
  // that completed (a real Certificate message came back) but whose chain
  // NSS couldn't build to a trusted root — NSS does strict path building
  // with no AIA-fetching fallback, so a backend that hands out an
  // incomplete intermediate chain fails here even though curl/OpenSSL
  // (which may already have the missing intermediate cached, or fetch it)
  // succeed against the exact same host seconds later.
  0x805a1ff3:
    "SEC_ERROR_UNKNOWN_ISSUER — TLS handshake completed but the certificate chain the server sent couldn't be verified to a trusted root (often a transient incomplete chain from one backend behind a load balancer, not a real MITM)",
  0x805a1fec:
    "SEC_ERROR_UNTRUSTED_ISSUER — the certificate's issuer is explicitly marked untrusted",
  0x805a1fe6:
    "SEC_ERROR_EXPIRED_CERTIFICATE — the certificate (or an intermediate) has expired; check the system clock",
};

function describeNsresultCode(code: number): string {
  // xhr.channel.status comes through XPConnect as a *signed* 32-bit long,
  // so any real nsresult (all of which have bit 31 set, i.e. are >= 0x8...)
  // arrives as a negative JS number. `>>> 0` re-interprets those same bits
  // as unsigned, matching both the hex we display and the positive-integer
  // keys in NSRESULT_NAMES below — do this once and use only the unsigned
  // form from here on, or every table lookup silently misses.
  const unsigned = code >>> 0;
  const hex = `0x${unsigned.toString(16)}`;
  if (NSRESULT_NAMES[unsigned]) return NSRESULT_NAMES[unsigned];
  // NS_ERROR_MODULE_SECURITY errors (TLS/certificate layer) all share the
  // 0x805a prefix even when the specific sub-code isn't in the table above.
  if ((unsigned & 0xffff0000) >>> 0 === 0x805a0000) {
    return `nsresult ${hex} — an NSS/TLS certificate error (module=security), code not in this table; look it up at https://searchfox.org or james-ross.co.uk/mozilla/misc/nserror`;
  }
  return `nsresult ${hex} (unrecognized code)`;
}

/** Read the channel's nsresult off a real XMLHttpRequest, if chrome-privileged. */
function describeNsresult(xhr: XMLHttpRequest): string {
  const code = (xhr as { channel?: { status?: number } }).channel?.status;
  if (typeof code !== "number" || !code) {
    return "no nsresult available from the channel";
  }
  return describeNsresultCode(code);
}

// Every external check (curl, openssl s_client) against eu.tectonic.remarkable.com
// from this network shows a perfectly valid, complete Google-issued chain,
// identical to the host that already works fine through Zotero — no chain,
// key-algorithm, OCSP, or clock difference found. That only leaves one real
// question: does Zotero's own TLS stack actually land on the same server and
// see the same certificate curl does? nsITransportSecurityInfo carries the
// cert chain Gecko itself received even when validation failed
// (`.failedCertChain`), which settles that empirically instead of by
// elimination — a mismatch here would mean Zotero's connection genuinely
// reaches something different than curl's (a hijack/different resolution),
// while a match would mean the servers agree and the gap is purely in NSS's
// own trust evaluation for this one connection.
//
// In practice this turned out to be the latter, and specifically a corporate
// SSL-inspecting proxy (confirmed by issuer "Zscaler Intermediate Root CA
// (zscaler.net)") re-signing this one host but not the sibling host that
// already worked — inspection policies are commonly per-hostname/category,
// so one subdomain of the same app can be bypassed while another isn't. Not
// a real MITM, but Zotero's own NSS store doesn't carry the proxy's root the
// way the OS/other browsers on the same machine might, so it fails chain
// validation regardless. See probeSyncCertificate/trustCertificateChain
// below for the (opt-in, user-confirmed) fix.
function readFailedCertChain(xhr: XMLHttpRequest): any[] | null {
  try {
    const channel = (xhr as { channel?: any }).channel;
    const secInfo = channel?.securityInfo;
    if (!secInfo) return null;
    const qi = (secInfo as any).QueryInterface;
    const info = qi
      ? secInfo.QueryInterface(Ci.nsITransportSecurityInfo)
      : secInfo;
    const chain: any[] =
      info.failedCertChain ?? (info.serverCert ? [info.serverCert] : []);
    return chain && chain.length ? chain : null;
  } catch {
    return null;
  }
}

function describeReceivedCert(xhr: XMLHttpRequest): string {
  try {
    const chain = readFailedCertChain(xhr);
    if (!chain) {
      const info = (xhr as { channel?: any }).channel?.securityInfo;
      return info
        ? `TLS handshake state: securityState=${info.securityState ?? "?"}, no cert chain exposed on this failure`
        : "no securityInfo on the channel";
    }
    const leaf = chain[0];
    const parts = [
      `subject=${leaf.subjectName ?? "?"}`,
      `issuer=${leaf.issuerName ?? "?"}`,
    ];
    try {
      if (leaf.sha256Fingerprint) parts.push(`sha256=${leaf.sha256Fingerprint}`);
    } catch {
      /* not all NSS builds expose this */
    }
    parts.push(`chainLength=${chain.length}`);
    return parts.join(" ");
  } catch (e) {
    return `couldn't read the received certificate: ${describeException(e)}`;
  }
}

// The one live sync endpoint rmapi-js talks to (uploads/downloads/root-hash
// all go through it) — the same host the SEC_ERROR_UNKNOWN_ISSUER reports
// above were about. Used only as an unauthenticated GET to observe whether
// the TLS handshake itself validates; the HTTP response body/status is
// irrelevant here (even a 401 means TLS was fine).
const SYNC_PROBE_URL = "https://eu.tectonic.remarkable.com/sync/v4/root";

export interface CertProbeResult {
  /** True if the TLS handshake validated (nothing to trust/fix). */
  trusted: boolean;
  /** Human-readable summary for display in the preferences pane. */
  detail: string;
  /**
   * base64 DER of the issuing CA cert(s) (chain minus the leaf), ready to
   * hand to trustCertificateChain — present only when there's something
   * concrete a user could choose to trust.
   */
  chainForTrust: string[] | null;
}

/**
 * Probe the reMarkable sync host's TLS certificate without performing any
 * real sync work, so the preferences pane can offer "trust this network's
 * certificate" as an explicit, informed opt-in rather than something that
 * happens implicitly (and silently) during a real sync attempt. Never
 * throws — a failed probe is itself the result.
 */
export async function probeSyncCertificate(): Promise<CertProbeResult> {
  ensureNetworkGlobals();
  const url = SYNC_PROBE_URL;
  try {
    const xhr = await zoteroHttpRequest("GET", url, {}, undefined);
    if (xhr.status !== 0) {
      return {
        trusted: true,
        detail: `TLS validated fine (HTTP ${xhr.status}) — nothing to trust here.`,
        chainForTrust: null,
      };
    }
    return buildCertProbeResult(xhr, url);
  } catch (e) {
    const xmlhttp = (e as { xmlhttp?: XMLHttpRequest }).xmlhttp;
    if (xmlhttp) return buildCertProbeResult(xmlhttp, url);
    return {
      trusted: false,
      detail: `Couldn't even attempt the connection: ${describeException(e)}`,
      chainForTrust: null,
    };
  }
}

function buildCertProbeResult(xhr: XMLHttpRequest, url: string): CertProbeResult {
  const nsDetail = describeNsresult(xhr);
  const chain = readFailedCertChain(xhr);
  if (!chain || chain.length < 2) {
    return {
      trusted: false,
      detail: `${url} — ${nsDetail}. ${
        chain && chain.length
          ? "Only a leaf certificate was exposed, no issuing CA to trust."
          : "No certificate chain was exposed by this failure — likely not a certificate problem at all (DNS/firewall/proxy)."
      }`,
      chainForTrust: null,
    };
  }
  const leaf = chain[0];
  const issuer = chain[1];
  try {
    const chainForTrust = chain.slice(1).map((c: any) => c.getBase64DERString());
    return {
      trusted: false,
      detail: `${url} — ${nsDetail}. Received certificate for "${leaf.subjectName ?? "?"}" issued by "${issuer.subjectName ?? "?"}" (${chain.length - 1} CA cert(s) in the chain above the leaf) — this is not the issuer Zotero expects. If this is your organization's known SSL-inspection proxy (e.g. Zscaler, a corporate firewall), click "Trust this network's certificate" below to import it. If you don't recognize this issuer, do NOT trust it and investigate your network instead.`,
      chainForTrust,
    };
  } catch (e) {
    return {
      trusted: false,
      detail: `${url} — ${nsDetail}. Found a cert chain (issuer "${issuer.subjectName ?? "?"}") but couldn't extract it for import: ${describeException(e)}`,
      chainForTrust: null,
    };
  }
}

/**
 * Import a CA certificate chain (base64 DER, as produced by
 * probeSyncCertificate) into Zotero's own NSS trust store as trusted for TLS
 * server certs — equivalent to Firefox's "Add Security Exception", done
 * in-app because Linux Zotero has no such dialog and
 * security.enterprise_roots.enabled (the Windows/macOS fix for "the OS
 * trusts our proxy but Firefox doesn't") is a no-op on Linux, which relies on
 * p11-kit-trust instead — a system integration Zotero's bundled runtime
 * isn't wired into. Only ever call this after a human has seen the actual
 * issuer/subject (via CertProbeResult.detail) and chosen to trust it; this
 * function itself does not judge whether the issuer is legitimate.
 */
export function trustCertificateChain(chainBase64: string[]): {
  ok: boolean;
  detail: string;
} {
  if (!chainBase64.length) {
    return { ok: false, detail: "No certificate chain to import." };
  }
  try {
    const certdb = Cc["@mozilla.org/security/x509certdb;1"].getService(
      Ci.nsIX509CertDB,
    );
    const added: string[] = [];
    for (const base64 of chainBase64) {
      const cert = certdb.addCertFromBase64(base64, "CT,C,C");
      added.push(cert?.subjectName ?? "(unnamed cert)");
    }
    log(`trustCertificateChain: imported ${added.length} cert(s): ${added.join("; ")}`);
    return {
      ok: true,
      detail: `Imported and trusted ${added.length} certificate(s): ${added.join("; ")}. This is saved in your Zotero profile and persists across restarts — try Sync again now.`,
    };
  } catch (e) {
    return { ok: false, detail: `Import failed: ${describeException(e)}` };
  }
}

/**
 * Pull every scrap of diagnostic info out of a thrown value. XPCOM/nsresult
 * exceptions are frequently XPCOM-flavored: `.message` is often empty, and
 * the useful bits — HTTP status, the underlying nsresult, the exception's
 * real class name — live on non-enumerable properties that `String(e)` and
 * `JSON.stringify(e)` both drop. Never return an empty string: a message
 * like "unknown error (no diagnostic detail available)" is itself a
 * diagnostic finding, not a failure to report one.
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
      bits.push(describeNsresultCode(nsresult));
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
    : "unknown error (no diagnostic detail available)";
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
