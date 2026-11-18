import { Schema, SchemaTransformation } from "effect";

const uuidPattern =
  "[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}";

const projectIdInputPattern = new RegExp(`^(?:prj_|p-)(${uuidPattern})$`);

/** Only the stored form, `prj_<uuid>`, as `StoredThreadId` is for Threads. */
export const StoredProjectId = Schema.String.check(
  Schema.isPattern(new RegExp(`^prj_${uuidPattern}$`)),
).pipe(Schema.brand("@dx/ProjectId"));

/**
 * Decodes a Project ID written as `prj_<uuid>` (stored) or `p-<uuid>` (public)
 * and always produces the stored `prj_<uuid>` form.
 */
export const ProjectId = Schema.String.check(
  Schema.isPattern(projectIdInputPattern),
).pipe(
  Schema.decodeTo(
    StoredProjectId,
    SchemaTransformation.transform({
      decode: (input: string) =>
        `prj_${input.startsWith("prj_") ? input.slice(4) : input.slice(2)}`,
      encode: (id: string) => id,
    }),
  ),
);

export type ProjectId = typeof ProjectId.Type;

/** The public form `p-<uuid>` of a Project ID given as `prj_<uuid>` or `p-<uuid>`. */
export const publicProjectId = (id: string): string => {
  const match = projectIdInputPattern.exec(id);
  return match ? `p-${match[1]}` : id;
};
