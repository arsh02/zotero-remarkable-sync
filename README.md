# Zotero reMarkable Sync

> [!WARNING]
> **This is an experimental add-on.** It reads and writes the undocumented `.rm`
> v6 format, generates EPUBs on the fly, and mutates documents in your reMarkable
> cloud account. Bugs can reorder, corrupt, or delete annotations and files.
> **Back up your reMarkable data and your Zotero library before using it, and
> treat every sync as potentially destructive.** Use at your own risk.
>
> To limit the risk, **Safe mode is on by default**: the plugin only _pulls_
> annotations from the reMarkable into Zotero and uploads documents — it never
> bakes/pushes Zotero annotations onto the device. Turn it off in the plugin
> preferences to push Zotero annotations back to the device (the riskier path).

A [Zotero 7](https://www.zotero.org/) plugin (supports up to Zotero 9) that keeps your
documents **and annotations** in sync with a [reMarkable](https://remarkable.com/) tablet.

- **Tag-driven** — items (and notes) tagged `@remarkable` (configurable) are pushed.
- **Multi-format** — PDF and DOCX (auto-converted) attachments, plus Zotero notes.
- **Bidirectional for PDF and DOCX companions** — documents go up; highlights, underlines, and (for PDF)
  ink strokes made on the device come back as **native Zotero annotations**.
- **On demand or scheduled** — sync from a context menu / button, or on a timer.
- **Works with any Zotero storage backend** — WebDAV (e.g. via `rclone` + Google Drive),
  Zotero storage, or local-only: the plugin only ever reads the file Zotero already
  resolved locally, so however your PDFs got onto disk is irrelevant to it.
- **Cross-platform** — macOS, Linux, and Windows, using only Zotero's own
  cross-platform file/IO APIs (no shell-outs, no OS-specific paths).
- **Pure TypeScript** — talks to the reMarkable cloud directly via
  [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); DOCX→HTML via
  [`mammoth`](https://github.com/mwilliamson/mammoth.js), EPUB packaging via
  [`jszip`](https://github.com/Stuk/jszip). No external binaries required.

> Status: early development. See [`MILESTONES`](#milestones) below.

## Supported formats

| Format                          | Push                                | Pull annotations           | Notes                                                                                                                                                                                                                                                                                                           |
| ------------------------------- | ----------------------------------- | -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **PDF**                         | ✅                                  | ✅ highlight/underline/ink | Annotations patched into per-page `.rm` files in place.                                                                                                                                                                                                                                                         |
| **EPUB** (native attachment)    | —                                   | —                          | Not synced. Prefer a PDF, or a `.docx` (which is converted).                                                                                                                                                                                                                                                    |
| **DOCX**                        | ✅ (via a generated companion EPUB) | ✅ (on the companion)      | The original `.docx` is never modified. A read-only `.epub` child attachment is generated with [`mammoth`](https://github.com/mwilliamson/mammoth.js) and kept in sync instead. Regenerated whenever the `.docx` changes (old companion annotations are dropped, since they'd point at stale positions anyway). |
| **Notes** (standalone or child) | ✅ (one-way, Zotero → device)       | —                          | Pushed as a small standalone EPUB. No annotation layer to pull back into. Tag the note itself with `@remarkable` to include it.                                                                                                                                                                                 |

Toggle DOCX conversion and note sync independently in the plugin preferences
("Formats" section).

## How it works

```
Zotero  ──push (tagged PDF/DOCX-companion/Notes)──▶  reMarkable cloud
        ◀──────────────pull (PDF / DOCX-companion annotations)──────
```

**PDF**: the reMarkable cloud stores annotations as separate `.rm` v6 vector blobs. This
plugin downloads those, parses them, maps their coordinates onto the PDF page, and writes
the result back as native Zotero highlight/ink annotations — and, in reverse, converts
Zotero annotations into `.rm` strokes/highlights patched into the existing page file.

**DOCX companions**: reMarkable re-paginates the generated EPUB with its own undocumented renderer, so there's no
stable page-coordinate mapping to reuse from the PDF pipeline. See the next section.

### DOCX companion annotations: how it actually works

reMarkable renders an uploaded EPUB through its own layout engine (its own fonts,
pagination, margins) that this plugin has no access to or control over — there is no
"page coordinate space" it can target the way it does for PDF. Two consequences:

- **Push** (Zotero → device): each Zotero highlight/underline (addressed by an
  [EPUB CFI](https://idpf.org/epub/linking/cfi/epub-cfi.html)) is _baked directly into the
  chapter's XHTML_ as a styled `<mark>` element — i.e. it becomes real, literal content —
  and the **whole EPUB is re-uploaded**. This survives reMarkable's re-pagination because
  the highlight travels with the text itself. The previous device copy of the document is
  then deleted (reMarkable has no "update in place" for a whole document, only for
  individual pages of an already-uploaded one).
- **Pull** (device → Zotero): reMarkable's highlight blocks embed the literal highlighted
  text. The plugin searches the EPUB's own content for that text and builds a CFI
  pointing at the match. If the exact phrase occurs more than once in the document, it can
  occasionally resolve to the wrong occurrence — a known limitation of text-based
  matching without page geometry.

Because push replaces the whole document, **the plugin always pulls companion annotations
before pushing** in a given sync run, so any highlight made on the device since the last
sync is captured into Zotero (and re-baked into the new upload) rather than being
overwritten. Even so, this path is inherently heavier and less precise than PDF —
prefer PDFs when you have a choice, and keep Safe mode on if you mainly want to _read_ on
the device.

### Multiple machines, one reMarkable

The plugin's local mapping (`state.json` / `notes.json` under Zotero's data
directory) is **not** synced by Zotero, so two computers that share a library
would otherwise each upload their own copy of every tagged file. To keep a
single document on the tablet, every push stamps two small tags on the
reMarkable document:

- `zrs-id-{libraryID}-{itemKey}` — which Zotero attachment or note this is
- `zrs-fp-{sha256[:12]}` — fingerprint of the content that was last pushed

A second machine sees those tags in the cloud listing it already fetches, adopts
the existing document into its local state, and skips the upload. The tags are
visible in the reMarkable app's tag list.

If two machines push a never-before-synced item in the same few seconds, both
may briefly create a document. The next sync on either machine detects the
duplicate identity tags, keeps the newest, and deletes the rest.

### Import PDFs already on the reMarkable

PDFs you added to the tablet some other way (the reMarkable web/desktop app,
email, another tool) are invisible to this plugin until they have a matching
Zotero item. **Tools → reMarkable: Import untracked PDFs…** scans the
configured sync folder (the same folder the plugin pushes into — not
subfolders, not the rest of the account) for PDFs that:

- this machine has no sync record for, and
- no machine has stamped with a `zrs-id-` tag.

A confirmation list lets you pick which to import. Each selected PDF is
downloaded, added as a new Zotero document in a **reMarkable Imports**
collection, tagged for future sync, and stamped with the usual
`zrs-id-`/`zrs-fp-` cloud tags so other machines adopt it instead of
uploading a duplicate. The next **Sync now** then pulls any annotations
already on the device.

This command is manual and opt-in. Regular sync never imports untracked files
on its own.

## Development

On **macOS Apple Silicon (M1+)**, run the prerequisite script first. It
checks each build tool and installs anything missing, one package at a time
(Xcode Command Line Tools, Homebrew, git, Node ≥ 18 arm64, npm, then this
repo's `npm install`). It also warns — without failing the build — if
`Zotero.app` is missing or if the reMarkable cloud hosts used at runtime
(`my.remarkable.com` for Connect, `eu.tectonic.remarkable.com` for Sync)
are unreachable. Google Chrome is not required.

```bash
bash scripts/macos-m1-prereqs.sh           # toolchain + npm packages
bash scripts/macos-m1-prereqs.sh --build   # same, then produce the .xpi
```

It refuses to run under Rosetta (`uname -m` must be `arm64`) so you do not end
up with an x64 Node that rewrites `package-lock.json`. Do not run `npm install`
with Node 10 — that truncates the lockfile.

```bash
npm install        # also installs the husky pre-commit hook
npm start          # launch Zotero with hot-reload
npm run build      # build the .xpi and type-check
npm test           # run unit tests
npm run lint:fix   # format + lint
```

### Generating the extension (.xpi)

```bash
# macOS Apple Silicon: install missing build tools, then compile
bash scripts/macos-m1-prereqs.sh --build

# or, if Node ≥ 18 is already on PATH:
npm install     # once, or whenever package.json changes
npm run build    # type-checks and writes .scaffold/build/*.xpi
```

The build is driven by [`zotero-plugin-scaffold`](https://github.com/northword/zotero-plugin-scaffold)
(see `zotero-plugin.config.ts`), which bundles `src/` with esbuild, injects the
manifest/locale files from `addon/`, and zips the result into a versioned `.xpi` under
`.scaffold/build/`, then copies that file to `build/` for install. To install it,
open Zotero → Settings → Add-ons → the gear menu → _Install Add-on From File…_ and
pick `build/*.xpi`. During development, `npm start` is
faster: it launches (or attaches to) a Zotero profile with the plugin loaded and
hot-reloads on file changes.

Requirements: **Node.js ≥ 18** (the toolchain — `esbuild`, `zotero-plugin-scaffold`,
TypeScript 5.9, ESLint 9 — needs a modern Node; `mammoth`'s `package.json` itself
requires Node ≥ 12, but the bundled _browser_ build we import,
`mammoth/mammoth.browser`, is what actually ships in the plugin and only needs
`ArrayBuffer`/`Promise`, so the runtime target — Zotero's own Firefox-based JS engine —
is unaffected by the Node version used to _build_).

### Connecting to reMarkable

Google Chrome is **not** required. In **Firefox** (or any browser), open
<https://my.remarkable.com/device/desktop/connect>, copy the 8-letter code,
paste it in the plugin preferences, and click **Connect**. The resulting
device token is stored in Zotero preferences.

(`chrome://…` messages in Zotero's log are internal Mozilla UI paths, not a
request for Google Chrome.)

If **Connect** fails with a one-time code, get a **fresh** 8-letter code
from <https://my.remarkable.com/device/desktop/connect> (each code is
single-use and expires in about a minute). Registration POSTs JSON through
`Zotero.HTTP.request` with `Content-Type: application/json`; older builds
could send it as form-urlencoded, which the auth host rejects.

If Connect reports `Registration returned a token that is too short (0 chars)`
on a build before `v0.3.14-textread`, this was a plugin-side bug, not a bad or
expired one-time code. `Zotero.HTTP.request`'s `responseType: "arraybuffer"`
path was silently handing back an empty `ArrayBuffer` for these plain-text
token endpoints even though the server sent a full body — confirmed by the
`Last request: ...` diagnostic added in `v0.3.13-diag`, which showed
`content-length=411` (a real device token's length) alongside `bytes=0`. Since
`/token/json/2/device/new` and `/token/json/2/user/new` only ever return plain
text/JSON, `v0.3.14-textread` reads them with `responseType: "text"` instead
(`.responseText`), which does not hit whatever part of the binary path was
dropping the body; the sync API (`eu.tectonic.remarkable.com`, which does
carry real binary PDF content) is untouched and still reads as
`arraybuffer`. If this still recurs on `v0.3.14-textread` or later, the
`Last request: ...` text in the error will flag a
`content-length says the server sent a body but it read as 0 bytes
client-side` mismatch — share that with the error report.

If the pane still says **Connected** but **Sync now** fails with `couldn't fetch auth token`
(often with nothing after the colon — Firefox XHR leaves `statusText` empty),
the plugin did reach `webapp-prod.cloud.remarkable.engineering` but
`POST /token/json/2/user/new` returned a non-2xx (typically 401). That
usually means the stored device token is stale. Click **Disconnect**, get a
fresh one-time code, **Connect** again, then sync. Help → Debug Output Logging
will show the real HTTP status and whether the `Authorization` header made
it onto the channel.

If **Connect** succeeds but **Sync now** fails with
`NetworkError when attempting to fetch resource` against
`eu.tectonic.remarkable.com`, install a build that routes reMarkable traffic
through Zotero's privileged HTTP stack (look for `v0.3.5-zotero-http` or
later in Help → Debug Output Logging). The sandbox `fetch` is CORS-limited;
the `Authorization` header on the sync API triggers that.

If the error popup itself looks cut off with no real detail after "Network
error reaching reMarkable" — Zotero's native progress popup truncates long
lines and no CSS can override it — a build from `v0.3.6-error-details`
onward also opens a small dialog with the full error text and a **Copy**
button whenever a sync action fails; use that to see (and share) the actual
cause. If that dialog still shows "unknown error (no message from
Zotero.HTTP)" or a raw `nsresult`, the host itself is unreachable — a
firewall or proxy is blocking it. Confirm by opening
`https://eu.tectonic.remarkable.com/sync/v4/root` in Firefox.

**`No HTTP response from https://eu.tectonic.remarkable.com/sync/v4/root
(status 0)`** specifically means Gecko never got an HTTP response line back —
not a bad token, not an API error. `eu.tectonic.remarkable.com` is a real,
currently-live, hardcoded endpoint in the `rmapi-js` library used for all
sync traffic (uploads/downloads/root-hash), separate from
`webapp-prod.cloud.remarkable.engineering` used only for Connect/session-auth.

In one observed case this decoded to `nsresult 0x805a1ff3` —
**`SEC_ERROR_UNKNOWN_ISSUER`** (confirmed against Mozilla's own
`GetXPCOMFromNSSError` source: the code field is `-1 * PRErrorCode`, and
`-1 * (SEC_ERROR_BASE + 13) = 0x1ff3`): the TLS handshake *did* complete (a
real certificate came back) but NSS couldn't build a trust path from it to a
root it recognizes. `curl -v`/`openssl s_client -showcerts` against that
exact host from the same network showed a perfectly valid, complete 3-cert
chain (leaf → `Google Trust Services WR3` → `GTS Root R1`, `SSL certificate
verify ok.`) — and the *same* chain/CAs as `webapp-prod.cloud.remarkable.engineering`,
the host that already works. So it's not a DNS block, a firewall, a MITM
proxy, nor an incomplete/missing-intermediate chain from the server — those
would either affect both hosts identically (same root/intermediate) or show
up as a different chain shape than what was actually observed. It also
wasn't a one-off per-backend flake: it reproduced on all 3 retry attempts.

A full Zotero restart did **not** fix it either, ruling out an in-process NSS
verification-result cache too. The actual root cause: `eu.tectonic.remarkable.com`
resolves to *both* an A (IPv4) and an AAAA (IPv6) record
(`getent ahosts eu.tectonic.remarkable.com`), while
`webapp-prod.cloud.remarkable.engineering` — the host that works — has
**only** an A record, no AAAA. A direct test of the IPv6 address
(`curl -6 https://eu.tectonic.remarkable.com/...` and
`openssl s_client -connect [that AAAA address]:443`) hung and timed out with
*no response at all* — this network's IPv6 route to that address is
blackholed (packets silently dropped, not even a clean refusal). Gecko's
Happy-Eyeballs dual-stack connection racing tries IPv4 and IPv6 in parallel
and prefers IPv6 when available; on a network where the IPv6 attempt doesn't
fail cleanly but also never succeeds, that appears to surface as a spurious
`SEC_ERROR_UNKNOWN_ISSUER` instead of a clean timeout — and reproduces on
every attempt because the broken IPv6 route doesn't change run to run.
`webapp-prod` never hit this simply because it has no AAAA record to race in
the first place.

**Fix (`v0.3.17-noipv6`)**: `ensureNetworkGlobals()` now sets the standard
Firefox/Gecko preference `network.dns.disableIPv6 = true` once per profile
(persists across restarts) if it isn't already set. This is the documented
fix for "IPv6 is nominally available but doesn't actually route" networks —
it's a global preference (Gecko has no smaller-grained per-request knob), so
it also protects any *other* Zotero networking that happens to hit an
IPv6-enabled host on the same broken network, not just reMarkable Sync's own
requests. If a network's IPv6 is later fixed, unset it in Zotero the same way
you'd flip it in Firefox's `about:config`.

If a `status 0` error still shows up after installing this build, builds from
`v0.3.18-ipv6-verify` onward also flush Necko's DNS cache every time network
globals are (re)initialized (a DNS entry resolved earlier in the same
long-running process — including its AAAA record — can otherwise stay cached
past the pref flip until its TTL expires) and append
`(network.dns.disableIPv6=..., build ...)` directly to the `status 0` error
text. That confirms, from the error message alone and without a separate trip
to Help → Debug Output Logging, both which build actually produced the error
and whether the pref genuinely took effect — if it still says
`disableIPv6=false`, the running Zotero instance hasn't picked up this build
yet (fully quit and reinstall); if it says `true` and the error persists
anyway, IPv6 wasn't actually the (whole) story and it's worth attaching a
debugger/HAR or re-testing with a plain Firefox profile pointed at the same
network to isolate it further.

**Update: IPv6 confirmed *not* the (whole) story.** After installing
`v0.3.18-ipv6-verify`, the error text showed
`disableIPv6=true, build v0.3.18-ipv6-verify` — proving the pref was live and
the DNS cache had been flushed — and the sync request still failed with the
identical `SEC_ERROR_UNKNOWN_ISSUER`. That rules IPv6 racing all the way out:
with `network.dns.disableIPv6=true`, Necko cannot resolve or attempt the AAAA
address at all, so whatever's failing is happening purely over IPv4, the same
path curl already succeeds on. Follow-up checks against both hosts from the
same network, specifically looking for *any* remaining asymmetry that could
explain a per-host difference, all came back identical: OCSP stapling (`openssl
s_client -status`) — neither host staples, so that's not it either; leaf
certificate key algorithm/signature (`sha256WithRSAEncryption` /
`rsaEncryption` on both); negotiated TLS version/cipher (`TLSv1.3` /
`TLS_AES_256_GCM_SHA384` on both); and the system clock (correct, so not an
expired-certificate misread). Every externally-observable fact about the two
hosts' TLS setups is the same, yet Zotero only fails against one of them.

Since TLS certificate selection happens purely by SNI at the handshake layer
— before any application data, so it can't depend on anything this plugin's
request sends — the remaining open question is simply: **is Zotero's own TLS
stack even seeing the same certificate curl sees for this host?** `v0.3.19-cert-probe`
answers that empirically instead of by further elimination: on a `status 0`
failure it now reads `nsITransportSecurityInfo` straight off the failed
channel (`.failedCertChain`, falling back to `.serverCert`) and appends the
actual subject/issuer/fingerprint Gecko received — `Received cert: [...]` —
to the error text. A subject/issuer matching the real
`eu.tectonic.remarkable.com` / Google Trust Services chain means the servers
agree and the gap is purely inside NSS's own trust evaluation for this one
connection (at which point resetting Zotero's cert trust DB, or checking
`security.enterprise_roots.enabled` / an enterprise root/proxy CA installed
system-wide, are the next things to try); an unexpected subject/issuer (a
self-signed cert, a different CN, or a corporate proxy's own CA) would be
direct proof of an interception point specific to this connection.

Builds from `v0.3.15-nsresult` onward decode the underlying Necko `nsresult`
(e.g. `NS_ERROR_UNKNOWN_HOST` for DNS, `NS_ERROR_CONNECTION_REFUSED`,
`NS_ERROR_NET_TIMEOUT`, `SEC_ERROR_UNKNOWN_ISSUER`/other `0x805a...`
certificate errors) directly into the error message. Builds from
`v0.3.16-retry` onward also retry a `status 0` failure up to 3 times (with a
short backoff) before surfacing an error at all — harmless, but as the
0x805a1ff3 case showed, insufficient on its own for a *persistent* IPv6
blackhole rather than a transient per-connection flake. If it still fails
after updating to `v0.3.17-noipv6` or later, or the decoded nsresult is a
DNS/firewall/proxy one (not a `0x805a...` certificate code), it's a different,
more fundamental block:

- Open `https://eu.tectonic.remarkable.com/sync/v4/root` directly in
  Firefox's address bar. A `401` (even an ugly JSON/plain-text one) means
  Firefox itself can reach the host fine and the block is specific to
  Zotero (check Zotero's Advanced → Network proxy/SSL settings, and
  consider updating Zotero — an older bundled NSS root store is more likely
  to be missing a newer intermediate). No response / a Firefox network-error
  page means the block is at the OS/network level (DNS, VPN, corporate
  firewall) and is outside the plugin's control — try a different network or
  ask a network admin to allowlist `eu.tectonic.remarkable.com`.

**Actual root cause found (`v0.3.19-cert-probe`): a corporate SSL-inspection
proxy, not a server or IPv6 problem at all.** With IPv6 fully disabled
(`network.dns.disableIPv6=true` confirmed active) the identical
`SEC_ERROR_UNKNOWN_ISSUER` kept reproducing, which meant it was happening
purely over IPv4 — the exact path `curl`/`openssl s_client` already
succeeded on from the same network. Follow-up checks for every other
possible asymmetry between the two hosts (OCSP stapling, leaf key/signature
algorithm, negotiated TLS version/cipher, system clock) all came back
identical between the working and failing host. Since a TLS certificate is
selected purely by SNI at the handshake layer — before any request
headers/body are even sent — the only thing left that could actually differ
was *what certificate Zotero's own TLS stack was really seeing*, which
nothing external (curl, openssl) could answer, since those tools may not
even be subject to the same interception as Zotero's process.

`v0.3.19-cert-probe` answered that directly by reading
`nsITransportSecurityInfo.failedCertChain` off the failed channel and
printing the actual received subject/issuer in the error text. The result:

```
Received cert: [subject=OU=Zscaler Inc.,O=Zscaler Inc.,CN=eu.tectonic.remarkable.com
issuer=CN="Zscaler Intermediate Root CA (zscaler.net) (t) ",OU=Zscaler Inc.,
O=Zscaler Inc.,ST=California,C=US ... chainLength=3]
```

Zotero was never talking to Google Trust Services at all for this host — a
corporate SSL-inspecting proxy (Zscaler) was terminating and re-signing the
connection with its own CA. `webapp-prod.cloud.remarkable.engineering` kept
working because SSL-inspection policies are commonly configured per
hostname/category — this network's Zscaler policy evidently bypasses
inspection for that subdomain but not for `eu.tectonic`. Not a real MITM,
not a broken server, not IPv6 — the OS (and whatever `curl` on this network
uses as its trust store) already trusts the Zscaler root, but **Zotero's own
bundled NSS certificate store does not**, so only Zotero's own connections to
this one un-bypassed host fail.

The usual Firefox fix for "the OS trusts our proxy's root but Firefox
doesn't" is the `security.enterprise_roots.enabled` preference — but that
feature is Windows/macOS-only in Gecko; on Linux, Firefox instead relies on
the system's `p11-kit-trust` PKCS#11 module, which Zotero's bundled runtime
isn't wired into. So on Linux the only reliable fix is importing the proxy's
CA certificate directly into Zotero's own NSS database (`cert9.db` in the
profile), equivalent to what a user does by hand via a browser's "Add
Security Exception" flow — the same privileged `nsIX509CertDB` API a
`certutil -A -t "CT,C,C"` import uses under the hood.

**Fix (`v0.3.20-cert-trust`)**: added a "Check network certificate" /
"Trust this network's certificate" pair of buttons under the connection
status in Settings → _Zotero reMarkable Sync_. **Check** makes an
unauthenticated probe request to the sync host and, on a TLS failure, shows
exactly what was received (issuer/subject) — this never trusts anything
automatically. Only if the issuer is one you recognize as your own network's
proxy (Zscaler, a corporate firewall, etc.) should you click **Trust this
network's certificate**, which imports that specific CA chain into Zotero's
own trust store via `nsIX509CertDB.addCertFromBase64(..., "CT,C,C")`. This
is saved in the Zotero profile and persists across restarts — it needs to be
done once per machine/profile, not per sync. If you don't recognize the
issuer shown, do not trust it; that's a sign of something worth investigating
on the network rather than working around.

**The same empty-body bug from `v0.3.14-textread`, one endpoint over.** Once
the certificate trust issue above is resolved and the TLS handshake actually
succeeds, sync can still fail immediately with:

```
type: SyntaxError
JSON.parse: unexpected end of data at line 1 column 1 of the JSON data
getRootHash@...remarkablesync.js:...
```

This is the identical `Zotero.HTTP.request` `responseType: "arraybuffer"`
bug that originally broke device registration — it was only ever fixed for
`/token/json/2/...`, not for the sync API's other small-JSON-body endpoints.
`getRootHash()` (`GET /sync/v4/root`, called on essentially every sync) hit
it next, but `putRootHash()` (`PUT /sync/v3/root`) and `uploadFile()`'s
response (`POST {uploadHost}/doc/v2/files`) read their responses the exact
same way (`res.text()`/`res.json()` → `JSON.parse`) and were just as exposed.

**Fix (`v0.3.21-json-endpoints`)**: widened the existing token-endpoint
`responseType: "text"` fix to also cover `/sync/v[34]/root` (both the GET and
PUT) and the upload response path — proactively, rather than waiting for each
to fail in turn with the same confusing raw `SyntaxError`. This deliberately
did **not** touch `GET`/`PUT /sync/v3/files/{hash}` (the actual PDF/EPUB
file bytes), since that traffic can be genuine binary and a naive
text/`TextEncoder` round-trip would silently corrupt it.

**The actual root cause, found right after (`v0.3.22-xuserdefined`): this was
never really about "which endpoints return small JSON bodies" at all.**
`getEntries()` (reading `/sync/v3/files/{hash}` — the same endpoint that also
serves real binary PDF/EPUB content, so it couldn't be fixed by widening a
URL allowlist any further) failed next with:

```
schema version  not supported
getEntries@...remarkablesync.js:...
```

(note the double space — `version` decoded as an *empty string*, the same
symptom, a third endpoint over.) Rather than add yet another regex, this
prompted actually confirming the mechanism, and it turns out **`Zotero.HTTP.request`
does not implement `responseType: "arraybuffer"` at all** — confirmed
directly by the Zotero team on the
[zotero-dev mailing list](https://groups.google.com/g/zotero-dev/c/gjfM2QK08p4)
and in [forum discussion #120148](https://forums.zotero.org/discussion/120148/zotero-http-request-return-empty-arraybuffer-in-response-when-set-responsetype-as-arraybuffer):
*"We only support the text, json, and document responseTypes"* — passing
`arraybuffer` silently returns an empty result for **every** request,
unconditionally, regardless of endpoint, body size, or content. Every
"empty body" bug chased through this whole README (0-char registration
token, `JSON.parse` failures, this) was the exact same bug wearing a
different rmapi-js stack trace; the endpoint-by-endpoint regex fixes only
ever worked by accident, by happening to route those specific calls through
`responseType: "text"` instead — which was never really "the JSON-safe
path", just the only one of Zotero's three actually-supported responseTypes
that happened to fit.

That also explains why it couldn't be fixed the same way for
`/sync/v3/files/{hash}`: that single endpoint serves both small text index
files *and* real binary PDF/EPUB bytes behind an identical URL shape, so no
amount of URL pattern-matching could ever tell them apart — the fix had to
work for arbitrary binary content, not just JSON.

**Real fix (`v0.3.22-xuserdefined`)**: every request now uses
`responseType: "text"` with `responseCharset: "x-user-defined"` — the classic
pre-`ArrayBuffer` binary-safe XHR trick from the same Zotero forum thread.
With that charset, each raw wire byte (0x00–0xFF) comes back as its own
UTF-16 code unit in `.responseText` (bytes 0x80–0xFF offset by `+0xF700`)
instead of being run through the browser's own UTF-8 decoder — masking each
code unit with `& 0xff` recovers the exact original byte, correct whether
the content is genuinely binary or plain UTF-8 text/JSON, since decoding to
actual text only happens afterward, deliberately, on the recovered bytes
(`HttpResponse.text()`), never on the wire bytes directly. This replaces
every endpoint-specific regex from `v0.3.14`–`v0.3.21` with one
content-agnostic fix that covers the file-content endpoint too — including
the real PDF/EPUB upload/download path this plugin's whole purpose depends
on, which had not yet been exercised far enough in testing to have failed
visibly before this.

**`v0.3.22-xuserdefined` broke *every* request, including the ones that
already worked.** Setting `responseCharset` on `Zotero.HTTP.request`'s
options — documented, real, and used successfully in Zotero *translator*
code from the same forum thread — throws immediately in this plugin's
bootstrap/privileged calling context:

```
Network error reaching reMarkable (.../token/json/2/device/new):
Error — ReferenceError — responseCharset is not defined
Received cert: [no xhr on this exception].
```

The error fires before any xhr object even exists, i.e. inside
`Zotero.HTTP.request`'s own option handling, before a network request is
attempted at all — so this is a bug (or at least an incompatibility) in
`Zotero.HTTP.request` itself for this specific combination of options and
calling context, not a mistake in how the option was being passed. The
translator sandbox's `request()`/`requestText()` helpers that the
`responseCharset` workaround was documented for are a different, thin
wrapper around the same underlying machinery, apparently with a code path
that doesn't have this bug; the raw, privileged `Zotero.HTTP.request` a
bootstrap plugin calls directly does not have that luxury.

**`v0.3.23-privileged-xhr` could not construct that XHR.** The plugin
sandbox's `Components.classes` does not include
`@mozilla.org/xmlextras/xmlhttprequest;1` (`Cc[...]` is `undefined`), so
Connect failed immediately with:

```
TypeError — can't access property "createInstance",
Cc['@mozilla.org/xmlextras/xmlhttprequest;1'] is undefined
Received cert: [no xhr on this exception].
```

Other XPCOM contracts used elsewhere in this file (prefs, DNS, cert DB)
*are* present; this one is not. The plugin cannot mint its own privileged
XHR from this sandbox.

**Real fix (`v0.3.24-override-mime`): stay on `Zotero.HTTP.request`, do not
pass `responseCharset`, apply the charset on the live XHR instead.**
`Zotero.HTTP.request` documents a `requestObserver` callback that receives
the `XMLHttpRequest` after `open()` and before `send()`. That is the legal
moment to call `xhr.overrideMimeType("text/plain; charset=x-user-defined")`
— the same MIME override `responseCharset` was supposed to perform, without
touching the option that throws. Requests still use `responseType: "text"`
(the only Zotero-supported type that returns a body here). Each `.responseText`
character is one raw byte; `& 0xff` recovers it, for JSON and PDF/EPUB
alike. Diagnostic helpers from `v0.3.15`–`v0.3.20` are unchanged: they still
read `xhr.channel` off the object `Zotero.HTTP.request` returns.

If a similar `JSON.parse`/`Unexpected token`/empty-body symptom ever
surfaces again from a different endpoint despite this, `v0.3.21-json-endpoints`
generalized the token-only "content-length vs. bytes-actually-read"
diagnostic (previously `getLastTokenRequestSummary`, now
`getLastRequestSummary`) and wired it into the sync error dialog itself: any
error whose message looks like a JSON-parse failure gets a
`Last request: ...` line appended automatically, with the real HTTP
status/content-length/bytes-read for whichever request actually produced the
truncated body — no separate trip to Help → Debug Output Logging needed.

### Works with any Zotero installation/storage setup

The plugin only ever touches files through Zotero's own cross-platform APIs
(`item.getFilePathAsync()`, `IOUtils`, `PathUtils`) — it never assumes a particular OS,
file layout, or sync backend. In particular:

- **macOS / Linux / Windows**: no shell-outs, no hardcoded path separators, no
  platform-specific code anywhere in the plugin.
- **WebDAV storage (e.g. Google Drive via `rclone` on Linux)**: Zotero itself resolves
  attachments to a local file before the plugin ever sees them, regardless of whether
  that file is synced via Zotero storage, WebDAV, or not synced at all. The plugin never
  talks to WebDAV/rclone/Google Drive directly — from its point of view there is just
  "a file path on disk", so any storage backend Zotero itself supports works unmodified.

## Usage

- **Connect**: Settings → _Zotero reMarkable Sync_ → open
  <https://my.remarkable.com/device/desktop/connect> in Firefox (Chrome is not
  required), paste the 8-letter code, and click **Connect**.
- **Disconnect**: same pane, **Disconnect** (enabled only while a device token
  is stored). Clears the token so you can Connect again with a fresh code.
- **Sync**: tag an item `@remarkable` (right-click → _reMarkable: Add to sync_) — this
  covers all of its PDF and DOCX attachments — then the toolbar **Sync now** button (or
  set an interval in preferences). To sync a note on its own, tag the note item itself
  (via Zotero's normal tag UI).
- **Tools menu**: _Sync now_, _Force re-pull annotations_, _Remove pulled
  annotations_ (removes only plugin-created annotations), _Import untracked
  PDFs…_ (see [Import PDFs already on the reMarkable](#import-pdfs-already-on-the-remarkable)).
- **Per-item**: right-click a synced item → _Overwrite device from Zotero_ / _Overwrite
  Zotero from device_ to force one side to win for just that item.

Document annotations sync **bidirectionally** for PDF and DOCX companions; the Zotero side is never
modified destructively (only annotations the plugin itself created are ever
added/removed), so you can keep annotating on the device between syncs. PDF text
highlights become Zotero highlights, freehand highlighter becomes translucent
highlights, pen strokes become ink; highlights/underlines on a DOCX companion become Zotero
highlights/underlines (see [DOCX companion annotations](#docx-companion-annotations-how-it-actually-works)
above for how that direction actually works).

## Milestones

- **M0** — scaffold, tooling, pre-commit ✅
- **M1** — push tagged PDFs, auth, preferences, context-menu UX ✅
- **M2** — pull annotations back as native Zotero annotations ✅
- **M3** — scheduled auto-sync ✅ · further polish ongoing
- **M4** — Zotero → reMarkable annotation push (write `.rm` v6), bidirectional
  deletion, per-item overwrite, status indicator ✅
- **M5** — native EPUB attachment support: dropped (PDF/DOCX/notes only)
- **M6** — DOCX companion bidirectional annotations: CFI build/resolve, highlight baking,
  device-highlight text matching ✅
- **M7** — DOCX support via an auto-generated, auto-refreshed companion EPUB
  (mammoth) ✅
- **M8** — standalone/child Zotero notes pushed as one-way EPUB documents ✅
- **M9** — preferences/UI/locale polish for the new formats, docs ✅

## Known limitations

- **Companion annotation matching is text-based**, not geometry-based — see
  [DOCX companion annotations](#docx-companion-annotations-how-it-actually-works). Identical phrases
  repeated verbatim in a document can occasionally match the wrong occurrence.
- **CFI resolution** (used when baking an _existing_ Zotero annotation into the
  companion) supports the common single-indirection, single- or same-node-range shapes
  that Zotero's own reader generates. Anything it can't parse is simply skipped (logged),
  rather than guessed at.
- **DOCX companion regeneration drops prior annotations** made directly on the generated
  EPUB whenever the source `.docx` changes — they'd be positioned against stale content
  anyway.
- **Notes sync is one-way** (Zotero → device) and best-effort: embedded images inside a
  note (if any) are not extracted, only the text/HTML content.
- Every companion push that includes baked annotations **replaces the whole device
  document** (new document id, old one deleted) — heavier than the PDF path's per-page
  `.rm` patch, and any device-side companion annotation not yet pulled before that happens
  would be lost, which is why pull always runs first for companions within a sync cycle.
- **Multi-machine dedup is best-effort, not a lock.** Two machines that push the
  same never-before-synced item at the same moment can still create two cloud
  documents for a short window; the next sync collapses them to one (newest
  `lastModified` wins). There is no coordination server. Documents uploaded
  before this tagging existed have no `zrs-id-` tag, so a second machine cannot
  recognise them and may still upload a duplicate.

## Credits

Built on [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
and [`zotero-plugin-toolkit`](https://github.com/windingwind/zotero-plugin-toolkit).
reMarkable cloud access via [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); `.rm`
format understanding draws on [`rmscene`](https://github.com/ricklupton/rmscene) and
[`rmc`](https://github.com/ricklupton/rmc). DOCX→HTML conversion via
[`mammoth`](https://github.com/mwilliamson/mammoth.js); EPUB packaging via
[`jszip`](https://github.com/Stuk/jszip).

## License

AGPL-3.0-or-later
