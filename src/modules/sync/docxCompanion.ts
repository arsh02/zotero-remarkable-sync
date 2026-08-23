// reMarkable's cloud API only accepts PDF/EPUB — there is no native way to
// sync a .docx. Instead, we auto-generate a read-only EPUB "companion" child
// attachment next to the .docx (via mammoth, see convert/docx.ts) and sync
// *that*; the original .docx is left completely untouched. The companion is
// regenerated only when the source .docx's bytes change.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import { sha256Hex } from "../../utils/hash";
import { docxToChapters } from "../convert/docx";
import { buildEpub } from "../epub/build";
import {
  getRecord,
  getCompanionKey,
  setCompanionKey,
  removeCompanionKey,
} from "./state";

const IO = globalThis as any;

function epubTitleFor(docxAtt: Zotero.Item): string {
  const parent = docxAtt.parentItem;
  const base =
    parent?.getDisplayTitle() || docxAtt.attachmentFilename || "Document";
  return base.replace(/\.docx$/i, "").trim() || "Document";
}

async function writeTempFile(name: string, bytes: Uint8Array): Promise<string> {
  const dir = Zotero.getTempDirectory().path;
  const safeName = name.replace(/[\\/:*?"<>|]/g, "_");
  const path = IO.PathUtils.join(dir, `rms-${Date.now()}-${safeName}`);
  await IO.IOUtils.write(path, bytes);
  return path;
}

/** Find an already-generated companion attachment without creating one. */
export async function findCompanion(
  docxAtt: Zotero.Item,
): Promise<Zotero.Item | null> {
  const key = await getCompanionKey(docxAtt.key);
  if (!key) return null;
  const item = Zotero.Items.getByLibraryAndKey(docxAtt.libraryID, key);
  return (item as Zotero.Item) || null;
}

/**
 * Ensure a `.epub` child attachment exists next to `docxAtt`, generated from
 * the docx's current content. Regenerates (deleting the old companion, which
 * also drops any annotations made directly on it — they'd be positioned
 * against stale content anyway) only when the source .docx bytes changed
 * since the last generation. Returns null if the "convertDocx" preference is
 * off, or if reading/converting the source fails.
 */
export async function ensureCompanion(
  docxAtt: Zotero.Item,
): Promise<Zotero.Item | null> {
  if (getPref("convertDocx") === false) return null;
  ensureNetworkGlobals(); // sha256Hex below needs crypto.subtle

  const path = await docxAtt.getFilePathAsync();
  if (!path) return null;

  let bytes: Uint8Array;
  try {
    bytes = await IO.IOUtils.read(path);
  } catch (e) {
    log(
      `docxCompanion: cannot read "${docxAtt.attachmentFilename}": ${errMsg(e)}`,
    );
    return null;
  }
  const hash = await sha256Hex(bytes);

  const existing = await findCompanion(docxAtt);
  if (existing) {
    const rec = await getRecord(existing.key);
    if (rec?.fileHash === hash) return existing; // source unchanged
  }

  const title = epubTitleFor(docxAtt);
  let epubBytes: Uint8Array;
  try {
    const { chapters, images } = await docxToChapters(bytes);
    epubBytes = await buildEpub(chapters, images, {
      title,
      identifier: `urn:uuid:${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`,
    });
  } catch (e) {
    log(
      `docxCompanion: conversion failed for "${docxAtt.attachmentFilename}": ${errMsg(e)}`,
    );
    return null;
  }

  const tempPath = await writeTempFile(`${title}.epub`, epubBytes);
  try {
    if (existing) {
      try {
        await existing.eraseTx();
      } catch {
        /* already gone */
      }
      await removeCompanionKey(docxAtt.key);
    }
    const parent = docxAtt.parentItem;
    const created = await Zotero.Attachments.importFromFile({
      file: tempPath,
      libraryID: docxAtt.libraryID,
      parentItemID: parent?.id,
      fileBaseName: title,
      contentType: "application/epub+zip",
    });
    await setCompanionKey(docxAtt.key, created.key);
    log(
      `docxCompanion: generated "${title}.epub" for "${docxAtt.attachmentFilename}"`,
    );
    return created as Zotero.Item;
  } finally {
    try {
      await IO.IOUtils.remove(tempPath, { ignoreAbsent: true });
    } catch {
      /* best effort cleanup */
    }
  }
}

export async function removeCompanionMapping(
  docxAtt: Zotero.Item,
): Promise<void> {
  await removeCompanionKey(docxAtt.key);
}
