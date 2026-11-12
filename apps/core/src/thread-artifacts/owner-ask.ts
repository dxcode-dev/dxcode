import type { ThreadId } from "@dx/domain";
import { publishRealtimeInvalidation } from "../realtime/publication.js";
import type { ThreadToolsContext } from "../threads/agent-tools.js";
import { artifactSaved, askDecidedElsewhere } from "./ask-effects.js";
import { openAsks } from "./asks.js";
import {
  type ArtifactWithMarkdown,
  type ArtifactWriteResult,
  type ArtifactWriter,
  createArtifact,
  listArtifacts,
  readArtifact,
  saveArtifact,
} from "./store.js";

/** The artifact an ask goes to when the agent names none. */
export const PLAN_TITLE = "Plan";

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

const ownerOf = (db: D1Database, threadId: string) =>
  db
    .prepare(
      `SELECT "user".id, "user".name FROM threads
         JOIN "user" ON "user".id = threads.owner_user_id
        WHERE threads.id = ?`,
    )
    .bind(threadId)
    .first<{ id: string; name: string }>();

/** Appends a checklist item, inside a list that already ends the document. */
const appendItem = (markdown: string, item: string) => {
  const body = markdown.trimEnd();
  if (body === "") return `${item}\n`;
  const last = body.slice(body.lastIndexOf("\n") + 1);
  return `${body}${/^\s*[-*+] \[[ xX]\] /.test(last) ? "\n" : "\n\n"}${item}\n`;
};

const written = (result: ArtifactWriteResult) => {
  if (result.kind === "saved") return result;
  if (result.kind === "conflict") return undefined;
  throw new Error(
    result.kind === "too-large"
      ? "The artifact is at its 2 MB limit; name another artifact with artifact_id."
      : result.kind === "storage-full"
        ? "This Thread's artifacts are full; delete one or name another artifact."
        : result.kind === "invalid"
          ? result.message
          : "The artifact was not found in this Thread.",
  );
};

export interface OwnerAsk {
  readonly artifactId: string;
  readonly title: string;
  readonly revision: number;
  /** False when the artifact already held the owner's open ask. */
  readonly added: boolean;
}

/**
 * What `request_attention` asks of the owner, as an unchecked checklist item
 * mentioning them: in the artifact the agent names, unless it already holds
 * an open ask for the owner there, or else in the Thread's top-level Plan
 * artifact, which it creates when there is none. The mention notifies the
 * owner; a tick or an answer under it reaches the agent through Notify agent
 * or a comment that mentions it (`ask-effects.ts`).
 */
export const addOwnerAsk = async (
  context: ThreadToolsContext,
  threadId: string,
  ask: {
    readonly summary: string;
    readonly url?: string | undefined;
    readonly artifactId?: string | undefined;
    readonly submissionId?: string | undefined;
  },
): Promise<OwnerAsk> => {
  const owner = await ownerOf(context.db, threadId);
  if (owner === null) throw new Error("This Thread was not found.");
  const writer: ArtifactWriter = {
    kind: "agent",
    ...(ask.submissionId === undefined
      ? {}
      : { submissionId: ask.submissionId }),
  };
  const item = `- [ ] ${personMention(owner.id, owner.name)} ${ask.summary}${
    ask.url === undefined ? "" : ` ([link](${ask.url}))`
  }`;
  const asksOwner = (current: ArtifactWithMarkdown) =>
    openAsks(current.markdown).some(({ mentions, text }) =>
      ask.artifactId === undefined
        ? mentions.includes(owner.id) && text.includes(ask.summary)
        : mentions.includes(owner.id),
    );
  for (let attempt = 0; attempt < ATTEMPTS; attempt++) {
    let current: ArtifactWithMarkdown | undefined;
    if (ask.artifactId !== undefined) {
      current = await readArtifact(context.bindings, threadId, ask.artifactId);
      if (current === undefined)
        throw new Error(
          `Artifact ${ask.artifactId} is not in this Thread. List this Thread's artifacts with the artifact tool.`,
        );
    } else {
      const plan = (
        await listArtifacts(context.bindings, threadId, { folder: "" })
      ).find(({ title }) => title.toLowerCase() === PLAN_TITLE.toLowerCase());
      if (plan !== undefined)
        current = await readArtifact(context.bindings, threadId, plan.id);
    }
    if (current !== undefined && asksOwner(current))
      return {
        artifactId: current.artifact.id,
        title: current.artifact.title,
        revision: current.artifact.revision,
        added: false,
      };
    const result = written(
      current === undefined
        ? await createArtifact(context.bindings, {
            threadId,
            title: PLAN_TITLE,
            markdown: `${item}\n`,
            writer,
          })
        : await saveArtifact(context.bindings, {
            threadId,
            artifactId: current.artifact.id,
            baseRevision: current.artifact.revision,
            markdown: appendItem(current.markdown, item),
            writer,
          }),
    );
    if (result === undefined) continue;
    const saved = result.value;
    await publishRealtimeInvalidation(
      context.bindings,
      threadId as ThreadId,
      "artifacts.invalidated",
    );
    // Notifies the owner's mention. An agent's own save never wakes its
    // Thread. Awaited, so the owner hears of the ask before the agent's
    // final reply.
    await artifactSaved(context.bindings, {
      threadId,
      artifactId: saved.artifact.id,
      title: saved.artifact.title,
      revision: saved.artifact.revision,
      before: result.previous,
      after: saved.markdown,
      writer,
    });
    return {
      artifactId: saved.artifact.id,
      title: saved.artifact.title,
      revision: saved.artifact.revision,
      added: true,
    };
  }
  throw new Error(
    "People kept saving the artifact while the ask was added. Read it, add the ask yourself, and call request_attention again with its artifact_id.",
  );
};

/**
 * Ticks the owner's open ask in `artifactId` whose text holds `marker`, and
 * appends `outcome`, as `writer`'s save. A person's decision wakes the
 * Thread (`askDecidedElsewhere`), so the agent hears the outcome of
 * something it asked about that was decided elsewhere, such as a skill
 * proposal decided on the Skills settings page. Best effort: an ask already ticked, edited
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
