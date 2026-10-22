import {
  DICTATION_MAX_BYTES,
  DICTATION_STREAM_SUBPROTOCOL,
  type DictationJob,
  type DictationStreamResult,
  type DictationUnavailable,
} from "@dx/api";
import { SpeechProviderError, type SpeechSession } from "@dx/domain";
import { Effect } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../auth/browser-session.js";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import {
  checkBrowserSessions,
  closeForEndedSession,
  sessionSocketCheckMs,
} from "../auth/session-sockets.js";
import type { AppEnv, Bindings } from "../http/types.js";
import { dictationLogger } from "../logging.js";
import type { AdmittedConfiguration } from "../plugins/host.js";
import {
  admitSpeech,
  audioSeconds,
  effectiveSpeechProviderId,
  recordTranscription,
  speechProviderFor,
} from "../plugins/speech/transcription.js";
import { loadDictationVocabulary } from "./vocabulary.js";
import { InvalidDictationAudio, readCanonicalWav } from "./wav.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const STALE_AFTER = 120_000;
/** A live session refreshes its admission lock well before it goes stale. */
const STREAM_HEARTBEAT = 30_000;
const TRANSCRIBE_TIMEOUT = 90_000;
const MAX_STREAM_PCM_BYTES = DICTATION_MAX_BYTES - 44;
const MAX_STREAM_FRAME_BYTES = 64 * 1024;
const genericError = "Dictation could not be completed.";
const unavailableError = "Dictation is not available.";

/** Speech resolves no provider for this user: fail closed. */
const unavailable = (c: Context<AppEnv>) =>
  c.json<DictationUnavailable>(
    { code: "DICTATION_UNAVAILABLE", error: unavailableError },
    409,
  );

const noStore = (c: { header(name: string, value: string): void }) =>
  c.header("Cache-Control", "no-store");

const safeDiagnostic = (value: string) =>
  value
    .replaceAll(/https?:\/\/\S+/g, "[url]")
    .replaceAll(/[A-Za-z0-9_-]{24,}/g, "[value]")
    .slice(0, 2_000);

const logUnexpectedRouteError = (
  context: Context<AppEnv>,
  operation: "create" | "stream" | "read" | "delete",
  cause: unknown,
) => {
  const error = cause instanceof Error ? cause : undefined;
  dictationLogger.error("Dictation request failed.", {
    event: "dictation_request_failed",
    category: "internal",
    operation,
    requestId: context.get("requestId"),
    errorName: error?.name ?? "UnknownError",
    errorMessage: safeDiagnostic(error?.message ?? String(cause)),
    ...(error?.stack ? { errorStack: safeDiagnostic(error.stack) } : {}),
  });
};

const logTranscriptionFailure = (
  bindings: Bindings,
  id: string,
  configuration: AdmittedConfiguration,
  mode: "recording" | "stream",
  error: unknown,
) =>
  dictationLogger.warn("Dictation transcription failed.", {
    event: "dictation_transcription_failed",
    id,
    mode,
    providerId: effectiveSpeechProviderId(configuration, bindings),
    credentialScope: configuration.scope,
    category: error instanceof SpeechProviderError ? "provider" : "internal",
    reason:
      error instanceof SpeechProviderError
        ? error.reason
        : safeDiagnostic(
            error instanceof Error ? error.message : String(error),
          ),
  });

async function authorize(c: Context<AppEnv>) {
  const requirements = await Effect.runPromise(
    loadAuthenticationRequirements(c.env),
  );
  await Effect.runPromise(
    requireBrowserSession(c, createAuth(c.env, requirements)),
  );
  const owner = c.get("principal").userId as string;
  const db = c.env.DB;
  if (!db) throw new Error("Persistence unavailable");
  // Dictation edits a personal draft, including before a Project/Thread exists.
  // Team membership is not required to use the personal composer.
  return { db, owner, workspace: "personal" };
}

const retireOwnerJobs = async (db: D1Database, owner: string, now: number) => {
  await db.batch([
    db
      .prepare("DELETE FROM dictation_job WHERE owner_id=? AND expires_at<=?")
      .bind(owner, now),
    db
      .prepare(
        "UPDATE dictation_job SET state='failed',updated_at=? WHERE owner_id=? AND state IN ('reserved','dispatching','provider') AND updated_at<=?",
      )
      .bind(now, owner, now - STALE_AFTER),
  ]);
};

