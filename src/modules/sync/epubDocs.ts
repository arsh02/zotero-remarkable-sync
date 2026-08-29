// Orchestrates sync of DOCX-generated companion EPUBs (see docxCompanion.ts).
// Native Zotero EPUB attachments are not synced — reMarkable still receives
// an EPUB for DOCX (and notes) because that is the only non-PDF format its
// cloud API accepts.
//
// Unlike the PDF pipeline (file bytes never change; annotations are patched
// into small per-page `.rm` sidecars — see push.ts), reMarkable's API has no
// way to update an existing EPUB's *content* in place. Pushing a Zotero
// highlight means baking it into the chapter XHTML (epub/highlights.ts) and
// re-uploading the *whole document*, which necessarily gets a new reMarkable
// document id — so we delete the old one to avoid piling up duplicates.
//
// Because a full re-upload replaces the document, any not-yet-pulled
// highlights the user made directly on the device would otherwise be lost.
// To minimise that, callers MUST pull before push for these documents (the
// opposite order from the PDF pipeline) — see ui.ts's runSyncNow.

import { getPref } from "../../utils/prefs";
import { ensureNetworkGlobals } from "../../utils/globals";
import { log, errMsg } from "../../utils/log";
import { sha256Hex } from "../../utils/hash";
import * as client from "../remarkable/client";
import { fetchAnnotations } from "../remarkable/rmdoc";
import { rmToZoteroHex } from "../remarkable/colors";
import { openEpub, repackage } from "../epub/read";
import {
  bakeHighlights,
  matchDeviceHighlights,
  type BakeTarget,
  type DeviceHighlight,
  type MatchedHighlight,
} from "../epub/highlights";
import {
  getRecord,
  setRecord,
  allRecords,
  type SyncRecord,
  type EpubSourceKind,
} from "./state";
import { save as saveAnnotation } from "./annotations";
import {
  findSyncItems,
  docxAttachmentsOf,
  displayNameFor,
  isSafeMode,
  stopSync,
  type ProgressFn,
  type SyncSummary,
  type PullSummary,
} from "./engine";
import { ensureCompanion } from "./docxCompanion";
import {
  identityTag,
  fingerprintTag,
  findByIdentity,
  hasTag,
  reconcileDuplicates,
  deleteSuperseded,
} from "./dedupe";

const IO = globalThis as any;
const PUSHABLE_TYPES = new Set(["highlight", "underline"]);

export interface EpubTarget {
  att: Zotero.Item;
  sourceKind: EpubSourceKind;
}

/** Resolve tagged items (or an explicit list) to DOCX companion EPUB targets,
 *  generating/refreshing companions along the way. Native EPUB attachments
 *  are ignored. */
export async function resolveEpubTargets(
  items?: Zotero.Item[],
): Promise<EpubTarget[]> {
  const regularItems = items ?? (await findSyncItems());
  const targets: EpubTarget[] = [];
  for (const docxAtt of docxAttachmentsOf(regularItems)) {
    const companion = await ensureCompanion(docxAtt);
    if (companion) {
      targets.push({ att: companion, sourceKind: "docx-companion" });
    }
  }
  return targets;
}

// --- Pull: device highlights -> Zotero CFI annotations ---------------------

interface EpubPending {
  signature: string;
  json: Record<string, unknown>;
}

function existingEpubSig(item: Zotero.Item): string | null {
  try {
    const pos = JSON.parse(item.annotationPosition) as {
      type?: string;
      value?: string;
    };
    if (pos?.type === "FragmentSelector" && typeof pos.value === "string") {
      return `epub|${pos.value}`;
    }
  } catch {
    /* not an EPUB (or unparseable) position */
  }
  return null;
}

function buildEpubPending(m: MatchedHighlight): EpubPending {
  const section = String(m.spineIndex).padStart(5, "0");
  const offset = String(m.charOffset).padStart(8, "0");
  return {
    signature: `epub|${m.cfi}`,
    json: {
      type: "highlight",
      color: m.colorHex,
      sortIndex: `${section}|${offset}`,
      position: {
        type: "FragmentSelector",
        conformsTo: "http://www.idpf.org/epub/linking/cfi/epub-cfi.html",
        value: m.cfi,
      },
      text: m.text,
      comment: "",
    },
  };
}

