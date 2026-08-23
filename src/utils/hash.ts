/** sha-256 of the given bytes, as a lowercase hex string. */
export async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const subtle = (globalThis as any).crypto.subtle;
  const digest: ArrayBuffer = await subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}
