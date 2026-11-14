/**
 * Loads every plugin host so each registers itself with the registry, and
 * re-exports the registry. Callers import this module, never registry.ts
 * directly, so a host registered from its own folder is always loaded.
 * A new host adds one import here; registry.ts stays unchanged.
 */
export * from "./registry.js";

import "./durable/runtime.js";
import "./container/runtime.js";
import "./orb/runtime.js";