/**
 * Admits one active transcription per owner (`dictation_job_owner_active`):
 * a recording upload is `dispatching`, a live session is `provider` (held
 * open at the provider). An upload supersedes the owner's live session,
 * which is how a composer recovers from a session that broke. The row fences
 * cancellation: a transcript is returned only while its job is still active.
 */
const reserve = async (
  db: D1Database,
  bindings: Bindings,
  id: string,
  owner: string,
  workspace: string,
  configuration: AdmittedConfiguration,
  state: "dispatching" | "provider",
) => {
  const now = Date.now();
  await retireOwnerJobs(db, owner, now);
  const insert = db
    .prepare(`INSERT INTO dictation_job(id,owner_id,workspace_id,state,provider_id,credential_scope,created_at,updated_at,expires_at)
      SELECT ?,?,?,?,?,?,?,?,? WHERE
      NOT EXISTS(SELECT 1 FROM dictation_job WHERE owner_id=? AND state IN ('reserved','dispatching','provider'))
      ON CONFLICT(id) DO NOTHING`)
    .bind(
      id,
      owner,
      workspace,
      state,
      effectiveSpeechProviderId(configuration, bindings),
      configuration.scope,
      now,
      now,
      now + HOUR,
      owner,
    );
  const results =
    state === "provider"
      ? [await insert.run()]
      : await db.batch([
          db
            .prepare(
              "UPDATE dictation_job SET state='failed',updated_at=? WHERE owner_id=? AND state='provider' AND id<>?",
            )
            .bind(now, owner, id),
          insert,
        ]);
  return results.at(-1)?.meta.changes === 1;
};

const settleJob = async (
  db: D1Database,
  id: string,
  owner: string,
  state: "completed" | "failed" | "canceled",
) => {
  const settled = await db
    .prepare(
      "UPDATE dictation_job SET state=?,updated_at=? WHERE id=? AND owner_id=? AND state IN ('dispatching','provider') AND expires_at>?",
    )
    .bind(state, Date.now(), id, owner, Date.now())
    .run();
  return settled.meta.changes === 1;
};

const existingJob = async (
  c: Context<AppEnv>,
  db: D1Database,
  id: string,
  owner: string,
  workspace: string,
) => {
  const existing = await db
    .prepare(
      "SELECT state FROM dictation_job WHERE id=? AND owner_id=? AND workspace_id=?",
    )
    .bind(id, owner, workspace)
    .first<{ state: string }>();
  if (!existing)
    return c.json({ error: "Dictation is temporarily unavailable." }, 429);
  return ["reserved", "dispatching", "provider"].includes(existing.state)
    ? c.json<DictationJob>({ id, state: "processing" }, 202)
    : c.json<DictationJob>({ id, state: "failed", error: genericError });
};

export const dictationRoutes = new Hono<AppEnv>();
dictationRoutes.use("*", async (c, next) => {
  noStore(c);
  await next();
});

/**
 * Live dictation. The composer streams PCM while the user speaks; the
 * provider transcribes each stretch of speech as it ends, so the transcript
 * is ready moments after `finish`.
 */
