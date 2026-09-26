import type { DictationJob } from "@dx/api";
import { Effect } from "effect";
import { type Context, Hono } from "hono";
import { createAuth } from "../auth/better-auth.js";
import {
  BrowserSessionRequired,
  requireBrowserSession,
} from "../auth/browser-session.js";
import { loadAuthenticationRequirements } from "../auth/requirements.js";
import type { AppEnv } from "../http/types.js";
import { dictationLogger } from "../logging.js";
import {
  DictationProviderError,
  dispatchSarvam,
  pollSarvam,
} from "./provider.js";
import { InvalidDictationAudio, readCanonicalWav } from "./wav.js";

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const HOUR = 3_600_000;
const STALE_AFTER = 120_000;
const PROVIDER_IDLE_AFTER = 300_000;
const genericError = "Dictation could not be completed.";
type Row = {
  id: string;
  state: string;
  provider_job_id: string | null;
  local_reads: number;
  expires_at: number;
};

const noStore = (c: { header(name: string, value: string): void }) =>
  c.header("Cache-Control", "no-store");

const safeDiagnostic = (value: string) =>
  value
    .replaceAll(/https?:\/\/\S+/g, "[url]")
    .replaceAll(/[A-Za-z0-9_-]{24,}/g, "[value]")
    .slice(0, 2_000);

const logUnexpectedRouteError = (
  context: Context<AppEnv>,
  operation: "create" | "read" | "delete",
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

async function dispatch(
  db: D1Database,
  id: string,
  owner: string,
  wav: Uint8Array,
  secret: string | undefined,
  local: boolean,
) {
  const claimed = await db
    .prepare(
      "UPDATE dictation_job SET state='dispatching', updated_at=? WHERE id=? AND owner_id=? AND state='reserved'",
    )
    .bind(Date.now(), id, owner)
    .run();
  if (!claimed.meta.changes) return;
  if (local) {
    await db
      .prepare(
        "UPDATE dictation_job SET state='provider', provider_job_id='local-fixture', updated_at=? WHERE id=? AND state='dispatching'",
      )
      .bind(Date.now(), id)
      .run();
    return;
  }
  if (!secret) {
    await db
      .prepare(
        "UPDATE dictation_job SET state='failed', updated_at=? WHERE id=? AND state='dispatching'",
      )
      .bind(Date.now(), id)
      .run();
    return;
  }
  try {
    await Effect.runPromise(
      dispatchSarvam(
        secret,
        wav,
        async (providerId) => {
          const persisted = await db
            .prepare(
              "UPDATE dictation_job SET provider_job_id=?,updated_at=? WHERE id=? AND owner_id=? AND state='dispatching' AND expires_at>?",
            )
            .bind(providerId, Date.now(), id, owner, Date.now())
            .run();
          return persisted.meta.changes === 1;
        },
        async (providerId) => {
          const active = await db
            .prepare(
              "SELECT 1 AS active FROM dictation_job WHERE id=? AND owner_id=? AND provider_job_id=? AND state='dispatching' AND expires_at>?",
            )
            .bind(id, owner, providerId, Date.now())
            .first<{ active: number }>();
          return active?.active === 1;
        },
      ).pipe(Effect.timeout("90 seconds")),
    );
    await db
      .prepare(
        "UPDATE dictation_job SET state='provider',updated_at=? WHERE id=? AND owner_id=? AND state='dispatching' AND expires_at>?",
      )
      .bind(Date.now(), id, owner, Date.now())
      .run();
  } catch (error) {
    await db
      .prepare(
        "UPDATE dictation_job SET state='failed', updated_at=? WHERE id=? AND owner_id=? AND state IN ('dispatching','provider')",
      )
      .bind(Date.now(), id, owner)
      .run();
    dictationLogger.warn("Dictation dispatch failed.", {
      event: "dictation_dispatch_failed",
      id,
      category:
        error instanceof DictationProviderError ? "provider" : "internal",
      reason:
        error instanceof DictationProviderError
          ? error.reason
          : "Unexpected error",
      stage:
        error instanceof DictationProviderError &&
        error.reason === "Dictation was canceled"
          ? "persistence"
          : "dispatch",
    });
  }
}

export const dictationRoutes = new Hono<AppEnv>();
dictationRoutes.use("*", async (c, next) => {
  noStore(c);
  await next();
});

const retireOwnerJobs = async (db: D1Database, owner: string, now: number) => {
  await db.batch([
    db
      .prepare("DELETE FROM dictation_job WHERE owner_id=? AND expires_at<=?")
      .bind(owner, now),
    db
      .prepare(
        "UPDATE dictation_job SET state='failed',updated_at=? WHERE owner_id=? AND state IN ('reserved','dispatching') AND updated_at<=?",
      )
      .bind(now, owner, now - STALE_AFTER),
    db
      .prepare(
        "UPDATE dictation_job SET state='failed',updated_at=? WHERE owner_id=? AND state='provider' AND updated_at<=?",
      )
      .bind(now, owner, now - PROVIDER_IDLE_AFTER),
  ]);
};

dictationRoutes.post("/:id", async (c) => {
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "Invalid request." }, 400);
    const wav = await readCanonicalWav(c.req.raw);
    const now = Date.now();
    await retireOwnerJobs(db, owner, now);
    const result = await db
      .prepare(`INSERT INTO dictation_job(id,owner_id,workspace_id,state,created_at,updated_at,expires_at)
      SELECT ?,?,?,'reserved',?,?,? WHERE
      NOT EXISTS(SELECT 1 FROM dictation_job WHERE owner_id=? AND state IN ('reserved','dispatching','provider'))
      ON CONFLICT(id) DO NOTHING`)
      .bind(id, owner, workspace, now, now, now + HOUR, owner)
      .run();
    if (!result.meta.changes) {
      const existing = await db
        .prepare(
          "SELECT state FROM dictation_job WHERE id=? AND owner_id=? AND workspace_id=?",
        )
        .bind(id, owner, workspace)
        .first<{ state: string }>();
      if (existing)
        return existing.state === "canceled" || existing.state === "failed"
          ? c.json<DictationJob>({ id, state: "failed", error: genericError })
          : c.json<DictationJob>({ id, state: "processing" }, 202);
      return c.json({ error: "Dictation is temporarily unavailable." }, 429);
    }
    await dispatch(
      db,
      id,
      owner,
      wav,
      c.env.SARVAM_API_KEY,
      c.env.DX_RUNTIME_MODE === "local",
    );
    return c.json<DictationJob>({ id, state: "processing" }, 202);
  } catch (error) {
    if (error instanceof InvalidDictationAudio)
      return c.json({ error: "Invalid WAV audio." }, 400);
    if (error instanceof BrowserSessionRequired)
      return c.json({ error: genericError }, 403);
    logUnexpectedRouteError(c, "create", error);
    return c.json({ error: genericError }, 500);
  }
});

