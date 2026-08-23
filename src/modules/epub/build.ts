// Minimal EPUB3 container builder — packages DOCX-derived HTML and Zotero
// note content into documents reMarkable can open natively. Deliberately
// small: one XHTML "chapter" per entry, inline images, no styling beyond
// what's already inlined in the HTML. Not a general-purpose EPUB authoring
// library — just enough to round-trip through reMarkable and back into
// Zotero's own EPUB reader.

import JSZip from "jszip";

export interface EpubImage {
  /** filename inside OEBPS/images/, e.g. "img-0.png" */
  name: string;
  mediaType: string;
  bytes: Uint8Array;
}

export interface EpubChapter {
  /** stable id, used as the manifest/spine id and filename stem */
  id: string;
  title: string;
  /** inner XHTML body markup (no surrounding <html>/<body>) */
  bodyHtml: string;
}

export interface EpubMeta {
  title: string;
  /** e.g. "urn:uuid:<uuid>" — must be stable across re-uploads of the same doc */
  identifier: string;
  author?: string;
  language?: string;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

export function chapterFile(id: string): string {
  return `${id}.xhtml`;
}

function chapterXhtml(title: string, bodyHtml: string): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8" /><title>${escapeXml(title)}</title></head>
<body>
${bodyHtml}
</body>
</html>
`;
}

function containerXml(): string {
  return `<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
`;
}

function navXhtml(chapters: EpubChapter[]): string {
  const items = chapters
    .map(
      (c) =>
        `      <li><a href="${chapterFile(c.id)}">${escapeXml(c.title)}</a></li>`,
    )
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops">
<head><meta charset="utf-8" /><title>Contents</title></head>
<body>
  <nav epub:type="toc" id="toc">
    <ol>
${items}
    </ol>
  </nav>
</body>
</html>
`;
}

function contentOpf(
  meta: EpubMeta,
  chapters: EpubChapter[],
  images: EpubImage[],
): string {
  const manifestChapters = chapters
    .map(
      (c) =>
        `    <item id="${c.id}" href="${chapterFile(c.id)}" media-type="application/xhtml+xml"/>`,
    )
    .join("\n");
  const manifestImages = images
    .map(
      (img, i) =>
        `    <item id="img-${i}" href="images/${img.name}" media-type="${img.mediaType}"/>`,
    )
    .join("\n");
  const spine = chapters
    .map((c) => `    <itemref idref="${c.id}"/>`)
    .join("\n");
  const now = new Date().toISOString().replace(/\.\d+Z$/, "Z");
  return `<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="pub-id">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="pub-id">${escapeXml(meta.identifier)}</dc:identifier>
    <dc:title>${escapeXml(meta.title)}</dc:title>
    <dc:language>${meta.language ?? "en"}</dc:language>
${meta.author ? `    <dc:creator>${escapeXml(meta.author)}</dc:creator>\n` : ""}    <meta property="dcterms:modified">${now}</meta>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
${manifestChapters}
${manifestImages}
  </manifest>
  <spine>
${spine}
  </spine>
</package>
`;
}

/** Build a minimal, valid EPUB3 package from HTML chapters (+ optional images). */
export async function buildEpub(
  chapters: EpubChapter[],
  images: EpubImage[],
  meta: EpubMeta,
): Promise<Uint8Array> {
  const zip = new JSZip();
  // The OCF "mimetype" file must be the first entry, stored uncompressed.
  zip.file("mimetype", "application/epub+zip", { compression: "STORE" });
  zip.folder("META-INF")!.file("container.xml", containerXml());
  const oebps = zip.folder("OEBPS")!;
  oebps.file("content.opf", contentOpf(meta, chapters, images));
  oebps.file("nav.xhtml", navXhtml(chapters));
  for (const c of chapters) {
    oebps.file(chapterFile(c.id), chapterXhtml(c.title, c.bodyHtml));
  }
  if (images.length) {
    const imgDir = oebps.folder("images")!;
    for (const img of images) imgDir.file(img.name, img.bytes);
  }
  return zip.generateAsync({ type: "uint8array" });
}
