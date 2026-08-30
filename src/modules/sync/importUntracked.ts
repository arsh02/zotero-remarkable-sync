// Import PDFs that already live on the reMarkable (dropped via the web app,
// another tool, etc.) into Zotero and wire them into the existing sync
// records so later push/pull treats them like any plugin-uploaded document.
//
// Manual only — the Tools-menu command in ui.ts is the sole caller. Regular
// sync never scans for untracked files.

import type { Entry, Tag } from "rmapi-js";
import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import { sha256Hex } from "../../utils/hash";
import { writeTempFile, removeTempFile } from "../../utils/tempFile";
import * as client from "../remarkable/client";
import { allRecords, setRecord, type SyncRecord } from "./state";
import {
  IDENTITY_PREFIX,
  identityTag,
  fingerprintTag,
  tagNames,
  reconcileDuplicates,
} from "./dedupe";

/** Same shape as `engine.ProgressFn` — kept local to avoid a cycle. */
type ProgressFn = (text: string, pct: number) => void;

function getSyncTag(): string {
  return (getPref("syncTag") || "@remarkable").toString();
}

/** Collection new imports land in (created in the user library if missing). */
export const IMPORT_COLLECTION_NAME = "reMarkable Imports";

export interface UntrackedCandidate {
  id: string;
  hash: string;
  visibleName: string;
  tags: Entry["tags"];
}

export interface ImportSummary {
  imported: number;
  failed: number;
  errors: string[];
}

/**
 * True when `entry` is a PDF sitting directly in `folderId` that no machine
 * has claimed (no local sync record, no `zrs-id-*` tag). Pure — unit-tested
 * without mocking Zotero or the cloud.
 */
export function isUntrackedPdf(
  entry: Entry,
  folderId: string,
  trackedDocIds: Set<string>,
): boolean {
  if (entry.type !== "DocumentType") return false;
  if (entry.fileType !== "pdf") return false;
  if ((entry.parent ?? "") !== folderId) return false;
  if (trackedDocIds.has(entry.id)) return false;
  if (tagNames(entry).some((t) => t.startsWith(IDENTITY_PREFIX))) {
    return false;
  }
  return true;
}

/** Scan the configured sync folder for PDFs this plugin has never tracked. */
export async function scanUntrackedPdfs(): Promise<UntrackedCandidate[]> {
  ensureNetworkGlobals();
  const api = await client.getApi();
  const folder = getPref("folder") || "";
  const folderId = await client.ensureFolder(api, folder);
  const remote = await reconcileDuplicates(api, await api.listItems(true));
  const records = await allRecords();
  const trackedDocIds = new Set(Object.values(records).map((r) => r.docId));
  return remote
    .filter((e) => isUntrackedPdf(e, folderId, trackedDocIds))
    .map((e) => ({
      id: e.id,
      hash: e.hash,
      visibleName: e.visibleName,
      tags: e.tags,
    }));
}

/**
 * Download each candidate, create a Zotero document + PDF attachment, tag
 * the parent for future sync, and stamp `zrs-id-`/`zrs-fp-` on the cloud
 * document so other machines adopt it instead of re-uploading.
 */
export async function importCandidates(
  candidates: UntrackedCandidate[],
  progress?: ProgressFn,
): Promise<ImportSummary> {
  ensureNetworkGlobals();
  const summary: ImportSummary = { imported: 0, failed: 0, errors: [] };
  if (candidates.length === 0) return summary;

  const api = await client.getApi();
  const collection = await ensureImportsCollection();
  const libraryID = Zotero.Libraries.userLibraryID;

  let done = 0;
  for (const candidate of candidates) {
    const name = candidate.visibleName || "Untitled";
    const pct = Math.round((done / candidates.length) * 100);
    progress?.(`Importing ${name}`, pct);
    let parent: Zotero.Item | null = null;
    let tempPath: string | null = null;
    let recorded = false;
    try {
      const bytes = await api.getPdf(candidate.id, candidate.hash);
      const fileHash = await sha256Hex(bytes);
      const base = pdfBaseName(name);
      tempPath = await writeTempFile(`${base}.pdf`, bytes);

      parent = new Zotero.Item("document");
      parent.libraryID = libraryID;
      parent.setField("title", name);
      await parent.saveTx();

      const att = await Zotero.Attachments.importFromFile({
        file: tempPath,
        libraryID,
        parentItemID: parent.id,
        fileBaseName: base,
        contentType: "application/pdf",
      });

      parent.addTag(getSyncTag(), 0);
      parent.addToCollection(collection.id);
      await parent.saveTx();

      // Record first so this machine will not re-import even if tagging
      // the cloud document fails.
      const record: SyncRecord = {
        docId: candidate.id,
        docHash: candidate.hash,
        fileHash,
        kind: "pdf",
        visibleName: name,
        libraryID: att.libraryID,
        lastPushed: Date.now(),
        lastPulledVersion: undefined,
        annotationKeys: [],
      };
      await setRecord(att.key, record);
      recorded = true;
      log(
        `importCandidates: imported "${name}" as ${att.key} -> ${candidate.id}`,
      );

      try {
        const tags = mergeTags(candidate.tags, [
          identityTag(att.libraryID, att.key),
          fingerprintTag(fileHash),
        ]);
        const newHash = await client.updateDocTags(api, candidate.hash, tags);
        await setRecord(att.key, { ...record, docHash: newHash });
      } catch (e) {
        log(`importCandidates: tag failed for "${name}": ${errMsg(e)}`);
      }

      summary.imported++;
    } catch (e) {
      log(`importCandidates: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
      if (parent && !recorded) {
        try {
          await parent.eraseTx();
        } catch {
          /* already gone */
        }
      }
    } finally {
      if (tempPath) await removeTempFile(tempPath);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}

function pdfBaseName(visibleName: string): string {
  return visibleName.replace(/\.pdf$/i, "").trim() || "Document";
}

/** Find or create the top-level "reMarkable Imports" collection. */
async function ensureImportsCollection(): Promise<Zotero.Collection> {
  const libraryID = Zotero.Libraries.userLibraryID;
  const existing = Zotero.Collections.getByLibrary(libraryID).find(
    (c) => c.name === IMPORT_COLLECTION_NAME && !c.parentID,
  );
  if (existing) return existing;
  const col = new Zotero.Collection({
    name: IMPORT_COLLECTION_NAME,
    libraryID,
  });
  await col.saveTx();
  return col;
}

/** Existing cloud tags plus extra names, as rmapi-js `Tag` objects. */
function mergeTags(existing: Entry["tags"], extra: string[]): Tag[] {
  const now = Date.now();
  const out: Tag[] = [];
  const seen = new Set<string>();
  for (const t of existing ?? []) {
    const name = typeof t === "string" ? t : t.name;
    if (seen.has(name)) continue;
    seen.add(name);
    out.push(typeof t === "string" ? { name, timestamp: now } : t);
  }
  for (const name of extra) {
    if (seen.has(name)) continue;
    seen.add(name);
    out.push({ name, timestamp: now });
  }
  return out;
}
