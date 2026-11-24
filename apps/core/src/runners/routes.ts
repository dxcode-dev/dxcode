import {
  CreateRunnerPairingResponseSchema,
  ListRunnersResponseSchema,
  RemoveRunnerResponseSchema,
  RunnerMachineId,
} from "@dx/api";
import { orbProviderBetaFeature } from "@dx/domain";
import { getLogger } from "@logtape/logtape";
import { Option, Schema } from "effect";
import { type Context, Hono } from "hono";
import { runnerArchiveKey } from "../execution/runner/provider.js";
import { readBoundedBody } from "../http/bounded-body.js";
import type { AppEnv } from "../http/types.js";
import { takeRequestBudget } from "../security/request-budget.js";
import { enabledExperimentalFeatures } from "../settings/experimental-features/routes.js";
import { revokeRunnerSession, runnerStatus } from "./client.js";
import installScript from "./install.sh?raw";
import {
  createPairing,
  listMachines,
  machineForToken,
  newPairingCode,
  normalisePairingCode,
  pairMachine,
  revokeMachine,
  threadPinnedToMachine,
} from "./repository.js";
import {
  RUNNER_MACHINE_HEADER,
  RUNNER_ORIGIN_HEADER,
} from "./session-object.js";

const logger = getLogger(["dx", "runners", "routes"]);

/** A Thread's snapshot is at most this large (dxd runner caps it at 50 MB). */
const MAX_ARCHIVE_BYTES = 64 * 1024 * 1024;
const MAX_PAIR_BODY_BYTES = 4096;

/**
 * Pairing guesses (#2436). A code is one of 20^8 (about 2.6e10) and lives 15
 * minutes, so the deployment-wide budget caps a day's guesses at 28,800: a
 * chance of about 1 in 900,000 a day per live code. One address gets 10, so
 * a person who mistypes a code a few times still pairs.
 */
export const PAIR_GUESS_WINDOW_MS = 15 * 60_000;
export const PAIR_GUESSES_PER_ADDRESS = 10;
export const PAIR_GUESSES_OVERALL = 300;

const refuse = (
  context: Context<AppEnv>,
  status: 400 | 401 | 403 | 404 | 429 | 503,
  code: string,
  message: string,
) => {
  context.header("Cache-Control", "no-store");
  return context.json(
    {
      status: "error",
      data: { code, message, requestId: context.get("requestId") },
    },
    status,
  );
};

const originOf = (context: Context<AppEnv>) => new URL(context.req.url).origin;

/** The person turned on runners and the deployment offers them. */
const runnersOffered = async (context: Context<AppEnv>) => {
  if (context.env.RUNNER_SESSION === undefined || context.env.DB === undefined)
    return false;
  const feature = orbProviderBetaFeature("runner");
  if (feature === undefined) return true;
  const enabled: ReadonlySet<string> = await enabledExperimentalFeatures(
    context.env,
    context.get("principal"),
  ).catch(() => new Set<string>());
  return enabled.has(feature);
};

/**
 * `/v1/settings/personal/runners`: the person's paired machines. Hidden
 * (404) until they turn on the `orb-provider-runner` experimental feature.
 */
