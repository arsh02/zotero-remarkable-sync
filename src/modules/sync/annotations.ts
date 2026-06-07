// Create native Zotero annotations (highlights + ink) on a PDF attachment from
// parsed reMarkable pages.
//
// Pull is *non-destructive*: we never delete Zotero annotations (there is no
// Zotero -> reMarkable path yet, so the Zotero side must be preserved). Instead
// we dedup against the annotations already on the attachment by a content
// signature and only create the ones that are missing. Re-pulling is therefore
// idempotent and safe.

import {
  rectToZotero,
  strokeToPath,
  inkWidth,
  pageSizeAt,
  type PdfPageSize,
} from "../remarkable/geometry";
import type { RmDocPage } from "../remarkable/rmdoc";
import type { RmHighlight, RmStroke } from "../remarkable/rmlines";
import { rmToZoteroHex } from "../remarkable/colors";
import { log, errMsg } from "../../utils/log";

// Zotero object-key charset (excludes 0/1/I/O).
const KEY_CHARS = "23456789ABCDEFGHIJKLMNPQRSTUVWXYZ";

function generateKey(): string {
  const gen = (Zotero as any).DataObjectUtilities?.generateKey;
  if (typeof gen === "function") return gen();
  let k = "";
  for (let i = 0; i < 8; i++) {
    k += KEY_CHARS[Math.floor(Math.random() * KEY_CHARS.length)];
  }
  return k;
}

function colorToHex(
  colorIndex: number,
  rgba?: [number, number, number, number],
): string {
  return rmToZoteroHex(colorIndex, rgba);
}

function sortIndex(pageIndex: number, yFromTop: number): string {
  const top = Math.max(0, Math.min(99999, Math.round(yFromTop)));
  return [
    String(pageIndex).padStart(5, "0"),
    "000000",
    String(top).padStart(5, "0"),
  ].join("|");
}

// --- Content signatures (for dedup against existing annotations) ------------

function sig(
  type: string,
  pageIndex: number,
  x: number,
  y: number,
  extra = "",
): string {
  return `${type}|${pageIndex}|${Math.round(x)}|${Math.round(y)}|${extra}`;
}

/** Signature of an annotation already saved in Zotero. */
function existingSig(item: Zotero.Item): string | null {
  try {
    const type = item.annotationType;
    const pos = JSON.parse(item.annotationPosition) as {
      pageIndex: number;
      rects?: number[][];
      paths?: number[][];
    };
    if (type === "highlight" || type === "underline") {
      const r = pos.rects?.[0];
      if (!r) return null;
      return sig(
        type,
        pos.pageIndex,
        r[0],
        r[1],
        (item.annotationText || "").slice(0, 24),
      );
    }
    if (type === "ink") {
      const p = pos.paths?.[0];
      if (!p || p.length < 2) return null;
      return sig("ink", pos.pageIndex, p[0], p[1]);
    }
  } catch {
    /* ignore unparseable */
  }
  return null;
}

async function save(
  attachment: Zotero.Item,
  json: Record<string, unknown>,
): Promise<string | null> {
  const key = generateKey();
  try {
    await Zotero.Annotations.saveFromJSON(attachment, { key, ...json } as any);
    return key;
  } catch (e) {
    log(`saveAnnotation(${json.type}) failed:`, errMsg(e));
    return null;
  }
}

// --- Builders ---------------------------------------------------------------

interface Pending {
  signature: string;
  json: Record<string, unknown>;
}

function buildHighlight(
  pageIndex: number,
  hl: RmHighlight,
  size: PdfPageSize,
): Pending | null {
  const rects = hl.rects.map((r) => rectToZotero(r, size));
  if (!rects.length) return null;
  const topY = Math.max(...rects.map((r) => r[3]));
  return {
    signature: sig(
      "highlight",
      pageIndex,
      rects[0][0],
      rects[0][1],
      (hl.text || "").slice(0, 24),
    ),
    json: {
      type: "highlight",
      color: colorToHex(hl.colorIndex, hl.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - topY),
      position: { pageIndex, rects },
      text: hl.text ?? "",
      comment: "",
    },
  };
}

/**
 * A freehand (non-snapping) highlighter stroke. Rendered as a translucent
 * Zotero highlight (bounding rect) rather than opaque ink so the text underneath
 * stays readable.
 */
