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
  type PdfPageSize,
} from "../remarkable/geometry";
import type { RmDocPage } from "../remarkable/rmdoc";
import type { RmHighlight, RmStroke } from "../remarkable/rmlines";
import { log, errMsg } from "../../utils/log";

// reMarkable PenColor index -> hex, used when no explicit rgba is present.
const PEN_HEX: Record<number, string> = {
  0: "#000000", // black
  1: "#aaaaaa", // gray
  2: "#ffffff", // white
  3: "#ffd400", // yellow
  4: "#5fb236", // green
  5: "#ff6666", // pink
  6: "#2ea8e5", // blue
  7: "#ff6666", // red
  9: "#ffd400", // highlight (real colour in rgba)
  10: "#5fb236",
  11: "#2ea8e5",
  12: "#e56eee",
  13: "#ffd400",
};

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
  if (rgba) {
    return (
      "#" +
      rgba
        .slice(0, 3)
        .map((c) => c.toString(16).padStart(2, "0"))
        .join("")
    );
  }
  return PEN_HEX[colorIndex] ?? "#ffd400";
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

/**
 * Add the reMarkable annotations that aren't already present on the attachment.
 * Never deletes anything. Returns the keys of the newly created annotations.
 */
export async function applyAnnotations(
  attachment: Zotero.Item,
  docPages: RmDocPage[],
  size: PdfPageSize,
): Promise<string[]> {
  const seen = new Set<string>();
  for (const a of attachment.getAnnotations()) {
    const s = existingSig(a);
    if (s) seen.add(s);
  }

  const newKeys: string[] = [];
  for (const { pdfPageIndex, page } of docPages) {
    const pendings: (Pending | null)[] = [
      ...page.highlights.map((hl) => buildHighlight(pdfPageIndex, hl, size)),
      ...page.strokes.map((st) =>
        st.isHighlighter
          ? buildHighlighterStroke(pdfPageIndex, st, size)
          : buildInk(pdfPageIndex, st, size),
      ),
    ];
    for (const p of pendings) {
      if (!p || seen.has(p.signature)) continue;
      const key = await save(attachment, p.json);
      if (key) {
        seen.add(p.signature);
        newKeys.push(key);
      }
    }
  }
  return newKeys;
}
