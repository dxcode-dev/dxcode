import { env } from "cloudflare:test";
import { Hono } from "hono";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  bootstrapDeployment,
  createCloudflareD1BootstrapDatabase,
} from "../../../../scripts/bootstrap-deployment.mjs";
import { createAuth } from "../../src/auth/better-auth.js";
import type { AuthenticationRequirements } from "../../src/auth/requirements.js";
import { authRoutes } from "../../src/auth/routes.js";
import type { AppEnv, Bindings } from "../../src/http/types.js";

const origin = "https://dx.test";
const requirements: AuthenticationRequirements = {
  environment: "selfhost",
  authUrl: origin,
  trustedOrigins: [origin],
  secret: "sign-in-providers-secret-0000000000000",
};
const sentEmails: EmailMessageBuilder[] = [];
const base: Bindings = {
  DB: env.DB,
  EMAIL: {
    send: async (message: EmailMessage | EmailMessageBuilder) => {
      if (!("subject" in message)) throw new Error("Expected composed email.");
      sentEmails.push(message);
      return { messageId: crypto.randomUUID() };
    },
  },
  DX_ENV: "selfhost",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: requirements.secret,
  DX_AUTH_EMAIL_FROM: "sign-in@dx.test",
  DX_TURNSTILE_SECRET_KEY: "turnstile-secret",
  DX_TURNSTILE_SITE_KEY: "turnstile-site",
  DX_GOOGLE_CLIENT_ID: "google-client-id",
  DX_GOOGLE_CLIENT_SECRET: "google-client-secret",
};
const configured = (overrides: Partial<Bindings>) =>
  createAuth({ ...base, ...overrides }, requirements);

let nextIp = 10;
const headers = (extra: Record<string, string> = {}) => ({
  "content-type": "application/json",
  "cf-connecting-ip": `198.51.100.${nextIp++}`,
  origin,
  "x-turnstile-token": "turnstile-token",
  ...extra,
});

const unsignedJwt = (claims: Record<string, unknown>) => {
  const encode = (value: unknown) =>
    btoa(JSON.stringify(value))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replaceAll("=", "");
  return `${encode({ alg: "none", typ: "JWT" })}.${encode(claims)}.`;
};

interface GoogleProfile {
  readonly email: string;
  readonly email_verified: boolean;
  readonly name?: string;
}
let googleProfile: GoogleProfile | undefined;

beforeEach(() => {
  sentEmails.length = 0;
  googleProfile = undefined;
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = input instanceof Request ? input.url : String(input);
    if (url.startsWith("https://challenges.cloudflare.com/"))
      return Response.json({
        success: true,
        hostname: "dx.test",
        action: "dx-access",
      });
    if (url === "https://oauth2.googleapis.com/token" && googleProfile)
      return Response.json({
        access_token: "google-access-token",
        token_type: "Bearer",
        expires_in: 3600,
        id_token: unsignedJwt({
          iss: "https://accounts.google.com",
          aud: "google-client-id",
          sub: `google-${googleProfile.email}`,
          name: "Google User",
          ...googleProfile,
        }),
      });
    if (
      url.startsWith("https://api.cloudflare.com/") &&
      url.endsWith("/query")
    ) {
      const { sql, params } = JSON.parse(
        String(input instanceof Request ? await input.text() : init?.body),
      ) as { sql: string; params: unknown[] };
      const { results } = await env.DB.prepare(sql)
        .bind(...params)
        .all();
      return Response.json({ success: true, result: [{ results }] });
    }
    throw new Error(`Unexpected fetch: ${url}`);
  });
});

afterEach(() => vi.restoreAllMocks());

const requestMagicLink = (
  auth: ReturnType<typeof createAuth>,
  email: string,
  callbackURL = "/new",
) =>
  auth.handler(
    new Request(`${origin}/api/auth/sign-in/magic-link`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email, callbackURL }),
    }),
  );

const signUp = (
  auth: ReturnType<typeof createAuth>,
  email: string,
  callbackURL = "/new",
) =>
  auth.handler(
    new Request(`${origin}/api/auth/sign-up/email`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        name: "New Person",
        email,
        password: "a-long-password-123",
        callbackURL,
      }),
    }),
  );

const signIn = (auth: ReturnType<typeof createAuth>, email: string) =>
  auth.handler(
    new Request(`${origin}/api/auth/sign-in/email`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({ email, password: "a-long-password-123" }),
    }),
  );

const cookiePairs = (response: Response) =>
  response.headers
    .getSetCookie()
    .map((cookie) => cookie.split(";")[0])
    .join("; ");

