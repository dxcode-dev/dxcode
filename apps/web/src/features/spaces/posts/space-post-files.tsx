import type { MessageAttachment } from "@dx/api";
import * as React from "react";
import { SpacePostFilesContext } from "./space-post-files-context.js";

/** A post's images, as tiles above its bubble. */
export function SpacePostImages({
  attachments,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
}) {
  const { Images } = React.use(SpacePostFilesContext);
  return attachments.length === 0 ? null : <Images attachments={attachments} />;
}

/** A post's other files, as links at the end of its bubble. */
export function SpacePostLinks({
  attachments,
}: {
  readonly attachments: ReadonlyArray<MessageAttachment>;
}) {
  const { Links } = React.use(SpacePostFilesContext);
  return attachments.length === 0 ? null : <Links attachments={attachments} />;
}
