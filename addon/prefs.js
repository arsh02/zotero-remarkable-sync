// Default preferences. Keys are prefixed with `prefsPrefix` at build time.

// Tag that marks which items should be synced to the reMarkable.
pref("syncTag", "@remarkable");
// Destination folder on the reMarkable (top-level name or "/"-separated path).
pref("folder", "Zotero");
// reMarkable device token obtained from the one-time code (empty = not connected).
pref("deviceToken", "");
// Sync trigger: "manual" (on demand only) or "interval" (timer).
pref("syncMode", "manual");
// Auto-sync interval in minutes (used when syncMode === "interval").
pref("syncInterval", 30);
// When removing an item from sync, also delete it from the reMarkable cloud.
pref("deleteOnUnsync", true);
