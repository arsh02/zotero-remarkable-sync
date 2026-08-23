// Minimal EPUB Canonical Fragment Identifier (CFI) support — just enough to:
//  (a) BUILD a spec-correct range CFI from a DOM Range we found ourselves
//      (pull direction: we located the reMarkable highlight's text in the
//      chapter, so we know the exact nodes/offsets — this direction must
//      produce CFIs Zotero's own (complete) resolver can read back), and
//  (b) RESOLVE a subset of real-world CFIs (the shapes Zotero's own reader
//      generates: one indirection into a single content document, optional
//      range with a shared ancestor path) back to a DOM Range (push
//      direction: baking an existing Zotero annotation into the chapter).
//
// (b) is deliberately not a complete CFI implementation (no nested
// indirections, temporal/spatial offsets, or the full odd/even step
// resolution against mixed inline markup) — every caller has a text-quote
// fallback (`findTextRange` below) for anything this can't resolve, which
// covers the common case (a highlight sitting in a single run of text)
// robustly even when the strict parse fails.
//
// Reference: https://idpf.org/epub/linking/cfi/epub-cfi.html

const ELEMENT_NODE = 1;
const TEXT_NODE = 3;

/** The step number (odd=text, even=element) of `node` among its siblings. */
function stepOf(node: Node): number {
  const parent = node.parentNode;
  if (!parent) return 0;
  let elemN = 0;
  let textN = 0;
  for (const child of Array.from(parent.childNodes) as Node[]) {
    if (child.nodeType === ELEMENT_NODE) {
      elemN++;
      if (child === node) return elemN * 2;
    } else if (child.nodeType === TEXT_NODE) {
      textN++;
      if (child === node) return textN * 2 - 1;
    }
  }
  return 0;
}

/** Step numbers from (but not including) `root` down to `node`. */
function stepsTo(node: Node, root: Node): number[] {
  const steps: number[] = [];
  let cur: Node | null = node;
  while (cur && cur !== root) {
    const s = stepOf(cur);
    if (s > 0) steps.push(s);
    cur = cur.parentNode;
  }
  steps.reverse();
  return steps;
}

function longestCommonPrefix(a: number[], b: number[]): number[] {
  const out: number[] = [];
  for (let i = 0; i < a.length && i < b.length && a[i] === b[i]; i++) {
    out.push(a[i]);
  }
  return out;
}

function stepsToPath(steps: number[]): string {
  return steps.map((s) => `/${s}`).join("");
}

/**
 * Build a range CFI: `epubcfi(/6/{spineStep}!{common},{startLocal}:{o1},{endLocal}:{o2})`.
 * `root` should be the chapter's <body> (or documentElement) — the element the
 * step numbers are relative to. `spineIndex` is 0-based.
 */
export function buildRangeCfi(
  spineIndex: number,
  root: Node,
  startNode: Node,
  startOffset: number,
  endNode: Node,
  endOffset: number,
): string {
  const startSteps = stepsTo(startNode, root);
  const endSteps = stepsTo(endNode, root);
  // Always keep at least the terminal step in each branch, even when
  // start/end land in the very same text node — matches what real-world CFI
  // generators (including Zotero's) produce for a same-node range.
  const common = longestCommonPrefix(
    startSteps.slice(0, -1),
    endSteps.slice(0, -1),
  );
  const spineStep = 2 * (spineIndex + 1);
  const startLocal = stepsToPath(startSteps.slice(common.length));
  const endLocal = stepsToPath(endSteps.slice(common.length));
  return `epubcfi(/6/${spineStep}!${stepsToPath(common)},${startLocal}:${startOffset},${endLocal}:${endOffset})`;
}

export interface ResolvedCfi {
  spineIndex: number;
  startNode: Node;
  startOffset: number;
  endNode: Node;
  endOffset: number;
}

/** Split a raw step token like "68[body]" or "3" into its numeric step. */
function parseStepToken(token: string): number | null {
  const m = /^(\d+)/.exec(token);
  return m ? parseInt(m[1], 10) : null;
}

function parsePathSteps(path: string): number[] | null {
  const tokens = path.split("/").filter(Boolean);
  const steps: number[] = [];
  for (const t of tokens) {
    const n = parseStepToken(t);
    if (n === null) return null;
    steps.push(n);
  }
  return steps;
}

/** Resolve `/N` steps against a DOM root; even=element position, odd=text position. */
function resolveSteps(root: Node, steps: number[]): Node | null {
  let cur: Node = root;
  for (const s of steps) {
    const parent = cur;
    let elemN = 0;
    let textN = 0;
    let found: Node | null = null;
    for (const child of Array.from(parent.childNodes) as Node[]) {
      if (child.nodeType === ELEMENT_NODE) {
        elemN++;
        if (s % 2 === 0 && elemN * 2 === s) {
          found = child;
          break;
        }
      } else if (child.nodeType === TEXT_NODE) {
        textN++;
        if (s % 2 === 1 && textN * 2 - 1 === s) {
          found = child;
          break;
        }
      }
    }
    if (!found) return null;
    cur = found;
  }
  return cur;
}

