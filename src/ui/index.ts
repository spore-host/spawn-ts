// DOM UI components (self-mounting, client-driven). Consumers that want a
// prebuilt surface — e.g. the spore.host portal — mount these; the DOM-free
// engine lives under the package root and the other subpaths.
export { Dashboard } from "./dashboard.js";
export { Terminal } from "./terminal.js";
export { confirmDialog, backendDialog } from "./modals.js";
