import {
  TRANSCRIPT_WIRE_VERSION,
  TranscriptDisabledResponseSchema,
  TranscriptPageResponseSchema,
} from "@dx/api";
import {
  productionExperimentalFeatureRegistry,
  SERVER_TRANSCRIPT_FEATURE_ID,
  ThreadId,
} from "@dx/domain";
import {
  deriveTranscriptViewModel,
  isWithdrawnSettlement,
  type TranscriptItems,
  type TranscriptViewModel,
  transcriptItemOps,
  transcriptItems,
  transcriptPage,
} from "@dx/transcript";
import type {
  FlueClient,
  FlueConversationFinalOutput,
  FlueConversationMessage,
  FlueConversationSettlement,
} from "@flue/sdk";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import type { AppEnv, Bindings } from "../http/types.js";
import { transcriptLogger } from "../logging.js";

/**
 * A Thread's transcript as items Core projects from Flue's conversation with
 * the same `@dx/transcript` model the web runs (prototype; see
 * wiki/headless-client.md, "Server transcript"). Nothing is stored: a page is
 * projected when it is read, and each updates connection follows Flue's live
 * stream with its own projection of the newest page.
 *
 * - `GET /:threadId/transcript?before=`: one history page (5 prompts within
 *   1 MiB, as the web reads) as items.
 * - `GET /:threadId/transcript/updates`: `text/event-stream`. First
 *   `event: reset` with the newest page, then `event: items` with the ops
 *   that change it, at most every `FRAME_MS`.
 *
 * Both answer 404 `SERVER_TRANSCRIPT_DISABLED` unless the person turned on
 * the `server-transcript` experimental feature.
 */

/** As the web reads history (`THREAD_HISTORY_PAGE`). */
const PAGE = { promptLimit: 5, maxBytes: 1024 * 1024 } as const;
/** Coalesces Flue's chunks into one projection per frame. */
const FRAME_MS = 50;
const HEARTBEAT_MS = 15_000;
/**
 * While a turn runs and Flue's stream has sent nothing for this long, the
 * route reads the newest page again and sends what changed, so a follower
 * that stalls delays a client by about this much and never leaves it wrong.
 */
const RECONCILE_MS = 5_000;

/**
 * `sent` with the turns of a newer page replaced by that page's: older
 * turns the connection already sent stay, since the page holds only the
 * newest prompts.
 */
const withPage = (
  sent: TranscriptItems,
  page: TranscriptItems,
): TranscriptItems => {
  const turns = new Set(page.turns.map((turn) => turn.id));
  return {
    turns: [...sent.turns.filter((turn) => !turns.has(turn.id)), ...page.turns],
    items: [
      ...sent.items.filter((item) => !turns.has(item.turn)),
      ...page.items,
    ],
  };
};

const featureDefault =
  productionExperimentalFeatureRegistry.features.find(
    ({ id }) => id === SERVER_TRANSCRIPT_FEATURE_ID,
  )?.defaultEnabled ?? false;

/** The person's `server-transcript` preference, else its default (off). */
export const serverTranscriptOn = async (db: D1Database, userId: string) => {
  const stored = await db
    .prepare(
      "SELECT preferences FROM personal_experimental_feature_preferences WHERE user_id = ?",
    )
    .bind(userId)
    .first<string>("preferences");
  if (stored === null) return featureDefault;
  try {
    const found = (
      JSON.parse(stored) as Array<{ id?: unknown; enabled?: unknown }>
    ).find(({ id }) => id === SERVER_TRANSCRIPT_FEATURE_ID);
    return typeof found?.enabled === "boolean" ? found.enabled : featureDefault;
  } catch {
    return featureDefault;
  }
};

interface Conversation {
  readonly messages: ReadonlyArray<FlueConversationMessage>;
  readonly settlements: ReadonlyArray<FlueConversationSettlement>;
  readonly finalOutputs: ReadonlyArray<FlueConversationFinalOutput>;
}

/** The view model of a conversation, as the web derives it from Flue's. */
export const conversationModel = (
  conversation: Conversation,
  previous?: TranscriptViewModel,
) =>
  deriveTranscriptViewModel(
    {
      messages: conversation.messages as FlueConversationMessage[],
      // A withdrawn message ran nothing; it shows no stopped turn.
      settlements: conversation.settlements.filter(
        (settlement) => !isWithdrawnSettlement(settlement),
      ),
      finalOutputs: conversation.finalOutputs as FlueConversationFinalOutput[],
    },
    previous,
  );

export interface TranscriptRouteDependencies {
  readonly flue: (threadId: string, env: Bindings) => FlueClient;
  readonly featureOn: (db: D1Database, userId: string) => Promise<boolean>;
}

const decodeThreadId = Schema.decodeUnknownOption(ThreadId);

const disabled = (context: Context<AppEnv>) =>
  context.json(
    Schema.encodeUnknownSync(TranscriptDisabledResponseSchema)({
      status: "error",
      data: {
        code: "SERVER_TRANSCRIPT_DISABLED",
        message:
          "Server transcripts are an experimental feature that is off for this account.",
        requestId: context.get("requestId"),
      },
    }),
    404,
  );

const admit = async (
  context: Context<AppEnv>,
  dependencies: TranscriptRouteDependencies,
) => {
  const threadId = decodeThreadId(context.req.param("threadId"));
  if (Option.isNone(threadId)) return context.notFound();
  const db = context.env.DB;
  const on =
    db !== undefined &&
    (await dependencies.featureOn(db, context.get("actor").userId));
  return on ? threadId.value : disabled(context);
};

