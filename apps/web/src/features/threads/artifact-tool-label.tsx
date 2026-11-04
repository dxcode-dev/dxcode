import {
  artifactAction as action,
  artifactOutput as output,
} from "./artifact-tool-part.js";
import type { ToolPart } from "./transcript-activity-projection.js";

const title = (part: ToolPart) => {
  const value =
    output(part)?.title ?? (part.input as { title?: unknown })?.title;
  return typeof value === "string" && value.length > 0 ? value : undefined;
};

/** The one-line label of a list or read in a tool group. */
export function ArtifactToolLabel({ part }: { readonly part: ToolPart }) {
  const named = title(part);
  if (action(part) === "list") return <>Listed artifacts</>;
  return (
    <>Read artifact {named === undefined ? null : <strong>{named}</strong>}</>
  );
}