/**
 * Best-effort resolve of a single-indirection range/point CFI, e.g.
 * `epubcfi(/6/18!/4/68/2,/3:189,/3:491)` or `epubcfi(/6/18!/4/68/2/3:189)`.
 * Returns null on anything outside that shape (nested indirection, temporal
 * offsets, malformed input) — callers should fall back to text search.
 */
export function resolveCfi(cfi: string, chapterRoot: Node): ResolvedCfi | null {
  const m = /^epubcfi\((.*)\)$/.exec(cfi.trim());
  if (!m) return null;
  const inner = m[1];
  const bang = inner.indexOf("!");
  if (bang < 0) return null;
  const spinePath = inner.slice(0, bang);
  const spineSteps = parsePathSteps(spinePath);
  if (!spineSteps || spineSteps.length < 2) return null;
  const spineStep = spineSteps[1]; // spineSteps[0] should be 6 (the <spine> element)
  const spineIndex = spineStep / 2 - 1;
  if (!Number.isInteger(spineIndex) || spineIndex < 0) return null;

  const rest = inner.slice(bang + 1);
  // Reject anything with a second indirection or temporal/spatial markers —
  // outside the scope of this resolver.
  if (rest.includes("!") || rest.includes("~") || rest.includes("@"))
    return null;

  const parts = rest.split(",");
  const parseLocal = (
    segment: string,
  ): { steps: number[]; offset: number } | null => {
    const om = /^(.*):(\d+)$/.exec(segment);
    const pathStr = om ? om[1] : segment;
    const offset = om ? parseInt(om[2], 10) : 0;
    const steps = pathStr ? parsePathSteps(pathStr) : [];
    if (steps === null) return null;
    return { steps, offset };
  };

  if (parts.length === 1) {
    const p = parseLocal(parts[0]);
    if (!p) return null;
    const node = resolveSteps(chapterRoot, p.steps);
    if (!node) return null;
    return {
      spineIndex,
      startNode: node,
      startOffset: p.offset,
      endNode: node,
      endOffset: p.offset,
    };
  }
  if (parts.length === 3) {
    const common = parseLocal(parts[0]);
    const startLoc = parseLocal(parts[1]);
    const endLoc = parseLocal(parts[2]);
    if (!common || !startLoc || !endLoc) return null;
    const startNode = resolveSteps(chapterRoot, [
      ...common.steps,
      ...startLoc.steps,
    ]);
    const endNode = resolveSteps(chapterRoot, [
      ...common.steps,
      ...endLoc.steps,
    ]);
    if (!startNode || !endNode) return null;
    return {
      spineIndex,
      startNode,
      startOffset: startLoc.offset,
      endNode,
      endOffset: endLoc.offset,
    };
  }
  return null;
}

/**
 * Find the first occurrence of `quote` in `root`'s text content and return it
 * as a DOM Range. This is the robust fallback used whenever strict CFI
 * resolution fails or isn't attempted (e.g. matching a reMarkable-side
 * highlight's text back into the chapter). `startAt` lets a caller skip past
 * already-matched occurrences.
 */
export function findTextRange(
  root: Node,
  quote: string,
  startAt = 0,
): { range: Range; index: number } | null {
  const doc = root.ownerDocument ?? (root as Document);
  const needle = quote.trim();
  if (!needle) return null;

  const walker = doc.createTreeWalker(
    root,
    // NodeFilter.SHOW_TEXT === 4, but that global may not exist in every scope
    4,
  );
  let pos = 0;
  const nodePositions: { node: Node; start: number; end: number }[] = [];
  for (let n = walker.nextNode(); n; n = walker.nextNode()) {
    const len = n.nodeValue?.length ?? 0;
    nodePositions.push({ node: n, start: pos, end: pos + len });
    pos += len;
  }
  const full = nodePositions.map((p) => p.node.nodeValue ?? "").join("");
  const idx = full.indexOf(needle, startAt);
  if (idx < 0) return null;

  const locate = (offset: number) => {
    for (const p of nodePositions) {
      if (offset >= p.start && offset <= p.end) {
        return { node: p.node, offset: offset - p.start };
      }
    }
    const last = nodePositions[nodePositions.length - 1];
    return last
      ? { node: last.node, offset: (last.node.nodeValue ?? "").length }
      : null;
  };
  const start = locate(idx);
  const end = locate(idx + needle.length);
  if (!start || !end) return null;

  const range = doc.createRange();
  range.setStart(start.node, start.offset);
  range.setEnd(end.node, end.offset);
  return { range, index: idx };
}
