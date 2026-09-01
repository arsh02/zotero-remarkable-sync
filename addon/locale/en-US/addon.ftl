startup-begin = reMarkable Sync is loading
startup-finish = reMarkable Sync is ready

menuitem-sync-now = reMarkable: Sync now
menuitem-push = reMarkable: Push annotations to device
menuitem-force-pull = reMarkable: Force re-pull annotations
menuitem-clear-pulled = reMarkable: Remove pulled annotations
menuitem-add-to-sync = reMarkable: Add to sync
menuitem-remove-from-sync = reMarkable: Remove from sync
menuitem-overwrite-from-zotero = reMarkable: Overwrite device from Zotero
menuitem-overwrite-from-remarkable = reMarkable: Overwrite Zotero from device
menuitem-import-untracked = reMarkable: Import untracked PDFs…

status-synced = Synced to reMarkable
status-not-synced = Not synced
status-not-connected = Not connected to reMarkable. Connect in the plugin preferences.

sync-now = Sync now
sync-running = Syncing…
sync-done = Pushed { $pushed }, skipped { $skipped }, failed { $failed }
sync-complete = { $files } up · { $sent } sent · +{ $added } −{ $removed }{ $stopped ->
    [0] {""}
   *[other] { " · " }{ $stopped } unsynced (deleted on device)
}
safe-mode-blocked = Safe mode is on — turn it off in preferences to push annotations to the device.
pull-done = Pulled +{ $added } −{ $removed }
clear-done = Removed { $count } pulled annotation(s)
push-done = Pushed { $pushed } annotation(s) to device, skipped { $skipped }
overwrite-zotero-done = Device overwritten from Zotero: { $sent } annotation(s) sent
overwrite-remarkable-done = Zotero overwritten from device: +{ $added } −{ $removed }
nothing-selected = No items selected
sync-error = reMarkable sync error: { $error }
import-scanning = Scanning reMarkable for untracked PDFs…
import-none-found = No untracked PDFs found in { $folder }
import-confirm-title = Import from reMarkable
import-confirm-body = These PDFs are already on the reMarkable in the sync folder, but are not tracked in Zotero. Import the selected ones:
import-confirm-import = Import
import-confirm-cancel = Cancel
import-done = Imported { $imported } of { $total } PDF(s) into reMarkable Imports
error-dialog-title = reMarkable Sync — Error Details
error-copy = Copy
error-close = Close