/** Mirror device EPUB highlights onto the attachment (add-only; see
 *  annotations.ts's applyAnnotations for the equivalent PDF logic/rationale). */
async function applyEpubAnnotations(
  attachment: Zotero.Item,
  matched: MatchedHighlight[],
  ourKeys: string[],
  deletedSigs: string[],
): Promise<{ keys: string[]; added: number; removed: number }> {
  const suppressed = new Set(deletedSigs);
  const pendings = matched.map(buildEpubPending);
  const incoming = new Set(pendings.map((p) => p.signature));

  const ourSet = new Set(ourKeys);
  const present = new Set<string>();
  const keptKeys: string[] = [];
  let removed = 0;

  for (const a of attachment.getAnnotations()) {
    const s = existingEpubSig(a);
    if (ourSet.has(a.key)) {
      if (s && incoming.has(s)) {
        keptKeys.push(a.key);
        present.add(s);
      } else {
        try {
          await a.eraseTx();
          removed++;
        } catch {
          keptKeys.push(a.key);
        }
      }
    } else if (s) {
      present.add(s);
    }
  }

  const newKeys: string[] = [];
  for (const p of pendings) {
    if (present.has(p.signature) || suppressed.has(p.signature)) continue;
    const key = await saveAnnotation(attachment, p.json);
    if (key) {
      present.add(p.signature);
      newKeys.push(key);
    }
  }

  return { keys: [...keptKeys, ...newKeys], added: newKeys.length, removed };
}

