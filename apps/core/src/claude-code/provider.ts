import {
  CLAUDE_CODE_DEFAULT_EFFORT,
  CLAUDE_CODE_PROVIDER_ID,
  type ClaudePlanReading,
  claudeCodeEffort,
  claudePlanBlockedUntil,
  claudePlanLimitText,
  claudePlanUsesExtraUsage,
} from "@dx/domain";
import {
  type Api,
  type AssistantMessage,
  type AssistantMessageEvent,
  type Context,
  createAssistantMessageEventStream,
  createProvider,
  getCurrentSystemPrompt,
  type JsonObject,
  type Model,
  type SimpleStreamOptions,
  type Usage,
} from "@earendil-works/pi-ai";
import type { getModelInvocationContext, Sandbox } from "@flue/runtime";
import { claudeCodeLogger } from "../logging.js";
import {
  CLAUDE_CODE_API,
  catalogProviderModels,
} from "../settings/model-routing/catalog.js";
import {
  claudeCodeDxToolList,
  deliverClaudeCodeDxToolResults,
} from "./dx-tools.js";
import { type ClaudePlanAccess, claudePlanBlockedCause } from "./plan.js";
import { claudeCodeRuns } from "./runs.js";
import type { ClaudeCodeBlock, ClaudeCodeSegment } from "./stream.js";
import { mirroredToolCall } from "./tools.js";
import {
  type ClaudeCodeInputBlock,
  type ClaudeCodeRun,
  claudeCodeRunKey,
} from "./workspace-run.js";

const ALREADY_FINISHED = "Claude Code already finished this request.";

/** Attempts per turn before a failure is reported without another try. */
const MAX_ATTEMPTS = 8;

const CONTINUE_INPUT: ClaudeCodeInputBlock = {
  type: "text",
  text: "The previous Claude Code run for this request stopped before it finished, and this is a retry. A tool call that was running when it stopped did not complete and its output is lost, so run it again. Check the workspace only before repeating file changes that may already be made, then finish the request.",
};

/**
 * The `claude-code` Flue provider. A model call does not reach a model API:
 * it starts (or rejoins) the Claude Code CLI run for the newest user input
 * and streams the run's next segment as one assistant message. Flue keeps
 * history, streaming, Stop, and settlement; Claude keeps its own session.
 */
export interface ClaudeCodeProviderDeps {
  readonly invocation: typeof getModelInvocationContext;
  readonly sandbox: (threadId: string) => Promise<Sandbox>;
  readonly credential: (
    threadId: string,
    submissionId: string,
    canonical: string,
  ) => Promise<{ readonly token: string; readonly plan: ClaudePlanAccess }>;
  /**
   * Records plan limits the run reported, read at `observedAt` (epoch
   * seconds); answers with the plan's current extra usage choice. Throws
   * when the reading could not be recorded.
   */
  readonly recordUsage: (
    threadId: string,
    submissionId: string,
    canonical: string,
    reading: ClaudePlanReading,
    observedAt: number,
  ) => Promise<ClaudePlanAccess>;
}

/**
 * Each Thread's latest known plan choice. A turn's later model calls rejoin
 * its run without fetching the credential, so they start from this one.
 */
const knownPlans = new Map<string, ClaudePlanAccess>();
const KNOWN_PLANS = 500;

const rememberPlan = (threadId: string, plan: ClaudePlanAccess) => {
  knownPlans.delete(threadId);
  knownPlans.set(threadId, plan);
  if (knownPlans.size > KNOWN_PLANS)
    for (const key of [...knownPlans.keys()].slice(
      0,
      knownPlans.size - KNOWN_PLANS,
    ))
      knownPlans.delete(key);
};

/** A failed recording is tried again after these delays, in milliseconds. */
const RECORD_RETRY_DELAYS = [250, 1_000];