const sse = (event: string, data: unknown) =>
  `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

export const createTranscriptRoutes = (
  dependencies: TranscriptRouteDependencies,
) =>
  new Hono<AppEnv>()
    .get("/:threadId/transcript", async (context) => {
      const threadId = await admit(context, dependencies);
      if (threadId instanceof Response) return threadId;
      const before = context.req.query("before");
      const page = await dependencies
        .flue(threadId, context.env)
        .history({ ...PAGE, ...(before ? { before } : {}) });
      const body = Schema.encodeUnknownSync(TranscriptPageResponseSchema)({
        status: "success",
        data: transcriptPage(conversationModel(page), page),
      });
      return context.json(body, 200, { "cache-control": "no-store" });
    })
    .get("/:threadId/transcript/updates", async (context) => {
      const threadId = await admit(context, dependencies);
      if (threadId instanceof Response) return threadId;
      const observation = dependencies
        .flue(threadId, context.env)
        // Long-poll: each wait is a new request to the agent's object. A
        // long-lived SSE subrequest inside the Worker sometimes went quiet
        // while still "live" (server-transcript journey, runs 4 and 5).
        .observe({ live: "long-poll", ...PAGE });
      context.req.raw.signal.addEventListener(
        "abort",
        () => observation.close(),
        { once: true },
      );
      const encoder = new TextEncoder();
      let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
      let model: TranscriptViewModel | undefined;
      let sent: TranscriptItems | undefined;
      let incarnation: string | undefined;
      let frame: ReturnType<typeof setTimeout> | undefined;
      let closed = false;
      const write = (text: string) => {
        if (closed || controller === undefined) return;
        try {
          controller.enqueue(encoder.encode(text));
        } catch {
          close();
        }
      };
      const log = (event: string, fields: Record<string, unknown>) =>
        transcriptLogger.info(event, { threadId, ...fields });
      // Offsets are fixed-width, so they compare as strings.
      let sentOffset = "";
      let changedAt = Date.now();
      let phase: string | undefined;
      const project = () => {
        frame = undefined;
        try {
          projectNow();
        } catch (cause) {
          log("transcript.updates.projection_failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        }
      };
      const projectNow = () => {
        const snapshot = observation.getSnapshot();
        if (snapshot.phase !== phase) {
          phase = snapshot.phase;
          log("transcript.updates.phase", {
            phase,
            error: snapshot.error?.message,
          });
        }
        if (snapshot.phase === "absent" || snapshot.phase === "error") {
          close();
          return;
        }
        const conversation = snapshot.conversation;
        if (conversation === undefined || snapshot.offset === undefined) return;
        // A page read to reconcile may be ahead of a stalled follower.
        if (snapshot.offset < sentOffset) return;
        if (snapshot.offset > sentOffset) changedAt = Date.now();
        sentOffset = snapshot.offset;
        model = conversationModel(conversation, model);
        const next = transcriptItems(model);
        if (sent === undefined || snapshot.incarnation !== incarnation) {
          incarnation = snapshot.incarnation;
          sent = next;
          write(
            sse("reset", transcriptPage(model, { offset: snapshot.offset })),
          );
          return;
        }
        const ops = transcriptItemOps(sent, next);
        sent = next;
        if (ops.length > 0)
          write(
            sse("items", {
              v: TRANSCRIPT_WIRE_VERSION,
              offset: snapshot.offset,
              ops,
            }),
          );
      };
      let reconciling = false;
      const reconcile = setInterval(async () => {
        if (closed || reconciling || sent === undefined) return;
        const running = sent.turns.some((turn) => turn.status === "active");
        if (!running || Date.now() - changedAt < RECONCILE_MS) return;
        reconciling = true;
        try {
          const page = await flue.history(PAGE);
          if (closed || sent === undefined || page.offset < sentOffset) return;
          const next = withPage(sent, transcriptItems(conversationModel(page)));
          const ops = transcriptItemOps(sent, next);
          sent = next;
          sentOffset = page.offset;
          changedAt = Date.now();
          if (ops.length > 0) {
            log("transcript.updates.reconciled", { ops: ops.length });
            write(
              sse("items", {
                v: TRANSCRIPT_WIRE_VERSION,
                offset: page.offset,
                ops,
              }),
            );
          }
        } catch (cause) {
          log("transcript.updates.reconcile_failed", {
            error: cause instanceof Error ? cause.message : String(cause),
          });
        } finally {
          reconciling = false;
        }
      }, RECONCILE_MS);
      const unsubscribe = observation.subscribe(() => {
        frame ??= setTimeout(project, FRAME_MS);
      });
      const heartbeat = setInterval(
        () => write(": heartbeat\n\n"),
        HEARTBEAT_MS,
      );
      const close = () => {
        if (closed) return;
        closed = true;
        unsubscribe();
        clearInterval(heartbeat);
        clearInterval(reconcile);
        if (frame !== undefined) clearTimeout(frame);
        observation.close();
        try {
          controller?.close();
        } catch {
          // Already closed by the reader.
        }
      };
      context.req.raw.signal.addEventListener("abort", close, { once: true });
      // The first event comes from one history read, with the cursor to page
      // back from; the live stream then only sends what changed since.
      const flue = dependencies.flue(threadId, context.env);
      const first = await flue.history(PAGE);
      model = conversationModel(first);
      sent = transcriptItems(model);
      incarnation = first.incarnation;
      sentOffset = first.offset;
      const body = new ReadableStream<Uint8Array>({
        start(started) {
          controller = started;
          write(
            sse("reset", transcriptPage(model as TranscriptViewModel, first)),
          );
          observation.start();
        },
        cancel: close,
      });
      return new Response(body, {
        headers: {
          "content-type": "text/event-stream; charset=utf-8",
          "cache-control": "no-store",
        },
      });
    });
