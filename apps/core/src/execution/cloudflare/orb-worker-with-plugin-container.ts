/**
 * The Orb Worker for a stage that has not deleted the retired plugin
 * container class yet: the same Worker, plus that class's empty stub.
 * `deploy/orb/containers.mjs` picks this entry until the stage's
 * `v4-remove-plugin-container` migration runs, which it does once Core no
 * longer binds the class. Delete this file and the stub once every stage has
 * run that migration (tasks/plugins-next.md).
 */
export * from "./orb-worker.js";
export { default } from "./orb-worker.js";
export { PluginContainerObject } from "./plugin-container-tombstone.js";
