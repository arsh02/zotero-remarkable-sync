// Cross-machine push deduplication via reMarkable cloud tags.
//
// Local sync state (state.json / notes.json) is per-machine and is never
// synced by Zotero. The reMarkable cloud account *is* shared, and every
// listItems() call already returns each entry's tags. We stamp two tags on
// every document we upload:
//
//   zrs-id-{libraryID}-{itemKey}  — stable identity of the Zotero attachment
//                                   or note that produced this document
//   zrs-fp-{sha256[:12]}          — content fingerprint of the bytes last
//                                   pushed (source file hash, or note HTML)
//
// A second machine seeing a matching identity+fingerprint adopts the cloud
// document into local state instead of uploading a duplicate. Identity-tag
// collisions (two machines racing a first-time push) are collapsed on the
// next sync by keeping the newest lastModified and deleting the rest.

import type { Entry, RemarkableApi } from "rmapi-js";
import * as client from "../remarkable/client";
import { log, errMsg } from "../../utils/log";

export const IDENTITY_PREFIX = "zrs-id-";
export const FINGERPRINT_PREFIX = "zrs-fp-";

/** Tag that uniquely identifies a Zotero item across machines. */
export function identityTag(libraryID: number, key: string): string {
  return `${IDENTITY_PREFIX}${libraryID}-${key}`;
}

/** Short content-fingerprint tag derived from a hex sha-256. */
export function fingerprintTag(hashHex: string): string {
  return `${FINGERPRINT_PREFIX}${hashHex.slice(0, 12)}`;
}

/** Normalise rmapi-js's `tags?: Tag[] | string[]` to a list of names. */
export function tagNames(entry: Entry): string[] {
  return (entry.tags ?? []).map((t) => (typeof t === "string" ? t : t.name));
}

export function hasTag(entry: Entry, tag: string): boolean {
  return tagNames(entry).includes(tag);
}

/** First cloud document carrying this identity tag, if any. */
export function findByIdentity(
  entries: readonly Entry[],
  idTag: string,
): Entry | undefined {
  return entries.find((e) => hasTag(e, idTag));
}

export interface DuplicateGroup {
  idTag: string;
  keep: Entry;
  dupes: Entry[];
}

/**
 * Group documents that share a `zrs-id-*` tag. Within each group of size > 1,
 * `keep` is the newest by `lastModified` (reMarkable stores this as a
 * millisecond epoch string); `dupes` are the rest.
 */
export function findDuplicateGroups(
  entries: readonly Entry[],
): DuplicateGroup[] {
  const groups = new Map<string, Entry[]>();
  for (const e of entries) {
    if (e.type !== "DocumentType") continue;
    for (const t of tagNames(e)) {
      if (!t.startsWith(IDENTITY_PREFIX)) continue;
      const list = groups.get(t);
      if (list) list.push(e);
      else groups.set(t, [e]);
    }
  }
  const out: DuplicateGroup[] = [];
  for (const [idTag, group] of groups) {
    if (group.length <= 1) continue;
    const sorted = [...group].sort((a, b) => {
      const d = modifiedMs(b) - modifiedMs(a);
      if (d !== 0) return d;
      return a.id.localeCompare(b.id);
    });
    const [keep, ...dupes] = sorted;
    out.push({ idTag, keep, dupes });
  }
  return out;
}

/**
 * Collapse duplicate docs that share an identity tag (e.g. from a race
 * between two machines pushing a never-before-synced item at the same time).
 * Keeps the newest by lastModified, deletes the rest. Self-healing: callers
 * run this on every push before looking up identity tags.
 */
export async function reconcileDuplicates(
  api: RemarkableApi,
  entries: Entry[],
): Promise<Entry[]> {
  const groups = findDuplicateGroups(entries);
  if (groups.length === 0) return entries;

  const removed = new Set<string>();
  for (const { idTag, keep, dupes } of groups) {
    for (const dupe of dupes) {
      try {
        await client.deleteDoc(api, dupe.hash);
        removed.add(dupe.id);
      } catch (e) {
        log(
          `reconcileDuplicates: failed to delete ${dupe.id} for "${idTag}": ` +
            errMsg(e),
        );
      }
    }
    log(
      `reconcileDuplicates: "${idTag}" had ${dupes.length + 1} copies, kept ` +
        keep.id,
    );
  }
  return entries.filter((e) => !removed.has(e.id));
}

/** Best-effort delete of a superseded cloud document (foreign or previous). */
export async function deleteSuperseded(
  api: RemarkableApi,
  entry: Entry | undefined,
  context: string,
): Promise<void> {
  if (!entry) return;
  try {
    await client.deleteDoc(api, entry.hash);
    log(`deleteSuperseded: ${context} (${entry.id})`);
  } catch (e) {
    log(`deleteSuperseded: failed ${context}: ${errMsg(e)}`);
  }
}

function modifiedMs(entry: Entry): number {
  const n = Number(entry.lastModified);
  if (Number.isFinite(n)) return n;
  const parsed = Date.parse(entry.lastModified);
  return Number.isFinite(parsed) ? parsed : 0;
}
