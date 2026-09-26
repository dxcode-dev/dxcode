import { Schema } from "effect";

export const ProjectId = Schema.String.check(
  Schema.isPattern(
    /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  ),
).pipe(Schema.brand("@dx/ProjectId"));

export type ProjectId = typeof ProjectId.Type;
