// Orchestrates the Zotero -> reMarkable push and the add/remove-from-sync
// actions. The pull side (annotations) is added in M2.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import * as client from "../remarkable/client";
import { getRecord, setRecord, removeRecord, type SyncRecord } from "./state";

const IO = globalThis as any;

export interface SyncSummary {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

export type ProgressFn = (done: number, total: number, label: string) => void;

export function getSyncTag(): string {
  return (getPref("syncTag") || "@remarkable").toString();
}

export function isItemSynced(item: Zotero.Item): boolean {
  return item.hasTag(getSyncTag());
}

/** Find all regular (top-level) items carrying the sync tag. */
export async function findSyncItems(
  libraryID: number = Zotero.Libraries.userLibraryID,
): Promise<Zotero.Item[]> {
  const search = new Zotero.Search();
  // `libraryID` is typed read-only but is assignable on a fresh search.
  (search as any).libraryID = libraryID;
  search.addCondition("tag", "is", getSyncTag());
  const ids = await search.search();
  return Zotero.Items.get(ids).filter((it) => it.isRegularItem());
}

/** Collect the PDF attachments of the given regular items. */
function pdfAttachmentsOf(items: Zotero.Item[]): Zotero.Item[] {
  const out: Zotero.Item[] = [];
  for (const item of items) {
    const attIDs = item.getAttachments();
    for (const att of Zotero.Items.get(attIDs)) {
      if (att.isPDFAttachment()) out.push(att);
    }
  }
  return out;
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as any).crypto.subtle;
  const digest: ArrayBuffer = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

function displayNameFor(att: Zotero.Item): string {
  const parent = att.parentItem;
  const title = parent ? parent.getDisplayTitle() : "";
  return (title || att.attachmentFilename || "Untitled").trim();
}

/**
 * Push every tagged item's PDF attachment to the configured reMarkable folder.
 * Unchanged files (matching the recorded sha-256) are skipped.
 */
export async function pushAll(progress?: ProgressFn): Promise<SyncSummary> {
  ensureNetworkGlobals();
  const summary: SyncSummary = {
    pushed: 0,
    skipped: 0,
    failed: 0,
    errors: [],
  };

  const items = await findSyncItems();
  const attachments = pdfAttachmentsOf(items);
  if (attachments.length === 0) return summary;

  const api = await client.getApi();
  const folderId = await client.ensureFolder(api, getPref("folder") || "");

  let done = 0;
  for (const att of attachments) {
    const name = displayNameFor(att);
    progress?.(done, attachments.length, name);
    try {
      const path = await att.getFilePathAsync();
      if (!path) {
        summary.skipped++;
        done++;
        continue;
      }
      const bytes: Uint8Array = await IO.IOUtils.read(path);
      const fileHash = await sha256Hex(bytes);

      const existing = await getRecord(att.key);
      if (existing && existing.fileHash === fileHash) {
        summary.skipped++;
        done++;
        continue;
      }

      const entry = await client.uploadPdf(api, name, bytes, folderId);
      const record: SyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        fileHash,
        visibleName: name,
        lastPushed: Date.now(),
        lastPulledVersion: existing?.lastPulledVersion,
      };
      await setRecord(att.key, record);
      summary.pushed++;
    } catch (e) {
      summary.failed++;
      summary.errors.push(`${name}: ${(e as Error).message ?? e}`);
    }
    done++;
  }
  progress?.(done, attachments.length, "");
  return summary;
}

/** Tag the given regular items so they are included in sync. */
export async function addToSync(items: Zotero.Item[]): Promise<void> {
  const tag = getSyncTag();
  for (const item of items) {
    if (!item.isRegularItem() || item.hasTag(tag)) continue;
    item.addTag(tag, 0);
    await item.saveTx();
  }
}

/**
 * Remove the sync tag from the given items. If `deleteOnUnsync` is set, also
 * delete the corresponding documents from the reMarkable cloud.
 */
export async function removeFromSync(items: Zotero.Item[]): Promise<void> {
  const tag = getSyncTag();
  const deleteRemote = !!getPref("deleteOnUnsync");

  let api: Awaited<ReturnType<typeof client.getApi>> | null = null;
  if (deleteRemote && client.isConnected()) {
    ensureNetworkGlobals();
    api = await client.getApi();
  }

  for (const item of items) {
    if (!item.isRegularItem()) continue;
    if (item.hasTag(tag)) {
      item.removeTag(tag);
      await item.saveTx();
    }
    for (const att of Zotero.Items.get(item.getAttachments())) {
      if (!att.isPDFAttachment()) continue;
      const record = await getRecord(att.key);
      if (record && api) {
        try {
          const entry = await client.findById(api, record.docId);
          if (entry) await client.deleteDoc(api, entry.hash);
        } catch {
          // Best effort: leave the remote doc if deletion fails.
        }
      }
      await removeRecord(att.key);
    }
  }
}
