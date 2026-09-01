// Single source of truth for the build marker shown in Help -> Debug Output
// Logging and folded into diagnostic error messages, so "which build is
// this error actually from" never needs a separate round trip to ask.
// Bump this whenever shipping a build worth confirming is loaded.
export const BUILD = "v0.3.24-override-mime";
