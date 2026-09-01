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
npm run build    # type-checks, writes .scaffold/build/*.xpi, copies to build/
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
single-use and expires in about a minute).

If the pane still says **Connected** but **Sync now** fails with `couldn't fetch auth token`
(often with nothing after the colon — Firefox XHR leaves `statusText` empty),
the stored device token is usually stale. Click **Disconnect**, get a
fresh one-time code, **Connect** again, then sync.

If Sync fails with `SEC_ERROR_UNKNOWN_ISSUER` or HTTP status 0, use **Check
network certificate** / **Trust this network's certificate** in the plugin
preferences. That is typical on a corporate SSL-inspection proxy (e.g.
Zscaler) whose CA is in the OS trust store but not in Zotero's bundled NSS
store. Only trust an issuer you recognize as your own network's.

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
