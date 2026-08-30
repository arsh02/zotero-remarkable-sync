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
- **Multi-format** — PDF, EPUB, and DOCX (auto-converted) attachments, plus Zotero notes.
- **Bidirectional for PDF/EPUB** — documents go up; highlights, underlines, and (for PDF)
  ink strokes made on the device come back as **native Zotero annotations**.
- **On demand or scheduled** — sync from a context menu / button, or on a timer.
- **Works with any Zotero storage backend** — WebDAV (e.g. via `rclone` + Google Drive),
  Zotero storage, or local-only: the plugin only ever reads the file Zotero already
  resolved locally, so however your PDFs/EPUBs got onto disk is irrelevant to it.
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
| **EPUB** (native attachment)    | ✅                                  | ✅ highlight/underline     | Annotations are _baked into the chapter HTML_ and the whole document is re-uploaded — see [EPUB annotations](#epub-annotations-how-it-actually-works) below. No ink (Zotero's EPUB reader has no ink annotation type).                                                                                          |
| **DOCX**                        | ✅ (via a generated companion EPUB) | ✅ (on the companion)      | The original `.docx` is never modified. A read-only `.epub` child attachment is generated with [`mammoth`](https://github.com/mwilliamson/mammoth.js) and kept in sync instead. Regenerated whenever the `.docx` changes (old companion annotations are dropped, since they'd point at stale positions anyway). |
| **Notes** (standalone or child) | ✅ (one-way, Zotero → device)       | —                          | Pushed as a small standalone EPUB. No annotation layer to pull back into. Tag the note itself with `@remarkable` to include it.                                                                                                                                                                                 |

Toggle DOCX conversion and note sync independently in the plugin preferences
("Formats" section).

## How it works

```
Zotero  ──push (tagged PDF/EPUB/DOCX-companion/Notes)──▶  reMarkable cloud
        ◀──────────────pull (PDF/EPUB annotations)──────
```

**PDF**: the reMarkable cloud stores annotations as separate `.rm` v6 vector blobs. This
plugin downloads those, parses them, maps their coordinates onto the PDF page, and writes
the result back as native Zotero highlight/ink annotations — and, in reverse, converts
Zotero annotations into `.rm` strokes/highlights patched into the existing page file.

**EPUB**: reMarkable re-paginates EPUBs with its own undocumented renderer, so there's no
stable page-coordinate mapping to reuse from the PDF pipeline. See the next section.

### EPUB annotations: how it actually works

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
  pointing at the match. If the exact phrase occurs more than once in the book, it can
  occasionally resolve to the wrong occurrence — a known limitation of text-based
  matching without page geometry.

Because push replaces the whole document, **the plugin always pulls EPUB annotations
before pushing** in a given sync run, so any highlight made on the device since the last
sync is captured into Zotero (and re-baked into the new upload) rather than being
overwritten. Even so, EPUB sync is inherently heavier and less precise than the PDF path —
prefer PDFs when you have a choice, and keep Safe mode on if you mainly want to _read_ on
the device.

## Development

```bash
npm install        # also installs the husky pre-commit hook
npm start          # launch Zotero with hot-reload
npm run build      # build the .xpi and type-check
npm test           # run unit tests
npm run lint:fix   # format + lint
```

### Generating the extension (.xpi)

```bash
npm install     # once, or whenever package.json changes
npm run build    # produces build/*.xpi (and type-checks with tsc)
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

In the plugin preferences, paste a one-time code from
<https://my.remarkable.com/device/browser/connect> and click **Connect**. The resulting
device token is stored in Zotero preferences.

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

- **Connect**: Settings → _Zotero reMarkable Sync_ → paste a one-time code from
  <https://my.remarkable.com/device/browser/connect>.
- **Sync**: tag an item `@remarkable` (right-click → _reMarkable: Add to sync_) — this
  covers all of its PDF/EPUB/DOCX attachments — then the toolbar **Sync now** button (or
  set an interval in preferences). To sync a note on its own, tag the note item itself
  (via Zotero's normal tag UI).
- **Tools menu**: _Sync now_, _Force re-pull annotations_, _Remove pulled
  annotations_ (removes only plugin-created annotations).
- **Per-item**: right-click a synced item → _Overwrite device from Zotero_ / _Overwrite
  Zotero from device_ to force one side to win for just that item.

Document annotations sync **bidirectionally** for PDF and EPUB; the Zotero side is never
modified destructively (only annotations the plugin itself created are ever
added/removed), so you can keep annotating on the device between syncs. PDF text
highlights become Zotero highlights, freehand highlighter becomes translucent
highlights, pen strokes become ink; EPUB highlights/underlines become Zotero
highlights/underlines (see [EPUB annotations](#epub-annotations-how-it-actually-works)
above for how that direction actually works).

## Milestones

- **M0** — scaffold, tooling, pre-commit ✅
- **M1** — push tagged PDFs, auth, preferences, context-menu UX ✅
- **M2** — pull annotations back as native Zotero annotations ✅
- **M3** — scheduled auto-sync ✅ · further polish ongoing
- **M4** — Zotero → reMarkable annotation push (write `.rm` v6), bidirectional
  deletion, per-item overwrite, status indicator ✅
- **M5** — native EPUB attachment support: upload/re-upload, generalized
  attachment-kind detection across PDF/EPUB/DOCX ✅
- **M6** — EPUB bidirectional annotations: CFI build/resolve, highlight baking,
  device-highlight text matching ✅
- **M7** — DOCX support via an auto-generated, auto-refreshed companion EPUB
  (mammoth) ✅
- **M8** — standalone/child Zotero notes pushed as one-way EPUB documents ✅
- **M9** — preferences/UI/locale polish for the new formats, docs ✅

## Known limitations

- **EPUB annotation matching is text-based**, not geometry-based — see
  [EPUB annotations](#epub-annotations-how-it-actually-works). Identical phrases
  repeated verbatim in a book can occasionally match the wrong occurrence.
- **EPUB CFI resolution** (used when baking an _existing_ Zotero annotation into the
  content) supports the common single-indirection, single- or same-node-range shapes
  that Zotero's own reader generates. Anything it can't parse is simply skipped (logged),
  rather than guessed at.
- **DOCX companion regeneration drops prior annotations** made directly on the generated
  EPUB whenever the source `.docx` changes — they'd be positioned against stale content
  anyway.
- **Notes sync is one-way** (Zotero → device) and best-effort: embedded images inside a
  note (if any) are not extracted, only the text/HTML content.
- Every EPUB push that includes baked annotations **replaces the whole device
  document** (new document id, old one deleted) — heavier than the PDF path's per-page
  `.rm` patch, and any device-side EPUB annotation not yet pulled before that happens
  would be lost, which is why pull always runs first for EPUBs within a sync cycle.

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
