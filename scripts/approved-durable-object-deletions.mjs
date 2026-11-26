/**
 * Durable Object classes whose deletion the owner approved (2026-11-26, in
 * #2445: "In the same PR"). A `deleted_classes` migration destroys every
 * object of a class and its storage, so the release gate refuses any other:
 * Core's manifest (scripts/migration-manifest.mjs) and the Orb Worker's
 * config (deploy/orb/containers.mjs) each check their deletions against
 * this list, tag and classes exactly. Adding a line here is the approval
 * for the next one. See wiki/release-operations.md, "Retiring a Durable
 * Object class".
 */
export const APPROVED_DURABLE_OBJECT_DELETIONS = Object.freeze([
  Object.freeze({
    worker: "orb",
    tag: "v4-remove-plugin-container",
    deletedClasses: Object.freeze(["PluginContainerObject"]),
  }),
  Object.freeze({
    worker: "core",
    tag: "v13-remove-plugin-stream-relay",
    deletedClasses: Object.freeze(["PluginStreamRelay"]),
  }),
]);

/** Throws unless `worker`'s migration `tag` deletes exactly an approved set. */
export const assertApprovedDurableObjectDeletion = (
  worker,
  tag,
  deletedClasses,
) => {
  const approved = APPROVED_DURABLE_OBJECT_DELETIONS.find(
    (entry) => entry.worker === worker && entry.tag === tag,
  );
  if (
    approved === undefined ||
    JSON.stringify([...deletedClasses].sort()) !==
      JSON.stringify([...approved.deletedClasses].sort())
  )
    throw new Error(
      `Durable Object migration ${tag} (${worker}) deletes ${deletedClasses.join(", ")}, which no owner approved (scripts/approved-durable-object-deletions.mjs).`,
    );
};
