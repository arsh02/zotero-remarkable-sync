// Orchestrates the Zotero -> reMarkable push and the add/remove-from-sync
// actions. The pull side (annotations) is added in M2.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { fetchAnnotations } from "../remarkable/rmdoc";
import { readPdfPageSizes, pageSizeAt } from "../remarkable/geometry";
import {
  getRecord,
  setRecord,
  removeRecord,
  allRecords,
  type SyncRecord,
} from "./state";
import { applyAnnotations } from "./annotations";

const IO = globalThis as any;

export interface SyncSummary {
  pushed: number;
  skipped: number;
  failed: number;
  errors: string[];
}

/** Report progress to the UI: a status line and a 0-100 percentage. */
export type ProgressFn = (text: string, pct: number) => void;

export function getSyncTag(): string {
  return (getPref("syncTag") || "@remarkable").toString();
}

export function isItemSynced(item: Zotero.Item): boolean {
  return item.hasTag(getSyncTag());
}

/** Find tagged regular items in one library. */
async function findSyncItemsIn(libraryID: number): Promise<Zotero.Item[]> {
  const search = new Zotero.Search();
  // `libraryID` is typed read-only but is assignable on a fresh search.
  (search as any).libraryID = libraryID;
  search.addCondition("tag", "is", getSyncTag());
  const ids = await search.search();
  return Zotero.Items.get(ids).filter((it) => it.isRegularItem());
}

