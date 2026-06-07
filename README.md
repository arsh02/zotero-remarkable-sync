# Zotero reMarkable Sync

A [Zotero 7](https://www.zotero.org/) plugin that keeps your PDFs **and annotations**
in sync with a [reMarkable](https://remarkable.com/) tablet.

- **Tag-driven** — items tagged `@remarkable` (configurable) are pushed to the device.
- **Bidirectional** — PDFs go up; highlights and ink strokes made on the device come
  back as **native Zotero annotations**.
- **On demand or scheduled** — sync from a context menu / button, or on a timer.
- **Pure TypeScript** — talks to the reMarkable cloud directly via
  [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); no external binary required.

> Status: early development. See [`MILESTONES`](#milestones) below.

## How it works

```
Zotero  ──push (tagged PDFs)──▶  reMarkable cloud
        ◀──pull (annotations)──
```

The reMarkable cloud stores annotations as separate `.rm` v6 vector blobs. This plugin
downloads those, parses them, maps their coordinates onto the PDF page, and writes the
result back as native Zotero highlight/ink annotations.

## Development

```bash
npm install        # also installs the husky pre-commit hook
npm start          # launch Zotero with hot-reload
npm run build      # build the .xpi and type-check
npm test           # run unit tests
npm run lint:fix   # format + lint
```

### Connecting to reMarkable

In the plugin preferences, paste a one-time code from
<https://my.remarkable.com/device/browser/connect> and click **Connect**. The resulting
device token is stored in Zotero preferences.

## Milestones

- **M0** — scaffold, tooling, pre-commit ✅
- **M1** — push tagged PDFs, auth, preferences, context-menu UX
- **M2** — pull annotations back as native Zotero annotations
- **M3** — scheduled auto-sync, conflict/dedup handling, polish

## Credits

Built on [`windingwind/zotero-plugin-template`](https://github.com/windingwind/zotero-plugin-template)
and [`zotero-plugin-toolkit`](https://github.com/windingwind/zotero-plugin-toolkit).
reMarkable cloud access via [`rmapi-js`](https://github.com/erikbrinkman/rmapi-js); `.rm`
format understanding draws on [`rmscene`](https://github.com/ricklupton/rmscene) and
[`rmc`](https://github.com/ricklupton/rmc).

## License

AGPL-3.0-or-later