const usage = (segment?: ClaudeCodeSegment): Usage => {
  const input = segment?.usage.input ?? 0;
  const output = segment?.usage.output ?? 0;
  const cacheRead = segment?.usage.cacheRead ?? 0;
  const cacheWrite = segment?.usage.cacheWrite ?? 0;
  return {
    input,
    output,
    cacheRead,
    cacheWrite,
    totalTokens: input + output + cacheRead + cacheWrite,
    // The owner's Claude plan pays; dx records no cost.
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
};

type Content = AssistantMessage["content"][number];

const contentFor = (block: ClaudeCodeBlock): Content => {
  switch (block.type) {
    case "text":
      return { type: "text", text: block.text };
    case "thinking":
      return {
        type: "thinking",
        thinking: block.thinking,
        ...(block.signature === undefined
          ? {}
          : { thinkingSignature: block.signature }),
      };
    case "toolCall": {
      const call = mirroredToolCall(block.name, block.input ?? {});
      return {
        type: "toolCall",
        id: block.id,
        name: call.name,
        arguments: call.arguments as JsonObject,
      };
    }
  }
};

/**
 * Emits one segment as pi-ai events, sending only what is new since the
 * last update, so a segment read live and one read after a restart produce
 * the same message.
 */
class SegmentEmitter {
  #started = false;
  /** Characters of each block already sent; -1 once the block has ended. */
  readonly #sent: number[] = [];

  constructor(
    private readonly model: Model<Api>,
    private readonly push: (event: AssistantMessageEvent) => void,
  ) {}

  message(
    source: ClaudeCodeSegment | undefined,
    stopReason: AssistantMessage["stopReason"],
    blocks = this.#sent.length,
  ): AssistantMessage {
    const segment = this.#view(source);
    return {
      role: "assistant",
      content: (segment?.blocks ?? []).slice(0, blocks).map(contentFor),
      api: this.model.api,
      provider: this.model.provider,
      model: this.model.id,
      usage: usage(segment),
      stopReason,
      timestamp: Date.now(),
    };
  }

  /** A leading text block dx adds before Claude's own content. */
  prefix: ClaudeCodeBlock | undefined;

  #view(segment: ClaudeCodeSegment | undefined): ClaudeCodeSegment | undefined {
    if (this.prefix === undefined || segment === undefined) return segment;
    return { ...segment, blocks: [this.prefix, ...segment.blocks] };
  }

  update(source: ClaudeCodeSegment, final: boolean) {
    const segment = this.#view(source) ?? source;
    if (!this.#started) {
      this.#started = true;
      this.push({
        type: "start",
        partial: this.message(source, "pending", 0),
      });
    }
    segment.blocks.forEach((block, index) => {
      const closed = final || index < segment.blocks.length - 1;
      if (this.#sent[index] === -1) return;
      if (this.#sent[index] === undefined) {
        this.#sent[index] = 0;
        const partial = this.message(source, "pending", index + 1);
        if (block.type === "text")
          this.push({ type: "text_start", contentIndex: index, partial });
        else if (block.type === "thinking")
          this.push({ type: "thinking_start", contentIndex: index, partial });
        else
          this.push({ type: "toolcall_start", contentIndex: index, partial });
      }
      const body =
        block.type === "text"
          ? block.text
          : block.type === "thinking"
            ? block.thinking
            : block.json;
      const sent = this.#sent[index] ?? 0;
      if (body.length > sent) {
        const partial = this.message(source, "pending", index + 1);
        const delta = body.slice(sent);
        this.#sent[index] = body.length;
        if (block.type === "text")
          this.push({
            type: "text_delta",
            contentIndex: index,
            delta,
            partial,
          });
        else if (block.type === "thinking")
          this.push({
            type: "thinking_delta",
            contentIndex: index,
            delta,
            partial,
          });
        else
          this.push({
            type: "toolcall_delta",
            contentIndex: index,
            delta,
            partial,
          });
      }
      const complete =
        block.type === "toolCall" ? block.complete || final : closed;
      if (!complete) return;
      this.#sent[index] = -1;
      const partial = this.message(source, "pending", index + 1);
      if (block.type === "text")
        this.push({
          type: "text_end",
          contentIndex: index,
          content: block.text,
          partial,
        });
      else if (block.type === "thinking")
        this.push({
          type: "thinking_end",
          contentIndex: index,
          content: block.thinking,
          partial,
        });
      else {
        const toolCall = contentFor(block);
        if (toolCall.type === "toolCall")
          this.push({
            type: "toolcall_end",
            contentIndex: index,
            toolCall,
            partial,
          });
      }
    });
  }
}

const inputBlocks = (messages: Context["messages"]): ClaudeCodeInputBlock[] =>
  messages.flatMap((message): ClaudeCodeInputBlock[] => {
    if (message.role !== "user") return [];
    if (typeof message.content === "string")
      return [{ type: "text", text: message.content }];
    return message.content.map((block) =>
      block.type === "text"
        ? { type: "text", text: block.text }
        : {
            type: "image",
            source: {
              type: "base64",
              media_type: block.mimeType,
              data: block.data,
            },
          },
    );
  });

type UserMessage = Extract<Context["messages"][number], { role: "user" }>;

/** FNV-1a, enough to tell two user messages with one timestamp apart. */
const fingerprint = (value: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16);
};

