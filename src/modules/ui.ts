// UI surface for the plugin:
//  - a toolbar button + Tools-menu item for "Sync now",
//  - a native item context-menu for Add / Remove from sync,
//  - an item-pane status section with toggle + sync buttons,
//  - the progress-window runner shared by all of them.

import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import { log, errMsg } from "../utils/log";
import * as engine from "./sync/engine";
import * as client from "./remarkable/client";

const ICON = `chrome://${config.addonRef}/content/icons/favicon.png`;
const ID = `${config.addonRef}`;
const SECTION_ID = `${config.addonRef}-status`;

interface WindowUI {
  /** elements to remove on teardown */
  nodes: Element[];
  /** the item context menu and its popupshowing listener, for removal */
  itemmenu?: Element;
  onShowing?: (e: Event) => void;
}
const registry = new Map<Window, WindowUI>();
let sectionRegistered = false;

// ---------------------------------------------------------------------------
// Shared runner
// ---------------------------------------------------------------------------

function selectedRegularItems(win: Window): Zotero.Item[] {
  const pane = (win as any).ZoteroPane;
  const items: Zotero.Item[] = pane?.getSelectedItems?.() ?? [];
  return items.filter((it) => it.isRegularItem());
}

export async function runSyncNow(): Promise<void> {
  if (!client.isConnected()) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("status-not-connected"), type: "fail" })
      .show(4000);
    return;
  }

  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();

  try {
    const summary = await engine.pushAll((text, pct) => {
      pw.changeLine({ progress: pct, text });
    });
    pw.changeLine({
      progress: 100,
      text: getString("sync-done", {
        args: {
          pushed: summary.pushed,
          skipped: summary.skipped,
          failed: summary.failed,
        },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runSyncNow error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

// ---------------------------------------------------------------------------
// Per-window UI (toolbar button, Tools menu, context menu)
// ---------------------------------------------------------------------------

function makeMenuitem(
  doc: Document,
  suffix: string,
  label: string,
  onCommand: () => void,
): Element {
  const item = (doc as any).createXULElement("menuitem") as Element;
  item.id = `${ID}-${suffix}`;
  item.setAttribute("label", label);
  item.addEventListener("command", onCommand);
  return item;
}

function registerToolbarButton(win: Window, nodes: Element[]): void {
  const doc = win.document;
  const toolbar = doc.getElementById("zotero-items-toolbar");
  if (!toolbar) return;
  const btn = (doc as any).createXULElement("toolbarbutton") as Element;
  btn.id = `${ID}-tb-syncnow`;
  btn.setAttribute("class", "zotero-tb-button");
  btn.setAttribute("tooltiptext", getString("menuitem-sync-now"));
  btn.setAttribute("image", ICON);
  btn.addEventListener("command", () => void runSyncNow());
  toolbar.appendChild(btn);
  nodes.push(btn);
}

function registerToolsMenu(win: Window, nodes: Element[]): void {
  const doc = win.document;
  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) return;
  const item = makeMenuitem(
    doc,
    "tools-syncnow",
    getString("menuitem-sync-now"),
    () => void runSyncNow(),
  );
  toolsPopup.appendChild(item);
  nodes.push(item);
}

function registerContextMenu(
  win: Window,
  nodes: Element[],
): { itemmenu?: Element; onShowing?: (e: Event) => void } {
  const doc = win.document;
  const itemmenu = doc.getElementById("zotero-itemmenu");
  if (!itemmenu) return {};

  const sep = (doc as any).createXULElement("menuseparator") as Element;
  sep.id = `${ID}-sep`;
  const addItem = makeMenuitem(
    doc,
    "add",
    getString("menuitem-add-to-sync"),
    () => {
      engine
        .addToSync(selectedRegularItems(win))
        .catch((e) => log("addToSync error:", e));
    },
  );
  const removeItem = makeMenuitem(
    doc,
    "remove",
    getString("menuitem-remove-from-sync"),
    () => {
      engine
        .removeFromSync(selectedRegularItems(win))
        .catch((e) => log("removeFromSync error:", e));
    },
  );

  const menuNodes = [sep, addItem, removeItem];
  menuNodes.forEach((n) => {
    itemmenu.appendChild(n);
    nodes.push(n);
  });

  const onShowing = () => {
    const items = selectedRegularItems(win);
    const anyUnsynced = items.some((i) => !engine.isItemSynced(i));
    const anySynced = items.some((i) => engine.isItemSynced(i));
    (addItem as any).hidden = !anyUnsynced;
    (removeItem as any).hidden = !anySynced;
    (sep as any).hidden = items.length === 0;
  };
  itemmenu.addEventListener("popupshowing", onShowing);

  return { itemmenu, onShowing };
}

export function registerWindowUI(win: Window): void {
  if (registry.has(win)) return;
  const nodes: Element[] = [];
  registerToolbarButton(win, nodes);
  registerToolsMenu(win, nodes);
  const { itemmenu, onShowing } = registerContextMenu(win, nodes);
  registry.set(win, { nodes, itemmenu, onShowing });
}

export function unregisterWindowUI(win: Window): void {
  const reg = registry.get(win);
  if (!reg) return;
  if (reg.itemmenu && reg.onShowing) {
    reg.itemmenu.removeEventListener("popupshowing", reg.onShowing);
  }
  reg.nodes.forEach((n) => n.remove());
  registry.delete(win);
}

// ---------------------------------------------------------------------------
// Item-pane status section
// ---------------------------------------------------------------------------

export function registerSection(): void {
  if (sectionRegistered) return;
  Zotero.ItemPaneManager.registerSection({
    paneID: SECTION_ID,
    pluginID: config.addonID,
    header: {
      l10nID: getLocaleID("item-section-remarkable-head-text"),
      icon: ICON,
    },
    sidenav: {
      l10nID: getLocaleID("item-section-remarkable-sidenav-tooltip"),
      icon: ICON,
    },
    onRender: ({ body, item, doc }) => renderSection(body, item, doc),
  });
  sectionRegistered = true;
}

export function unregisterSection(): void {
  if (!sectionRegistered) return;
  Zotero.ItemPaneManager.unregisterSection(SECTION_ID);
  sectionRegistered = false;
}

function renderSection(
  body: HTMLDivElement,
  item: Zotero.Item,
  doc: Document,
): void {
  body.replaceChildren();
  if (!item?.isRegularItem()) return;

  const synced = engine.isItemSynced(item);

  const status = doc.createElement("div");
  status.style.marginBottom = "6px";
  status.textContent = synced
    ? getString("status-synced")
    : getString("status-not-synced");
  body.appendChild(status);

  const toggle = doc.createElement("button");
  toggle.textContent = synced
    ? getString("menuitem-remove-from-sync")
    : getString("menuitem-add-to-sync");
  toggle.addEventListener("click", async () => {
    try {
      if (synced) await engine.removeFromSync([item]);
      else await engine.addToSync([item]);
      renderSection(body, item, doc);
    } catch (e) {
      log("toggle sync error:", e);
    }
  });
  body.appendChild(toggle);

  const sync = doc.createElement("button");
  sync.style.marginInlineStart = "6px";
  sync.textContent = getString("sync-now");
  sync.addEventListener("click", () => void runSyncNow());
  body.appendChild(sync);
}
