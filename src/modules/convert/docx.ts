// Converts a .docx file's content to HTML via mammoth's browser build (no
// Node Buffer/Stream dependency — see typings/mammoth-browser.d.ts), pulling
// embedded images out into separate EpubImage entries instead of leaving them
// inline as base64 (keeps the generated EPUB's chapter markup lean and lets
// reMarkable cache/paginate images normally).

import {
  convertToHtml,
  images as mammothImages,
} from "mammoth/mammoth.browser";
import type { EpubChapter, EpubImage } from "../epub/build";

export interface DocxConversion {
  chapters: EpubChapter[];
  images: EpubImage[];
}

function extOf(contentType: string): string {
  if (contentType.includes("png")) return "png";
  if (contentType.includes("gif")) return "gif";
  if (contentType.includes("bmp")) return "bmp";
  if (contentType.includes("svg")) return "svg";
  return "jpg";
}

const B64_CHARS =
  "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

/** Manual base64 decode — avoids relying on the ambient `atob` global, which
 *  (like several other browser globals) isn't reliably present in Zotero's
 *  plugin sandbox. */
function base64ToBytes(b64: string): Uint8Array {
  const clean = b64.replace(/[^A-Za-z0-9+/]/g, "");
  const out = new Uint8Array(Math.floor((clean.length * 3) / 4));
  let o = 0;
  for (let i = 0; i < clean.length; i += 4) {
    const c0 = B64_CHARS.indexOf(clean[i]);
    const c1 = B64_CHARS.indexOf(clean[i + 1]);
    const c2 =
      clean[i + 2] !== undefined ? B64_CHARS.indexOf(clean[i + 2]) : -1;
    const c3 =
      clean[i + 3] !== undefined ? B64_CHARS.indexOf(clean[i + 3]) : -1;
    out[o++] = (c0 << 2) | (c1 >> 4);
    if (c2 >= 0) out[o++] = ((c1 & 0xf) << 4) | (c2 >> 2);
    if (c3 >= 0) out[o++] = ((c2 & 0x3) << 6) | c3;
  }
  return out.subarray(0, o);
}

/** Convert a .docx file's bytes into a single-chapter EPUB body + images. */
export async function docxToChapters(
  bytes: Uint8Array,
): Promise<DocxConversion> {
  const images: EpubImage[] = [];
  let counter = 0;

  // Copy so the result is a real ArrayBuffer (not SharedArrayBuffer).
  const arrayBuffer = Uint8Array.from(bytes).buffer;

  const result = await convertToHtml(
    { arrayBuffer },
    {
      convertImage: mammothImages.imgElement(async (image) => {
        const base64 = await image.readAsBase64String();
        const name = `docx-img-${counter++}.${extOf(image.contentType)}`;
        images.push({
          name,
          mediaType: image.contentType,
          bytes: base64ToBytes(base64),
        });
        return { src: `images/${name}` };
      }),
    },
  );

  for (const msg of result.messages) {
    if (msg.type === "error") {
      throw new Error(`docx conversion: ${msg.message}`);
    }
  }

  return {
    chapters: [{ id: "chapter-1", title: "Document", bodyHtml: result.value }],
    images,
  };
}
