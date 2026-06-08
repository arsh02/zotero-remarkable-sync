// reMarkable status indicator shown *before the item title* (not a separate
// column). A small coloured dot reflecting sync state. Implemented by directly
// wrapping the item tree's `_renderCell` for the first column — every addition
// is in try/catch so it can never break the list, and the wrap is idempotent.

import { getRecordCached } from "./sync/state";
import { getSyncTag } from "./sync/engine";
import { log } from "../utils/log";

const FRESH_MS = 24 * 60 * 60 * 1000; // "synced recently" window
const PUSHABLE = new Set(["highlight", "underline", "ink"]);

type SyncState = "fresh" | "stale" | "changed" | "never" | "";

const DOT: Record<Exclude<SyncState, "">, [string, string, string]> = {
  fresh: ["●", "#3fae4a", "reMarkable: synced recently"],
  stale: ["●", "#9b9b9b", "reMarkable: synced a while ago"],
  changed: ["◆", "#e67e22", "reMarkable: changed, not yet synced"],
  never: ["○", "#c0c0c0", "reMarkable: tagged, not synced yet"],
};

function stateOf(item: Zotero.Item): SyncState {
  if (!item?.isRegularItem?.()) return "";
  let lastPushed = 0;
  let hasRecord = false;
  let dirty = false;
  for (const att of Zotero.Items.get(item.getAttachments())) {
    if (!att.isPDFAttachment()) continue;
    const rec = getRecordCached(att.key);
    if (!rec) continue;
    hasRecord = true;
    lastPushed = Math.max(lastPushed, rec.lastPushed || 0);
    const pushed = new Set(rec.pushedKeys ?? []);
    const pulled = new Set(rec.annotationKeys ?? []);
    for (const a of att.getAnnotations()) {
      if (
        PUSHABLE.has(a.annotationType) &&
        !pulled.has(a.key) &&
        !pushed.has(a.key)
      ) {
        dirty = true;
        break;
      }
    }
  }
  if (!hasRecord) return item.hasTag(getSyncTag()) ? "never" : "";
  if (dirty) return "changed";
  return Date.now() - lastPushed < FRESH_MS ? "fresh" : "stale";
}

export function registerColumn(): void {
  try {
    const proto = (Zotero as any).ItemTree?.prototype;
    if (!proto || typeof proto._renderCell !== "function") {
      log("status dot: ItemTree._renderCell not found");
      return;
    }
    if (proto.__rmsOrig) return; // already wrapped
    proto.__rmsOrig = proto._renderCell;
    proto._renderCell = function (this: any, ...args: any[]) {
      const cell = proto.__rmsOrig.apply(this, args);
      try {
        const [index, , , isFirstColumn] = args;
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
    };
    log("status dot: attached to item tree");
  } catch (e) {
    log("status dot failed:", e);
  }
}

export function unregisterColumn(): void {
  try {
    const proto = (Zotero as any).ItemTree?.prototype;
    if (proto?.__rmsOrig) {
      proto._renderCell = proto.__rmsOrig;
      delete proto.__rmsOrig;
    }
  } catch {
    /* ignore */
  }
}
