// Lightweight logging that avoids zotero-plugin-toolkit's console path (which is
// broken on Zotero 9: it calls the removed `ChromeUtils.import`). Writes to
// Zotero's debug log — visible in the `zotero-plugin serve` terminal and in
// Help → Debug Output Logging.

const PREFIX = "[remarkablesync]";

export function log(...args: unknown[]): void {
  try {
    const text = args
      .map((a) =>
        a instanceof Error
          ? `${a.name}: ${a.message}`
          : typeof a === "string"
            ? a
            : safeStringify(a),
      )
      .join(" ");
    const line = `${PREFIX} ${text}`;
    // Debug log (serve terminal / Help -> Debug Output Logging).
    Zotero.debug(line);
    // Also the Browser Console, so it shows up alongside other errors.
    (Zotero.getMainWindow() as any)?.console?.log(line);
  } catch {
    // never let logging throw
  }
}

function safeStringify(value: unknown): string {
  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

/** Normalise any thrown value into a readable string. */
export function errMsg(e: unknown): string {
  if (e instanceof Error) return e.message || e.name;
  if (e === undefined) return "undefined error (no message)";
  if (e === null) return "null error";
  if (typeof e === "string") return e;
  return safeStringify(e);
}
