// Browser-native SSM Session Manager shell client (demo-scoped). If this proves
// out, it's a candidate to promote into the spawn-ts library proper.
export * from "./agent-message.js";
export { SsmSession, type SsmSessionInit, type SsmSessionHandlers } from "./session.js";