/**
 * A user turn's identity: its anchoring user message, stable across Flue
 * retries, resumes, and Durable Object restarts, unlike the submission.
 */
const turnKey = (anchor: UserMessage) =>
  claudeCodeRunKey(
    `t${anchor.timestamp}-${fingerprint(
      typeof anchor.content === "string"
        ? anchor.content
        : anchor.content
            .map((block) => (block.type === "text" ? block.text : "[image]"))
            .join("\n"),
    )}`,
  );

/**
 * Flue records a submission's own outcome (an abort, a failure) as a
 * `submission_*` signal in the conversation. It is not input: a Retry after
 * one continues the interrupted turn. Other signals, such as plugin
 * deliveries, are input like a user message.
 */
const isLifecycleSignal = (message: Context["messages"][number]) => {
  if (message.role !== "user") return false;
  const first =
    typeof message.content === "string"
      ? message.content
      : message.content.find((block) => block.type === "text")?.text;
  return first?.trimStart().startsWith('<signal type="submission_') === true;
};

/**
 * Where this call sits: new user input after the last assistant message
 * starts a turn; otherwise Flue continues the turn after tool results and
 * wants its next segment. `previous` is the turn new input interrupts, with
 * how many of its segments Flue recorded.
 */
const position = (context: Context) => {
  const messages = context.messages;
  const isInput = (message: Context["messages"][number]) =>
    message.role === "user" && !isLifecycleSignal(message);
  const lastUser = messages.findLastIndex(isInput);
  const lastAssistant = messages.findLastIndex(
    ({ role }) => role === "assistant",
  );
  const pending =
    lastUser > lastAssistant
      ? messages.slice(lastAssistant + 1).filter(isInput)
      : [];
  const segment = messages
    .slice(lastUser + 1)
    .filter(({ role }) => role === "assistant").length;
  const anchor = messages[lastUser];
  // Segments Flue recorded before the latest interruption of this turn.
  const interruption = messages.findLastIndex(
    (message, index) => index > lastUser && isLifecycleSignal(message),
  );
  const interruptedAt =
    interruption < 0
      ? undefined
      : messages
          .slice(lastUser + 1, interruption)
          .filter(({ role }) => role === "assistant").length;
  const previousIndex =
    pending.length === 0
      ? -1
      : messages.findLastIndex(
          (message, index) => isInput(message) && index < lastAssistant,
        );
  const previousAnchor = messages[previousIndex];
  const last = messages[lastAssistant];
  return {
    pending,
    segment,
    anchor: anchor?.role === "user" ? anchor : undefined,
    interruptedAt,
    previous:
      previousAnchor?.role === "user"
        ? {
            anchor: previousAnchor,
            // Claude's result ended it, and no failure or Stop followed.
            finished:
              last?.role === "assistant" &&
              last.stopReason === "stop" &&
              !messages.slice(lastAssistant + 1).some(isLifecycleSignal),
            /** Tool calls Flue recorded for it, in order. */
            calls: messages
              .slice(previousIndex + 1, lastAssistant + 1)
              .flatMap((message) =>
                message.role === "assistant"
                  ? message.content.flatMap((block) =>
                      block.type === "toolCall" ? [block.id] : [],
                    )
                  : [],
              ),
          }
        : undefined,
  };
};

const describeToolCall = (
  block: Extract<ClaudeCodeBlock, { type: "toolCall" }>,
) => {
  const input = block.input ?? {};
  const detail =
    typeof input.command === "string"
      ? `\`${input.command.split("\n")[0]?.slice(0, 120)}\``
      : typeof input.file_path === "string"
        ? input.file_path
        : typeof input.description === "string"
          ? input.description
          : "";
  return detail === "" ? block.name : `${block.name} ${detail}`;
};

/**
 * Work Claude did after the last segment Flue recorded for the interrupted
 * turn: it happened in the workspace and in Claude's session, so the new
 * turn's transcript names it. A run this isolate never read is read from
 * the chunk that names the last call Flue recorded.
 */
