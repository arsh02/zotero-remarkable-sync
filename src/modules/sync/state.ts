// Persistent mapping between Zotero PDF attachments and reMarkable documents.
// Stored as a single JSON file in the Zotero data directory. Keyed by the
// attachment item key.

export interface SyncRecord {
  /** reMarkable document id (uuid4) */
  docId: string;
  /** reMarkable document hash at last push */
  docHash: string;
  /** sha-256 of the PDF bytes last pushed (hex) — guards against re-upload */
  fileHash: string;
  /** name shown on the device */
  visibleName: string;
  /** epoch ms of last successful push */
  lastPushed: number;
  /** reMarkable version last pulled (for annotation sync, M2) */
  lastPulledVersion?: string;
}

type StateMap = Record<string, SyncRecord>;

const IO = globalThis as any;

let cache: StateMap | null = null;

function stateDir(): string {
  return IO.PathUtils.join(Zotero.DataDirectory.dir, "remarkablesync");
}

function stateFile(): string {
  return IO.PathUtils.join(stateDir(), "state.json");
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

/** Drop the in-memory cache (forces a reload from disk on next access). */
export function invalidate(): void {
  cache = null;
}