dictationRoutes.get("/:id", async (c) => {
  try {
    const { db, owner, workspace } = await authorize(c);
    const id = c.req.param("id");
    if (!UUID.test(id)) return c.json({ error: "Not found." }, 404);
    const now = Date.now();
    await retireOwnerJobs(db, owner, now);
    const row = await db
      .prepare(
        "SELECT id,state,provider_job_id,local_reads,expires_at FROM dictation_job WHERE id=? AND owner_id=? AND workspace_id=?",
      )
      .bind(id, owner, workspace)
      .first<Row>();
    if (!row || row.expires_at <= now || row.state === "canceled")
      return c.json({ error: "Not found." }, 404);
    if (row.state === "failed")
      return c.json<DictationJob>({ id, state: "failed", error: genericError });
    if (row.provider_job_id === "local-fixture") {
      if (row.local_reads === 0) {
        await db
          .prepare(
            "UPDATE dictation_job SET local_reads=1 WHERE id=? AND owner_id=? AND local_reads=0",
          )
          .bind(id, owner)
          .run();
        return c.json<DictationJob>({ id, state: "processing" });
      }
      const completed = await db
        .prepare(
          "UPDATE dictation_job SET state='completed',updated_at=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND expires_at>?",
        )
        .bind(Date.now(), id, owner, Date.now())
        .run();
      if (!completed.meta.changes) return c.json({ error: "Not found." }, 404);
      return c.json<DictationJob>({
        id,
        state: "completed",
        text: "This is a local dictation fixture.",
      });
    }
    if (!["provider", "completed"].includes(row.state) || !row.provider_job_id)
      return c.json<DictationJob>({ id, state: "processing" });
    const token = crypto.randomUUID();
    const leased = await db
      .prepare(
        "UPDATE dictation_job SET lease_token=?,lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND expires_at>? AND (lease_until IS NULL OR lease_until<?)",
      )
      .bind(
        token,
        Date.now() + 45_000,
        Date.now(),
        id,
        owner,
        Date.now(),
        Date.now(),
      )
      .run();
    if (!leased.meta.changes)
      return c.json<DictationJob>({ id, state: "processing" });
    let result: "processing" | { text: string } | "failed";
    try {
      result = c.env.SARVAM_API_KEY
        ? await Effect.runPromise(
            pollSarvam(c.env.SARVAM_API_KEY, row.provider_job_id).pipe(
              Effect.timeout("30 seconds"),
            ),
          )
        : "failed";
    } catch {
      const released = await db
        .prepare(
          "UPDATE dictation_job SET lease_token=NULL,lease_until=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND lease_token=? AND expires_at>?",
        )
        .bind(Date.now() + 3_000, id, owner, token, Date.now())
        .run();
      if (!released.meta.changes) return c.json({ error: "Not found." }, 404);
      return c.json<DictationJob>({ id, state: "processing" });
    }
    if (result === "processing") {
      const released = await db
        .prepare(
          "UPDATE dictation_job SET lease_token=NULL,lease_until=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND lease_token=? AND expires_at>?",
        )
        .bind(Date.now() + 3_000, id, owner, token, Date.now())
        .run();
      if (!released.meta.changes) return c.json({ error: "Not found." }, 404);
      return c.json<DictationJob>({ id, state: "processing" });
    }
    if (result === "failed") {
      const failed = await db
        .prepare(
          "UPDATE dictation_job SET state='failed',updated_at=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND lease_token=? AND expires_at>?",
        )
        .bind(Date.now(), id, owner, token, Date.now())
        .run();
      if (!failed.meta.changes) return c.json({ error: "Not found." }, 404);
      return c.json<DictationJob>({ id, state: "failed", error: genericError });
    }
    const completed = await db
      .prepare(
        "UPDATE dictation_job SET state='completed',lease_token=NULL,lease_until=?,updated_at=? WHERE id=? AND owner_id=? AND state IN ('provider','completed') AND lease_token=? AND expires_at>?",
      )
      .bind(Date.now() + 3_000, Date.now(), id, owner, token, Date.now())
      .run();
    if (!completed.meta.changes) return c.json({ error: "Not found." }, 404);
    return c.json<DictationJob>({ id, state: "completed", text: result.text });
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
