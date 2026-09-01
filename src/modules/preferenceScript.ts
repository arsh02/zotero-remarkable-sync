import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { log, errMsg, errDetail } from "../utils/log";
import * as client from "./remarkable/client";
import * as scheduler from "./scheduler";
import { showErrorDetails } from "./ui";

// Populated by "Check network certificate" and consumed by "Trust this
// network's certificate" — deliberately in-memory only (not persisted), so
// a stale chain from a previous profile/session can never be trusted by
// accident; each Trust click acts strictly on the most recent Check.
let lastCertChainForTrust: string[] | null = null;

/**
 * Register the plugin's preference pane so it appears in Zotero Settings.
 * Auto-unregistered by Zotero on plugin shutdown.
 */
export async function registerPrefPane() {
  await Zotero.PreferencePanes.register({
    pluginID: config.addonID,
    src: rootURI + "content/preferences.xhtml",
    label: config.addonName,
    image: `chrome://${config.addonRef}/content/icons/favicon.png`,
  });
}

export async function registerPrefsScripts(_window: Window) {
  // Called when the prefs pane is opened (see preferences.xhtml onload).
  if (!addon.data.prefs) {
    addon.data.prefs = { window: _window };
  } else {
    addon.data.prefs.window = _window;
  }
  updateConnectionStatus();
  bindPrefEvents();
}

function el(id: string): HTMLElement | null {
  const doc = addon.data.prefs?.window?.document;
  return (
    doc?.querySelector(`#zotero-prefpane-${config.addonRef}-${id}`) ?? null
  );
}

function setStatus(text: string) {
  const status = el("status");
  if (!status) return;
  // Set text directly: Fluent message ids are prefixed at build time, so
  // swapping data-l10n-id at runtime is brittle.
  status.removeAttribute("data-l10n-id");
  status.textContent = text;
}

function setDisabled(id: string, disabled: boolean) {
  const node = el(id);
  if (!node) return;
  if (disabled) node.setAttribute("disabled", "true");
  else node.removeAttribute("disabled");
}

export function updateConnectionStatus() {
  const connected = client.isConnected();
  setStatus(
    getString(
      connected
        ? "pref-connection-status-connected"
        : "pref-connection-status-disconnected",
    ),
  );
  setDisabled("disconnect", !connected);
}

function bindPrefEvents() {
  // registerPrefsScripts runs on every pane onload. If the same DOM is
  // reused, stacking another set of listeners makes Connect fire twice
  // with the same one-time code (second request gets an empty 2xx body).
  const connectBtn = el("connect");
  if (!connectBtn || connectBtn.getAttribute("data-rms-bound") === "1") return;
  connectBtn.setAttribute("data-rms-bound", "1");

  el("connect-link")?.addEventListener("click", (ev) => {
    ev.preventDefault();
    Zotero.launchURL(client.CONNECT_URL);
  });

  connectBtn.addEventListener("command", async () => {
    const input = el("code") as HTMLInputElement | null;
    const code = input?.value?.trim();
    if (!code) return;
    setStatus(getString("pref-connection-status-connecting"));
    try {
      await client.connect(code);
      if (input) input.value = "";
      updateConnectionStatus();
    } catch (e) {
      log("connect failed:", errDetail(e));
      const text = getString("pref-connection-status-error", {
        args: { error: errMsg(e) },
      });
      setStatus(text);
      showErrorDetails(text, errDetail(e));
    }
  });

  el("disconnect")?.addEventListener("command", () => {
    client.disconnect();
    updateConnectionStatus();
  });

  function setCertStatus(text: string) {
    const status = el("cert-status");
    if (status) status.textContent = text;
  }

  el("check-cert")?.addEventListener("command", async () => {
    lastCertChainForTrust = null;
    setDisabled("trust-cert", true);
    setDisabled("check-cert", true);
    setCertStatus("Checking…");
    try {
      const result = await client.probeCertificate();
      setCertStatus(result.detail);
      if (result.chainForTrust) {
        lastCertChainForTrust = result.chainForTrust;
        setDisabled("trust-cert", false);
      }
    } catch (e) {
      log("check-cert failed:", errDetail(e));
      setCertStatus(`Check failed: ${errMsg(e)}`);
    } finally {
      setDisabled("check-cert", false);
    }
  });

  el("trust-cert")?.addEventListener("command", () => {
    if (!lastCertChainForTrust) {
      setCertStatus(
        "No pending certificate to trust — click \u201CCheck network certificate\u201D first.",
      );
      return;
    }
    const result = client.trustCertificate(lastCertChainForTrust);
    setCertStatus(result.detail);
    if (result.ok) {
      lastCertChainForTrust = null;
      setDisabled("trust-cert", true);
    }
  });

  // Restart the auto-sync timer when the schedule prefs change. The preference
  // binding writes the pref before this fires, so scheduler.start() reads fresh
  // values.
  const restart = () => scheduler.start();
  el("mode")?.addEventListener("command", restart);
  el("interval")?.addEventListener("change", restart);
}
