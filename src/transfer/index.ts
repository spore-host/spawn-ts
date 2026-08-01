// Data movement in and out of launched instances, browser-native.
//
// Its own subpath (rather than the main barrel) for the same reason `./auth` is:
// a consumer that only launches instances shouldn't pull in the transfer surface,
// and the Globus Transfer token it needs comes from `./auth`, not from core.
export * from "./globus.js";
