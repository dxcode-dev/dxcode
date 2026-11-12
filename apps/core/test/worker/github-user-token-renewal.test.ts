import {
  createExecutionContext,
  createScheduledController,
  env,
  runInDurableObject,
  waitOnExecutionContext,
} from "cloudflare:test";
import { AsyncLocalStorage } from "node:async_hooks";
import { Effect } from "effect";
import { HttpResponse, http } from "msw";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import type { Bindings } from "../../src/http/types.js";
import { THREAD_SWEEP_CRON } from "../../src/notifications/snooze-cron.js";
import { loadConfigEncryptionKeyring } from "../../src/settings/environment-variables/encryption.js";
import {
  IntegrationCredentialVault,
  IntegrationCredentialVaultD1,
  sealIntegrationCredential,
} from "../../src/settings/integrations/credential-vault.js";
import { readGitHubUserAccessToken } from "../../src/source-control/github/control-plane.js";
import { network } from "./network-boundary.js";

// GitHub App user tokens as GitHub documents them
// (https://docs.github.com/en/apps/creating-github-apps/authenticating-with-a-github-app/refreshing-user-access-tokens):
// an access token lasts 8 hours, "once you use a refresh token, that refresh
// token and the old user access token will no longer work", and a used
// refresh token is answered with 200 `{"error":"bad_refresh_token"}`. These
// cases drive dx through the call `gh` and additional-repository clones make
// (readGitHubUserAccessToken) and through its cron, with the real token
// Durable Object, and fail on the code before #1953.

const { default: worker } = await import("../../src/cloudflare.js");

const ACCESS_LIFETIME_S = 8 * 3_600;
const ACCOUNT_ID = 42;
const bindings = { ...env, DB: env.DB } as Bindings;

/**
 * Marks work started by a request whose Worker invocation Cloudflare
 * cancelled (the client disconnected). Nothing that request started hears
 * back, as in production; work another invocation owns, such as a Durable
 * Object's, is unaffected.
 */
const cancelledRequest = new AsyncLocalStorage<true>();

type Event =
  | { readonly kind: "refresh"; readonly issued: string; readonly at: number }
  | { readonly kind: "refused"; readonly at: number }
  | {
      readonly kind: "user";
      readonly token: string;
      readonly ok: boolean;
      readonly at: number;
    };

/** A GitHub that rotates user tokens and refuses a used refresh token. */
const fakeGitHub = () => {
  const state = {
    generation: 0,
    refreshToken: "ghr_0",
    accessToken: "ghu_0",
    accessExpiresAt: Number.POSITIVE_INFINITY,
    events: [] as Event[],
    /** Makes the next rotation's answer wait until released. */
    hold: undefined as Promise<void> | undefined,
    /** Answers every token call with this status instead. */
    outage: undefined as number | undefined,
  };
  const count = (kind: Event["kind"]) =>
    state.events.filter((event) => event.kind === kind).length;
  network.use(
    http.post(
      "https://github.com/login/oauth/access_token",
      async ({ request }) => {
        const form = new URLSearchParams(await request.text());
        if (state.outage !== undefined)
          return new HttpResponse("unavailable", { status: state.outage });
        if (
          form.get("grant_type") !== "refresh_token" ||
          form.get("refresh_token") !== state.refreshToken
        ) {
          state.events.push({ kind: "refused", at: Date.now() });
          return HttpResponse.json({
            error: "bad_refresh_token",
            error_description:
              "The refresh token passed is incorrect or expired.",
          });
        }
        // GitHub rotates before its answer reaches anyone: the old pair is dead.
        state.generation += 1;
        state.accessToken = `ghu_${state.generation}`;
        state.refreshToken = `ghr_${state.generation}`;
        state.accessExpiresAt = Date.now() + ACCESS_LIFETIME_S * 1_000;
        const answer = HttpResponse.json({
          access_token: state.accessToken,
          refresh_token: state.refreshToken,
          expires_in: ACCESS_LIFETIME_S,
          refresh_token_expires_in: 15_811_200,
          token_type: "bearer",
          scope: "",
        });
        state.events.push({
          kind: "refresh",
          issued: state.accessToken,
          at: Date.now(),
        });
        if (cancelledRequest.getStore()) return new Promise<never>(() => {});
        if (state.hold !== undefined) await state.hold;
        return answer;
      },
    ),
    http.get("https://api.github.com/user", ({ request }) => {
      const token =
        request.headers.get("authorization")?.replace(/^Bearer /, "") ?? "";
      const ok =
        token === state.accessToken && Date.now() < state.accessExpiresAt;
      state.events.push({ kind: "user", token, ok, at: Date.now() });
      return ok
        ? HttpResponse.json({ id: ACCOUNT_ID, login: "octo" })
        : new HttpResponse("Bad credentials", { status: 401 });
    }),
  );
  return {
    state,
    rotations: () => count("refresh"),
    refused: () => count("refused"),
  };
};

let userId = "";

