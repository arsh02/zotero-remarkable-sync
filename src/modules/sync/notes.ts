// Push Zotero notes (standalone or child) to reMarkable as their own
// documents. Tagged the same way as everything else (the sync tag), but
// notes have no annotation layer, so this is one-way and file-level only:
// re-push whenever the note's content changes, never pull anything back.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import { sha256Hex } from "../../utils/hash";
import * as client from "../remarkable/client";
import { buildEpub } from "../epub/build";
import {
  getNoteRecord,
  setNoteRecord,
  removeNoteRecord,
  allNoteRecords,
  type NoteSyncRecord,
} from "./state";
import {
  getSyncTag,
  stopSyncNote,
  type ProgressFn,
  type SyncSummary,
} from "./engine";

/** Find tagged note items (standalone or child) in one library. */
async function findSyncNotesIn(libraryID: number): Promise<Zotero.Item[]> {
  const search = new Zotero.Search();
  (search as any).libraryID = libraryID;
  search.addCondition("tag", "is", getSyncTag());
  const ids = await search.search();
  return Zotero.Items.get(ids).filter((it) => it.isNote());
}

/** Find every tagged note across all editable libraries. */
export async function findSyncNotes(): Promise<Zotero.Item[]> {
  const libs = Zotero.Libraries.getAll().filter((l) => l.editable);
  const out: Zotero.Item[] = [];
  for (const lib of libs) out.push(...(await findSyncNotesIn(lib.libraryID)));
  return out;
}

function noteTitleFor(note: Zotero.Item): string {
  const anyNote = note as any;
  const title =
    typeof anyNote.getNoteTitle === "function"
      ? anyNote.getNoteTitle()?.trim()
      : "";
  return title || "Note";
}

async function utf8Hash(text: string): Promise<string> {
  const enc = (globalThis as any).TextEncoder
    ? new (globalThis as any).TextEncoder().encode(text)
    : Uint8Array.from(text, (c: string) => c.charCodeAt(0));
  return sha256Hex(enc);
}

/**
 * Push every tagged note's current HTML content as a standalone EPUB.
 * Skips notes whose content hasn't changed since the last push. Any embedded
 * `<img>` referencing Zotero-internal note attachments won't render on
 * reMarkable (only the text content is guaranteed) — a known limitation of
 * this push-only, best-effort feature.
 */
export async function pushNotes(
  progress?: ProgressFn,
  opts: { notes?: Zotero.Item[]; force?: boolean } = {},
): Promise<SyncSummary> {
  const summary: SyncSummary = {
    pushed: 0,
    skipped: 0,
    stopped: 0,
    failed: 0,
    errors: [],
  };
  if (getPref("syncNotes") === false) return summary;

  ensureNetworkGlobals();
  const notes = opts.notes ?? (await findSyncNotes());
  log(`pushNotes: ${notes.length} tagged note(s)`);
  if (notes.length === 0) return summary;

  const api = await client.getApi();
  const folder = getPref("folder") || "";
  const folderId = await client.ensureFolder(api, folder);
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const note of notes) {
    const name = noteTitleFor(note);
    const pct = Math.round((done / notes.length) * 100);
    progress?.(`Uploading note: ${name}`, pct);
    try {
      const html = note.getNote?.() ?? "";
      const contentHash = await utf8Hash(html);

      const existing = await getNoteRecord(note.key);
      const missingOnDevice = !!existing && !byId.has(existing.docId);
      if (missingOnDevice && !opts.force) {
        log(`pushNotes: "${name}" was deleted on reMarkable — stopping sync`);
        await stopSyncNote(note);
        summary.stopped++;
        done++;
        continue;
      }
      if (
        !opts.force &&
        existing &&
        existing.contentHash === contentHash &&
        !missingOnDevice
      ) {
        summary.skipped++;
        done++;
        continue;
      }

      const epubBytes = await buildEpub(
        [{ id: "note", title: name, bodyHtml: html || "<p></p>" }],
        [],
        { title: name, identifier: `urn:uuid:${contentHash.slice(0, 32)}` },
      );

      log(`pushNotes: uploading "${name}" (${epubBytes.length} bytes) …`);
      const entry = await client.uploadEpub(api, name, epubBytes, folderId);

      if (existing && !missingOnDevice) {
        const old = byId.get(existing.docId);
        if (old) {
          try {
            await client.deleteDoc(api, old.hash);
          } catch (e) {
            log(
              `pushNotes: could not delete old doc for "${name}": ${errMsg(e)}`,
            );
          }
        }
      }

      const record: NoteSyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        contentHash,
        visibleName: name,
        libraryID: note.libraryID,
        lastPushed: Date.now(),
      };
      await setNoteRecord(note.key, record);
      summary.pushed++;
    } catch (e) {
      log(`pushNotes: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}

/** Remove the reMarkable documents for the given note keys and forget them. */
export async function unsyncNotesByKeys(keys: string[]): Promise<void> {
  const want = new Set(keys);
  const records = await allNoteRecords();
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
  for (const key of hits) {
    const rec = records[key];
    if (api) {
      try {
        const entry = await client.findById(api, rec.docId);
        if (entry) await client.deleteDoc(api, entry.hash);
      } catch (e) {
        log(
          `unsyncNotes: delete failed for "${rec.visibleName}": ${errMsg(e)}`,
        );
      }
    }
    await removeNoteRecord(key);
  }
}
