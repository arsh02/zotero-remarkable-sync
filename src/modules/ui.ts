// UI surface for the plugin:
//  - a toolbar button + Tools-menu item for "Sync now",
//  - a native item context-menu for Add / Remove from sync,
//  - an item-pane status section with toggle + sync buttons,
//  - the progress-window runner shared by all of them.

import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import { log, errMsg } from "../utils/log";
import * as engine from "./sync/engine";
import { pushAnnotations } from "./sync/push";
import { pullEpubAll, pushEpubAll, resolveEpubTargets } from "./sync/epubDocs";
import { pushNotes } from "./sync/notes";
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
  `${ID}-tools-push`,
  `${ID}-tools-forcepull`,
  `${ID}-tools-clearpulled`,
  `${ID}-sep`,
  `${ID}-add`,
  `${ID}-remove`,
  `${ID}-ovr-zotero`,
  `${ID}-ovr-remarkable`,
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
    const runOnce = async () => {
      const push = await engine.pushAll(report);
      const sent = await pushAnnotations(report);
      log("runSyncNow: push done, starting pull");
      const pull = await engine.pullAll(report);

      // DOCX companion EPUBs are fully replaced on every annotation-bearing
      // push (reMarkable has no in-place content update — see epubDocs.ts), so
      // we pull first here to capture any not-yet-synced device highlights
      // before they'd otherwise be lost — the opposite order from PDF above.
      const epubPull = await pullEpubAll(report);
      const epubPush = await pushEpubAll(report);
      const notesPush = await pushNotes(report);

      return {
        push: {
          pushed: push.pushed + epubPush.pushed + notesPush.pushed,
          skipped: push.skipped + epubPush.skipped + notesPush.skipped,
          stopped: push.stopped + epubPush.stopped + notesPush.stopped,
          failed: push.failed + epubPush.failed + notesPush.failed,
          errors: [...push.errors, ...epubPush.errors, ...notesPush.errors],
        },
        sent,
        pull: {
          updated: pull.updated + epubPull.updated,
          annotations: pull.annotations + epubPull.annotations,
          removed: pull.removed + epubPull.removed,
          failed: pull.failed + epubPull.failed,
          errors: [...pull.errors, ...epubPull.errors],
        },
      };
    };
    let push, sent, pull;
    try {
      ({ push, sent, pull } = await runOnce());
    } catch (e) {
      // A stalled/aborted request usually means a stale session token. Drop the
      // cached session, re-authenticate, and try the whole run once more.
      log("runSyncNow: first attempt failed, refreshing session:", errMsg(e));
      report(getString("sync-running"), 0);
      client.resetApi();
      ({ push, sent, pull } = await runOnce());
    }
    pw.changeLine({
      progress: 100,
      text: getString("sync-complete", {
        args: {
          files: push.pushed,
          sent: sent.pushed,
          added: pull.annotations,
          removed: pull.removed,
          stopped: push.stopped,
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

/** Force a re-pull of annotations (ignores the unchanged-since-last-pull guard). */
export async function runForcePull(): Promise<void> {
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
    const pull = await engine.pullAll(report, { force: true });
    const epubPull = await pullEpubAll(report, { force: true });
    pw.changeLine({
      progress: 100,
      text: getString("pull-done", {
        args: {
          added: pull.annotations + epubPull.annotations,
          removed: pull.removed + epubPull.removed,
        },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runForcePull error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Push Zotero-origin annotations to the reMarkable device. */
export async function runPush(): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();
  try {
    const summary = await pushAnnotations((text, pct) =>
      pw.changeLine({ progress: pct, text }),
    );
    pw.changeLine({
      progress: 100,
      text: getString("push-done", {
        args: { pushed: summary.pushed, skipped: summary.skipped },
      }),
    });
    pw.startCloseTimer(6000);
  } catch (e) {
    log("runPush error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Remove all plugin-created annotations and reset pull state (manual reset). */
export async function runClearPulled(): Promise<void> {
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 50 })
    .show();
  try {
    const removed = await engine.clearPulledAnnotations();
    pw.changeLine({
      progress: 100,
      text: getString("clear-done", { args: { count: removed } }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runClearPulled error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

function notConnected(): boolean {
  if (client.isConnected()) return false;
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: getString("status-not-connected"), type: "fail" })
    .show(4000);
  return true;
}

/** Block device-mutating annotation pushes while safe mode is on (with notice). */
function blockedBySafeMode(): boolean {
  if (!engine.isSafeMode()) return false;
  new ztoolkit.ProgressWindow(config.addonName)
    .createLine({ text: getString("safe-mode-blocked"), type: "fail" })
    .show(5000);
  return true;
}

function newProgress() {
  return new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress: 0 })
    .show();
}

/** Force-push the selected items' PDFs + annotations to the device (Zotero wins). */
export async function runOverwriteFromZotero(
  items: Zotero.Item[],
): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const atts = engine.pdfAttachmentsOf(items);
  const epubTargets = await resolveEpubTargets(items);
  if (atts.length === 0 && epubTargets.length === 0) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("nothing-selected"), type: "fail" })
      .show(3000);
    return;
  }
  const onlyKeys = new Set(atts.map((a) => a.key));
  const pw = newProgress();
  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    await engine.pushAll(report, { attachments: atts, force: true });
    const ann = await pushAnnotations(report, { onlyKeys });
    // Companion annotations are re-baked from the current Zotero state on
    // every forced push, so no separate "pull first" step is needed here.
    await pushEpubAll(report, { targets: epubTargets, force: true });
    pw.changeLine({
      progress: 100,
      text: getString("overwrite-zotero-done", { args: { sent: ann.pushed } }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runOverwriteFromZotero error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Force-pull the selected items' annotations from the device (device wins). */
export async function runOverwriteFromRemarkable(
  items: Zotero.Item[],
): Promise<void> {
  if (notConnected()) return;
  const atts = engine.pdfAttachmentsOf(items);
  const epubTargets = await resolveEpubTargets(items);
  const epubKeys = new Set(epubTargets.map((t) => t.att.key));
  if (atts.length === 0 && epubKeys.size === 0) {
    new ztoolkit.ProgressWindow(config.addonName)
      .createLine({ text: getString("nothing-selected"), type: "fail" })
      .show(3000);
    return;
  }
  const onlyKeys = new Set(atts.map((a) => a.key));
  const pw = newProgress();
  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    await engine.resetPullState([...onlyKeys, ...epubKeys]);
    const pull = await engine.pullAll(report, { force: true, onlyKeys });
    const epubPull = await pullEpubAll(report, {
      force: true,
      onlyKeys: epubKeys,
    });
    pw.changeLine({
      progress: 100,
      text: getString("overwrite-remarkable-done", {
        args: {
          added: pull.annotations + epubPull.annotations,
          removed: pull.removed + epubPull.removed,
        },
      }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    log("runOverwriteFromRemarkable error:", e);
    pw.changeLine({
      type: "fail",
      progress: 100,
      text: getString("sync-error", { args: { error: errMsg(e) } }),
    });
    pw.startCloseTimer(8000);
  }
}

/** Repaint item-tree status dots after a membership change. */
function refreshStatusDots(): void {
  for (const win of Zotero.getMainWindows()) {
    try {
      (win as any)?.ZoteroPane?.itemsView?.tree?.invalidate?.();
    } catch {
      /* ignore */
    }
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
  toolsPopup.appendChild(
    makeMenuitem(
      doc,
      "tools-push",
      getString("menuitem-push"),
      () => void runPush(),
    ),
  );
  toolsPopup.appendChild(
    makeMenuitem(
      doc,
      "tools-forcepull",
      getString("menuitem-force-pull"),
      () => void runForcePull(),
    ),
  );
  toolsPopup.appendChild(
    makeMenuitem(
      doc,
      "tools-clearpulled",
      getString("menuitem-clear-pulled"),
      () => void runClearPulled(),
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
        .then(() => refreshStatusDots())
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
        .then(() => refreshStatusDots())
        .catch((e) => log("removeFromSync error:", e));
    },
  );
  const ovrZotero = makeMenuitem(
    doc,
    "ovr-zotero",
    getString("menuitem-overwrite-from-zotero"),
    () => void runOverwriteFromZotero(selectedRegularItems(win)),
  );
  const ovrRemarkable = makeMenuitem(
    doc,
    "ovr-remarkable",
    getString("menuitem-overwrite-from-remarkable"),
    () => void runOverwriteFromRemarkable(selectedRegularItems(win)),
  );

  [sep, addItem, removeItem, ovrZotero, ovrRemarkable].forEach((n) =>
    itemmenu.appendChild(n),
  );

  const onShowing = () => {
    const items = selectedRegularItems(win);
    const anyUnsynced = items.some((i) => !engine.isItemSynced(i));
    const anySynced = items.some((i) => engine.isItemSynced(i));
    (addItem as any).hidden = !anyUnsynced;
    (removeItem as any).hidden = !anySynced;
    // Overwrite actions only make sense for already-synced items.
    (ovrZotero as any).hidden = !anySynced;
    (ovrRemarkable as any).hidden = !anySynced;
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

  // Guide the user to connect first.
  if (!client.isConnected()) {
    const hint = doc.createElement("div");
    hint.style.opacity = "0.8";
    hint.textContent = getString("status-not-connected");
    body.appendChild(hint);
    return;
  }

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