const put = (purpose: "access-token" | "refresh-token", value: string) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      const vault = yield* IntegrationCredentialVault;
      return yield* vault.put(
        keyring,
        { scope: "personal", id: userId as never },
        purpose,
        value,
      );
    }).pipe(Effect.provide(IntegrationCredentialVaultD1(env.DB))),
  );

/** The authorization a completed GitHub sign-in leaves, holding GitHub's current pair. */
const authorize = async (
  github: ReturnType<typeof fakeGitHub>,
  expiresInMs: number,
) => {
  github.state.accessExpiresAt = Date.now() + expiresInMs;
  const [access, refresh] = await Promise.all([
    put("access-token", github.state.accessToken),
    put("refresh-token", github.state.refreshToken),
  ]);
  const now = new Date().toISOString();
  await env.DB.prepare(`
    INSERT INTO github_user_authorization (
      id, user_id, provider_account_id, provider_account_login, status,
      access_token_reference_id, refresh_token_reference_id, expires_at,
      refresh_expires_at, created_at, updated_at
    ) VALUES (?, ?, ?, 'octo', 'active', ?, ?, ?, NULL, ?, ?)
  `)
    .bind(
      `ghu_${userId}`,
      userId,
      String(ACCOUNT_ID),
      access.id,
      refresh.id,
      new Date(Date.now() + expiresInMs).toISOString(),
      now,
      now,
    )
    .run();
};

const token = () => readGitHubUserAccessToken(bindings, env.DB, userId);
const row = () =>
  env.DB.prepare("SELECT * FROM github_user_authorization WHERE user_id = ?")
    .bind(userId)
    .first<Record<string, string | number | null>>();
const tick = async (scheduledTime = Date.now()) => {
  const context = createExecutionContext();
  await worker.scheduled(
    createScheduledController({ cron: THREAD_SWEEP_CRON, scheduledTime }),
    bindings,
    context,
  );
  await waitOnExecutionContext(context);
};
const until = async (condition: () => boolean) => {
  for (let attempt = 0; attempt < 200 && !condition(); attempt += 1)
    await new Promise((resolve) => setTimeout(resolve, 10));
  expect(condition()).toBe(true);
};

