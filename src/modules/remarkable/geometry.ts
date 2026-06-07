// Map reMarkable scene coordinates onto PDF points (Zotero annotation space:
// origin bottom-left, units = PDF points).
//
// reMarkable renders a PDF at a fixed device resolution (RM_DPI) and stores
// annotation coordinates in those device pixels, with x measured from the page
// centre and y from the top. So the conversion is a single constant scale —
// 1 PDF point = RM_DPI/72 reMarkable units — independent of page size:
//
//   pdfX     = rmX * (72/RM_DPI) + pageWidth/2
//   pdfYtop  = rmY * (72/RM_DPI)
//   zoteroY  = pageHeight - pdfYtop      (flip to bottom-left origin)
//
// Verified against a real reMarkable export: highlight rects matched the baked
// PDF vectors to <1pt. RM_DPI is the single calibration knob (226 = rM2 / rMPP).

import type { RmPoint, RmRect } from "./rmlines";

export interface PdfPageSize {
  /** page width in PDF points */
  width: number;
  /** page height in PDF points */
  height: number;
}

/** reMarkable device resolution. The only calibration constant. */
export const RM_DPI = 226;
const PT_PER_RM = 72 / RM_DPI;

// Per-point pen width (reMarkable units) -> PDF points. Derived from a real
// export: highlighter point-width 120 -> 11.34pt, fineliner 16 -> 1.51pt.
const RM_WIDTH_FACTOR = 0.0945;

/** Convert a reMarkable pen width to a Zotero ink width in PDF points. */
export function inkWidth(rmPointWidth: number): number {
  return Math.max(0.5, Math.round(rmPointWidth * RM_WIDTH_FACTOR * 100) / 100);
}

/** Map a reMarkable (x, y) to a PDF point [x, y] with origin bottom-left. */
export function rmToPdf(
  x: number,
  y: number,
  page: PdfPageSize,
): [number, number] {
  const px = x * PT_PER_RM + page.width / 2;
  const pyFromTop = y * PT_PER_RM;
  return [px, page.height - pyFromTop];
}

/** Convert a reMarkable highlight rectangle to a Zotero rect [x1,y1,x2,y2]. */
export function rectToZotero(
  r: RmRect,
  page: PdfPageSize,
): [number, number, number, number] {
  const [ax, ay] = rmToPdf(r.x, r.y, page); // top-left
  const [bx, by] = rmToPdf(r.x + r.w, r.y + r.h, page); // bottom-right
  return [
    Math.min(ax, bx),
    Math.min(ay, by),
    Math.max(ax, bx),
    Math.max(ay, by),
  ];
}

/** Convert a stroke's points to a flat Zotero ink path [x1,y1,x2,y2,...]. */
export function strokeToPath(points: RmPoint[], page: PdfPageSize): number[] {
  const out: number[] = [];
  for (const p of points) {
    const [x, y] = rmToPdf(p.x, p.y, page);
    out.push(round(x), round(y));
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

const LETTER: PdfPageSize = { width: 612, height: 792 };

function decodeLatin1(bytes: Uint8Array): string {
  let s = "";
  const chunk = 32768;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return s;
}

/**
 * Extract every `/MediaBox` entry from a PDF, in file order. PDFs that vary
 * page size store a MediaBox per page (usually in order); uniform PDFs yield a
 * single value reused for all pages. Falls back to US Letter.
 */
export function readPdfPageSizes(bytes: Uint8Array): PdfPageSize[] {
  const s = decodeLatin1(bytes);
  const re =
    /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/g;
  const sizes: PdfPageSize[] = [];
  for (let m = re.exec(s); m; m = re.exec(s)) {
    const width = Math.abs(parseFloat(m[3]) - parseFloat(m[1]));
    const height = Math.abs(parseFloat(m[4]) - parseFloat(m[2]));
    if (width > 0 && height > 0) sizes.push({ width, height });
  }
  return sizes.length ? sizes : [LETTER];
}

/** Page size for a given page index, reusing the last known size if needed. */
export function pageSizeAt(sizes: PdfPageSize[], index: number): PdfPageSize {
  if (!sizes.length) return LETTER;
  return sizes[Math.min(index, sizes.length - 1)];
}
