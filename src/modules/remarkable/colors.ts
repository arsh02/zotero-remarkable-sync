// Shared colour mapping between Zotero annotations and reMarkable, so a colour
// round-trips (push then pull yields the same Zotero colour) and the two sides
// "match". e-ink has less contrast, so highlights pushed to the device are made
// more transparent there (PUSH_HIGHLIGHT_ALPHA) while Zotero keeps its own
// translucent rendering of the opaque hex.

export interface ColorEntry {
  /** Zotero hex (its annotation palette) */
  hex: string;
  /** reMarkable PenColor index */
  rmIndex: number;
  rgb: [number, number, number];
}

// Zotero's default annotation palette mapped to the nearest reMarkable PenColor.
const COLORS: ColorEntry[] = [
  { hex: "#ffd400", rmIndex: 3, rgb: [255, 212, 0] }, // yellow
  { hex: "#5fb236", rmIndex: 4, rgb: [95, 178, 54] }, // green
  { hex: "#ff6666", rmIndex: 5, rgb: [255, 102, 102] }, // pink/red
  { hex: "#2ea8e5", rmIndex: 6, rgb: [46, 168, 229] }, // blue
  { hex: "#e56eee", rmIndex: 12, rgb: [229, 110, 238] }, // magenta
  { hex: "#a28ae5", rmIndex: 6, rgb: [162, 138, 229] }, // purple ~ blue
  { hex: "#f19837", rmIndex: 7, rgb: [241, 152, 55] }, // orange ~ red
  { hex: "#aaaaaa", rmIndex: 1, rgb: [170, 170, 170] }, // gray
  { hex: "#000000", rmIndex: 0, rgb: [0, 0, 0] }, // black (pens)
];

/**
 * Alpha (0-255) for highlights pushed to the device. Lower = more transparent
 * on the reMarkable (compensates for e-ink contrast / keeps text readable).
 * Tune here.
 */
export const PUSH_HIGHLIGHT_ALPHA = 110;

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function nearestByRgb(rgb: [number, number, number]): ColorEntry {
  let best = COLORS[0];
  let bestDist = Infinity;
  for (const c of COLORS) {
    const d =
      (rgb[0] - c.rgb[0]) ** 2 +
      (rgb[1] - c.rgb[1]) ** 2 +
      (rgb[2] - c.rgb[2]) ** 2;
    if (d < bestDist) {
      bestDist = d;
      best = c;
    }
  }
  return best;
}

/** Zotero hex -> reMarkable PenColor index + rgba (for push). */
export function zoteroToRm(
  hex: string,
  kind: "highlight" | "ink",
): { index: number; rgba: [number, number, number, number] } {
  const entry = nearestByRgb(hexToRgb(hex));
  const alpha = kind === "highlight" ? PUSH_HIGHLIGHT_ALPHA : 255;
  return { index: entry.rmIndex, rgba: [...entry.rgb, alpha] };
}

/** reMarkable PenColor index (+ optional rgba) -> Zotero hex (for pull). */
export function rmToZoteroHex(
  colorIndex: number,
  rgba?: [number, number, number, number],
): string {
  if (rgba) return nearestByRgb([rgba[0], rgba[1], rgba[2]]).hex;
  return COLORS.find((c) => c.rmIndex === colorIndex)?.hex ?? "#ffd400";
}
