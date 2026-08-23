// Bridges Zotero's CFI-addressed EPUB highlights and reMarkable's
// content-agnostic `.rm` GlyphRange highlights.
//
// Push (Zotero -> device): reMarkable renders an uploaded EPUB through its own
// undocumented, non-configurable-by-us layout engine, so we cannot compute the
// on-device pixel rectangles the PDF pipeline uses (see geometry.ts). Instead
// we bake each highlight directly into the chapter's XHTML as a styled
// `<mark>` — real content, so it survives reMarkable's own re-pagination —
// and the caller re-uploads the whole document (see sync/epubDocs.ts).
//
// Pull (device -> Zotero): reMarkable's GlyphRange highlight blocks embed the
// literal highlighted text (see rmlines.ts's `parseGlyph`), so we locate that
// text in the known chapter content and build a proper EPUB CFI selector.

import type { EpubDoc } from "./read";
import { getChapterDom, setChapterDom, spinePaths } from "./read";
import { buildRangeCfi, findTextRange, resolveCfi } from "./cfi";
import { log } from "../../utils/log";

export const RMS_MARK_ATTR = "data-rms-key";

export interface BakeTarget {
  /** Zotero annotation key, used to tag + later find/replace the <mark> */
  annotationKey: string;
  /** the annotation's `FragmentSelector.value`, e.g. "epubcfi(...)" */
  cfi: string;
  colorHex: string;
  underline?: boolean;
}

export interface BakeResult {
  baked: string[];
  failed: string[];
}

/** Remove any `<mark data-rms-key>` previously baked for the given keys. */
function unwrapExistingMarks(dom: Document, keys: Set<string>): boolean {
  let changed = false;
  const marks = Array.from(
    dom.querySelectorAll(`mark[${RMS_MARK_ATTR}]`),
  ) as Element[];
  for (const mark of marks) {
    const key = mark.getAttribute(RMS_MARK_ATTR);
    if (!key || !keys.has(key)) continue;
    const parent = mark.parentNode;
    if (!parent) continue;
    while (mark.firstChild) parent.insertBefore(mark.firstChild, mark);
    parent.removeChild(mark);
    parent.normalize();
    changed = true;
  }
  return changed;
}

/**
 * Bake the given Zotero highlight/underline annotations into their resolved
 * chapters as styled `<mark>` elements, mutating `doc`'s in-memory zip.
 * Chapters that need no change are left untouched. Call `repackage(doc)`
 * afterwards to get the bytes to re-upload.
 */
export async function bakeHighlights(
  doc: EpubDoc,
  targets: BakeTarget[],
): Promise<BakeResult> {
  const result: BakeResult = { baked: [], failed: [] };
  const paths = spinePaths(doc);
  const allKeys = new Set(targets.map((t) => t.annotationKey));

  for (let spineIndex = 0; spineIndex < paths.length; spineIndex++) {
    const got = await getChapterDom(doc, spineIndex);
    if (!got) continue;
    const { dom, path } = got;
    const root = dom.body as unknown as Node;
    if (!root) continue;

    let changed = unwrapExistingMarks(dom, allKeys);

    for (const target of targets) {
      const resolved = resolveCfi(target.cfi, root);
      if (!resolved || resolved.spineIndex !== spineIndex) continue;
      try {
        const range = dom.createRange();
        range.setStart(resolved.startNode, resolved.startOffset);
        range.setEnd(resolved.endNode, resolved.endOffset);
        const mark = dom.createElement("mark");
        mark.setAttribute(RMS_MARK_ATTR, target.annotationKey);
        const style = target.underline
          ? `text-decoration:underline;text-decoration-color:${target.colorHex};background:transparent`
          : `background-color:${target.colorHex}`;
        mark.setAttribute("style", style);
        try {
          range.surroundContents(mark);
        } catch {
          const frag = range.extractContents();
          mark.appendChild(frag);
          range.insertNode(mark);
        }
        result.baked.push(target.annotationKey);
        changed = true;
      } catch (e) {
        log(
          `epub bake: failed for ${target.annotationKey}: ${(e as Error).message}`,
        );
        result.failed.push(target.annotationKey);
      }
    }

    if (changed) setChapterDom(doc, path, dom);
  }

  // Anything never resolved to any chapter counts as failed.
  const handled = new Set([...result.baked, ...result.failed]);
  for (const t of targets) {
    if (!handled.has(t.annotationKey)) result.failed.push(t.annotationKey);
  }
  return result;
}

export interface DeviceHighlight {
  text: string;
  colorHex: string;
}

export interface MatchedHighlight extends DeviceHighlight {
  spineIndex: number;
  cfi: string;
  /** character offset of the match within the chapter's flattened text — used
   *  only to build a stable sortIndex, mirroring Zotero's own
   *  `"{section}|{charOffset}"` EPUB sortIndex convention. */
  charOffset: number;
}

/**
 * Locate each device-side highlight's text in the EPUB's own content (in
 * spine order) and build a CFI for it. Matching is purely text-based (no
 * device page geometry is available to us for EPUBs), so identical phrases
 * repeated in the book can occasionally resolve to the wrong occurrence —
 * an accepted limitation, consistent with this plugin's experimental status.
 */
export async function matchDeviceHighlights(
  doc: EpubDoc,
  highlights: DeviceHighlight[],
): Promise<MatchedHighlight[]> {
  const paths = spinePaths(doc);
  const cache = new Map<number, { dom: Document; path: string }>();
  const cursors = new Map<number, number>();
  const out: MatchedHighlight[] = [];

  for (const hl of highlights) {
    const text = hl.text.trim();
    if (!text) continue;
    let matched = false;
    for (let spineIndex = 0; spineIndex < paths.length; spineIndex++) {
      let entry = cache.get(spineIndex);
      if (!entry) {
        const got = await getChapterDom(doc, spineIndex);
        if (!got) continue;
        entry = got;
        cache.set(spineIndex, entry);
      }
      const root = entry.dom.body as unknown as Node;
      if (!root) continue;
      const cursor = cursors.get(spineIndex) ?? 0;
      const found = findTextRange(root, text, cursor);
      if (!found) continue;
      cursors.set(spineIndex, found.index + text.length);
      const cfi = buildRangeCfi(
        spineIndex,
        root,
        found.range.startContainer,
        found.range.startOffset,
        found.range.endContainer,
        found.range.endOffset,
      );
      out.push({ ...hl, spineIndex, cfi, charOffset: found.index });
      matched = true;
      break;
    }
    if (!matched) {
      log(`epub pull: no match for highlight text "${text.slice(0, 40)}…"`);
    }
  }
  return out;
}
