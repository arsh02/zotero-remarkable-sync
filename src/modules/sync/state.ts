// Persistent mapping between Zotero attachments/notes and reMarkable
// documents. Stored as JSON files in the Zotero data directory, keyed by
// item key.

/** What kind of document is on the other end of this record. */
export type DocKind = "pdf" | "epub";

/** How an "epub" record's content was produced. Native Zotero EPUB
 *  attachments are no longer synced; "native-epub" is only read for
 *  leftover records from older builds. */
export type EpubSourceKind = "native-epub" | "docx-companion";

export interface SyncRecord {
  /** reMarkable document id (uuid4) */
  docId: string;
  /** reMarkable document hash at last push */
  docHash: string;
  /** sha-256 of the *source* bytes last pushed (hex) — guards against
   *  re-upload. For "pdf" this is the attachment file itself; for a
   *  docx-companion epub this is the original .docx's hash. */
  fileHash: string;
  /** sha-256 of the bytes actually uploaded (post EPUB highlight-baking).
   *  Only meaningful for kind === "epub" — lets us tell "source changed" apart
   *  from "only the baked annotations changed" without re-reading the source. */
  contentHash?: string;
  /** name shown on the device */
  visibleName: string;
  /** Zotero library the attachment lives in (defaults to user library) */
  libraryID?: number;
  /** epoch ms of last successful push */
  lastPushed: number;
  /** reMarkable doc hash last pulled (skip pull when unchanged) */
  lastPulledVersion?: string;
  /** keys of annotations created on the last pull (for idempotent re-pull) */
  annotationKeys?: string[];
  /** keys of Zotero annotations already pushed to the device (avoid re-push).
   *  For "epub" records this is also the full set of keys currently baked
   *  into the uploaded document. */
  pushedKeys?: string[];
  /** PDF only: Zotero annotations pushed to the device + the reMarkable item
   *  ids assigned, so we can tombstone them on the device when deleted in
   *  Zotero */
  pushedItems?: PushedItem[];
  /** signatures of annotations deleted in Zotero, so pull won't re-create them */
  deletedSigs?: string[];
  /** "pdf" (default, for records predating this field) or "epub" */
  kind?: DocKind;
  /** epub only: where the epub content came from */
  sourceKind?: EpubSourceKind;
  /** docx-companion only: the key of the generated .epub child attachment
   *  (the thing actually registered/synced under this same record) */
  companionKey?: string;
}

export interface PushedItem {
  /** Zotero annotation key */
  key: string;
  /** reMarkable page uuid the items were written to */
  page: string;
  /** assigned reMarkable item ids ([part1, part2] each) */
  ids: [number, number][];
  /** content signature, to suppress re-pull if deleted */
  sig?: string;
}

/** Standalone/child Zotero notes pushed to reMarkable as their own document.
 *  Push-only: notes have no annotation layer to pull back into. */
export interface NoteSyncRecord {
  docId: string;
  docHash: string;
  /** sha-256 of the note's HTML at last push */
  contentHash: string;
  visibleName: string;
  libraryID?: number;
  lastPushed: number;
}

type StateMap = Record<string, SyncRecord>;
type NoteStateMap = Record<string, NoteSyncRecord>;

const IO = globalThis as any;

let cache: StateMap | null = null;
let noteCache: NoteStateMap | null = null;

function stateDir(): string {
  return IO.PathUtils.join(Zotero.DataDirectory.dir, "remarkablesync");
}

function stateFile(): string {
  return IO.PathUtils.join(stateDir(), "state.json");
}

function notesStateFile(): string {
  return IO.PathUtils.join(stateDir(), "notes.json");
}

async function load(): Promise<StateMap> {
  if (cache) return cache;
  try {
    const text = await IO.IOUtils.readUTF8(stateFile());
    cache = JSON.parse(text) as StateMap;
  } catch {
    // Missing or unreadable file → start empty.
    cache = {};
  }
  return cache!;
}

