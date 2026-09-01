// UI surface for the plugin:
//  - a toolbar button + Tools-menu item for "Sync now",
//  - a native item context-menu for Add / Remove from sync,
//  - an item-pane status section with toggle + sync buttons,
//  - the progress-window runner shared by all of them.

import { config } from "../../package.json";
import { getString, getLocaleID } from "../utils/locale";
import { getPref } from "../utils/prefs";
import { log, errMsg, errDetail } from "../utils/log";
import * as engine from "./sync/engine";
import { pushAnnotations } from "./sync/push";
import { pullEpubAll, pushEpubAll, resolveEpubTargets } from "./sync/epubDocs";
import { pushNotes } from "./sync/notes";
import * as client from "./remarkable/client";
import {
  scanUntrackedPdfs,
  importCandidates,
  type UntrackedCandidate,
} from "./sync/importUntracked";

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
  `${ID}-tools-import-untracked`,
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
    showNotice(getString("status-not-connected"), "fail", 4000);
    return;
  }

  const pw = newProgress();

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
    failProgress(pw, "runSyncNow", e);
  }
}

/** Force a re-pull of annotations (ignores the unchanged-since-last-pull guard). */
export async function runForcePull(): Promise<void> {
  if (!client.isConnected()) {
    showNotice(getString("status-not-connected"), "fail", 4000);
    return;
  }
  const pw = newProgress();
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
    failProgress(pw, "runForcePull", e);
  }
}

/** Push Zotero-origin annotations to the reMarkable device. */
export async function runPush(): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const pw = newProgress();
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
    failProgress(pw, "runPush", e);
  }
}

/** Remove all plugin-created annotations and reset pull state (manual reset). */
export async function runClearPulled(): Promise<void> {
  const pw = newProgress(50);
  try {
    const removed = await engine.clearPulledAnnotations();
    pw.changeLine({
      progress: 100,
      text: getString("clear-done", { args: { count: removed } }),
    });
    pw.startCloseTimer(5000);
  } catch (e) {
    failProgress(pw, "runClearPulled", e);
  }
}

/**
 * Scan the reMarkable sync folder for PDFs this plugin has never tracked,
 * let the user pick which to import, and create matching Zotero items.
 */
export async function runImportUntracked(): Promise<void> {
  if (notConnected()) return;
  const scanPw = newProgress();
  let candidates: UntrackedCandidate[];
  try {
    scanPw.changeLine({
      progress: 0,
      text: getString("import-scanning"),
    });
    candidates = await scanUntrackedPdfs();
    if (candidates.length === 0) {
      const folder = (getPref("folder") || "").toString() || "/";
      scanPw.changeLine({
        progress: 100,
        text: getString("import-none-found", { args: { folder } }),
      });
      scanPw.startCloseTimer(5000);
      return;
    }
    scanPw.close();
  } catch (e) {
    failProgress(scanPw, "runImportUntracked scan", e);
    return;
  }

  const selected = await confirmImportDialog(candidates);
  if (!selected || selected.length === 0) return;

  const pw = newProgress();
  try {
    const report = (text: string, pct: number) =>
      pw.changeLine({ progress: pct, text });
    const result = await importCandidates(selected, report);
    pw.changeLine({
      progress: 100,
      text: getString("import-done", {
        args: {
          imported: result.imported,
          total: selected.length,
        },
      }),
    });
    pw.startCloseTimer(5000);
    refreshStatusDots();
  } catch (e) {
    failProgress(pw, "runImportUntracked import", e);
  }
}