function buildHighlighterStroke(
  pageIndex: number,
  stroke: RmStroke,
  size: PdfPageSize,
): Pending | null {
  const path = strokeToPath(stroke.points, size);
  if (path.length < 4) return null;
  let minX = Infinity,
    maxX = -Infinity,
    minY = Infinity,
    maxY = -Infinity;
  for (let i = 0; i < path.length; i += 2) {
    minX = Math.min(minX, path[i]);
    maxX = Math.max(maxX, path[i]);
    minY = Math.min(minY, path[i + 1]);
    maxY = Math.max(maxY, path[i + 1]);
  }
  const halfW = inkWidth(stroke.pointWidth) / 2;
  const rect: [number, number, number, number] = [
    minX,
    minY - halfW,
    maxX,
    maxY + halfW,
  ];
  return {
    signature: sig("highlight", pageIndex, rect[0], rect[1], "fh"),
    json: {
      type: "highlight",
      color: colorToHex(stroke.colorIndex, stroke.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - rect[3]),
      position: { pageIndex, rects: [rect] },
      text: "",
      comment: "",
    },
  };
}

function buildInk(
  pageIndex: number,
  stroke: RmStroke,
  size: PdfPageSize,
): Pending | null {
  const path = strokeToPath(stroke.points, size);
  if (path.length < 4) return null;
  let topY = 0;
  for (let i = 1; i < path.length; i += 2) topY = Math.max(topY, path[i]);
  return {
    signature: sig("ink", pageIndex, path[0], path[1]),
    json: {
      type: "ink",
      color: colorToHex(stroke.colorIndex, stroke.rgba),
      pageLabel: String(pageIndex + 1),
      sortIndex: sortIndex(pageIndex, size.height - topY),
      position: {
        pageIndex,
        paths: [path],
        width: inkWidth(stroke.pointWidth),
      },
      comment: "",
    },
  };
}

export interface ApplyResult {
  /** updated full set of keys for annotations this plugin created on pull */
  keys: string[];
  added: number;
  removed: number;
}

/**
 * Mirror the device's annotations onto the attachment:
 *  - add device annotations not already present,
 *  - remove annotations WE previously pulled (`ourKeys`) that have disappeared
 *    from the device.
 * Never touches the user's own annotations. Returns the updated key set.
 */
export async function applyAnnotations(
  attachment: Zotero.Item,
  docPages: RmDocPage[],
  sizes: PdfPageSize[],
  ourKeys: string[] = [],
): Promise<ApplyResult> {
  // Build the device's current set: pendings to create + their signatures.
  const pendings: Pending[] = [];
  const incoming = new Set<string>();
  for (const { pdfPageIndex, page } of docPages) {
    const size = pageSizeAt(sizes, pdfPageIndex);
    const built = [
      ...page.highlights.map((hl) => buildHighlight(pdfPageIndex, hl, size)),
      ...page.strokes.map((st) =>
        st.isHighlighter
          ? buildHighlighterStroke(pdfPageIndex, st, size)
          : buildInk(pdfPageIndex, st, size),
      ),
    ];
    for (const p of built) {
      if (p) {
        pendings.push(p);
        incoming.add(p.signature);
      }
    }
  }

  const ourSet = new Set(ourKeys);
  const present = new Set<string>();
  const keptKeys: string[] = [];
  let removed = 0;

  // Pass over existing annotations: delete ours that vanished; index the rest.
  for (const a of attachment.getAnnotations()) {
    const s = existingSig(a);
    if (ourSet.has(a.key)) {
      if (s && incoming.has(s)) {
        keptKeys.push(a.key);
        if (s) present.add(s);
      } else {
        try {
          await a.eraseTx();
          removed++;
        } catch {
          keptKeys.push(a.key); // couldn't delete — keep tracking it
        }
      }
    } else if (s) {
      present.add(s); // user's own annotation — never touched, used for dedup
    }
  }

  // Add device annotations not already present.
  const newKeys: string[] = [];
  for (const p of pendings) {
    if (present.has(p.signature)) continue;
    const key = await save(attachment, p.json);
    if (key) {
      present.add(p.signature);
      newKeys.push(key);
    }
  }

  return { keys: [...keptKeys, ...newKeys], added: newKeys.length, removed };
}
