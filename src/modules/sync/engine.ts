// Orchestrates the Zotero -> reMarkable push and the add/remove-from-sync
// actions. The pull side (annotations) is added in M2.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import * as client from "../remarkable/client";
import { fetchAnnotations } from "../remarkable/rmdoc";
import { readPdfPageSize } from "../remarkable/geometry";
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
      if (existing && existing.fileHash === fileHash) {
        log(`pushAll: skip "${name}" (unchanged)`);
        summary.skipped++;
        done++;
        continue;
      }

      log(`pushAll: uploading "${name}" (${bytes.length} bytes) …`);
      const entry = await client.uploadPdf(api, name, bytes, folderId);
      const record: SyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        fileHash,
        visibleName: name,
        libraryID: att.libraryID,
        lastPushed: Date.now(),
        lastPulledVersion: existing?.lastPulledVersion,
        annotationKeys: existing?.annotationKeys,
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
  failed: number;
  errors: string[];
}

/**
 * Pull annotations for every synced attachment whose reMarkable document has
 * changed since the last pull, writing them as native Zotero annotations.
 */
export async function pullAll(progress?: ProgressFn): Promise<PullSummary> {
  ensureNetworkGlobals();
  const summary: PullSummary = {
    updated: 0,
    annotations: 0,
    failed: 0,
    errors: [],
  };

  const records = await allRecords();
  const keys = Object.keys(records);
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  progress?.("Checking reMarkable for annotations…", 0);
  log(`pullAll: ${keys.length} synced attachment(s)`);

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
        done++;
        continue;
      }
      if (entry.hash === rec.lastPulledVersion) {
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
      const size = readPdfPageSize(bytes);

      const newKeys = await applyAnnotations(
        att as Zotero.Item,
        pages,
        size,
        rec.annotationKeys ?? [],
      );

      const updated: SyncRecord = {
        ...rec,
        lastPulledVersion: entry.hash,
        annotationKeys: newKeys,
      };
      await setRecord(attKey, updated);
      summary.updated++;
      summary.annotations += newKeys.length;
      log(`pullAll: "${rec.visibleName}" -> ${newKeys.length} annotation(s)`);
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
