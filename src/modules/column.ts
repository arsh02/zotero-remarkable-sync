// A "reMarkable" status column in the items list: a coloured dot showing whether
// each item is synced recently, synced a while ago, or tagged-but-not-yet-synced.

import { config } from "../../package.json";
import { getRecordCached } from "./sync/state";
import { getSyncTag } from "./sync/engine";
import { log } from "../utils/log";

const FRESH_MS = 24 * 60 * 60 * 1000; // "just synced" window

type SyncState = "fresh" | "stale" | "never" | "";

const DOT: Record<Exclude<SyncState, "">, [string, string, string]> = {
  fresh: ["●", "#3fae4a", "Synced to reMarkable recently"],
  stale: ["●", "#c9a227", "Synced to reMarkable a while ago"],
  never: ["○", "#9b9b9b", "Tagged for reMarkable — not synced yet"],
};

let columnKey: string | null = null;

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

export async function registerColumn(): Promise<void> {
  try {
    const key = await Zotero.ItemTreeManager.registerColumn({
      dataKey: "remarkable",
      label: "reMarkable",
      pluginID: config.addonID,
      width: "70",
      dataProvider: (item) => stateOf(item),
      renderCell: (_index, data, column, _isFirst, doc) => {
        const cell = doc.createElement("span");
        cell.className = `cell ${column.className}`;
        cell.style.textAlign = "center";
        const dot = DOT[data as Exclude<SyncState, "">];
        if (dot) {
          cell.textContent = dot[0];
          cell.style.color = dot[1];
          cell.setAttribute("title", dot[2]);
        }
        return cell;
      },
    });
    columnKey = key || null;
  } catch (e) {
    log("registerColumn failed:", e);
  }
}

export function unregisterColumn(): void {
  if (columnKey) {
    Zotero.ItemTreeManager.unregisterColumn(columnKey);
    columnKey = null;
  }
}
