import { config } from "../../package.json";
import { getString } from "../utils/locale";
import { getPref } from "../utils/prefs";
import * as client from "./remarkable/client";

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

export function updateConnectionStatus() {
  const connected = !!getPref("deviceToken");
  setStatus(
    getString(
      connected
        ? "pref-connection-status-connected"
        : "pref-connection-status-disconnected",
    ),
  );
}

function bindPrefEvents() {
  el("connect")?.addEventListener("command", async () => {
    const input = el("code") as HTMLInputElement | null;
    const code = input?.value?.trim();
    if (!code) return;
    setStatus(getString("pref-connection-status-connecting"));
    try {
      await client.connect(code);
      if (input) input.value = "";
      updateConnectionStatus();
    } catch (e) {
      setStatus(
        getString("pref-connection-status-error", {
          args: { error: (e as Error).message ?? String(e) },
        }),
      );
    }
  });
}