async function persist(): Promise<void> {
  await IO.IOUtils.makeDirectory(stateDir(), { ignoreExisting: true });
  await IO.IOUtils.writeUTF8(stateFile(), JSON.stringify(cache ?? {}, null, 2));
}

export async function getRecord(key: string): Promise<SyncRecord | undefined> {
  return (await load())[key];
}

/** Load the state into memory (so getRecordCached works). */
export async function preload(): Promise<void> {
  await load();
  await loadNotes();
}

/** Synchronous record lookup from the in-memory cache (undefined if unloaded). */
export function getRecordCached(key: string): SyncRecord | undefined {
  return cache?.[key];
}

export async function setRecord(
  key: string,
  record: SyncRecord,
): Promise<void> {
  const map = await load();
  map[key] = record;
  await persist();
}

export async function removeRecord(key: string): Promise<void> {
  const map = await load();
  if (key in map) {
    delete map[key];
    await persist();
  }
}

export async function allRecords(): Promise<StateMap> {
  return { ...(await load()) };
}

/** Drop the in-memory caches (forces a reload from disk on next access). */
export function invalidate(): void {
  cache = null;
  noteCache = null;
  companionCache = null;
}

// --- Standalone note records -------------------------------------------------

async function loadNotes(): Promise<NoteStateMap> {
  if (noteCache) return noteCache;
  try {
    const text = await IO.IOUtils.readUTF8(notesStateFile());
    noteCache = JSON.parse(text) as NoteStateMap;
  } catch {
    noteCache = {};
  }
  return noteCache!;
}

async function persistNotes(): Promise<void> {
  await IO.IOUtils.makeDirectory(stateDir(), { ignoreExisting: true });
  await IO.IOUtils.writeUTF8(
    notesStateFile(),
    JSON.stringify(noteCache ?? {}, null, 2),
  );
}

export async function getNoteRecord(
  key: string,
): Promise<NoteSyncRecord | undefined> {
  return (await loadNotes())[key];
}

export async function setNoteRecord(
  key: string,
  record: NoteSyncRecord,
): Promise<void> {
  const map = await loadNotes();
  map[key] = record;
  await persistNotes();
}

export async function removeNoteRecord(key: string): Promise<void> {
  const map = await loadNotes();
  if (key in map) {
    delete map[key];
    await persistNotes();
  }
}

export async function allNoteRecords(): Promise<NoteStateMap> {
  return { ...(await loadNotes()) };
}

// --- DOCX -> companion EPUB attachment mapping ------------------------------
// Maps the original .docx attachment's key to the generated .epub child
// attachment's key, so re-syncing finds/reuses the same companion instead of
// creating a new one every time.

type CompanionMap = Record<string, string>;
let companionCache: CompanionMap | null = null;

function companionsFile(): string {
  return IO.PathUtils.join(stateDir(), "docx-companions.json");
}

async function loadCompanions(): Promise<CompanionMap> {
  if (companionCache) return companionCache;
  try {
    const text = await IO.IOUtils.readUTF8(companionsFile());
    companionCache = JSON.parse(text) as CompanionMap;
  } catch {
    companionCache = {};
  }
  return companionCache!;
}

async function persistCompanions(): Promise<void> {
  await IO.IOUtils.makeDirectory(stateDir(), { ignoreExisting: true });
  await IO.IOUtils.writeUTF8(
    companionsFile(),
    JSON.stringify(companionCache ?? {}, null, 2),
  );
}

export async function getCompanionKey(
  docxKey: string,
): Promise<string | undefined> {
  return (await loadCompanions())[docxKey];
}

export async function setCompanionKey(
  docxKey: string,
  companionKey: string,
): Promise<void> {
  const map = await loadCompanions();
  map[docxKey] = companionKey;
  await persistCompanions();
}

export async function removeCompanionKey(docxKey: string): Promise<void> {
  const map = await loadCompanions();
  if (docxKey in map) {
    delete map[docxKey];
    await persistCompanions();
  }
}