dictationRoutes.get("/:id/stream", async (c) => {
  const request = c.req.raw;
  const offered = (request.headers.get("sec-websocket-protocol") ?? "")
    .split(",")
    .map((protocol) => protocol.trim());
  if (
    request.headers.get("upgrade")?.toLowerCase() !== "websocket" ||
    request.headers.get("origin") !== new URL(request.url).origin ||
    !offered.includes(DICTATION_STREAM_SUBPROTOCOL)
  )
    return c.json({ error: "Not found." }, 404);
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "Invalid request." }, 400);
    // Read alongside admission so the session opens no later; never rejects.
    const vocabularyRead = loadDictationVocabulary(db, owner);
    const admission = await admitSpeech({ db, bindings: c.env }, owner);
    if (!admission.admitted) return unavailable(c);
    const { configuration } = admission;
    if (
      !(await reserve(
        db,
        c.env,
        id,
        owner,
        workspace,
        configuration,
        "provider",
      ))
    )
      return c.json({ error: "Dictation is temporarily unavailable." }, 429);

    const vocabulary = await vocabularyRead;
    let reached = false;
    const abort = new AbortController();
    let session: SpeechSession;
    try {
      session = speechProviderFor(configuration, c.env, () => {
        reached = true;
      }).openSession({ signal: abort.signal, vocabulary });
    } catch (error) {
      await settleJob(db, id, owner, "failed");
      logTranscriptionFailure(c.env, id, configuration, "stream", error);
      return c.json({ error: genericError }, 500);
    }

    const { 0: client, 1: server } = new WebSocketPair();
    server.accept();
    // Binary frames otherwise arrive as Blobs, which cannot be read in order.
    server.binaryType = "arraybuffer";
    const startedAt = Date.now();
    let bytes = 0;
    let heartbeatAt = startedAt;
    let settled = false;
    let sessionWatch: ReturnType<typeof setInterval> | undefined;
    let done: () => void = () => undefined;
    const lifetime = new Promise<void>((resolve) => {
      done = resolve;
    });
    const settle = async (
      outcome:
        | { readonly state: "completed"; readonly text: string }
        | { readonly state: "failed"; readonly error: unknown }
        | { readonly state: "canceled" },
    ) => {
      if (settled) return;
      settled = true;
      clearInterval(sessionWatch);
      abort.abort();
      if (outcome.state !== "completed") session.close();
      try {
        const current = await settleJob(db, id, owner, outcome.state);
        const result: DictationStreamResult =
          outcome.state === "completed" && current
            ? { type: "completed", text: outcome.text }
            : { type: "failed", error: genericError };
        if (outcome.state === "failed")
          logTranscriptionFailure(
            c.env,
            id,
            configuration,
            "stream",
            outcome.error,
          );
        if (outcome.state !== "canceled") {
          try {
            server.send(JSON.stringify(result));
            server.close(1000, "done");
          } catch {}
        }
        if (reached)
          await recordTranscription(
            { db, bindings: c.env },
            owner,
            configuration,
            {
              units: audioSeconds(bytes),
              outcome: outcome.state === "completed" ? "success" : "error",
              durationMs: Date.now() - startedAt,
            },
          );
      } finally {
        done();
      }
    };
    const fail = (error: unknown) => void settle({ state: "failed", error });

    server.addEventListener("message", (event) => {
      if (settled) return;
      if (typeof event.data === "string") {
        if (event.data !== JSON.stringify({ type: "finish" })) return;
        session
          .finish()
          .then((text) => settle({ state: "completed", text }), fail);
        return;
      }
      const pcm = new Uint8Array(event.data);
      bytes += pcm.byteLength;
      if (
        pcm.byteLength > MAX_STREAM_FRAME_BYTES ||
        pcm.byteLength % 2 !== 0 ||
        bytes > MAX_STREAM_PCM_BYTES
      ) {
        fail(new InvalidDictationAudio("Invalid dictation audio"));
        return;
      }
      session.send(pcm);
      const now = Date.now();
      if (now - heartbeatAt >= STREAM_HEARTBEAT) {
        heartbeatAt = now;
        void db
          .prepare(
            "UPDATE dictation_job SET updated_at=? WHERE id=? AND owner_id=? AND state='provider'",
          )
          .bind(now, id, owner)
          .run()
          .catch(() => undefined);
      }
    });
    // The socket lives in this request, so the request checks its session.
    let browserSession = c.get("browserSession");
    if (browserSession !== undefined)
      sessionWatch = setInterval(() => {
        if (browserSession === undefined) return;
        const watched = browserSession;
        void checkBrowserSessions(db, [watched], Date.now())
          .then((states) => {
            const state = states.get(watched.sessionId);
            if (state?.state === "renewed")
              browserSession = { ...watched, expiresAt: state.expiresAt };
            if (state?.state !== "ended" || settled) return;
            closeForEndedSession(server);
            return settle({ state: "canceled" });
          })
          .catch(() => undefined);
      }, sessionSocketCheckMs(c.env));
    server.addEventListener("close", () => void settle({ state: "canceled" }));
    server.addEventListener("error", () => void settle({ state: "canceled" }));
    try {
      c.executionCtx.waitUntil(lifetime);
    } catch {}
    return new Response(null, {
      status: 101,
      webSocket: client,
      headers: {
        "sec-websocket-protocol": DICTATION_STREAM_SUBPROTOCOL,
        "cache-control": "no-store",
      },
    });
  } catch (error) {
    if (error instanceof BrowserSessionRequired)
      return c.json({ error: genericError }, 403);
    logUnexpectedRouteError(c, "stream", error);
    return c.json({ error: genericError }, 500);
  }
});

