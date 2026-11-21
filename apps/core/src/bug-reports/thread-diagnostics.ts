import { ThreadFilesPath, ThreadSandboxFilePath } from "@dx/api";
import type { ThreadId, UserId } from "@dx/domain";
import { Effect, Redacted, Result, Schema } from "effect";
import type { Bindings } from "../http/types.js";
import { selectWorkspaceRuntime } from "../runtime/workspace-composition.js";
import { resolveExecutionEnvironment } from "../settings/environment-variables/execution.js";
import { readThreadFileThroughDaemon } from "../thread-files/service.js";
import { readHistory } from "../thread-search/history.js";
import { requestThreadDaemon } from "../threads/daemon-client.js";
import { readThreadWorkerLogs } from "./worker-logs.js";

/** Each source gets this long, so one slow source cannot stall a report. */
const SOURCE_TIMEOUT_MS = 8_000;
/** The prompts whose settlements a report lists. */
const AGENT_PROMPT_LIMIT = 20;
/** The Orb's own setup files in the repository. */
const ORB_SETUP_FILES = [".dx/services.yaml"];
/**
 * The Project's scripts as the Orb holds them: source activation's guest
 * program keeps resume and desktop-resume in sync, and writes setup each time
 * it runs it (apps/core/src/source-control/workspace-assets.ts).
 */
const PROJECT_SCRIPTS_DIRECTORY = "/home/user/.local/state/dx/project-scripts";
const PROJECT_SCRIPT_FILES = ["setup", "resume", "desktop-resume"];
const ORB_SETUP_MAX_CHARACTERS = 64 * 1024;

const capped = (content: string) =>
  content.length > ORB_SETUP_MAX_CHARACTERS
    ? `${content.slice(0, ORB_SETUP_MAX_CHARACTERS)}\n[cut at ${ORB_SETUP_MAX_CHARACTERS} characters]`
    : content;

type Source<A> =
  | { readonly ok: true; readonly value: A }
  | {
      readonly ok: false;
      readonly error: string;
    };

const settle = async <A>(work: () => Promise<A>): Promise<Source<A>> => {
  try {
    const value = await Promise.race([
      work(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("timed out")), SOURCE_TIMEOUT_MS),
      ),
    ]);
    return { ok: true, value };
  } catch (cause) {
    return {
      ok: false,
      error: cause instanceof Error ? cause.message.slice(0, 200) : "failed",
    };
  }
};

const executionStub = (bindings: Bindings, threadId: ThreadId) => {
  try {
    selectWorkspaceRuntime(bindings, {
      local: "resident",
      deployed: "resident",
    });
  } catch {
    return undefined;
  }
  const namespace = bindings.THREAD_EXECUTION;
  return namespace?.get(namespace.idFromName(threadId));
};

/** The Thread execution Durable Object's own account of its Orb. */
const executionState = async (bindings: Bindings, threadId: ThreadId) => {
  const stub = executionStub(bindings, threadId);
  if (stub === undefined) return { runtime: "not resident" };
  const response = await stub.fetch(
    new Request("https://thread-execution/diagnostics", {
      headers: { "x-dx-thread-id": threadId },
    }),
  );
  if (!response.ok) throw new Error(`answered ${response.status}`);
  return (await response.json()) as {
    readonly daemon?: { readonly connected?: boolean } | null;
  } & Record<string, unknown>;
};

/** The agent Durable Object's recent prompts and how each one settled. */
const agentState = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: ThreadId,
) => {
  const history = await readHistory(
    bindings,
    ownerUserId,
    threadId,
    AGENT_PROMPT_LIMIT,
  );
  if (history.kind !== "page") return { history: history.kind };
  const { messages, settled, failures, answeredBy, hasOlder } = history.page;
  const submissions = [
    ...new Set(
      messages.flatMap(({ role, submissionId }) =>
        role === "user" && submissionId !== undefined ? [submissionId] : [],
      ),
    ),
  ];
  return {
    history: "page",
    messages: messages.length,
    hasOlder,
    submissions: submissions.map((submissionId) => ({
      submissionId,
      outcome: settled.get(submissionId) ?? "unsettled",
      // Why it failed, such as WORKSPACE_READ_ONLY with what dx did.
      ...(failures.has(submissionId)
        ? { error: failures.get(submissionId) }
        : {}),
      ...(answeredBy.has(submissionId)
        ? { answeredBy: answeredBy.get(submissionId) }
        : {}),
    })),
    lastMessageAt: messages.at(-1)?.timestamp ?? null,
  };
};

