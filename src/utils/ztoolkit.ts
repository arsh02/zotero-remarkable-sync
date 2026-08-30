import { ZoteroToolkit } from "zotero-plugin-toolkit";
import { config } from "../../package.json";

export { createZToolkit };

function createZToolkit() {
  const _ztoolkit = new ZoteroToolkit();
  /**
   * Alternatively, import toolkit modules you use to minify the plugin size.
   * You can add the modules under the `MyToolkit` class below and uncomment the following line.
   */
  // const _ztoolkit = new MyToolkit();
  initZToolkit(_ztoolkit);
  return _ztoolkit;
}

function initZToolkit(_ztoolkit: ReturnType<typeof createZToolkit>) {
  _ztoolkit.basicOptions.log.prefix = `[${config.addonName}]`;
  // Always disable the toolkit console logger: on Zotero 9 it initialises a
  // ConsoleAPI via the removed `ChromeUtils.import`, which throws. We log via
  // src/utils/log.ts (Zotero.debug) instead.
  _ztoolkit.basicOptions.log.disableConsole = true;
  _ztoolkit.UI.basicOptions.ui.enableElementJSONLog = __env__ === "development";
  _ztoolkit.UI.basicOptions.ui.enableElementDOMLog = __env__ === "development";
  // Getting basicOptions.debug will load global modules like the debug bridge.
  // since we want to deprecate it, should avoid using it unless necessary.
  // _ztoolkit.basicOptions.debug.disableDebugBridgePassword =
  //   __env__ === "development";
  _ztoolkit.basicOptions.api.pluginID = config.addonID;
  const iconBase = `chrome://${config.addonRef}/content/icons`;
  // Zotero 9 removed chrome://zotero/skin/{tick,cross}.png. Point the
  // toolkit ProgressWindow at icons we ship so fail/success lines do not
  // log "Missing chrome or resource URL".
  _ztoolkit.ProgressWindow.setIconURI("default", `${iconBase}/favicon.png`);
  _ztoolkit.ProgressWindow.setIconURI("success", `${iconBase}/tick.svg`);
  _ztoolkit.ProgressWindow.setIconURI("fail", `${iconBase}/cross.svg`);
}

import { BasicTool, unregister } from "zotero-plugin-toolkit";
import { UITool } from "zotero-plugin-toolkit";

class MyToolkit extends BasicTool {
  UI: UITool;

  constructor() {
    super();
    this.UI = new UITool(this);
  }

  unregisterAll() {
    unregister(this);
  }
}