beforeEach(async () => {
  userId = `github-renewal-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(userId, "Renewal", `${userId}@example.com`)
    .run();
});
afterEach(async () => {
  vi.useRealTimers();
  // The shared reset deletes users; their GitHub rows go first.
  await env.DB.batch([
    env.DB.prepare("DELETE FROM github_user_authorization"),
    env.DB.prepare("DELETE FROM github_authorization_epoch"),
  ]);
});

it("keeps the rotation when the request that started the refresh is cancelled after GitHub rotated", async () => {
  const github = fakeGitHub();
  await authorize(github, 30 * 60_000);

  // An additional-repository clone asks for the token inside its last hour;
  // GitHub rotates; the request is cancelled before the answer arrives.
  void cancelledRequest.run(true, () => token().catch(() => undefined));
  await until(() => github.rotations() === 1);

  // The next use gets the token GitHub issued, the only one it still
  // accepts, not the old one it disabled when it rotated.
  await expect(token()).resolves.toBe(github.state.accessToken);
  expect(github.refused()).toBe(0);
  expect(github.rotations()).toBe(1);
  expect(await row()).toMatchObject({ status: "active" });
});

it("rotates once for three simultaneous requests, and every caller gets the new token", async () => {
  const github = fakeGitHub();
  await authorize(github, 30 * 60_000);
  let release!: () => void;
  github.state.hold = new Promise((resolve) => {
    release = resolve;
  });
  const requests = [1, 2, 3].map(() => token());
  await until(() => github.rotations() >= 1);
  await new Promise((resolve) => setTimeout(resolve, 100));
  release();
  const tokens = await Promise.all(requests);
  expect(github.rotations()).toBe(1);
  expect(github.refused()).toBe(0);
  expect(tokens).toEqual([
    github.state.accessToken,
    github.state.accessToken,
    github.state.accessToken,
  ]);
});

it("keeps an untouched authorization alive for 48 hours on the cron alone, checking every new token with GitHub", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const github = fakeGitHub();
  await authorize(github, ACCESS_LIFETIME_S * 1_000);
  const start = Date.now();
  const expiries: number[] = [];
  // Nobody uses dx. The Worker cron fires every minute; sample every 15,
  // well inside the hour before expiry in which renewal is due.
  for (let at = start; at <= start + 48 * 3_600_000; at += 15 * 60_000) {
    vi.setSystemTime(at);
    await tick(at);
    const current = await row();
    const expiresAt = Date.parse(String(current?.expires_at));
    // The stored access token never lapses.
    expect(current?.status).toBe("active");
    expect(expiresAt).toBeGreaterThan(at);
    if (expiries.at(-1) !== expiresAt) expiries.push(expiresAt);
  }

  // An 8-hour token renewed an hour early: one rotation per 7 hours.
  expect(github.rotations()).toBeGreaterThanOrEqual(6);
  expect(github.rotations()).toBeLessThanOrEqual(7);
  expect(github.refused()).toBe(0);
  // Every rotation was followed by an authenticated call that GitHub
  // accepted with exactly the token it had just issued.
  const events = github.state.events;
  events.forEach((event, index) => {
    if (event.kind !== "refresh") return;
    expect(events[index + 1]).toMatchObject({
      kind: "user",
      token: event.issued,
      ok: true,
    });
  });
  // expires_at only ever moved forward, once per rotation.
  expect(expiries).toEqual([...expiries].sort((a, b) => a - b));
  expect(expiries.length).toBe(github.rotations() + 1);
  expect((await row())?.last_verified_at).toEqual(expect.any(String));
  // And the token dx hands `gh` is the live one, without another rotation.
  const rotations = github.rotations();
  await expect(token()).resolves.toBe(github.state.accessToken);
  expect(github.rotations()).toBe(rotations);
}, 120_000);

it("asks for a reconnect, once, when GitHub refuses a refresh token whose rotation was lost", async () => {
  const github = fakeGitHub();
  await authorize(github, 30 * 60_000);
  // A refresh reached GitHub, which rotated, and its answer never came back.
  // dx still holds the used refresh token.
  github.state.refreshToken = "ghr_rotated_away";

  await expect(token()).rejects.toThrow();
  expect(await row()).toMatchObject({
    status: "reauthorization-required",
    access_token_reference_id: null,
    refresh_token_reference_id: null,
  });
  // Neither later uses nor the cron keep hammering GitHub.
  await expect(token()).rejects.toThrow();
  await tick();
  await tick(Date.now() + 60 * 60_000);
  expect(github.refused()).toBe(1);
});

it("keeps serving the current token through a GitHub outage, backs off, and recovers", async () => {
  vi.useFakeTimers({ toFake: ["Date"] });
  const github = fakeGitHub();
  await authorize(github, 30 * 60_000);
  github.state.outage = 503;
  await tick();
  // The token still has 30 minutes: `gh` keeps working meanwhile.
  await expect(token()).resolves.toBe("ghu_0");
  const failing = await row();
  expect(failing).toMatchObject({
    status: "active",
    renewal_failures: 1,
    renewal_failing_since: expect.any(String),
  });
  // GitHub recovers; the retry a few minutes later succeeds and clears it.
  github.state.outage = undefined;
  vi.setSystemTime(Date.now() + 5 * 60_000);
  await tick();
  await expect(token()).resolves.toBe(github.state.accessToken);
  expect(await row()).toMatchObject({
    status: "active",
    renewal_failures: 0,
    renewal_failing_since: null,
  });
  expect(github.refused()).toBe(0);
});

it("commits GitHub's journalled answer when the object was reset before saving it to D1", async () => {
  const github = fakeGitHub();
  await authorize(github, 30 * 60_000);
  const before = await row();
  // GitHub rotated and answered; the object journalled the answer, then was
  // reset before its D1 batch. D1 still holds the pair GitHub disabled.
  github.state.generation = 1;
  github.state.accessToken = "ghu_1";
  github.state.refreshToken = "ghr_1";
  github.state.accessExpiresAt = Date.now() + ACCESS_LIFETIME_S * 1_000;
  const owner = { scope: "personal" as const, id: userId as never };
  const [access, refresh] = await Effect.runPromise(
    Effect.gen(function* () {
      const keyring = yield* loadConfigEncryptionKeyring(bindings);
      return yield* Effect.all([
        sealIntegrationCredential(keyring, owner, "access-token", "ghu_1"),
        sealIntegrationCredential(keyring, owner, "refresh-token", "ghr_1"),
      ]);
    }),
  );
  const namespace = env.GITHUB_TOKEN_COORDINATOR;
  await runInDurableObject(
    namespace.get(namespace.idFromName(String(before?.id))),
    (_instance, state) =>
      state.storage.put("renewal-journal", {
        stage: "answered",
        authorizationId: before?.id,
        userId,
        previousAccess: before?.access_token_reference_id,
        previousRefresh: before?.refresh_token_reference_id,
        access,
        refresh,
        expiresAt: new Date(github.state.accessExpiresAt).toISOString(),
        refreshExpiresAt: null,
        at: new Date().toISOString(),
      }),
  );

  // The next use recovers the journalled pair instead of replaying the dead one.
  await expect(token()).resolves.toBe("ghu_1");
  expect(github.refused()).toBe(0);
  expect(github.rotations()).toBe(0);
  expect(await row()).toMatchObject({
    status: "active",
    access_token_reference_id: access.id,
    refresh_token_reference_id: refresh.id,
  });
  // The replaced credentials are gone.
  const stale = await env.DB.prepare(
    "SELECT COUNT(*) AS n FROM integration_credential WHERE id IN (?, ?)",
  )
    .bind(before?.access_token_reference_id, before?.refresh_token_reference_id)
    .first<{ n: number }>();
  expect(stale?.n).toBe(0);
});