/** Transcribes a saved recording in one request. */
dictationRoutes.post("/:id", async (c) => {
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "Invalid request." }, 400);
    const wav = await readCanonicalWav(c.req.raw);
    // Read alongside admission; never rejects.
    const vocabularyRead = loadDictationVocabulary(db, owner);
    const admission = await admitSpeech({ db, bindings: c.env }, owner);
    if (!admission.admitted) return unavailable(c);
    const { configuration } = admission;
    if (
      !(await reserve(
        db,
        c.env,
        id,
        owner,
        workspace,
        configuration,
        "dispatching",
      ))
    )
      return existingJob(c, db, id, owner, workspace);
    const vocabulary = await vocabularyRead;
    let reached = false;
    const startedAt = Date.now();
    const meter = (outcome: "success" | "error") =>
      reached
        ? recordTranscription({ db, bindings: c.env }, owner, configuration, {
            units: audioSeconds(wav.byteLength - 44),
            outcome,
            durationMs: Date.now() - startedAt,
          })
        : Promise.resolve();
    let text: string;
    try {
      text = await speechProviderFor(configuration, c.env, () => {
        reached = true;
      }).transcribe(wav, {
        signal: AbortSignal.any([
          c.req.raw.signal,
          AbortSignal.timeout(TRANSCRIBE_TIMEOUT),
        ]),
        vocabulary,
      });
    } catch (error) {
      await settleJob(db, id, owner, "failed");
      await meter("error");
      logTranscriptionFailure(c.env, id, configuration, "recording", error);
      return c.json<DictationJob>({ id, state: "failed", error: genericError });
    }
    await meter("success");
    // A job canceled meanwhile never returns its transcript.
    if (!(await settleJob(db, id, owner, "completed")))
      return c.json<DictationJob>({ id, state: "failed", error: genericError });
    return c.json<DictationJob>({ id, state: "completed", text });
  } catch (error) {
    if (error instanceof InvalidDictationAudio)
      return c.json({ error: "Invalid WAV audio." }, 400);
    if (error instanceof BrowserSessionRequired)
      return c.json({ error: genericError }, 403);
    logUnexpectedRouteError(c, "create", error);
    return c.json({ error: genericError }, 500);
  }
});

/**
 * Transcripts are returned only by the request that produced them and are
 * never stored, so a job read later is still processing or has failed.
 */
dictationRoutes.get("/:id", async (c) => {
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "Not found." }, 404);
    const now = Date.now();
    await retireOwnerJobs(db, owner, now);
    const row = await db
      .prepare(
        "SELECT state,expires_at FROM dictation_job WHERE id=? AND owner_id=? AND workspace_id=?",
      )
      .bind(id, owner, workspace)
      .first<{ state: string; expires_at: number }>();
    if (!row || row.expires_at <= now || row.state === "canceled")
      return c.json({ error: "Not found." }, 404);
    return ["reserved", "dispatching", "provider"].includes(row.state)
      ? c.json<DictationJob>({ id, state: "processing" })
      : c.json<DictationJob>({ id, state: "failed", error: genericError });
  } catch (error) {
    if (error instanceof BrowserSessionRequired)
      return c.json({ error: genericError }, 403);
    logUnexpectedRouteError(c, "read", error);
    return c.json({ error: genericError }, 500);
  }
});

dictationRoutes.delete("/:id", async (c) => {
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.body(null, 204);
    const now = Date.now();
    await db
      .prepare(`INSERT INTO dictation_job(id,owner_id,workspace_id,state,created_at,updated_at,expires_at) VALUES(?,?,?,'canceled',?,?,?)
      ON CONFLICT(id) DO UPDATE SET state='canceled',updated_at=excluded.updated_at WHERE owner_id=excluded.owner_id AND workspace_id=excluded.workspace_id AND expires_at>?`)
      .bind(id, owner, workspace, now, now, now + HOUR, now)
      .run();
    return c.body(null, 204);
  } catch (error) {
    if (error instanceof BrowserSessionRequired)
      return c.json({ error: "Forbidden." }, 403);
    logUnexpectedRouteError(c, "delete", error);
    return c.json({ error: genericError }, 500);
  }
});
