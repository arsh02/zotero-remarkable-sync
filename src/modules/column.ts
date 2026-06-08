// reMarkable status indicator shown *before the item title* (not a separate
// column). A small coloured dot: synced recently / synced a while ago / tagged
// but not yet synced. Implemented by defensively wrapping the item tree's
// internal `_renderCell` — every addition is in try/catch so it can never break
// the list, and we guard against double-patching across hot-reloads.

import { getRecordCached } from "./sync/state";
import { getSyncTag } from "./sync/engine";
import { log } from "../utils/log";

const FRESH_MS = 24 * 60 * 60 * 1000; // "synced recently" window

type SyncState = "fresh" | "stale" | "never" | "";

const DOT: Record<Exclude<SyncState, "">, [string, string, string]> = {
  fresh: ["●", "#3fae4a", "reMarkable: synced recently"],
  stale: ["●", "#c9a227", "reMarkable: synced a while ago"],
  never: ["○", "#9b9b9b", "reMarkable: tagged, not synced yet"],
};

let patch: { disable: () => void } | null = null;

function stateOf(item: Zotero.Item): SyncState {
  if (!item?.isRegularItem?.()) return "";
  let lastPushed = 0;
  let hasRecord = false;
  for (const att of Zotero.Items.get(item.getAttachments())) {
    if (!att.isPDFAttachment()) continue;
    const rec = getRecordCached(att.key);
    if (rec) {
      hasRecord = true;
      lastPushed = Math.max(lastPushed, rec.lastPushed || 0);
    }
  }
  if (hasRecord) return Date.now() - lastPushed < FRESH_MS ? "fresh" : "stale";
  return item.hasTag(getSyncTag()) ? "never" : "";
}

export function registerColumn(): void {
  try {
    const proto = (Zotero as any).ItemTree?.prototype;
    if (!proto || typeof proto._renderCell !== "function") {
      log("title indicator: ItemTree._renderCell not found");
      return;
    }
    if (proto.__rmsTitleDot) return; // already patched (e.g. after hot-reload)
    proto.__rmsTitleDot = true;

    patch = new ztoolkit.Patch();
    (patch as any).setData({
      target: proto,
      funcSign: "_renderCell",
      enabled: true,
      patcher: (origin: any) =>
        function (this: any, index: number, ...rest: any[]) {
          const cell = origin.call(this, index, ...rest);
          try {
            const isFirstColumn = rest[2];
            if (!isFirstColumn || !cell?.ownerDocument) return cell;
            const item = this.getRow?.(index)?.ref as Zotero.Item;
            const st = stateOf(item);
            if (st) {
              const [glyph, color, title] = DOT[st];
              const dot = cell.ownerDocument.createElement("span");
              dot.textContent = `${glyph} `;
              dot.style.color = color;
              dot.style.flex = "none";
              dot.setAttribute("title", title);
              cell.insertBefore(dot, cell.firstChild);
            }
          } catch {
            // never break the item tree
          }
          return cell;
        },
    });
  } catch (e) {
    log("title indicator failed:", e);
  }
}

export function unregisterColumn(): void {
  try {
    patch?.disable();
    const proto = (Zotero as any).ItemTree?.prototype;
    if (proto) delete proto.__rmsTitleDot;
  } catch {
    /* ignore */
  }
  patch = null;
}
