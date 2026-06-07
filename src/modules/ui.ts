// UI surface for the plugin: a native item context-menu (Add / Remove / Sync
// now), an item-pane status section with toggle + sync buttons, and the
// progress-window runner shared by both.

import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import * as engine from "./sync/engine";
import * as client from "./remarkable/client";

const ICON = `chrome://${config.addonRef}/content/icons/favicon.png`;
const MENU_ID = `${config.addonRef}-itemmenu`;
const SECTION_ID = `${config.addonRef}-status`;

interface WindowMenus {
  menu: Element;
  nodes: Element[];
  onShowing: (e: Event) => void;
}
const menuRegistry = new Map<Window, WindowMenus>();
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
    const summary = await engine.pushAll((done, total, label) => {
      const pct = total ? Math.round((done / total) * 100) : 100;
      pw.changeLine({ progress: pct, text: `[${pct}%] ${label}` });
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
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: (e as Error).message } }),
    });
    pw.startCloseTimer(8000);
  }
}

// ---------------------------------------------------------------------------
// Context menu (native DOM, since toolkit v5 has no Menu manager)
// ---------------------------------------------------------------------------

function makeMenuitem(
  doc: Document,
  suffix: string,
  label: string,
  onCommand: () => void,
): Element {
  const item = (doc as any).createXULElement("menuitem") as Element;
  item.id = `${MENU_ID}-${suffix}`;
  item.setAttribute("label", label);
  item.addEventListener("command", onCommand);
  return item;
}

export function registerMenu(win: Window): void {
  const doc = win.document;
  const itemmenu = doc.getElementById("zotero-itemmenu");
  if (!itemmenu || menuRegistry.has(win)) return;

  const sep = (doc as any).createXULElement("menuseparator") as Element;
  sep.id = `${MENU_ID}-sep`;

  const addItem = makeMenuitem(
    doc,
    "add",
    getString("menuitem-add-to-sync"),
    () => {
      void engine.addToSync(selectedRegularItems(win));
    },
  );
  const removeItem = makeMenuitem(
    doc,
    "remove",
    getString("menuitem-remove-from-sync"),
    () => {
      void engine.removeFromSync(selectedRegularItems(win));
    },
  );
  const syncItem = makeMenuitem(
    doc,
    "syncnow",
    getString("menuitem-sync-now"),
    () => {
      void runSyncNow();
    },
  );

  const nodes = [sep, addItem, removeItem, syncItem];
  nodes.forEach((n) => itemmenu.appendChild(n));

  const onShowing = () => {
    const items = selectedRegularItems(win);
    const anyUnsynced = items.some((i) => !engine.isItemSynced(i));
    const anySynced = items.some((i) => engine.isItemSynced(i));
    (addItem as any).hidden = !anyUnsynced;
    (removeItem as any).hidden = !anySynced;
    (sep as any).hidden = items.length === 0;
  };
  itemmenu.addEventListener("popupshowing", onShowing);

  menuRegistry.set(win, { menu: itemmenu, nodes, onShowing });
}

export function unregisterMenu(win: Window): void {
  const reg = menuRegistry.get(win);
  if (!reg) return;
  reg.menu.removeEventListener("popupshowing", reg.onShowing);
  reg.nodes.forEach((n) => n.remove());
  menuRegistry.delete(win);
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
    if (synced) await engine.removeFromSync([item]);
    else await engine.addToSync([item]);
    renderSection(body, item, doc);
  });
  body.appendChild(toggle);

  const sync = doc.createElement("button");
  sync.style.marginInlineStart = "6px";
  sync.textContent = getString("sync-now");
  sync.addEventListener("click", () => void runSyncNow());
  body.appendChild(sync);
}