export const personalRunnerRoutes = new Hono<AppEnv>()
  .use("*", async (context, next) => {
    if (!(await runnersOffered(context)))
      return refuse(context, 404, "NOT_FOUND", "Not found.");
    await next();
  })
  .get("/", async (context) => {
    const db = context.env.DB as D1Database;
    const machines = await listMachines(db, context.get("principal").userId);
    const runners = await Promise.all(
      machines.map(async (machine) => {
        const status = await runnerStatus(context.env, machine.id);
        return {
          id: machine.id,
          name: machine.name,
          os: machine.os,
          arch: status?.arch ?? machine.arch,
          version: status?.version ?? machine.version,
          online: status?.online === true,
          lastSeenAt: status?.lastSeenAt ?? machine.last_seen_at,
          createdAt: machine.created_at,
        };
      }),
    );
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(ListRunnersResponseSchema)({
        status: "success",
        data: { runners },
      }),
    );
  })
  .post("/pairings", async (context) => {
    const db = context.env.DB as D1Database;
    const code = newPairingCode();
    const expiresAt = await createPairing(
      db,
      context.get("principal").userId,
      code,
    );
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(CreateRunnerPairingResponseSchema)({
        status: "success",
        data: {
          code,
          expiresAt,
          command: `curl -fsSL ${originOf(context)}/v1/runner/install.sh | sh -s -- --code ${code}`,
        },
      }),
      201,
    );
  })
  .delete("/:machineId", async (context) => {
    const machineId = Option.getOrUndefined(
      Schema.decodeUnknownOption(RunnerMachineId)(
        context.req.param("machineId"),
      ),
    );
    if (machineId === undefined)
      return refuse(context, 404, "RUNNER_NOT_FOUND", "Runner not found.");
    const removed = await revokeMachine(
      context.env.DB as D1Database,
      context.get("principal").userId,
      machineId,
    );
    if (!removed)
      return refuse(context, 404, "RUNNER_NOT_FOUND", "Runner not found.");
    await revokeRunnerSession(context.env, machineId);
    context.header("Cache-Control", "no-store");
    return context.json(
      Schema.encodeUnknownSync(RemoveRunnerResponseSchema)({
        status: "success",
        data: { removed: true },
      }),
    );
  });

const bearer = (context: Context<AppEnv>) => {
  const header = context.req.header("authorization") ?? "";
  const match = /^Bearer (dxr_[0-9a-f]{64})$/.exec(header);
  return match?.[1];
};

/** The live machine a runner request authenticates as. */
const runnerMachine = async (context: Context<AppEnv>) => {
  const token = bearer(context);
  const db = context.env.DB;
  if (token === undefined || db === undefined) return undefined;
  return machineForToken(db, token);
};

const PairRequest = Schema.Struct({
  code: Schema.String,
  name: Schema.String,
  os: Schema.Literals(["macos", "linux"]),
  arch: Schema.String,
  version: Schema.optional(Schema.String),
});

/**
 * `/v1/runner`: what `dxd runner` on a person's machine calls, before
 * session authentication. Pairing spends a one-time code; everything else
 * carries the runner's token.
 */