/** The Orb's setup scripts, read only from an Orb that is already running. */
const orbSetupScripts = async (bindings: Bindings, threadId: ThreadId) => {
  const files: Record<string, string | null> = {};
  for (const name of ORB_SETUP_FILES) {
    try {
      const file = await readThreadFileThroughDaemon(
        bindings,
        threadId,
        Schema.decodeUnknownSync(ThreadFilesPath)(name),
      );
      files[name] = capped(file.content);
    } catch {
      files[name] = null;
    }
  }
  for (const name of PROJECT_SCRIPT_FILES) {
    const path = `${PROJECT_SCRIPTS_DIRECTORY}/${name}`;
    try {
      const result = await requestThreadDaemon(bindings, threadId, {
        operation: "files.readSandbox",
        path: Schema.decodeUnknownSync(ThreadSandboxFilePath)(path),
        offset: 0,
        length: ORB_SETUP_MAX_CHARACTERS,
      });
      files[path] =
        result.kind === "sandbox-chunk"
          ? capped(new TextDecoder().decode(result.bytes))
          : null;
    } catch {
      files[path] = null;
    }
  }
  return files;
};

/** The values of the Thread's secret environment variables, to redact. */
export const threadSecretValues = async (
  bindings: Bindings,
  threadId: ThreadId,
) => {
  const environment = await Effect.runPromise(
    Effect.result(resolveExecutionEnvironment(bindings, threadId)),
  );
  if (!Result.isSuccess(environment)) return [];
  return environment.success.values.flatMap(({ kind, value }) => {
    const secret = Redacted.value(value);
    return kind === "secret" && secret.trim().length >= 4 ? [secret] : [];
  });
};

export interface ThreadServerDiagnostics {
  /** Exact secrets of the Thread's environment, for the redactor only. */
  readonly secrets: ReadonlyArray<string>;
  readonly value: {
    readonly execution: Source<unknown>;
    readonly agent: Source<unknown>;
    readonly orbSetup: Source<unknown>;
    readonly workerLogs: Source<unknown>;
  };
}

/**
 * What Core holds about a Thread for Thread and App Diagnostics: the
 * execution and agent Durable Objects' state, the Orb's setup scripts, and
 * the Thread's Worker log lines.
 * The Orb is read only when its daemon is connected, so a report never
 * wakes it, and only when the reporter may read it (`readOrb`). Every source
 * settles on its own; a failed one says why.
 */
export const collectThreadServerDiagnostics = async (
  bindings: Bindings,
  ownerUserId: UserId,
  threadId: ThreadId,
  readOrb: boolean,
): Promise<ThreadServerDiagnostics> => {
  const [secrets, execution, agent, workerLogs] = await Promise.all([
    threadSecretValues(bindings, threadId).catch(() => []),
    settle(() => executionState(bindings, threadId)),
    settle(() => agentState(bindings, ownerUserId, threadId)),
    settle(() => readThreadWorkerLogs(bindings, threadId)),
  ]);
  const connected =
    execution.ok &&
    (execution.value as { daemon?: { connected?: boolean } | null }).daemon
      ?.connected === true;
  const orbSetup: Source<unknown> = !readOrb
    ? {
        ok: false,
        error:
          "The reporter can only view this Thread, so its Orb was not read.",
      }
    : connected
      ? await settle(() => orbSetupScripts(bindings, threadId))
      : { ok: false, error: "The Orb was not running, so it was not read." };
  return { secrets, value: { execution, agent, orbSetup, workerLogs } };
};
