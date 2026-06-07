// Map reMarkable scene coordinates onto PDF points (Zotero annotation space:
// origin bottom-left, units = PDF points).
//
// reMarkable stores annotations in a canvas whose width is RM_WIDTH px with x
// centred on the page (0 at the middle) and y measured from the top. For a PDF,
// the page is fit to the canvas width, so one scale factor (points per rm-px =
// pdfWidth / RM_WIDTH) converts both axes.
//
// NOTE: these constants are the first calibration target. If pulled annotations
// land offset or mis-scaled, adjust RM_WIDTH (overall scale) / the centring.

import type { RmPoint, RmRect } from "./rmlines";

export interface PdfPageSize {
  /** page width in PDF points */
  width: number;
  /** page height in PDF points */
  height: number;
}

export interface Geometry {
  rmWidth: number;
  rmHeight: number;
}

export const DEFAULT_GEOMETRY: Geometry = { rmWidth: 1404, rmHeight: 1872 };

/** Map a reMarkable (x, y) to a PDF point [x, y] with origin bottom-left. */
export function rmToPdf(
  x: number,
  y: number,
  page: PdfPageSize,
  g: Geometry = DEFAULT_GEOMETRY,
): [number, number] {
  const scale = page.width / g.rmWidth;
  const px = (x + g.rmWidth / 2) * scale;
  const pyFromTop = y * scale;
  return [px, page.height - pyFromTop];
}

/** Convert a reMarkable highlight rectangle to a Zotero rect [x1,y1,x2,y2]. */
export function rectToZotero(
  r: RmRect,
  page: PdfPageSize,
  g: Geometry = DEFAULT_GEOMETRY,
): [number, number, number, number] {
  const [ax, ay] = rmToPdf(r.x, r.y, page, g); // top-left
  const [bx, by] = rmToPdf(r.x + r.w, r.y + r.h, page, g); // bottom-right
  return [
    Math.min(ax, bx),
    Math.min(ay, by),
    Math.max(ax, bx),
    Math.max(ay, by),
  ];
}

/** Convert a stroke's points to a flat Zotero ink path [x1,y1,x2,y2,...]. */
export function strokeToPath(
  points: RmPoint[],
  page: PdfPageSize,
  g: Geometry = DEFAULT_GEOMETRY,
): number[] {
  const out: number[] = [];
  for (const p of points) {
    const [x, y] = rmToPdf(p.x, p.y, page, g);
    out.push(round(x), round(y));
  }
  return out;
}

function round(n: number): number {
  return Math.round(n * 1000) / 1000;
}

/**
 * Extract page sizes from a PDF by scanning for `/MediaBox` entries. Falls back
 * to US Letter. Most PDFs use a uniform page size; we return the first found
 * and reuse it for all pages.
 */
export function readPdfPageSize(bytes: Uint8Array): PdfPageSize {
  // Decode as latin1 so byte offsets line up with the text we search for.
  let s = "";
  const chunk = 65536;
  for (let i = 0; i < bytes.length; i += chunk) {
    s += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  const m = s.match(
    /\/MediaBox\s*\[\s*(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s+(-?[\d.]+)\s*\]/,
  );
  if (m) {
    const x1 = parseFloat(m[1]);
    const y1 = parseFloat(m[2]);
    const x2 = parseFloat(m[3]);
    const y2 = parseFloat(m[4]);
    const width = Math.abs(x2 - x1);
    const height = Math.abs(y2 - y1);
    if (width > 0 && height > 0) return { width, height };
  }
  return { width: 612, height: 792 };
}