/** Runs the Google redirect round trip with Google's token endpoint mocked. */
const signInWithGoogle = async (
  auth: ReturnType<typeof createAuth>,
  profile: GoogleProfile,
  callbackURL = "/new",
) => {
  const start = await auth.handler(
    new Request(`${origin}/api/auth/sign-in/social`, {
      method: "POST",
      headers: headers(),
      body: JSON.stringify({
        provider: "google",
        callbackURL,
        errorCallbackURL: "/signin",
      }),
    }),
  );
  expect(start.status).toBe(200);
  const { url } = (await start.json()) as { url: string };
  const authorization = new URL(url);
  expect(authorization.origin).toBe("https://accounts.google.com");
  expect(authorization.searchParams.get("client_id")).toBe("google-client-id");
  expect(authorization.searchParams.get("redirect_uri")).toBe(
    `${origin}/api/auth/callback/google`,
  );
  googleProfile = profile;
  const callback = await auth.handler(
    new Request(
      `${origin}/api/auth/callback/google?code=google-code&state=${authorization.searchParams.get("state")}`,
      { headers: { cookie: cookiePairs(start) } },
    ),
  );
  expect(callback.status).toBe(302);
  return {
    location: new URL(callback.headers.get("location") ?? "", origin),
    cookies: callback.headers.getSetCookie(),
  };
};

const userEmail = (email: string) =>
  env.DB.prepare('SELECT email FROM "user" WHERE email = ?')
    .bind(email)
    .first("email");

const waitlistStatus = (email: string) =>
  env.DB.prepare("SELECT status FROM auth_waitlist WHERE email = ?")
    .bind(email)
    .first("status");

const createInviteLink = async () => {
  const suffix = crypto.randomUUID();
  const ownerId = `invite-owner-${suffix}`;
  const workspaceId = `invite-workspace-${suffix}`;
  const token = `${"a".repeat(7)}${suffix.replaceAll("-", "")}${"b".repeat(4)}`;
  const hash = Array.from(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(token)),
    ),
  )
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare(
      'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, ?, ?)',
    ).bind(ownerId, "Owner", `${ownerId}@example.com`, now, now),
    env.DB.prepare(
      "INSERT INTO organization (id, name, slug, createdAt) VALUES (?, ?, ?, ?)",
    ).bind(workspaceId, "Invite Team", `invite-${suffix}`, 1),
    env.DB.prepare(
      `INSERT INTO workspace_invite_link (id, organization_id, title, token_hash, token_envelope_json, created_by_user_id, created_at)
       VALUES (?, ?, 'Team', ?, '{}', ?, ?)`,
    ).bind(`link-${suffix}`, workspaceId, hash, ownerId, now),
  ]);
  expect(token).toMatch(/^[A-Za-z0-9_-]{43}$/);
  return `/join/${token}`;
};

