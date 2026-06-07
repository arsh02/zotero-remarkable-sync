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

// 96px icon (manifest/install). For in-app UI we use a small 32px variant so
// it isn't rendered oversized in the toolbar / item-pane sidenav.
const ICON = `chrome://${config.addonRef}/content/icons/icon-small.png`;
const ID = `${config.addonRef}`;
const SECTION_ID = `${config.addonRef}-status`;

// Stable ids of every element we inject, so registration can be made
// idempotent across hot-reloads (when our module-level state is reset but the
// previously injected DOM nodes survive).
const ELEMENT_IDS = [
  `${ID}-tb-syncnow`,
  `${ID}-style`,
  `${ID}-tools-syncnow`,
  `${ID}-sep`,
  `${ID}-add`,
  `${ID}-remove`,
];
// Property key under which we stash the popupshowing listener on the item menu
// element, so a stale one can be removed even after a hot-reload.
const SHOWING_KEY = `${ID}-onShowing`;

/** Remove any UI we (or a previous hot-reloaded instance) injected into a window. */
function clearWindowUI(win: Window): void {
  const doc = win.document;
  // Use querySelectorAll, not getElementById: stacked hot-reloads can leave
  // several elements sharing the same id, and we must remove all of them.
  ELEMENT_IDS.forEach((id) =>
    doc.querySelectorAll(`#${id}`).forEach((el: Element) => el.remove()),
  );
  const itemmenu = doc.getElementById("zotero-itemmenu") as any;
  if (itemmenu?.[SHOWING_KEY]) {
    itemmenu.removeEventListener("popupshowing", itemmenu[SHOWING_KEY]);
    delete itemmenu[SHOWING_KEY];
  }
}

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
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    const push = await engine.pushAll(report);
    const pull = await engine.pullAll(report);
    pw.changeLine({
      progress: 100,
      text: getString("sync-complete", {
        args: { pushed: push.pushed, annotations: pull.annotations },
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

function registerToolbarButton(win: Window): void {
  const doc = win.document;
  const toolbar = doc.getElementById("zotero-items-toolbar");
  if (!toolbar) return;

  // Constrain the button icon to 16px so it matches Zotero's own buttons.
  const style = doc.createElementNS(
    "http://www.w3.org/1999/xhtml",
    "style",
  ) as HTMLStyleElement;
  style.id = `${ID}-style`;
  style.textContent = `#${ID}-tb-syncnow .toolbarbutton-icon { width: 16px; height: 16px; }`;
  doc.documentElement?.appendChild(style);

  const btn = (doc as any).createXULElement("toolbarbutton") as Element;
  btn.id = `${ID}-tb-syncnow`;
  btn.setAttribute("class", "zotero-tb-button");
  btn.setAttribute("tooltiptext", getString("menuitem-sync-now"));
  btn.setAttribute("image", ICON);
  btn.addEventListener("command", () => void runSyncNow());
  toolbar.appendChild(btn);
}

function registerToolsMenu(win: Window): void {
  const doc = win.document;
  const toolsPopup = doc.getElementById("menu_ToolsPopup");
  if (!toolsPopup) return;
  toolsPopup.appendChild(
    makeMenuitem(
      doc,
      "tools-syncnow",
      getString("menuitem-sync-now"),
      () => void runSyncNow(),
    ),
  );
}

function registerContextMenu(win: Window): void {
  const doc = win.document;
  const itemmenu = doc.getElementById("zotero-itemmenu");
  if (!itemmenu) return;

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

  [sep, addItem, removeItem].forEach((n) => itemmenu.appendChild(n));

  const onShowing = () => {
    const items = selectedRegularItems(win);
    const anyUnsynced = items.some((i) => !engine.isItemSynced(i));
    const anySynced = items.some((i) => engine.isItemSynced(i));
    (addItem as any).hidden = !anyUnsynced;
    (removeItem as any).hidden = !anySynced;
    (sep as any).hidden = items.length === 0;
  };
  itemmenu.addEventListener("popupshowing", onShowing);
  (itemmenu as any)[SHOWING_KEY] = onShowing;
}

export function registerWindowUI(win: Window): void {
  // Idempotent: drop any leftovers from a previous (hot-reloaded) instance.
  clearWindowUI(win);
  registerToolbarButton(win);
  registerToolsMenu(win);
  registerContextMenu(win);
}

export function unregisterWindowUI(win: Window): void {
  clearWindowUI(win);
}

/** Tear down per-window UI in every open main window. */
export function unregisterAllWindows(): void {
  for (const win of Zotero.getMainWindows()) {
    clearWindowUI(win as unknown as Window);
  }
}

// ---------------------------------------------------------------------------
// Item-pane status section
// ---------------------------------------------------------------------------

export function registerSection(): void {
  // Idempotent: a previous (hot-reloaded) instance may have left it registered.
  unregisterSection();
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
}

export function unregisterSection(): void {
  try {
    Zotero.ItemPaneManager.unregisterSection(SECTION_ID);
  } catch {
    // not registered — fine
  }
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
