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
// Safe mode: never modify annotations on the reMarkable (pull only). PDFs are
// still uploaded ("storing" is non-destructive). On by default.
pref("safeMode", true);
// Auto-generate a companion EPUB (via mammoth) for tagged .docx attachments,
// so they can be synced too (reMarkable has no native .docx support).
pref("convertDocx", true);
// Push tagged standalone/child notes to reMarkable as their own EPUB
// documents. One-way (Zotero -> device only); notes have no annotation layer.
pref("syncNotes", true);
