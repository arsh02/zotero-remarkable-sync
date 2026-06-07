// Push Zotero annotations to the reMarkable.
//
// For each synced attachment, take the annotations that originated in Zotero
// (not pulled from the device, not already pushed), convert them to reMarkable
// strokes/highlights, and write them onto the relevant page, then commit via the
// raw sync API. A page that already has a `.rm` is appended to (reusing its
// layer); a page with none gets a new `.rm` cloned from another page's structure
// (loadTemplate). If the document has no `.rm` anywhere, those pages are skipped.

import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import type { RemarkableApi } from "rmapi-js";
import * as client from "../remarkable/client";
import { mapPdfPages, type PageRef } from "../remarkable/rmdoc";
import { parseRmPage } from "../remarkable/rmlines";
import type { RmStroke, RmHighlight, CrdtId } from "../remarkable/rmlines";
import { encodeAppend, splitStructure } from "../remarkable/rmwrite";
import { updateDocumentPages } from "../remarkable/rmupload";
import { zoteroToRm } from "../remarkable/colors";
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
      const { index, rgba } = zoteroToRm(color, "highlight");
      out.highlights.push({
        text: item.annotationText || "",
        colorIndex: index,
        rgba,
        rects,
      });
    }
  } else if (type === "ink") {
    const width = pdfWidthToRm(pos.width ?? 1);
    const { index } = zoteroToRm(color, "ink");
    for (const path of pos.paths ?? []) {
      const points = zoteroPathToRm(path, size);
      if (points.length) {
        out.strokes.push({
          tool: 17, // fineliner
          colorIndex: index,
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

interface Template {
  structure: Uint8Array;
  layerId: CrdtId;
  author: number;
  startCounter: number;
}

/** Find any page that has a `.rm` and turn it into a structural template. */
async function loadTemplate(
  api: RemarkableApi,
  pageMap: Map<number, PageRef>,
): Promise<Template | null> {
  for (const ref of pageMap.values()) {
    if (!ref.rmEntry) continue;
    try {
      const bytes = await api.raw.getHash(ref.rmEntry.id, ref.rmEntry.hash);
      const parsed = parseRmPage(bytes);
      if (parsed.layerId) {
        return {
          structure: splitStructure(bytes),
          layerId: parsed.layerId,
          author: parsed.lastItemId?.part1 ?? parsed.maxAuthor,
          startCounter: parsed.maxCounter + 1,
        };
      }
    } catch {
      // try the next page
    }
  }
  return null;
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

      // A template page (any page that has a .rm) lets us create page files for
      // pages the device has never had annotations on (clone its structure).
      const template = await loadTemplate(api, pageMap);

      const pageRm = new Map<string, Uint8Array>();
      const pushedNow: string[] = [];
      for (const [pdfIdx, annots] of byPage) {
        const ref = pageMap.get(pdfIdx);
        if (!ref) {
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
        }

        let newBytes: Uint8Array;
        if (ref.rmEntry) {
          // Append to the page's own existing .rm (reuse its layer + author).
          const existing = await api.raw.getHash(
            ref.rmEntry.id,
            ref.rmEntry.hash,
          );
          const parsed = parseRmPage(existing);
          if (!parsed.layerId) {
            summary.skipped += annots.length;
            continue;
          }
          const author =
            parsed.lastItemId?.part1 ??
            parsed.layerId?.part1 ??
            parsed.maxAuthor;
          newBytes = encodeAppend(existing, strokes, highlights, {
            layerId: parsed.layerId,
            lastItemId: parsed.lastItemId,
            author,
            startCounter: parsed.maxCounter + 1,
          });
        } else if (template) {
          // Page has no .rm yet — clone a template page's structure.
          newBytes = encodeAppend(template.structure, strokes, highlights, {
            layerId: template.layerId,
            author: template.author,
            startCounter: template.startCounter,
          });
        } else {
          log(`push: page ${pdfIdx + 1} has no .rm and no template — skipped`);
          summary.skipped += annots.length;
          continue;
        }

        for (const a of annots) pushedNow.push(a.key);
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