const unrecordedWork = async (
  run: ClaudeCodeRun,
  recorded: ReadonlyArray<string>,
): Promise<string | undefined> => {
  const last = run.unread ? recorded.at(-1) : undefined;
  const from = run.exited ? undefined : await run.stop(last);
  const reader = from === undefined ? run : run.readerFrom(from);
  await reader.poll();
  const known = new Set(recorded);
  const calls = reader.stream.segments
    .flatMap(({ blocks }) => blocks)
    .flatMap((block) =>
      block.type === "toolCall" && block.complete && !known.has(block.id)
        ? [describeToolCall(block)]
        : [],
    );
  if (calls.length === 0) return undefined;
  return `Before this message, Claude Code also ran: ${calls.join("; ")}.\n\n`;
};

export const createClaudeCodeProvider = (deps: ClaudeCodeProviderDeps) => {
  const models = catalogProviderModels(CLAUDE_CODE_PROVIDER_ID).map(
    (model) => ({
      ...model,
      // Claude Code compacts its own session; Flue must never summarize it.
      contextWindow: 0,
    }),
  );

  const streamSimple = (
    model: Model<Api>,
    context: Context,
    options?: SimpleStreamOptions,
  ) => {
    const events = createAssistantMessageEventStream();
    const emitter = new SegmentEmitter(model, (event) => events.push(event));
    const fail = (
      message: string,
      reason: "error" | "aborted",
      segment?: ClaudeCodeSegment,
    ) => {
      events.push({
        type: "error",
        reason,
        error: {
          ...emitter.message(segment, reason),
          errorMessage: message,
        },
      });
      events.end();
    };
    const signal = options?.signal;
    void (async () => {
      let run: ClaudeCodeRun | undefined;
      try {
        const invocation = deps.invocation();
        const scope = invocation?.scope;
        if (invocation === undefined || scope?.kind !== "prompt")
          throw new Error("Claude Code runs only for a Thread submission.");
        const threadId = invocation.instanceId;
        const { pending, segment, anchor, previous, interruptedAt } =
          position(context);
        if (anchor === undefined)
          throw new Error("Claude Code needs a user message to answer.");
        const turn = turnKey(anchor);
        const sandbox = await deps.sandbox(threadId);
        await deliverClaudeCodeDxToolResults(context, sandbox);
        const attempts = await claudeCodeRuns.attempts(threadId, turn, sandbox);
        let latest: { attempt: number; run: ClaudeCodeRun } | undefined;
        for (const candidate of [...attempts].reverse())
          if ((await candidate.run.base()) <= segment) {
            latest = candidate;
            break;
          }
        let relaunch = latest === undefined;
        let freshSession = false;
        if (latest !== undefined) {
          const existing = latest.run;
          await existing.settle();
          const local = segment - (await existing.base());
          const found = existing.stream.segments[local];
          const settled =
            found?.stopReason === "stop" || found?.stopReason === "toolUse";
          // An attempt from before the turn was stopped or failed is replaced,
          // even if its process has not finished exiting yet.
          const interrupted =
            interruptedAt !== undefined &&
            (await existing.base()) < interruptedAt;
          if (interrupted && !existing.exited) await existing.stop();
          // A run lost with its workspace's processes (a cold boot keeps only
          // files) never writes its exit marker; it counts as exited.
          if (!interrupted && !settled) await existing.lost();
          // The turn already ended, so there is no further segment to run.
          // A stopped attempt's result does not end it.
          if (
            !interrupted &&
            !settled &&
            existing.stream.finished &&
            existing.stream.result?.isError === false &&
            found === undefined &&
            !(await existing.stopped())
          ) {
            const finished: ClaudeCodeSegment = {
              blocks: [{ type: "text", text: ALREADY_FINISHED }],
              usage: { input: 0, output: 1, cacheRead: 0, cacheWrite: 0 },
              stopReason: "stop",
            };
            emitter.update(finished, true);
            events.push({
              type: "done",
              reason: "stop",
              message: emitter.message(finished, "stop"),
            });
            events.end();
            return;
          }
          // A failure already reported, a stopped attempt, or a lost process:
          // Flue is retrying, so this call starts the next attempt.
          relaunch =
            interrupted ||
            (!settled &&
              (found?.stopReason === "error" ||
                existing.stream.finished ||
                existing.exited));
          // A resumed CLI that exited on its own before naming a session
          // could not load it; the next attempt starts a new session.
          if (
            relaunch &&
            existing.stream.sessionId === undefined &&
            (await existing.resumed()) &&
            (await existing.exitedOnItsOwn())
          ) {
            await existing.forgetSession();
            freshSession = true;
          }
        }
        const canonical = `${model.provider}/${model.id}`;
        // The plan's extra usage choice: from the credential at launch, then
        // from each reading recorded, since the owner may change it mid-run.
        let plan = knownPlans.get(threadId);
        const setPlan = (next: ClaudePlanAccess) => {
          plan = next;
          rememberPlan(threadId, next);
        };
        let recording = Promise.resolve();
        const record = (reading: ClaudePlanReading, observedAt: number) => {
          recording = recording.then(async () => {
            for (const delay of [0, ...RECORD_RETRY_DELAYS]) {
              if (delay > 0)
                await new Promise((resolve) => setTimeout(resolve, delay));
              try {
                setPlan(
                  await deps.recordUsage(
                    threadId,
                    scope.submissionId,
                    canonical,
                    reading,
                    observedAt,
                  ),
                );
                return;
              } catch {}
            }
          });
        };
        let nextAttempt = (attempts.at(-1)?.attempt ?? -1) + 1;
        // A new session has none of the turn, so continuing it restates the
        // request instead of only asking to finish it.
        const input = () =>
          pending.length > 0
            ? inputBlocks(pending)
            : freshSession
              ? [...inputBlocks([anchor]), CONTINUE_INPUT]
              : [CONTINUE_INPUT];
        const launchAttempt = async () => {
          if (nextAttempt >= MAX_ATTEMPTS)
            throw new Error(
              latest?.run.stream.result?.text ||
                "Claude Code failed repeatedly for this request.",
            );
          const credential = await deps.credential(
            threadId,
            scope.submissionId,
            canonical,
          );
          setPlan(credential.plan);
          if (credential.plan.blockedUntil !== undefined)
            throw new Error(
              claudePlanLimitText({
                ...(credential.plan.limitWindow === undefined
                  ? {}
                  : { window: credential.plan.limitWindow }),
                resetsAt: credential.plan.blockedUntil,
                cause: claudePlanBlockedCause(credential.plan),
              }),
            );
          const next = claudeCodeRuns.create(
            threadId,
            turn,
            nextAttempt,
            segment,
            sandbox,
          );
          nextAttempt += 1;
          // Set before launching, so Stop during the launch stops it.
          run = next;
          await next.launch(
            {
              model: model.id,
              effort: claudeCodeEffort(
                options?.reasoning ?? CLAUDE_CODE_DEFAULT_EFFORT,
              ),
              // pi carries the prompt as transcript system messages.
              systemPrompt: getCurrentSystemPrompt(context.messages),
              input: input(),
              token: credential.token,
              tools: claudeCodeDxToolList(threadId),
            },
            signal,
          );
          return next;
        };
        if (relaunch) {
          // A fresh turn names the interrupted turn's unrecorded work.
          if (
            nextAttempt === 0 &&
            previous !== undefined &&
            !previous.finished
          ) {
            const earlier = (
              await claudeCodeRuns.attempts(
                threadId,
                turnKey(previous.anchor),
                sandbox,
              )
            ).at(-1);
            const note =
              earlier === undefined
                ? undefined
                : await unrecordedWork(earlier.run, previous.calls);
            if (note !== undefined)
              emitter.prefix = { type: "text", text: note };
          }
          run = await launchAttempt();
        } else run = latest?.run;
        if (run === undefined)
          throw new Error("Claude Code has no run to read.");
        let current = run;
        let local = segment - (await current.base());
        // Each new reading is recorded, starting with the latest one already
        // read: a rejoined run may have read past it while settling. One that
        // says the response drew on extra usage stops the wait until the
        // plan's current choice is known. A run that already finished is not
        // stopped: its work is done and billed.
        let reported: ClaudePlanReading | undefined;
        let extraUsage: ClaudePlanReading | undefined;
        let overLimit: ClaudePlanReading | undefined;
        const watchPlan = () => {
          const reading = current.stream.planReading;
          if (reading === undefined || reading === reported) return false;
          reported = reading;
          // Sent with when dx first read it: a later model call sends the
          // run's last reading again, and it must not replace a newer one.
          record(reading, current.stream.planReadingAt);
          if (!claudePlanUsesExtraUsage(reading)) return false;
          extraUsage = reading;
          return true;
        };
        const waitForSegment = async () => {
          for (;;) {
            await current.waitFor(() => {
              if (watchPlan()) return true;
              const found = current.stream.segments[local];
              if (found !== undefined) emitter.update(found, false);
              return found?.stopReason !== undefined;
            }, signal);
            if (extraUsage === undefined) return;
            const reading = extraUsage;
            extraUsage = undefined;
            await recording;
            // The choice the recording answered with, else the last one known
            // for this Thread; unknown when none ever was: fail closed.
            if (
              plan?.allowExtraUsage !== true &&
              current.stream.segments[local]?.stopReason !== "stop"
            ) {
              overLimit = reading;
              return;
            }
          }
        };
        await waitForSegment();
        const stopForPlan = async () => {
          if (overLimit === undefined) return false;
          await current.stop();
          const now = Math.floor(Date.now() / 1000);
          const resetsAt =
            plan?.blockedUntil ??
            claudePlanBlockedUntil(
              { ...overLimit, observedAt: now },
              false,
              now,
              model.id,
            ) ??
            now;
          fail(
            claudePlanLimitText({
              ...(overLimit.limit === undefined
                ? {}
                : { window: overLimit.limit.id }),
              resetsAt,
              cause: "stopped",
            }),
            "error",
            current.stream.segments[local],
          );
          return true;
        };
        if (await stopForPlan()) return;
        let found = current.stream.segments[local];
        // A resumed CLI that exited on its own before naming a session could
        // not load it: forget it and answer once more in a new session.
        if (
          found?.stopReason !== "stop" &&
          found?.stopReason !== "toolUse" &&
          current.stream.sessionId === undefined &&
          (await current.resumed()) &&
          (await current.exitedOnItsOwn())
        ) {
          await current.forgetSession();
          freshSession = true;
          current = await launchAttempt();
          run = current;
          local = 0;
          await waitForSegment();
          if (await stopForPlan()) return;
          found = current.stream.segments[local];
        }
        if (found?.stopReason === undefined || found.stopReason === "error") {
          // Claude Code fails a request the plan has no usage left for, and
          // no extra usage covers: say which limit, and when it resets, in
          // the form the web app shows. Other failures keep their own text.
          const reading = current.stream.planReading;
          const now = Math.floor(Date.now() / 1000);
          const limitedUntil =
            reading?.status === "rejected" && !claudePlanUsesExtraUsage(reading)
              ? claudePlanBlockedUntil(
                  { ...reading, observedAt: now },
                  false,
                  now,
                  model.id,
                )
              : undefined;
          if (reading !== undefined && limitedUntil !== undefined) {
            await recording;
            fail(
              claudePlanLimitText({
                ...(reading.limit === undefined
                  ? {}
                  : { window: reading.limit.id }),
                resetsAt: limitedUntil,
                cause: "exhausted",
              }),
              "error",
              found,
            );
            return;
          }
          const detail =
            found?.errorMessage ??
            current.stream.result?.text ??
            ((await current.stderrTail()) ||
              (current.dead
                ? "Claude Code stopped responding."
                : "Claude Code exited without a result."));
          fail(detail, "error", found);
          return;
        }
        emitter.update(found, true);
        if (found.stopReason === "stop") await current.syncChanges();
        events.push({
          type: "done",
          reason: found.stopReason,
          message: emitter.message(found, found.stopReason),
        });
        events.end();
      } catch (error) {
        if (signal?.aborted) {
          await run?.stop();
          fail("Stopped.", "aborted");
          return;
        }
        // A failed turn must not leave Claude working unobserved.
        if (run !== undefined && !run.exited) await run.stop();
        // Name what was thrown: a bare "failed" hides the cause.
        const detail =
          error instanceof Error
            ? error.message || error.name
            : typeof error === "string"
              ? error
              : (JSON.stringify(error) ?? String(error));
        claudeCodeLogger.error("Claude Code model call failed.", {
          event: "claude_code_model_call_failed",
          threadId: deps.invocation()?.instanceId,
          detail: detail.slice(0, 2_000),
          stack: error instanceof Error ? error.stack : undefined,
        });
        fail(
          error instanceof Error && error.message !== ""
            ? error.message
            : detail === ""
              ? "Claude Code failed."
              : `Claude Code failed: ${detail}`,
          "error",
        );
      }
    })();
    return events;
  };

  return createProvider({
    id: CLAUDE_CODE_PROVIDER_ID,
    name: "Claude Code",
    auth: {
      apiKey: {
        name: "Claude Pro/Max connection",
        resolve: async () => ({ auth: {} }),
      },
    },
    models: models.map((model) => ({
      ...model,
      api: CLAUDE_CODE_API,
    })) as Model<typeof CLAUDE_CODE_API>[],
    api: {
      stream: (model, context, options) =>
        streamSimple(model, context, options as SimpleStreamOptions),
      streamSimple,
    },
  });
};
