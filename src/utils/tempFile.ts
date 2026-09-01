// Temp-file helpers for bytes that need a path before Zotero can import them
// (DOCX companion EPUBs, PDFs downloaded from reMarkable). Uses Zotero's
// IOUtils/PathUtils so the same code works on every platform.

const IO = globalThis as any;

/** Write `bytes` to a unique file in Zotero's temp directory; return the path. */
export async function writeTempFile(
  name: string,
  bytes: Uint8Array,
): Promise<string> {
  const dir = Zotero.getTempDirectory().path;
  const safeName = name.replace(/[\\/:*?"<>|]/g, "_");
  const path = IO.PathUtils.join(dir, `rms-${Date.now()}-${safeName}`);
  await IO.IOUtils.write(path, bytes);
  return path;
}

/** Best-effort delete of a temp file written by `writeTempFile`. */
export async function removeTempFile(path: string): Promise<void> {
  try {
    await IO.IOUtils.remove(path, { ignoreAbsent: true });
  } catch {
    /* already gone or unreadable */
  }
}