export const runnerPublicRoutes = new Hono<AppEnv>()
  .get("/install.sh", (context) => {
    context.header("Content-Type", "text/x-shellscript; charset=utf-8");
    context.header("Cache-Control", "no-store");
    return context.body(
      installScript.replaceAll("__DX_ORIGIN__", originOf(context)),
    );
  })
  .post("/pair", async (context) => {
    const db = context.env.DB;
    if (db === undefined || context.env.RUNNER_SESSION === undefined)
      return refuse(context, 404, "NOT_FOUND", "Not found.");
    const bytes = await readBoundedBody(context.req.raw, MAX_PAIR_BODY_BYTES);
    let input: typeof PairRequest.Type | undefined;
    try {
      input =
        bytes === undefined
          ? undefined
          : Option.getOrUndefined(
              Schema.decodeUnknownOption(PairRequest)(
                JSON.parse(new TextDecoder().decode(bytes)),
              ),
            );
    } catch {
      input = undefined;
    }
    const code =
      input === undefined ? undefined : normalisePairingCode(input.code);
    const name =
      input === undefined
        ? undefined
        : [...input.name]
            .filter((character) => {
              const point = character.codePointAt(0) ?? 0;
              return point >= 0x20 && point !== 0x7f;
            })
            .join("")
            .trim();
    if (
      input === undefined ||
      code === undefined ||
      name === undefined ||
      name.length < 1 ||
      name.length > 64 ||
      !/^[a-z0-9_]{1,32}$/.test(input.arch)
    )
      return refuse(
        context,
        400,
        "INVALID_REQUEST",
        "Request validation failed.",
      );
    const address = context.req.header("cf-connecting-ip") ?? "unknown";
    if (
      !(await takeRequestBudget(db, `runner-pair:address:${address}`, {
        maximum: PAIR_GUESSES_PER_ADDRESS,
        windowMs: PAIR_GUESS_WINDOW_MS,
      })) ||
      !(await takeRequestBudget(db, "runner-pair", {
        maximum: PAIR_GUESSES_OVERALL,
        windowMs: PAIR_GUESS_WINDOW_MS,
      }))
    ) {
      logger.warn("Runner pairing was rate limited.", {
        event: "runner_pair_rate_limited",
      });
      context.header("Retry-After", "900");
      return refuse(
        context,
        429,
        "RATE_LIMITED",
        "Too many pairing attempts. Wait 15 minutes, then try again.",
      );
    }
    const paired = await pairMachine(db, {
      code,
      name,
      os: input.os,
      arch: input.arch,
      version: (input.version ?? "").slice(0, 32),
    });
    if (paired === undefined)
      return refuse(
        context,
        403,
        "PAIRING_CODE_INVALID",
        "This pairing code is wrong, used, or expired. Make a new one in dx.",
      );
    logger.info("Runner paired.", {
      event: "runner_paired",
      machineId: paired.machineId,
      os: input.os,
      arch: input.arch,
    });
    context.header("Cache-Control", "no-store");
    return context.json(
      { machineId: paired.machineId, token: paired.token },
      201,
    );
  })
  .get("/connect", async (context) => {
    const namespace = context.env.RUNNER_SESSION;
    if (namespace === undefined)
      return refuse(context, 404, "NOT_FOUND", "Not found.");
    if (context.req.header("upgrade")?.toLowerCase() !== "websocket")
      return refuse(context, 400, "INVALID_REQUEST", "Expected a WebSocket.");
    const machine = await runnerMachine(context);
    if (machine === undefined)
      return refuse(
        context,
        401,
        "RUNNER_UNAUTHORIZED",
        "This runner is not paired with dx. Pair it again.",
      );
    const headers = new Headers(context.req.raw.headers);
    headers.set(RUNNER_MACHINE_HEADER, machine.id);
    headers.set(RUNNER_ORIGIN_HEADER, originOf(context));
    return namespace
      .get(namespace.idFromName(machine.id))
      .fetch(new Request(context.req.url, { headers }));
  })
  .put("/archives/:threadId", async (context) => {
    const storage = context.env.DX_STORAGE;
    const machine = await runnerMachine(context);
    const threadId = context.req.param("threadId");
    if (machine === undefined)
      return refuse(context, 401, "RUNNER_UNAUTHORIZED", "Unauthorized.");
    if (
      storage === undefined ||
      !(await threadPinnedToMachine(
        context.env.DB as D1Database,
        threadId,
        machine.id,
      ))
    )
      return refuse(context, 404, "NOT_FOUND", "Not found.");
    const bytes = await readBoundedBody(context.req.raw, MAX_ARCHIVE_BYTES);
    if (bytes === undefined || bytes.byteLength === 0)
      return refuse(
        context,
        400,
        "INVALID_REQUEST",
        "The snapshot is empty or too large.",
      );
    await storage.put(runnerArchiveKey(threadId), bytes, {
      httpMetadata: { contentType: "application/json" },
      customMetadata: { machineId: machine.id },
    });
    logger.info("Runner Thread archived.", {
      event: "runner_thread_archived",
      threadId,
      machineId: machine.id,
      bytes: bytes.byteLength,
    });
    return context.json({ stored: true, bytes: bytes.byteLength });
  })
  .get("/archives/:threadId", async (context) => {
    const storage = context.env.DX_STORAGE;
    const machine = await runnerMachine(context);
    const threadId = context.req.param("threadId");
    if (machine === undefined)
      return refuse(context, 401, "RUNNER_UNAUTHORIZED", "Unauthorized.");
    if (
      storage === undefined ||
      !(await threadPinnedToMachine(
        context.env.DB as D1Database,
        threadId,
        machine.id,
      ))
    )
      return refuse(context, 404, "NOT_FOUND", "Not found.");
    const object = await storage.get(runnerArchiveKey(threadId));
    if (object === null) return refuse(context, 404, "NOT_FOUND", "Not found.");
    return new Response(object.body, {
      headers: {
        "content-type": "application/json",
        "cache-control": "no-store",
      },
    });
  });
