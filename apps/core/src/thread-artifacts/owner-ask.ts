import type { ThreadId } from "@dx/domain";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { artifactSaved, askDecidedElsewhere } from "./ask-effects.js";
import { type ArtifactWriter, readArtifact, saveArtifact } from "./store.js";

/** Saves that lose to a person's newer revision before the ask gives up. */
const ATTEMPTS = 3;

/**
 * A person's mention as artifacts write it. The name is cut to what a
 * mention can hold, so the mention always parses.
 */
export const personMention = (id: string, name: string) =>
  `@[${
    name
      .replace(/[[\]()\n\r]/g, " ")
      .trim()
      .slice(0, 60) || "Member"
  }](user:${id})`;

/**
 * Ticks the owner's open ask in `artifactId` whose text holds `marker`, and
 * appends `outcome`, as `writer`'s save. A person's decision wakes the
 * Thread (`askDecidedElsewhere`), so the agent hears the outcome of
 * something it asked about that was decided elsewhere, such as a skill
 * proposal decided on the Skills settings page. Only proposals filed while
 * the agent still asked in a Plan artifact have such an ask; newer ones wake
 * the Thread directly (`settings/proposal-decided.ts`). Best effort: an ask already ticked, edited
 * away, or lost to newer saves is left as it is.
 */
export const settleOwnerAsk = async (
  bindings: ThreadToolsContext["bindings"],
  input: {
    readonly threadId: string;
    readonly artifactId: string;
    readonly marker: string;
    readonly outcome: string;
    /** A person's decision wakes the Thread; the agent's own does not. */
    readonly writer: ArtifactWriter;
  },
): Promise<boolean> => {
  const { writer } = input;
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    const current = await readArtifact(
      bindings,
      input.threadId,
      input.artifactId,
    );
    if (current === undefined) return false;
    const lines = current.markdown.split("\n");
    const index = lines.findIndex(
      (line) => /^\s*[-*+] \[ \] /.test(line) && line.includes(input.marker),
    );
    if (index === -1) return false;
    const decided = `${(lines[index] ?? "").replace(/\[ \]/, "[x]").trimEnd()} ${input.outcome}`;
    lines[index] = decided;
    const result = await saveArtifact(bindings, {
      threadId: input.threadId,
      artifactId: input.artifactId,
      baseRevision: current.artifact.revision,
      markdown: lines.join("\n"),
      writer,
    });
    if (result.kind === "conflict") continue;
    if (result.kind !== "saved") return false;
    await publishRealtimeInvalidation(
      bindings,
      input.threadId as ThreadId,
      "artifacts.invalidated",
    );
    await artifactSaved(bindings, {
      threadId: input.threadId,
      artifactId: result.value.artifact.id,
      title: result.value.artifact.title,
      revision: result.value.artifact.revision,
      before: result.previous,
      after: result.value.markdown,
      writer,
    });
    // A person's decision reaches the agent now; the agent's own does not.
    if (writer.kind === "user")
      await askDecidedElsewhere(bindings, {
        threadId: input.threadId,
        artifactId: result.value.artifact.id,
        title: result.value.artifact.title,
        revision: result.value.artifact.revision,
        userId: writer.userId,
        item: decided.trim(),
      });
    return true;
  }
  return false;
};
