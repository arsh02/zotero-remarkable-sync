// mammoth ships no bundled typings, and its Node entry point pulls in
// Buffer/Stream which don't exist in Zotero's sandbox. We import the browser
// build (`mammoth/mammoth.browser`) instead, which only needs ArrayBuffer +
// Promise; this shim covers the small surface we actually use.
declare module "mammoth/mammoth.browser" {
  export interface MammothImage {
    contentType: string;
    readAsBase64String(): Promise<string>;
    readAsArrayBuffer(): Promise<ArrayBuffer>;
  }

  export interface MammothMessage {
    type: "warning" | "error";
    message: string;
  }

  export interface ConvertToHtmlResult {
    value: string;
    messages: MammothMessage[];
  }

  export interface ConvertImageOptions {
    (image: MammothImage): Promise<Record<string, string>>;
  }

  export const images: {
    imgElement: (
      fn: (image: MammothImage) => Promise<Record<string, string>>,
    ) => ConvertImageOptions;
  };

  export function convertToHtml(
    input: { arrayBuffer: ArrayBuffer },
    options?: {
      convertImage?: ConvertImageOptions;
      styleMap?: string | string[];
      includeDefaultStyleMap?: boolean;
      includeEmbeddedStyleMap?: boolean;
      ignoreEmptyParagraphs?: boolean;
      idPrefix?: string;
    },
  ): Promise<ConvertToHtmlResult>;
}
