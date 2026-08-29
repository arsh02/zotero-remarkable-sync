// Interval auto-sync. When the "interval" sync mode is selected, run a full
// push + pull on a repeating timer. Driven entirely by prefs; restart whenever
// they change.

import { getPref } from "../utils/prefs";
import { log, errMsg } from "../utils/log";
import * as client from "./remarkable/client";
import * as engine from "./sync/engine";
import { pushAnnotations } from "./sync/push";
import { pullEpubAll, pushEpubAll } from "./sync/epubDocs";
import { pushNotes } from "./sync/notes";

const Cc = Components.classes as any;
const Ci = Components.interfaces as any;

let timer: any = null;
let ticking = false;

async function tick(): Promise<void> {
  if (ticking) return; // don't overlap with a previous (slow) run
  if (!client.isConnected()) return;
  ticking = true;
  try {
    log("scheduler: auto-sync tick");
    await engine.pushAll();
    await pushAnnotations();
    await engine.pullAll();
    // DOCX companions: pull before push — a push may fully replace the
    // generated EPUB (see epubDocs.ts), so pull first to capture highlights.
    await pullEpubAll();
    await pushEpubAll();
    await pushNotes();
  } catch (e) {
    log("scheduler: tick error:", errMsg(e));
  } finally {
    ticking = false;
  }
}

/** (Re)start the scheduler from current prefs. No-op unless mode is "interval". */
export function start(): void {
  stop();
  if (getPref("syncMode") !== "interval") return;
  const minutes = Math.max(1, Number(getPref("syncInterval")) || 30);
  timer = Cc["@mozilla.org/timer;1"].createInstance(Ci.nsITimer);
  timer.initWithCallback(
    { notify: () => void tick() },
    minutes * 60 * 1000,
    Ci.nsITimer.TYPE_REPEATING_SLACK,
  );
  log(`scheduler: started (every ${minutes} min)`);
}

export function stop(): void {
  if (timer) {
    try {
      timer.cancel();
    } catch {
      /* ignore */
    }
    timer = null;
  }
}