/** Checklist of untracked PDFs. Returns the selected ones, or null if cancelled. */
async function confirmImportDialog(
  candidates: UntrackedCandidate[],
): Promise<UntrackedCandidate[] | null> {
  const dialogData: Record<string, unknown> = {};
  for (let i = 0; i < candidates.length; i++) {
    dialogData[`check-${i}`] = true;
  }

  const dialog = new ztoolkit.Dialog(2, 1)
    .addCell(0, 0, {
      tag: "div",
      properties: { textContent: getString("import-confirm-body") },
      styles: { margin: "8px", maxWidth: "480px" },
    })
    .addCell(1, 0, {
      tag: "div",
      styles: {
        maxHeight: "360px",
        overflow: "auto",
        margin: "8px",
      },
      children: candidates.map((c, i) => ({
        tag: "label",
        namespace: "html",
        styles: { display: "block", margin: "4px 0" },
        children: [
          {
            tag: "input",
            namespace: "html",
            attributes: {
              type: "checkbox",
              "data-bind": `check-${i}`,
              "data-prop": "checked",
            },
            properties: { checked: true },
          },
          {
            tag: "span",
            namespace: "html",
            properties: { textContent: ` ${c.visibleName}` },
          },
        ],
      })),
    })
    .addButton(getString("import-confirm-import"), "import")
    .addButton(getString("import-confirm-cancel"), "cancel")
    .setDialogData(dialogData)
    .open(getString("import-confirm-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: true,
    });

  const data = dialog.dialogData as {
    _lastButtonId?: string;
    unloadLock?: { promise: Promise<void> };
    [key: string]: unknown;
  };
  await data.unloadLock?.promise;
  if (data._lastButtonId !== "import") return null;
  return candidates.filter((_, i) => !!data[`check-${i}`]);
}

function notConnected(): boolean {
  if (client.isConnected()) return false;
  showNotice(getString("status-not-connected"), "fail", 4000);
  return true;
}

/** Block device-mutating annotation pushes while safe mode is on (with notice). */
function blockedBySafeMode(): boolean {
  if (!engine.isSafeMode()) return false;
  showNotice(getString("safe-mode-blocked"), "fail", 5000);
  return true;
}

/**
 * Show the full, untruncated error text in a resizable dialog with a Copy
 * button. Zotero's native progress popup truncates long lines via XUL
 * `crop`, which CSS cannot override, so the short popup line alone can show
 * "…without any details" — this dialog is the reliable place to read (and
 * copy) the actual error.
 */
export function showErrorDetails(headline: string, detail: string): void {
  const dialog = new ztoolkit.Dialog(2, 1)
    .addCell(0, 0, {
      tag: "div",
      properties: { textContent: headline },
      styles: { margin: "8px", fontWeight: "600", maxWidth: "520px" },
    })
    .addCell(1, 0, {
      tag: "textarea",
      namespace: "html",
      attributes: { readonly: "readonly", rows: "10" },
      properties: { value: detail },
      styles: {
        display: "block",
        margin: "8px",
        width: "500px",
        boxSizing: "border-box",
        fontFamily: "monospace",
        fontSize: "12px",
        whiteSpace: "pre-wrap",
      },
    })
    .addButton(getString("error-copy"), "copy")
    .addButton(getString("error-close"), "close")
    .open(getString("error-dialog-title"), {
      centerscreen: true,
      resizable: true,
      fitContent: true,
    });

  const data = dialog.dialogData as {
    _lastButtonId?: string;
    unloadLock?: { promise: Promise<void> };
    [key: string]: unknown;
  };
  data.unloadLock?.promise.then(() => {
    if (data._lastButtonId === "copy") {
      try {
        Zotero.Utilities.Internal.copyTextToClipboard(detail);
      } catch (e) {
        log("showErrorDetails: copy failed:", errMsg(e));
      }
    }
  });
}

// A raw JSON.parse failure surfacing all the way up from inside rmapi-js
// (e.g. getRootHash/putRootHash/uploadFile/getEntries) used to mean whatever
// endpoint it was reading got an empty body — Zotero.HTTP.request's
// "arraybuffer" responseType is simply unimplemented and always empty. Fixed
// at the transport level in globals.ts's zoteroHttpRequest via
// responseType "text" + overrideMimeType("text/plain; charset=x-user-defined")
// in requestObserver (see xhrToArrayBuffer). Kept as a safety net:
// getLastRequestSummary() carries the exact status/content-length/bytes-read
// for whichever request actually failed, which rmapi-js's own error has no
// way to attach, so append it here instead of sending the user back to
// Debug Output Logging if anything like this ever resurfaces.
const JSON_PARSE_ERROR_RE = /JSON\.parse|Unexpected token|Unexpected end of/i;

