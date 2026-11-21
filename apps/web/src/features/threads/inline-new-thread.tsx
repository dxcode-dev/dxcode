import type { ProjectId } from "@dx/domain";
import { NewThreadModal } from "./new-thread-page.js";

/**
 * The New Thread composer on the page instead of in a dialog: the home page
 * and /new on a wide screen. While it shows, "new Thread" (the New Thread
 * button, its shortcut, the palette) focuses it.
 */
export function InlineNewThread({
  initialProjectId,
  initialPrompt,
  initialPluginThreadType,
}: {
  /** /new's `project`: the Project the composer starts in. */
  readonly initialProjectId?: ProjectId;
  /** /new's `prompt`: text the composer starts with, after any draft. */
  readonly initialPrompt?: string;
  /** /new's `type`: a plugin Thread type, `<plugin>/<type>`, to start as. */
  readonly initialPluginThreadType?: string;
}) {
  return (
    <NewThreadModal
      presentation="inline"
      initialProjectId={initialProjectId}
      initialPrompt={initialPrompt}
      {...(initialPluginThreadType === undefined
        ? {}
        : { initialPluginThreadType })}
      onClose={() => undefined}
      onAccepted={() => undefined}
    />
  );
}
