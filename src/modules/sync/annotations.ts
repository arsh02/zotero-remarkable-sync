// Create native Zotero annotations (highlights + ink) on a PDF attachment from
// parsed reMarkable pages. Re-pull is idempotent: callers pass the annotation
// keys created last time, which are erased before new ones are written.

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

async function saveAnnotation(
  attachment: Zotero.Item,
  json: Record<string, unknown>,
): Promise<string | null> {
  const key = generateKey();
  try {
    await Zotero.Annotations.saveFromJSON(attachment, { key, ...json } as any);
    return key;
  } catch (e) {
    log(
      `saveAnnotation(${json.type}) failed:`,
      errMsg(e),
      "| json:",
      JSON.stringify(json).slice(0, 200),
    );
    return null;
  }
}

async function createHighlight(
  attachment: Zotero.Item,
  pageIndex: number,
  hl: RmHighlight,
  size: PdfPageSize,
): Promise<string | null> {
  const rects = hl.rects.map((r) => rectToZotero(r, size));
  if (!rects.length) return null;
  log(
    `calib HL p${pageIndex} page=${size.width}x${size.height} rmRect=${JSON.stringify(
      hl.rects[0],
    )} zRect=${JSON.stringify(rects[0])} text=${JSON.stringify(hl.text.slice(0, 24))}`,
  );
  const topY = Math.max(...rects.map((r) => r[3]));
  return saveAnnotation(attachment, {
    type: "highlight",
    color: colorToHex(hl.colorIndex, hl.rgba),
    pageLabel: String(pageIndex + 1),
    sortIndex: sortIndex(pageIndex, size.height - topY),
    position: { pageIndex, rects },
    text: hl.text ?? "",
    comment: "",
  });
}

async function createInk(
  attachment: Zotero.Item,
  pageIndex: number,
  stroke: RmStroke,
  size: PdfPageSize,
): Promise<string | null> {
  const path = strokeToPath(stroke.points, size);
  if (path.length < 4) return null;
  log(
    `calib INK p${pageIndex} page=${size.width}x${size.height} rmFirst=(${stroke.points[0].x.toFixed(
      1,
    )},${stroke.points[0].y.toFixed(1)}) zFirst=(${path[0]},${path[1]})`,
  );
  let topY = 0;
  for (let i = 1; i < path.length; i += 2) topY = Math.max(topY, path[i]);
  return saveAnnotation(attachment, {
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
  });
}

/**
 * Replace this attachment's reMarkable-sourced annotations with a fresh set.
 * Returns the keys of the newly created annotations (store these for the next
 * idempotent re-pull).
 */
export async function applyAnnotations(
  attachment: Zotero.Item,
  docPages: RmDocPage[],
  size: PdfPageSize,
  priorKeys: string[],
): Promise<string[]> {
  // Erase the annotations we created last time.
  for (const key of priorKeys) {
    const item = Zotero.Items.getByLibraryAndKey(attachment.libraryID, key);
    if (item) {
      try {
        await (item as Zotero.Item).eraseTx();
      } catch {
        // already gone
      }
    }
  }

  const newKeys: string[] = [];
  for (const { pdfPageIndex, page } of docPages) {
    for (const hl of page.highlights) {
      const key = await createHighlight(attachment, pdfPageIndex, hl, size);
      if (key) newKeys.push(key);
    }
    for (const stroke of page.strokes) {
      const key = await createInk(attachment, pdfPageIndex, stroke, size);
      if (key) newKeys.push(key);
    }
  }
  return newKeys;
}