describe("sign-in providers", () => {
  it("advertises the configured providers, admission, domains, and legal links", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/auth", authRoutes);
    const response = await app.request(
      "/api/auth/sign-in-options",
      { headers: { origin } },
      {
        ...base,
        DX_SIGN_IN_PROVIDERS: "magic-link, google,email-password",
        DX_SIGN_IN_ADMISSION: "waitlist",
        DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "Example.com,acme.dev",
        DX_TERMS_URL: "https://dx.test/terms",
        DX_PRIVACY_URL: "https://dx.test/privacy",
      },
    );
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({
      providers: ["magic-link", "google", "email-password"],
      admission: "waitlist",
      allowedEmailDomains: ["example.com", "acme.dev"],
      emailVerification: true,
      turnstileSiteKey: "turnstile-site",
      termsUrl: "https://dx.test/terms",
      privacyUrl: "https://dx.test/privacy",
    });
  });

  it.each([
    ["an unknown provider", { DX_SIGN_IN_PROVIDERS: "github" }],
    [
      "Google without credentials",
      { DX_SIGN_IN_PROVIDERS: "google", DX_GOOGLE_CLIENT_SECRET: undefined },
    ],
    [
      "magic link without a sender",
      { DX_SIGN_IN_PROVIDERS: "magic-link", DX_AUTH_EMAIL_FROM: undefined },
    ],
    [
      "magic link without Turnstile",
      {
        DX_SIGN_IN_PROVIDERS: "magic-link",
        DX_TURNSTILE_SECRET_KEY: undefined,
      },
    ],
    [
      "public password sign-up without a sender",
      {
        DX_SIGN_IN_PROVIDERS: "email-password",
        DX_SIGN_IN_ADMISSION: "open",
        DX_AUTH_EMAIL_FROM: undefined,
      },
    ],
    [
      "a malformed allowed domain",
      { DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "*.example.com" },
    ],
  ])("fails closed on %s", (_label, overrides) => {
    expect(() => configured(overrides)).toThrow();
  });

  it("refuses an email domain outside the allowlist on every provider", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link,email-password,google",
      DX_SIGN_IN_ADMISSION: "open",
      DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "acme.dev",
    });
    const outsider = "outsider@elsewhere.dev";

    const link = await requestMagicLink(auth, outsider);
    expect(link.status).toBe(403);
    await expect(link.json()).resolves.toMatchObject({
      code: "email_domain_not_allowed",
    });
    const password = await signUp(auth, outsider);
    expect(password.status).toBe(403);
    await expect(password.json()).resolves.toMatchObject({
      code: "email_domain_not_allowed",
    });
    const google = await signInWithGoogle(auth, {
      email: outsider,
      email_verified: true,
    });
    expect(google.location.pathname).toBe("/signin");
    expect(google.location.searchParams.get("error")).toBe(
      "email_domain_not_allowed",
    );

    expect(sentEmails).toHaveLength(0);
    expect(await userEmail(outsider)).toBeNull();
    expect(await waitlistStatus(outsider)).toBeNull();

    const insider = await signInWithGoogle(auth, {
      email: "member@acme.dev",
      email_verified: true,
    });
    expect(insider.location.pathname).toBe("/new");
    expect(insider.cookies.join(";")).toContain("session_token=");
  });

  it("refuses a Google identity whose email Google has not verified", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "google",
      DX_SIGN_IN_ADMISSION: "open",
      DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "acme.dev",
    });
    const google = await signInWithGoogle(auth, {
      email: "claimed@acme.dev",
      email_verified: false,
    });
    expect(google.location.searchParams.get("error")).toBe("email_unverified");
    expect(await userEmail("claimed@acme.dev")).toBeNull();
  });

  it("puts new Google and magic-link identities on the waitlist and lets existing users through", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link,google",
      DX_SIGN_IN_ADMISSION: "waitlist",
    });
    const email = "waitlisted-google@example.com";

    const google = await signInWithGoogle(auth, {
      email,
      email_verified: true,
    });
    expect(google.location.pathname).toBe("/signin");
    expect(google.location.searchParams.get("error")).toBe("waitlisted");
    expect(await userEmail(email)).toBeNull();
    expect(await waitlistStatus(email)).toBe("pending");

    const link = await requestMagicLink(auth, email);
    await expect(link.json()).resolves.toEqual({
      status: true,
      outcome: "waitlisted",
    });
    expect(sentEmails).toHaveLength(0);

    await env.DB.prepare(
      "UPDATE auth_waitlist SET status = 'approved' WHERE email = ?",
    )
      .bind(email)
      .run();
    const approved = await signInWithGoogle(auth, {
      email,
      email_verified: true,
    });
    expect(approved.location.pathname).toBe("/new");
    expect(await userEmail(email)).toBe(email);

    // An existing user never needs a waitlist row to receive a link.
    await env.DB.prepare("DELETE FROM auth_waitlist WHERE email = ?")
      .bind(email)
      .run();
    const returning = await requestMagicLink(auth, email);
    await expect(returning.json()).resolves.toEqual({
      status: true,
      outcome: "sent",
    });
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      from: { email: "sign-in@dx.test", name: "dx" },
      to: email,
      subject: "Sign in to dx",
    });
    expect(sentEmails[0]?.html).toContain("Sign in to dx");
  });

  it("lets a workspace invite link past the domain allowlist and invite-only admission", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link,email-password",
      DX_SIGN_IN_ADMISSION: "invite",
      DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "acme.dev",
    });
    const contractor = "contractor@agency.dev";

    const closed = await requestMagicLink(auth, "stranger@acme.dev");
    expect(closed.status).toBe(403);
    await expect(closed.json()).resolves.toMatchObject({
      code: "signup_closed",
    });

    const invite = await createInviteLink();
    const link = await requestMagicLink(auth, contractor, invite);
    await expect(link.json()).resolves.toEqual({
      status: true,
      outcome: "sent",
    });
    const url = /https?:\/\/\S+/.exec(sentEmails[0]?.text ?? "")?.[0];
    const verified = await auth.handler(new Request(url as string));
    expect(verified.status).toBe(302);
    expect(
      new URL(verified.headers.get("location") ?? "", origin).pathname,
    ).toBe(invite);
    expect(await userEmail(contractor)).toBe(contractor);
    // Following an invite admits without approving the address.
    expect(await waitlistStatus(contractor)).toBeNull();
  });

  it("admits an operator-approved administrator under invite-only Google sign-in", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "google",
      DX_SIGN_IN_ADMISSION: "invite",
      DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS: "acme.dev",
    });
    const stranger = await signInWithGoogle(auth, {
      email: "stranger@acme.dev",
      email_verified: true,
    });
    expect(stranger.location.searchParams.get("error")).toBe("signup_closed");

    // Deployment bootstrap approves the first administrator's address.
    const admin = "first-admin@outside.dev";
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO auth_waitlist (email, status, created_at, updated_at, approved_at) VALUES (?, 'approved', ?, ?, ?)",
    )
      .bind(admin, now, now, now)
      .run();
    const approved = await signInWithGoogle(auth, {
      email: admin,
      email_verified: true,
    });
    expect(approved.location.pathname).toBe("/new");
    expect(approved.cookies.join(";")).toContain("session_token=");
    expect(await userEmail(admin)).toBe(admin);
  });

  it("verifies a password sign-up's email before its first session", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "email-password",
      DX_SIGN_IN_ADMISSION: "open",
    });
    const email = "password-person@example.com";

    const created = await signUp(auth, email, "/projects");
    expect(created.status).toBe(200);
    expect(created.headers.get("set-cookie") ?? "").not.toContain(
      "session_token=",
    );
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      to: email,
      subject: "Confirm your email for dx",
    });

    const early = await signIn(auth, email);
    expect(early.status).toBe(403);
    expect(early.headers.get("set-cookie") ?? "").not.toContain(
      "session_token=",
    );

    const url = /https?:\/\/\S+/.exec(sentEmails[0]?.text ?? "")?.[0];
    const verified = await auth.handler(new Request(url as string));
    expect(verified.status).toBe(302);
    expect(
      new URL(verified.headers.get("location") ?? "", origin).pathname,
    ).toBe("/projects");
    expect(verified.headers.getSetCookie().join(";")).toContain(
      "session_token=",
    );

    const later = await signIn(auth, email);
    expect(later.status).toBe(200);
    expect(later.headers.get("set-cookie")).toContain("session_token=");
  });

  it("waitlists a password sign-up before creating the user", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "email-password",
      DX_SIGN_IN_ADMISSION: "waitlist",
    });
    const email = "password-waitlist@example.com";
    const response = await signUp(auth, email);
    expect(response.status).toBe(403);
    await expect(response.json()).resolves.toMatchObject({
      code: "waitlisted",
    });
    expect(await userEmail(email)).toBeNull();
    expect(await waitlistStatus(email)).toBe("pending");
    expect(sentEmails).toHaveLength(0);
  });

  it("signs a Google user into the bootstrapped administrator's account with the same email", async () => {
    // Self-host bootstrap creates the administrator with a password and a
    // verified email (scripts/bootstrap-deployment.mjs).
    const admin = "owner@selfhost.dev";
    const { hashPassword, verifyPassword } = await import("better-auth/crypto");
    const { userId } = await bootstrapDeployment({
      credentials: {
        target: "selfhost",
        email: admin,
        username: "owner",
        password: "a-long-password-123",
        userId: "usr_bootstrap_admin_0001",
        accountId: "acc_bootstrap_admin_0001",
        bootstrapProject: false,
        displayName: "dx admin",
      },
      database: createCloudflareD1BootstrapDatabase({
        accountId: "a".repeat(32),
        apiToken: "test-token",
        databaseId: "test-database",
        hashPassword,
        verifyPassword,
      }),
    });
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "email-password,google",
      DX_SIGN_IN_ADMISSION: "invite",
    });

    const google = await signInWithGoogle(auth, {
      email: admin,
      email_verified: true,
      name: "Owner From Google",
    });
    expect(google.location.pathname).toBe("/new");
    expect(google.cookies.join(";")).toContain("session_token=");
    const accounts = await env.DB.prepare(
      "SELECT providerId FROM account WHERE userId = ? ORDER BY providerId",
    )
      .bind(userId)
      .all<{ providerId: string }>();
    expect(accounts.results.map((row) => row.providerId)).toEqual([
      "credential",
      "google",
    ]);
    expect(
      await env.DB.prepare(
        'SELECT count(*) AS count FROM "user" WHERE email = ?',
      )
        .bind(admin)
        .first("count"),
    ).toBe(1);
    // A name the administrator already has is kept.
    expect(
      await env.DB.prepare('SELECT name FROM "user" WHERE id = ?')
        .bind(userId)
        .first("name"),
    ).toBe("dx admin");
    const password = await signIn(auth, admin);
    expect(password.status).toBe(200);
  });

  it("attaches a password to an administrator who signed in before password sign-in was on", async () => {
    const admin = "early-admin@selfhost.dev";
    const magicLinkOnly = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link",
      DX_SIGN_IN_ADMISSION: "invite",
    });
    const now = new Date().toISOString();
    await env.DB.prepare(
      "INSERT INTO auth_waitlist (email, status, created_at, updated_at, approved_at) VALUES (?, 'approved', ?, ?, ?)",
    )
      .bind(admin, now, now, now)
      .run();
    await requestMagicLink(magicLinkOnly, admin);
    const url = /https?:\/\/\S+/.exec(sentEmails.at(-1)?.text ?? "")?.[0];
    expect(
      (await magicLinkOnly.handler(new Request(url as string))).status,
    ).toBe(302);
    const existingId = await env.DB.prepare(
      'SELECT id FROM "user" WHERE email = ?',
    )
      .bind(admin)
      .first<string>("id");

    const { hashPassword, verifyPassword } = await import("better-auth/crypto");
    const { userId } = await bootstrapDeployment({
      credentials: {
        target: "selfhost",
        email: admin,
        username: "early-admin",
        password: "a-long-password-123",
        userId: "usr_bootstrap_admin_0002",
        accountId: "acc_bootstrap_admin_0002",
        bootstrapProject: false,
        displayName: "dx admin",
      },
      database: createCloudflareD1BootstrapDatabase({
        accountId: "a".repeat(32),
        apiToken: "test-token",
        databaseId: "test-database",
        hashPassword,
        verifyPassword,
      }),
    });
    expect(userId).toBe(existingId);
    const withPassword = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link,email-password",
      DX_SIGN_IN_ADMISSION: "invite",
    });
    expect((await signIn(withPassword, admin)).status).toBe(200);
  });

  it("names new Google accounts from Google and fills a name a magic link left empty", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "magic-link,google",
      DX_SIGN_IN_ADMISSION: "open",
    });
    const fresh = "fresh-google@example.com";
    await signInWithGoogle(auth, {
      email: fresh,
      email_verified: true,
      name: "Fresh Person",
    });
    await expect(
      env.DB.prepare(
        'SELECT "user".name AS name, personal_account.display_name AS displayName FROM "user" JOIN personal_account ON personal_account.user_id = "user".id WHERE email = ?',
      )
        .bind(fresh)
        .first(),
    ).resolves.toEqual({ name: "Fresh Person", displayName: "Fresh Person" });

    const linked = "linked-later@example.com";
    await requestMagicLink(auth, linked);
    const url = /https?:\/\/\S+/.exec(sentEmails.at(-1)?.text ?? "")?.[0];
    await auth.handler(new Request(url as string));
    await signInWithGoogle(auth, {
      email: linked,
      email_verified: true,
      name: "Linked Person",
    });
    await expect(
      env.DB.prepare(
        'SELECT "user".name AS name, personal_account.display_name AS displayName FROM "user" JOIN personal_account ON personal_account.user_id = "user".id WHERE email = ?',
      )
        .bind(linked)
        .first(),
    ).resolves.toEqual({ name: "Linked Person", displayName: "Linked Person" });
  });

  it("emails a sign-in reminder when someone signs up with an existing account's email", async () => {
    const auth = configured({
      DX_SIGN_IN_PROVIDERS: "email-password",
      DX_SIGN_IN_ADMISSION: "open",
    });
    const email = "already-here@example.com";
    await signUp(auth, email);
    sentEmails.length = 0;
    const again = await signUp(auth, email);
    expect(again.status).toBe(200);
    expect(sentEmails).toHaveLength(1);
    expect(sentEmails[0]).toMatchObject({
      to: email,
      subject: "You already have a dx account",
    });
    expect(sentEmails[0]?.text).toContain(`${origin}/signin`);
  });

  it("does not expose an open verification-email resend endpoint", async () => {
    const app = new Hono<AppEnv>();
    app.route("/api/auth", authRoutes);
    const response = await app.request(
      "/api/auth/send-verification-email",
      {
        method: "POST",
        headers: headers(),
        body: JSON.stringify({ email: "victim@example.com" }),
      },
      {
        ...base,
        DX_SIGN_IN_PROVIDERS: "email-password",
        DX_SIGN_IN_ADMISSION: "open",
      },
    );
    expect(response.status).toBe(404);
    expect(sentEmails).toHaveLength(0);
  });
});
