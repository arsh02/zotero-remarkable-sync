// Write changes back to a reMarkable document via the raw sync API.
//
// reMarkable's store is content-addressed: a document is a list of file
// entries; the whole account is a list of documents; the hash of that list is
// the root hash. To change a page we: upload the new .rm blob (putFile), rebuild
// the document's entry list (putEntries), rebuild the root list (putEntries),
// then commit the new root (putRootHash, guarded by the generation).

import { GenerationError } from "rmapi-js";
import type { RemarkableApi, RawEntry } from "rmapi-js";
import { log } from "../../utils/log";

function upsert(entries: RawEntry[], entry: RawEntry): void {
  const i = entries.findIndex((e) => e.id === entry.id);
  if (i >= 0) entries[i] = entry;
  else entries.push(entry);
}

async function updateOnce(
  api: RemarkableApi,
  docId: string,
  pageRm: Map<string, Uint8Array>,
  bumpMetadata: boolean,
): Promise<void> {
  const raw = api.raw;
  const [rootHash, generation, schema] = await raw.getRootHash();
  // Log a recovery snapshot before any write (the raw API can corrupt the root).
  log(`rmupload: pre-write root=${rootHash} generation=${generation}`);

  const root = await raw.getEntries("root.docSchema", rootHash);
  const docEntry = root.entries.find((e) => e.id === docId);
  if (!docEntry) throw new Error(`document ${docId} not found in root`);

  const doc = await raw.getEntries(`${docId}.docSchema`, docEntry.hash);

  // Replace each page's .rm blob. Only pages that already have an entry are
  // supported (we reuse the exact file id the cloud uses).
  for (const [pageUuid, bytes] of pageRm) {
    const existing = doc.entries.find((e) => e.id.endsWith(`${pageUuid}.rm`));
    if (!existing) {
      log(`rmupload: page ${pageUuid} has no existing .rm — skipped`);
      continue;
    }
    const [fileEntry, finish] = await raw.putFile(existing.id, bytes);
    await finish;
    upsert(doc.entries, fileEntry);
  }

  // Touch the document so the device notices the change.
  if (bumpMetadata) {
    const metaEnt = doc.entries.find((e) => e.id.endsWith(".metadata"));
    if (metaEnt) {
      try {
        const meta = await raw.getMetadata(metaEnt.id, metaEnt.hash);
        (meta as any).lastModified = String(Date.now());
        const [newMeta, finish] = await raw.putMetadata(metaEnt.id, meta);
        await finish;
        upsert(doc.entries, newMeta);
      } catch (e) {
        log(`rmupload: metadata bump skipped: ${(e as Error).message ?? e}`);
      }
    }
  }

  const [newDocEntry, finishDoc] = await raw.putEntries(
    docId,
    doc.entries,
    schema,
  );
  await finishDoc;
  upsert(root.entries, newDocEntry);

  const [newRootEntry, finishRoot] = await raw.putEntries(
    "root",
    root.entries,
    schema,
  );
  await finishRoot;

  await raw.putRootHash(newRootEntry.hash, generation);
}

/**
 * Replace the given pages' `.rm` blobs in a reMarkable document and commit.
 * Retries on a GenerationError (a concurrent change moved the root).
 */
export async function updateDocumentPages(
  api: RemarkableApi,
  docId: string,
  pageRm: Map<string, Uint8Array>,
  opts: { bumpMetadata?: boolean } = {},
): Promise<void> {
  if (pageRm.size === 0) return;
  const bump = opts.bumpMetadata ?? true;
  let lastErr: unknown;
  for (let attempt = 0; attempt < 4; attempt++) {
    try {
      await updateOnce(api, docId, pageRm, bump);
      return;
    } catch (e) {
      if (e instanceof GenerationError) {
        log(`rmupload: generation changed, retry ${attempt + 1}`);
        lastErr = e;
        continue;
      }
      throw e;
    }
  }
  throw lastErr;
}
