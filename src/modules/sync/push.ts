// Push Zotero annotations to the reMarkable.
//
// For each synced attachment, take the annotations that originated in Zotero
// (not pulled from the device, not already pushed), convert them to reMarkable
// strokes/highlights, append them to the relevant page's existing `.rm`, and
// commit via the raw sync API.
//
// Limitation: only pages that already have a `.rm` on the device can be appended
// to (we reuse their layer + structure). Annotations on never-touched pages are
// skipped and logged.

import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { mapPdfPages } from "../remarkable/rmdoc";
import { parseRmPage } from "../remarkable/rmlines";
import type { RmStroke, RmHighlight } from "../remarkable/rmlines";
import { encodeAppend } from "../remarkable/rmwrite";
import { updateDocumentPages } from "../remarkable/rmupload";
import {
  readPdfPageSizes,
  pageSizeAt,
  zoteroRectToRm,
  zoteroPathToRm,
  pdfWidthToRm,
  type PdfPageSize,
} from "../remarkable/geometry";
import { allRecords, setRecord } from "./state";
import type { ProgressFn } from "./engine";

const IO = globalThis as any;
const PUSHABLE = new Set(["highlight", "underline", "ink"]);

export interface PushSummary {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

// reMarkable PenColor index -> rgb, for nearest-colour mapping.
const PALETTE: [number, [number, number, number]][] = [
  [0, [0, 0, 0]],
  [1, [170, 170, 170]],
  [3, [255, 212, 0]],
  [4, [95, 178, 54]],
  [5, [255, 102, 102]],
  [6, [46, 168, 229]],
  [7, [255, 80, 80]],
  [12, [229, 110, 238]],
];

function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function nearestColorIndex(hex: string): number {
  const [r, g, b] = hexToRgb(hex);
  let best = 0;
  let bestDist = Infinity;
  for (const [idx, [cr, cg, cb]] of PALETTE) {
    const d = (r - cr) ** 2 + (g - cg) ** 2 + (b - cb) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = idx;
    }
  }
  return best;
}

/** Convert one Zotero annotation to reMarkable strokes/highlights. */
function annotationToRm(
  item: Zotero.Item,
  size: PdfPageSize,
): { strokes: RmStroke[]; highlights: RmHighlight[] } {
  const out = { strokes: [] as RmStroke[], highlights: [] as RmHighlight[] };
  const color = item.annotationColor || "#ffd400";
  let pos: { rects?: number[][]; paths?: number[][]; width?: number };
  try {
    pos = JSON.parse(item.annotationPosition);
  } catch {
    return out;
  }
  const type = item.annotationType;
  if (type === "highlight" || type === "underline") {
    const rects = (pos.rects ?? []).map((r) =>
      zoteroRectToRm(r as [number, number, number, number], size),
    );
    if (rects.length) {
      const [r, g, b] = hexToRgb(color);
      out.highlights.push({
        text: item.annotationText || "",
        colorIndex: nearestColorIndex(color),
        rgba: [r, g, b, 255],
        rects,
      });
    }
  } else if (type === "ink") {
    const width = pdfWidthToRm(pos.width ?? 1);
    for (const path of pos.paths ?? []) {
      const points = zoteroPathToRm(path, size);
      if (points.length) {
        out.strokes.push({
          tool: 17, // fineliner
          colorIndex: nearestColorIndex(color),
          thickness: 2,
          pointWidth: width,
          isHighlighter: false,
          points,
        });
      }
    }
  }
  return out;
}

/** Push Zotero-origin annotations for every synced attachment. */
export async function pushAnnotations(
  progress?: ProgressFn,
): Promise<PushSummary> {
  ensureNetworkGlobals();
  const summary: PushSummary = { pushed: 0, skipped: 0, failed: 0, errors: [] };

  const records = await allRecords();
  const keys = Object.keys(records);
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey);
      const entry = byId.get(rec.docId);
      if (!att || !entry) {
        done++;
        continue;
      }

      const pulled = new Set(rec.annotationKeys ?? []);
      const pushedBefore = new Set(rec.pushedKeys ?? []);
      const candidates = (att as Zotero.Item)
        .getAnnotations()
        .filter(
          (a) =>
            PUSHABLE.has(a.annotationType) &&
            !pulled.has(a.key) &&
            !pushedBefore.has(a.key),
        );
      if (candidates.length === 0) {
        done++;
        continue;
      }

      progress?.(`Pushing annotations: ${rec.visibleName}`, pct);
      const path = await (att as Zotero.Item).getFilePathAsync();
      const pdfBytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(pdfBytes);
      const pageMap = await mapPdfPages(api, rec.docId, entry.hash);

      // Group candidates by PDF page.
      const byPage = new Map<number, Zotero.Item[]>();
      for (const a of candidates) {
        let pi = 0;
        try {
          pi = JSON.parse(a.annotationPosition).pageIndex ?? 0;
        } catch {
          continue;
        }
        (byPage.get(pi) ?? byPage.set(pi, []).get(pi)!).push(a);
      }

      const pageRm = new Map<string, Uint8Array>();
      const pushedNow: string[] = [];
      for (const [pdfIdx, annots] of byPage) {
        const ref = pageMap.get(pdfIdx);
        if (!ref?.rmEntry) {
          log(`push: page ${pdfIdx + 1} not on device — skipped`);
          summary.skipped += annots.length;
          continue;
        }
        const existing = await api.raw.getHash(
          ref.rmEntry.id,
          ref.rmEntry.hash,
        );
        const parsed = parseRmPage(existing);
        if (!parsed.layerId) {
          summary.skipped += annots.length;
          continue;
        }
        const size = pageSizeAt(sizes, pdfIdx);
        const strokes: RmStroke[] = [];
        const highlights: RmHighlight[] = [];
        for (const a of annots) {
          const c = annotationToRm(a, size);
          strokes.push(...c.strokes);
          highlights.push(...c.highlights);
          pushedNow.push(a.key);
        }
        const newBytes = encodeAppend(existing, strokes, highlights, {
          layerId: parsed.layerId,
          lastItemId: parsed.lastItemId,
          author: parsed.maxAuthor + 1,
        });
        pageRm.set(ref.pageUuid, newBytes);
      }

      if (pageRm.size > 0) {
        log(`push: "${rec.visibleName}" -> ${pageRm.size} page(s)`);
        await updateDocumentPages(api, rec.docId, pageRm);
        await setRecord(attKey, {
          ...rec,
          pushedKeys: [...(rec.pushedKeys ?? []), ...pushedNow],
        });
        summary.pushed += pushedNow.length;
      }
    } catch (e) {
      log(`push: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}
