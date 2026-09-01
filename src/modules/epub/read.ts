// Open a generated companion EPUB well enough to: walk its spine in order, get
// each chapter's parsed XHTML DOM (for CFI resolution / highlight baking), and
// re-serialize an edited chapter back into the same zip for re-upload.
// Intentionally only understands the common, spec-typical EPUB2/3 shapes —
// falls back to "give up on this chapter" rather than guessing on anything
// unusual, since callers already have a text-search fallback for matching.

import JSZip from "jszip";
import { getDOMParser, getXMLSerializer } from "../../utils/globals";

export interface ManifestItem {
  href: string;
  mediaType: string;
}

export interface EpubDoc {
  zip: JSZip;
  opfPath: string;
  opfDir: string;
  manifest: Map<string, ManifestItem>;
  /** manifest ids in spine (reading) order */
  spineIds: string[];
  title?: string;
}

function dirOf(path: string): string {
  const i = path.lastIndexOf("/");
  return i >= 0 ? path.slice(0, i + 1) : "";
}

/** Resolve a relative href against a base directory, handling "./" and "../". */
export function resolvePath(baseDir: string, href: string): string {
  const clean = href.split("#")[0]; // drop any fragment
  const parts = (baseDir + clean).split("/");
  const out: string[] = [];
  for (const p of parts) {
    if (p === "" || p === ".") continue;
    if (p === "..") out.pop();
    else out.push(p);
  }
  return out.join("/");
}

function parseXml(
  text: string,
  mimeType: "text/xml" | "application/xhtml+xml",
): Document {
  const Parser = getDOMParser();
  const doc = new Parser().parseFromString(text, mimeType);
  if (doc.documentElement?.nodeName === "parsererror") {
    // Real-world EPUB chapters are sometimes not quite well-formed XHTML —
    // fall back to a lenient HTML parse so we can still search/read text
    // (baking a highlight into a malformed chapter is best-effort anyway).
    return new Parser().parseFromString(text, "text/html");
  }
  return doc;
}

async function readZipText(zip: JSZip, path: string): Promise<string> {
  const entry = zip.file(path);
  if (!entry) throw new Error(`EPUB: missing entry "${path}"`);
  return entry.async("string");
}

/** Parse the container/OPF structure of an EPUB. Does not parse chapters yet. */
export async function openEpub(bytes: Uint8Array): Promise<EpubDoc> {
  const zip = await JSZip.loadAsync(bytes);
  const containerXml = await readZipText(zip, "META-INF/container.xml");
  const containerDoc = parseXml(containerXml, "text/xml");
  const rootfile = containerDoc.getElementsByTagName("rootfile")[0];
  const opfPath = rootfile?.getAttribute("full-path");
  if (!opfPath) throw new Error("EPUB: no rootfile in META-INF/container.xml");

  const opfXml = await readZipText(zip, opfPath);
  const opfDoc = parseXml(opfXml, "text/xml");
  const opfDir = dirOf(opfPath);

  const manifest = new Map<string, ManifestItem>();
  const manifestEl = opfDoc.getElementsByTagName("manifest")[0];
  if (manifestEl) {
    for (const item of Array.from(
      manifestEl.getElementsByTagName("item"),
    ) as Element[]) {
      const id = item.getAttribute("id");
      const href = item.getAttribute("href");
      if (!id || !href) continue;
      manifest.set(id, {
        href: resolvePath(opfDir, href),
        mediaType: item.getAttribute("media-type") ?? "application/xhtml+xml",
      });
    }
  }

  const spineIds: string[] = [];
  const spineEl = opfDoc.getElementsByTagName("spine")[0];
  if (spineEl) {
    for (const ref of Array.from(
      spineEl.getElementsByTagName("itemref"),
    ) as Element[]) {
      const idref = ref.getAttribute("idref");
      if (idref && manifest.has(idref)) spineIds.push(idref);
    }
  }

  const titleNodes = opfDoc.getElementsByTagNameNS(
    "http://purl.org/dc/elements/1.1/",
    "title",
  );
  const title = titleNodes[0]?.textContent?.trim() || undefined;

  return { zip, opfPath, opfDir, manifest, spineIds, title };
}

/** Ordered list of chapter file paths, one per spine entry. */
export function spinePaths(doc: EpubDoc): string[] {
  return doc.spineIds
    .map((id) => doc.manifest.get(id))
    .filter((m): m is ManifestItem => !!m)
    .map((m) => m.href);
}

/** Parse one spine chapter's XHTML into a DOM document. */
export async function getChapterDom(
  doc: EpubDoc,
  spineIndex: number,
): Promise<{ dom: Document; path: string } | null> {
  const paths = spinePaths(doc);
  const path = paths[spineIndex];
  if (!path || !doc.zip.file(path)) return null;
  const text = await readZipText(doc.zip, path);
  return { dom: parseXml(text, "application/xhtml+xml"), path };
}

/** Plain text content of one spine chapter (for text-quote matching). */
export async function getChapterText(
  doc: EpubDoc,
  spineIndex: number,
): Promise<string> {
  const got = await getChapterDom(doc, spineIndex);
  return got?.dom.body?.textContent ?? "";
}

/** Replace a chapter's file content in the zip with a serialized DOM. */
export function setChapterDom(doc: EpubDoc, path: string, dom: Document): void {
  const Serializer = getXMLSerializer();
  const xml = new Serializer().serializeToString(dom);
  doc.zip.file(path, xml);
}

/** Re-generate the EPUB zip bytes after any in-place chapter edits. */
export async function repackage(doc: EpubDoc): Promise<Uint8Array> {
  return doc.zip.generateAsync({ type: "uint8array" });
}