/** Pull annotations for every synced EPUB record whose document changed. */
export async function pullEpubAll(
  progress?: ProgressFn,
  opts: { force?: boolean; onlyKeys?: Set<string> } = {},
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
  const keys = Object.keys(records).filter(
    (k) =>
      records[k].kind === "epub" &&
      records[k].sourceKind === "docx-companion" &&
      (!opts.onlyKeys || opts.onlyKeys.has(k)),
  );
  log(`pullEpubAll: start (${keys.length} synced record(s))`);
  if (keys.length === 0) return summary;

  const api = await client.getApi();
  progress?.("Checking reMarkable for EPUB annotations…", 0);
  const remote = await api.listItems(true);
  const byId = new Map(remote.map((e) => [e.id, e]));

  let done = 0;
  for (const attKey of keys) {
    const rec = records[attKey];
    const pct = Math.round((done / keys.length) * 100);
    try {
      const libraryID = rec.libraryID ?? Zotero.Libraries.userLibraryID;
      const att = Zotero.Items.getByLibraryAndKey(libraryID, attKey) as
        | Zotero.Item
        | false;
      if (!att) {
        done++;
        continue;
      }

      const entry = byId.get(rec.docId);
      if (!entry) {
        log(`pullEpubAll: "${rec.visibleName}" not found on cloud`);
        done++;
        continue;
      }
      if (!opts.force && entry.hash === rec.lastPulledVersion) {
        done++;
        continue;
      }

      progress?.(`Pulling annotations: ${rec.visibleName}`, pct);
      const { pages } = await fetchAnnotations(api, rec.docId, entry.hash);

      const deviceHighlights: DeviceHighlight[] = [];
      let inkCount = 0;
      for (const { page } of pages) {
        for (const hl of page.highlights) {
          if (!hl.text?.trim()) continue;
          deviceHighlights.push({
            text: hl.text,
            colorHex: rmToZoteroHex(hl.colorIndex, hl.rgba),
          });
        }
        inkCount += page.strokes.length;
      }
      if (inkCount) {
        log(
          `pullEpubAll: "${rec.visibleName}" has ${inkCount} ink stroke(s) — no EPUB annotation destination, skipped`,
        );
      }

      const path = await att.getFilePathAsync();
      if (!path) {
        done++;
        continue;
      }
      const bytes: Uint8Array = await IO.IOUtils.read(path);
      const epubDoc = await openEpub(bytes);
      const matched = await matchDeviceHighlights(epubDoc, deviceHighlights);

      const result = await applyEpubAnnotations(
        att,
        matched,
        rec.annotationKeys ?? [],
        rec.deletedSigs ?? [],
      );

      await setRecord(attKey, {
        ...rec,
        lastPulledVersion: entry.hash,
        annotationKeys: result.keys,
      });
      summary.updated++;
      summary.annotations += result.added;
      summary.removed += result.removed;
      log(
        `pullEpubAll: "${rec.visibleName}" -> +${result.added} -${result.removed}`,
      );
    } catch (e) {
      log(`pullEpubAll: FAILED "${rec.visibleName}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${rec.visibleName}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}

// --- Push: upload source (+ baked annotations) ------------------------------

/**
 * Upload every EPUB target's current content, one combined pass: the plain
 * source file if unchanged/safe-mode/no annotations to push, or a copy with
 * every current Zotero highlight/underline baked in as styled `<mark>`s
 * otherwise. Skips targets where neither the source nor the pushable
 * annotation set changed since the last push. Always deletes the previous
 * device document on a successful re-upload (reMarkable has no in-place
 * "replace content" for a whole document).
 */
export async function pushEpubAll(
  progress?: ProgressFn,
  opts: { targets?: EpubTarget[]; force?: boolean } = {},
): Promise<SyncSummary> {
  ensureNetworkGlobals();
  const summary: SyncSummary = {
    pushed: 0,
    skipped: 0,
    stopped: 0,
    failed: 0,
    errors: [],
  };

  const targets = opts.targets ?? (await resolveEpubTargets());
  log(`pushEpubAll: ${targets.length} EPUB target(s)`);
  if (targets.length === 0) {
    progress?.("Nothing tagged to sync", 100);
    return summary;
  }

  progress?.("Authenticating with reMarkable…", 0);
  const api = await client.getApi();
  const folder = getPref("folder") || "";
  const folderId = await client.ensureFolder(api, folder);
  const remote = await reconcileDuplicates(api, await api.listItems(true));
  const byId = new Map(remote.map((e) => [e.id, e]));
  const safeMode = isSafeMode();

  let done = 0;
  for (const { att, sourceKind } of targets) {
    const name = displayNameFor(att);
    const pct = Math.round((done / targets.length) * 100);
    progress?.(`Uploading ${name}`, pct);
    try {
      const path = await att.getFilePathAsync();
      if (!path) {
        log(`pushEpubAll: skip "${name}" (no file path)`);
        summary.skipped++;
        done++;
        continue;
      }
      const sourceBytes: Uint8Array = await IO.IOUtils.read(path);
      const fileHash = await sha256Hex(sourceBytes);
      const idTag = identityTag(att.libraryID, att.key);
      const fpTag = fingerprintTag(fileHash);

      const existing = await getRecord(att.key);
      const cloudMatch = findByIdentity(remote, idTag);
      const missingOnDevice = !!existing && !byId.has(existing.docId);

      // Zotero-origin highlights/underlines not already pulled from the
      // device — these are what get baked into the uploaded copy.
      const pulled = new Set(existing?.annotationKeys ?? []);
      const pushable = safeMode
        ? []
        : att
            .getAnnotations()
            .filter(
              (a) => PUSHABLE_TYPES.has(a.annotationType) && !pulled.has(a.key),
            );
      const pushableKeys = pushable.map((a) => a.key).sort();

      const priorKeys = (existing?.pushedKeys ?? []).slice().sort();
      const annotationsChanged =
        pushableKeys.length !== priorKeys.length ||
        pushableKeys.some((k, i) => k !== priorKeys[i]);
      const sourceChanged = !existing || existing.fileHash !== fileHash;

      // Matching identity+fingerprint on the cloud: another machine already
      // pushed this source. Skip unless this machine has annotations to bake
      // (those still require a full re-upload).
      if (
        !opts.force &&
        cloudMatch &&
        hasTag(cloudMatch, fpTag) &&
        !annotationsChanged
      ) {
        const alreadyTracked =
          !!existing &&
          existing.docId === cloudMatch.id &&
          existing.fileHash === fileHash;
        if (!alreadyTracked) {
          const sameDoc = existing?.docId === cloudMatch.id;
          await setRecord(att.key, {
            docId: cloudMatch.id,
            docHash: cloudMatch.hash,
            fileHash,
            contentHash: sameDoc ? existing?.contentHash : undefined,
            kind: "epub",
            sourceKind,
            visibleName: name,
            libraryID: att.libraryID,
            lastPushed: sameDoc && existing ? existing.lastPushed : Date.now(),
            lastPulledVersion: sameDoc
              ? existing?.lastPulledVersion
              : undefined,
            annotationKeys: sameDoc ? existing?.annotationKeys : [],
            pushedKeys: sameDoc ? existing?.pushedKeys : [],
            companionKey: existing?.companionKey,
          });
          log(`pushEpubAll: adopt "${name}" from cloud (${cloudMatch.id})`);
        }
        summary.skipped++;
        done++;
        continue;
      }

      if (missingOnDevice && !cloudMatch && !opts.force) {
        log(`pushEpubAll: "${name}" was deleted on reMarkable — stopping sync`);
        await stopSync(att);
        summary.stopped++;
        done++;
        continue;
      }

      if (
        !opts.force &&
        !missingOnDevice &&
        !sourceChanged &&
        !annotationsChanged
      ) {
        summary.skipped++;
        done++;
        continue;
      }

      let uploadBytes = sourceBytes;
      let bakedKeys: string[] = existing?.pushedKeys ?? [];
      if (pushable.length > 0) {
        try {
          const epubDoc = await openEpub(sourceBytes);
          const bakeTargets: BakeTarget[] = [];
          for (const a of pushable) {
            try {
              const cfi = JSON.parse(a.annotationPosition).value;
              if (typeof cfi === "string" && cfi) {
                bakeTargets.push({
                  annotationKey: a.key,
                  cfi,
                  colorHex: a.annotationColor || "#ffd400",
                  underline: a.annotationType === "underline",
                });
              }
            } catch {
              /* not a FragmentSelector/CFI position — skip */
            }
          }
          const result = await bakeHighlights(epubDoc, bakeTargets);
          uploadBytes = await repackage(epubDoc);
          // Track the full *considered* set (not just those successfully
          // resolved to a position) so an annotation with e.g. a malformed
          // CFI doesn't cause an unnecessary re-upload every sync cycle.
          bakedKeys = pushableKeys;
          if (result.failed.length) {
            log(
              `pushEpubAll: "${name}" — ${result.failed.length} annotation(s) could not be resolved to a chapter position`,
            );
          }
        } catch (e) {
          log(`pushEpubAll: bake failed for "${name}": ${errMsg(e)}`);
          uploadBytes = sourceBytes;
          bakedKeys = existing?.pushedKeys ?? [];
        }
      } else {
        // Nothing to bake — either there are no pushable annotations, or safe
        // mode suppressed them. Either way the uploaded content is the plain
        // source, so the baked-keys bookkeeping must reflect that (an empty
        // set) — not the previous push's set — or every future cycle would
        // keep seeing a spurious "annotations changed" and re-upload forever.
        bakedKeys = [];
      }

      log(`pushEpubAll: uploading "${name}" (${uploadBytes.length} bytes) …`);
      const entry = await client.uploadEpub(api, name, uploadBytes, folderId, [
        idTag,
        fpTag,
      ]);

      // Best-effort: remove the superseded device document so re-uploads
      // (which always mint a new document id) don't accumulate duplicates.
      // Covers both this machine's previous copy and a stale copy another
      // machine pushed (identity tag present, fingerprint no longer matches).
      const staleIds = new Set<string>();
      if (existing && !missingOnDevice) staleIds.add(existing.docId);
      if (cloudMatch) staleIds.add(cloudMatch.id);
      staleIds.delete(entry.id);
      for (const id of staleIds) {
        await deleteSuperseded(api, byId.get(id), `pushEpubAll "${name}"`);
      }

      const record: SyncRecord = {
        docId: entry.id,
        docHash: entry.hash,
        fileHash,
        contentHash: await sha256Hex(uploadBytes),
        kind: "epub",
        sourceKind,
        visibleName: name,
        libraryID: att.libraryID,
        lastPushed: Date.now(),
        lastPulledVersion: missingOnDevice
          ? undefined
          : existing?.lastPulledVersion,
        annotationKeys: missingOnDevice ? [] : existing?.annotationKeys,
        pushedKeys: bakedKeys,
      };
      await setRecord(att.key, record);
      log(`pushEpubAll: uploaded "${name}" -> ${entry.id}`);
      summary.pushed++;
    } catch (e) {
      log(`pushEpubAll: FAILED "${name}": ${errMsg(e)}`);
      summary.failed++;
      summary.errors.push(`${name}: ${errMsg(e)}`);
    }
    done++;
  }
  progress?.("", 100);
  return summary;
}
