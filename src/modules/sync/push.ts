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
import {
  encodePageUpdate,
  splitStructure,
  blankStructure,
} from "../remarkable/rmwrite";
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
import { existingSig } from "./annotations";
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
  const index = zoteroToRm(color);
  if (type === "highlight" || type === "underline") {
    const text = item.annotationText || "";
    // Break a multi-line Zotero highlight into one GlyphRange per line so each
    // line renders on the device. Text goes on the first; pull rejoins them.
    // No rgba: the device renders its native palette colour for `index`.
    (pos.rects ?? []).forEach((r, i) => {
      out.highlights.push({
        text: i === 0 ? text : "",
        colorIndex: index,
        rects: [zoteroRectToRm(r as [number, number, number, number], size)],
      });
    });
  } else if (type === "ink") {
    const width = pdfWidthToRm(pos.width ?? 1);
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
      const tracked = rec.pushedItems ?? [];
      const pushedBefore = new Set(tracked.map((p) => p.key));

      const annotations = (att as Zotero.Item).getAnnotations();
      const currentKeys = new Set(annotations.map((a) => a.key));
      const additions = annotations.filter(
        (a) =>
          PUSHABLE.has(a.annotationType) &&
          !pulled.has(a.key) &&
          !pushedBefore.has(a.key),
      );
      // Previously pushed annotations now gone from Zotero -> delete on device.
      const deletions = tracked.filter((p) => !currentKeys.has(p.key));
      if (additions.length === 0 && deletions.length === 0) {
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
      const findRef = (pageUuid: string) => {
        for (const [pi, r] of pageMap)
          if (r.pageUuid === pageUuid) return { pdfIdx: pi, ref: r };
        return null;
      };

      // Build a per-page plan of additions + deletions.
      interface Plan {
        pdfIdx: number;
        ref: PageRef;
        adds: Zotero.Item[];
        deleteIds: CrdtId[];
      }
      const plan = new Map<string, Plan>();
      for (const a of additions) {
        let pi = 0;
        try {
          pi = JSON.parse(a.annotationPosition).pageIndex ?? 0;
        } catch {
          continue;
        }
        const ref = pageMap.get(pi);
        if (!ref) {
          summary.skipped++;
          continue;
        }
        const p =
          plan.get(ref.pageUuid) ??
          plan
            .set(ref.pageUuid, { pdfIdx: pi, ref, adds: [], deleteIds: [] })
            .get(ref.pageUuid)!;
        p.adds.push(a);
      }
      for (const d of deletions) {
        const found = findRef(d.page);
        if (!found?.ref.rmEntry) continue; // page gone — deletion moot
        const p =
          plan.get(d.page) ??
          plan
            .set(d.page, {
              pdfIdx: found.pdfIdx,
              ref: found.ref,
              adds: [],
              deleteIds: [],
            })
            .get(d.page)!;
        for (const [p1, p2] of d.ids)
          p.deleteIds.push({ part1: p1, part2: p2 });
      }

      let template: Template | null | undefined;
      const pageRm = new Map<string, Uint8Array>();
      // Keep tracking for annotations still present; rebuild for re-pushed pages.
      const newTracked = tracked.filter((p) => currentKeys.has(p.key));
      let addedCount = 0;

      for (const [pageUuid, work] of plan) {
        const size = pageSizeAt(sizes, work.pdfIdx);
        const strokes: RmStroke[] = [];
        const highlights: RmHighlight[] = [];
        const hlOwners: string[] = [];
        const stOwners: string[] = [];
        for (const a of work.adds) {
          const c = annotationToRm(a, size);
          for (const h of c.highlights) {
            highlights.push(h);
            hlOwners.push(a.key);
          }
          for (const s of c.strokes) {
            strokes.push(s);
            stOwners.push(a.key);
          }
        }

        let base: Uint8Array;
        let meta: {
          layerId: CrdtId;
          lastItemId?: CrdtId;
          author: number;
          startCounter: number;
          deleteIds: CrdtId[];
        };
        if (work.ref.rmEntry) {
          const existing = await api.raw.getHash(
            work.ref.rmEntry.id,
            work.ref.rmEntry.hash,
          );
          const parsed = parseRmPage(existing);
          if (!parsed.layerId) {
            summary.skipped += work.adds.length;
            continue;
          }
          base = existing;
          meta = {
            layerId: parsed.layerId,
            lastItemId: parsed.lastItemId,
            author:
              parsed.lastItemId?.part1 ??
              parsed.layerId.part1 ??
              parsed.maxAuthor,
            startCounter: parsed.maxCounter + 1,
            deleteIds: work.deleteIds,
          };
        } else {
          if (template === undefined) {
            template = (await loadTemplate(api, pageMap)) ?? blankStructure();
          }
          if (!template) {
            summary.skipped += work.adds.length;
            continue;
          }
          base = template.structure;
          meta = {
            layerId: template.layerId,
            author: template.author,
            startCounter: template.startCounter,
            deleteIds: work.deleteIds,
          };
        }

        const { bytes, ids } = encodePageUpdate(
          base,
          strokes,
          highlights,
          meta,
        );
        pageRm.set(pageUuid, bytes);

        // Map assigned ids (highlights then strokes) back to annotation keys.
        const owners = [...hlOwners, ...stOwners];
        const byKey = new Map<string, [number, number][]>();
        ids.forEach((id, i) => {
          const k = owners[i];
          if (!k) return;
          (byKey.get(k) ?? byKey.set(k, []).get(k)!).push([id.part1, id.part2]);
        });
        const itemByKey = new Map(work.adds.map((a) => [a.key, a]));
        for (const [k, kids] of byKey) {
          const item = itemByKey.get(k);
          newTracked.push({
            key: k,
            page: pageUuid,
            ids: kids,
            sig: (item && existingSig(item)) || undefined,
          });
          addedCount++;
        }
      }

      // Remember signatures of deleted annotations so pull won't re-create them.
      const newDeletedSigs = [
        ...new Set([
          ...(rec.deletedSigs ?? []),
          ...deletions.map((d) => d.sig).filter((s): s is string => !!s),
        ]),
      ];

      if (
        pageRm.size > 0 ||
        newDeletedSigs.length !== (rec.deletedSigs ?? []).length
      ) {
        log(
          `push: "${rec.visibleName}" -> ${pageRm.size} page(s) (+${addedCount} -${deletions.length})`,
        );
        if (pageRm.size > 0) await updateDocumentPages(api, rec.docId, pageRm);
        await setRecord(attKey, {
          ...rec,
          pushedItems: newTracked,
          pushedKeys: newTracked.map((p) => p.key),
          deletedSigs: newDeletedSigs,
        });
        summary.pushed += addedCount;
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