/** Fail a progress popup and pop up the full error in a copyable dialog. */
function failProgress(
  pw: ReturnType<typeof newProgress>,
  context: string,
  e: unknown,
): void {
  log(`${context} error:`, e);
  const text = getString("sync-error", { args: { error: errMsg(e) } });
  pw.changeLine({ type: "fail", progress: 100, text });
  pw.startCloseTimer(8000);
  let detail = errDetail(e);
  if (JSON_PARSE_ERROR_RE.test(detail)) {
    detail += `\n\nLast request: ${client.getLastRequestSummary()}`;
  }
  showErrorDetails(text, detail);
}

const PROGRESS_STYLE_ID = `${ID}-progress-style`;

/**
 * Zotero's built-in progress popup is a compact chrome window (~250px,
 * 11px type). Inject a stylesheet so reMarkable notices are readable.
 */
function enlargeProgressPopup(pw: unknown): void {
  let tries = 0;
  const tick = () => {
    tries++;
    const line = (pw as { lines?: Array<{ _hbox?: Element }> }).lines?.[0];
    const node = line?._hbox;
    const doc = node?.ownerDocument;
    if (!doc) {
      if (tries < 40) setTimeout(tick, 50);
      return;
    }
    if (!doc.getElementById(PROGRESS_STYLE_ID)) {
      const style = doc.createElementNS(
        "http://www.w3.org/1999/xhtml",
        "style",
      ) as HTMLStyleElement;
      style.id = PROGRESS_STYLE_ID;
      style.textContent = `
        window, :root {
          min-width: 28em !important;
          font-size: 14px !important;
        }
        #zotero-progress-text-box {
          min-width: 26em !important;
          padding: 8px 12px 12px !important;
        }
        #zotero-progress-text-headline,
        #zotero-progress-text-headline label {
          font-size: 16px !important;
          font-weight: 600 !important;
        }
        .zotero-progress-item-hbox {
          min-width: 24em;
          min-height: 1.6em;
          margin-top: 8px !important;
        }
        .zotero-progress-item-label {
          font-size: 14px !important;
          line-height: 1.35 !important;
        }
      `;
      const parent = doc.head ?? doc.documentElement;
      parent?.appendChild(style);
    }
    try {
      doc.defaultView?.sizeToContent?.();
    } catch {
      /* ignore */
    }
  };
  setTimeout(tick, 50);
}

function showNotice(text: string, type?: string, closeTime = 4000) {
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime,
  })
    .createLine({ text, type })
    .show(closeTime);
  enlargeProgressPopup(pw);
  return pw;
}

function newProgress(progress = 0) {
  const pw = new ztoolkit.ProgressWindow(config.addonName, {
    closeOnClick: true,
    closeTime: -1,
  })
    .createLine({ text: getString("sync-running"), progress })
    .show();
  enlargeProgressPopup(pw);
  return pw;
}

/** Force-push the selected items' PDFs + annotations to the device (Zotero wins). */
export async function runOverwriteFromZotero(
  items: Zotero.Item[],
): Promise<void> {
  if (notConnected() || blockedBySafeMode()) return;
  const atts = engine.pdfAttachmentsOf(items);
  const epubTargets = await resolveEpubTargets(items);
  if (atts.length === 0 && epubTargets.length === 0) {
    showNotice(getString("nothing-selected"), "fail", 3000);
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
    failProgress(pw, "runOverwriteFromZotero", e);
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
    showNotice(getString("nothing-selected"), "fail", 3000);
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
    failProgress(pw, "runOverwriteFromRemarkable", e);
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
  toolsPopup.appendChild(
    makeMenuitem(
      doc,
      "tools-import-untracked",
      getString("menuitem-import-untracked"),
      () => void runImportUntracked(),
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