/** Find all regular (top-level) tagged items across every editable library. */
export async function findSyncItems(): Promise<Zotero.Item[]> {
  const libs = Zotero.Libraries.getAll().filter((l) => l.editable);
  const out: Zotero.Item[] = [];
  for (const lib of libs) {
    out.push(...(await findSyncItemsIn(lib.libraryID)));
  }
  return out;
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

  log("pushAll: start");
  const items = await findSyncItems();
  const attachments = pdfAttachmentsOf(items);
  log(`pushAll: ${attachments.length} PDF attachment(s) tagged`);
  if (attachments.length === 0) {
    progress?.("Nothing tagged to sync", 100);
    return summary;
  }

  progress?.("Authenticating with reMarkable…", 0);
  log("pushAll: getApi() …");
  const api = await client.getApi();
  log("pushAll: getApi() ok");

  progress?.("Resolving reMarkable folder…", 0);
  const folder = getPref("folder") || "";
  log(`pushAll: ensureFolder("${folder}") …`);
  const folderId = await client.ensureFolder(api, folder);
  log(`pushAll: folderId="${folderId}"`);

  // The device documents that currently exist — so we can re-upload (restore)
  // any that were deleted on the reMarkable. Zotero is the source of truth.
  const deviceDocIds = new Set((await api.listItems()).map((e) => e.id));

  let done = 0;
  for (const att of attachments) {
    const name = displayNameFor(att);
    const pct = Math.round((done / attachments.length) * 100);
    progress?.(`Uploading ${name}`, pct);
    try {
      const path = await att.getFilePathAsync();
      if (!path) {
        log(`pushAll: skip "${name}" (no file path)`);
        summary.skipped++;
        done++;
        continue;
      }
      const bytes: Uint8Array = await IO.IOUtils.read(path);
      const fileHash = await sha256Hex(bytes);

      const existing = await getRecord(att.key);
      const missingOnDevice = !!existing && !deviceDocIds.has(existing.docId);
      if (existing && existing.fileHash === fileHash && !missingOnDevice) {
        log(`pushAll: skip "${name}" (unchanged)`);
        summary.skipped++;
        done++;
        continue;
      }
      if (missingOnDevice) {
        log(`pushAll: "${name}" was removed from device — restoring`);
      }

      log(`pushAll: uploading "${name}" (${bytes.length} bytes) …`);
      const entry = await client.uploadPdf(api, name, bytes, folderId);
      // When restoring a deleted document, reset annotation tracking so every
      // Zotero annotation gets re-pushed onto the fresh document.
      const record: SyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        fileHash,
        visibleName: name,
        libraryID: att.libraryID,
        lastPushed: Date.now(),
        lastPulledVersion: missingOnDevice
          ? undefined
          : existing?.lastPulledVersion,
        annotationKeys: missingOnDevice ? [] : existing?.annotationKeys,
        pushedKeys: missingOnDevice ? [] : existing?.pushedKeys,
        pushedItems: missingOnDevice ? [] : existing?.pushedItems,
      };
      await setRecord(att.key, record);
      log(`pushAll: uploaded "${name}" -> ${entry.id}`);
      summary.pushed++;
    } catch (e) {
      log(`pushAll: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
    }
    done++;
  }
  log(
    `pushAll: done (pushed=${summary.pushed} skipped=${summary.skipped} failed=${summary.failed})`,
  );
  progress?.("", 100);
  return summary;
}

export interface PullSummary {
  updated: number;
  annotations: number;
  removed: number;
  failed: number;
  errors: string[];
}

/**
 * Pull annotations for every synced attachment whose reMarkable document has
 * changed since the last pull, writing them as native Zotero annotations.
 */
export async function pullAll(
  progress?: ProgressFn,
  opts: { force?: boolean } = {},
): Promise<PullSummary> {
  ensureNetworkGlobals();
  const summary: PullSummary = {
    updated: 0,
    annotations: 0,
    removed: 0,
    failed: 0,
    errors: [],
  };

  const records = await allRecords();
  const keys = Object.keys(records);
  log(`pullAll: start (${keys.length} synced record(s))`);
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  progress?.("Checking reMarkable for annotations…", 0);

  // Snapshot the cloud listing once, then look up each doc by id.
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey);
      if (!att) {
        done++;
        continue;
      }

      const entry = byId.get(rec.docId);
      if (!entry) {
        log(`pullAll: "${rec.visibleName}" not found on cloud (${rec.docId})`);
        done++;
        continue;
      }
      if (!opts.force && entry.hash === rec.lastPulledVersion) {
        log(`pullAll: "${rec.visibleName}" unchanged since last pull`);
        done++;
        continue; // unchanged since last pull
      }

      progress?.(`Pulling annotations: ${rec.visibleName}`, pct);
      log(`pullAll: fetching "${rec.visibleName}" (${rec.docId})`);
      const { pages } = await fetchAnnotations(api, rec.docId, entry.hash);

      const path = await (att as Zotero.Item).getFilePathAsync();
      const bytes: Uint8Array = path
        ? await IO.IOUtils.read(path)
        : new Uint8Array();
      const sizes = readPdfPageSizes(bytes);

      const result = await applyAnnotations(
        att as Zotero.Item,
        pages,
        sizes,
        rec.annotationKeys ?? [],
      );

      const updated: SyncRecord = {
        ...rec,
        lastPulledVersion: entry.hash,
        annotationKeys: result.keys,
      };
      await setRecord(attKey, updated);
      summary.updated++;
      summary.annotations += result.added;
      summary.removed += result.removed;
      log(
        `pullAll: "${rec.visibleName}" -> +${result.added} -${result.removed} annotation(s)`,
      );
    } catch (e) {
      log(`pullAll: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}

/**
 * Erase every annotation this plugin has created (across all synced
 * attachments) and reset the pull state, so the next pull recreates them. Used
 * to clean up after a geometry change or as a manual reset. Only removes our own
 * annotations — never the user's.
 */
export async function clearPulledAnnotations(): Promise<number> {
  let removed = 0;
  const records = await allRecords();
  for (const [attKey, rec] of Object.entries(records)) {
    const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
    for (const key of rec.annotationKeys ?? []) {
      const item = Zotero.Items.getByLibraryAndKey(libraryID, key);
      if (item) {
        try {
          await (item as Zotero.Item).eraseTx();
          removed++;
        } catch {
          /* already gone */
        }
      }
    }
    await setRecord(attKey, {
      ...rec,
      annotationKeys: [],
      pushedKeys: [],
      pushedItems: [],
      lastPulledVersion: undefined,
    });
  }
  log(`clearPulledAnnotations: removed ${removed}`);
  return removed;
}

/**
 * Remove the reMarkable documents for the given attachment keys and forget them.
 * Used when items are deleted/trashed in Zotero.
 */
export async function unsyncByKeys(attKeys: string[]): Promise<void> {
  const want = new Set(attKeys);
  const records = await allRecords();
  const hits = Object.keys(records).filter((k) => want.has(k));
  if (hits.length === 0) return;

  let api: Awaited<ReturnType<typeof client.getApi>> | null = null;
  if (client.isConnected()) {
    try {
      ensureNetworkGlobals();
      api = await client.getApi();
    } catch {
      api = null;
    }
  }
  for (const attKey of hits) {
    const rec = records[attKey];
    if (api) {
      try {
        const entry = await client.findById(api, rec.docId);
        if (entry) await client.deleteDoc(api, entry.hash);
        log(`unsync: deleted "${rec.visibleName}" from device`);
      } catch (e) {
        log(`unsync: delete failed for "${rec.visibleName}": ${errMsg(e)}`);
      }
    }
    await removeRecord(attKey);
  }
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
