import { initLocale } from "./utils/locale";
import {
  registerPrefPane,
  registerPrefsScripts,
} from "./modules/preferenceScript";
import { createZToolkit } from "./utils/ztoolkit";
import { log } from "./utils/log";
import * as ui from "./modules/ui";

// Build marker — bump when shipping a build you want to confirm is loaded.
const BUILD = "M2-pull-annotations";

async function onStartup() {
  await Promise.all([
    Zotero.initializationPromise,
    Zotero.unlockPromise,
    Zotero.uiReadyPromise,
  ]);

  log(`reMarkable Sync loaded — build ${BUILD}`);
  initLocale();

  // Register the Settings pane and the item-pane status section (both global,
  // registered once — not per window).
  await registerPrefPane();
  ui.registerSection();

  await Promise.all(
    Zotero.getMainWindows().map((win) => onMainWindowLoad(win)),
  );

  // Mark initialized as true to confirm plugin loading status
  // outside of the plugin (e.g. scaffold testing process)
  addon.data.initialized = true;
}

async function onMainWindowLoad(win: _ZoteroTypes.MainWindow): Promise<void> {
  // Create ztoolkit for every window
  addon.data.ztoolkit = createZToolkit();

  win.MozXULElement.insertFTLIfNeeded(
    `${addon.data.config.addonRef}-mainWindow.ftl`,
  );

  // Register this window's UI: toolbar button, Tools menu, context menu.
  ui.registerWindowUI(win);
}

async function onMainWindowUnload(win: Window): Promise<void> {
  ui.unregisterWindowUI(win);
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
}

function onShutdown(): void {
  ui.unregisterAllWindows();
  ui.unregisterSection();
  ztoolkit.unregisterAll();
  addon.data.dialog?.window?.close();
  // Remove addon object
  addon.data.alive = false;
  // @ts-expect-error - Plugin instance is not typed
  delete Zotero[addon.data.config.addonInstance];
}

/**
 * Dispatcher for Notify events. Hooks only dispatch; real work lives in modules.
 */
async function onNotify(
  event: string,
  type: string,
  ids: Array<string | number>,
  extraData: { [key: string]: any },
) {
  ztoolkit.log("notify", event, type, ids, extraData);
}

/**
 * Dispatcher for Preference UI events.
 */
async function onPrefsEvent(type: string, data: { [key: string]: any }) {
  switch (type) {
    case "load":
      registerPrefsScripts(data.window);
      break;
    default:
      return;
  }
}

function onShortcuts(_type: string) {}

function onDialogEvents(_type: string) {}

export default {
  onStartup,
  onShutdown,
  onMainWindowLoad,
  onMainWindowUnload,
  onNotify,
  onPrefsEvent,
  onShortcuts,
  onDialogEvents,
};
