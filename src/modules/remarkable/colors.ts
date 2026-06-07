// Shared colour mapping between Zotero and reMarkable, used both directions so
// colours match and round-trip. reMarkable has 6 highlighter colours (yellow,
// green, blue, orange, pink, gray); Zotero has 8, so red/magenta collapse onto
// pink and purple onto blue, and reMarkable pink comes back as Zotero magenta.

// reMarkable PenColor indices (rmscene's enum). ORANGE is not in the public
// spec — it's confirmed from a real pull (see the "pull HL" log) and set here.
const RM = {
  BLACK: 0,
  GRAY: 1,
  WHITE: 2,
  YELLOW: 3,
  GREEN: 4,
  PINK: 5,
  BLUE: 6,
  RED: 7,
  GRAY_OVERLAP: 8,
  HIGHLIGHT: 9,
  GREEN_2: 10,
  CYAN: 11,
  MAGENTA: 12,
  YELLOW_2: 13,
  ORANGE: 14, // TODO: confirm from a real reMarkable orange highlight
};

// Push: a Zotero colour (matched by nearest rgb) -> reMarkable PenColor index.
const PUSH: { rgb: [number, number, number]; rmIndex: number }[] = [
  { rgb: [255, 212, 0], rmIndex: RM.YELLOW }, // yellow
  { rgb: [95, 178, 54], rmIndex: RM.GREEN }, // green
  { rgb: [46, 168, 229], rmIndex: RM.BLUE }, // blue
  { rgb: [162, 138, 229], rmIndex: RM.BLUE }, // purple -> blue
  { rgb: [241, 152, 55], rmIndex: RM.ORANGE }, // orange
  { rgb: [170, 170, 170], rmIndex: RM.GRAY }, // gray
  { rgb: [255, 102, 102], rmIndex: RM.PINK }, // red -> pink
  { rgb: [229, 110, 238], rmIndex: RM.PINK }, // magenta -> pink
];

// Pull: reMarkable PenColor index -> Zotero hex.
const PULL: Record<number, string> = {
  [RM.YELLOW]: "#ffd400",
  [RM.YELLOW_2]: "#ffd400",
  [RM.GREEN]: "#5fb236",
  [RM.GREEN_2]: "#5fb236",
  [RM.BLUE]: "#2ea8e5",
  [RM.CYAN]: "#2ea8e5",
  [RM.PINK]: "#e56eee", // pink -> magenta
  [RM.MAGENTA]: "#e56eee",
  [RM.RED]: "#ff6666",
  [RM.ORANGE]: "#f19837",
  [RM.GRAY]: "#aaaaaa",
  [RM.GRAY_OVERLAP]: "#aaaaaa",
  [RM.BLACK]: "#000000",
  [RM.WHITE]: "#ffffff",
};

export function hexToRgb(hex: string): [number, number, number] {
  const h = hex.replace("#", "");
  return [
    parseInt(h.slice(0, 2), 16) || 0,
    parseInt(h.slice(2, 4), 16) || 0,
    parseInt(h.slice(4, 6), 16) || 0,
  ];
}

function dist(
  a: [number, number, number],
  b: [number, number, number],
): number {
  return (a[0] - b[0]) ** 2 + (a[1] - b[1]) ** 2 + (a[2] - b[2]) ** 2;
}

/** Zotero hex -> reMarkable PenColor index (push). */
export function zoteroToRm(hex: string): number {
  const rgb = hexToRgb(hex);
  let best = PUSH[0];
  for (const c of PUSH) if (dist(rgb, c.rgb) < dist(rgb, best.rgb)) best = c;
  return best.rmIndex;
}

/** reMarkable PenColor index (+ optional rgba) -> Zotero hex (pull). */
export function rmToZoteroHex(
  colorIndex: number,
  rgba?: [number, number, number, number],
): string {
  if (colorIndex in PULL) return PULL[colorIndex];
  // Unknown index (e.g. a colour we haven't mapped): match by rgba if present.
  if (rgba) {
    const rgb: [number, number, number] = [rgba[0], rgba[1], rgba[2]];
    let bestHex = "#ffd400";
    let bestDist = Infinity;
    for (const c of PUSH) {
      const d = dist(rgb, c.rgb);
      if (d < bestDist) {
        bestDist = d;
        bestHex =
          "#" + c.rgb.map((v) => v.toString(16).padStart(2, "0")).join("");
      }
    }
    return bestHex;
  }
  return "#ffd400";
}
