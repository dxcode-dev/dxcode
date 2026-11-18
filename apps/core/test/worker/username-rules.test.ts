import { env } from "cloudflare:test";
import { RESERVED_USERNAMES } from "@dx/domain";
import { describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { settingsAuditLogger } from "../../src/logging.js";

/**
 * Usernames are Mailbox addresses (migration 0202, wiki/agent-mail.md): a
 * person changes theirs once, a pick away from a placeholder or reserved
 * name is free, a name someone leaves is retired for good, sign-up never
 * derives a reserved or retired name, and a deployment admin can give the
 * change back. Everything runs through the Worker's own routes and D1.
 */

const appOrigin = "http://dx.test";
const ADMIN_EMAIL = "username-admin@example.com";
const bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_RUNTIME_MODE: "deployed",
  DX_AUTH_URL: appOrigin,
  DX_AUTH_TRUSTED_ORIGINS: appOrigin,
  BETTER_AUTH_SECRET: "username-rules-secret-000000000000000000",
  DX_DEPLOYMENT_ADMIN_EMAILS: ADMIN_EMAIL,
} satisfies Bindings;

const unique = () => crypto.randomUUID().slice(0, 8);

let sequence = 0;
/** Signs up with a password; local sign-ups count as verified. */
const signUp = async (email = `person-${unique()}@example.com`) => {
  sequence += 1;
  const response = await app.request(
    `${appOrigin}/api/auth/sign-up/email`,
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin: appOrigin,
        "cf-connecting-ip": `198.51.100.${(sequence % 250) + 1}`,
      },
      body: JSON.stringify({
        name: "Username Person",
        email,
        password: "username-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers
    .get("set-cookie")
    ?.match(/better-auth\.session_token=[^;,]+/)?.[0];
  const userId = await env.DB.prepare('SELECT id FROM "user" WHERE email = ?')
    .bind(email)
    .first<string>("id");
  if (cookie === undefined || userId === null)
    throw new Error("Expected a signed-in user.");
  return { cookie, userId };
};

type Person = Awaited<ReturnType<typeof signUp>>;

interface AccountBody {
  readonly status: string;
  readonly data: {
    readonly username?: string;
    readonly usernameChangeAvailable?: boolean;
    readonly usernameNeedsPick?: boolean;
    readonly code?: string;
    readonly message?: string;
    readonly fieldErrors?: ReadonlyArray<{ field: string; message: string }>;
  };
}

const call = async (
  person: Person,
  path: string,
  init: { method?: string; body?: unknown } = {},
) => {
  const response = await app.request(
    `${appOrigin}${path}`,
    {
      method: init.method ?? "GET",
      headers: {
        cookie: person.cookie,
        origin: appOrigin,
        ...(init.body === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    },
    bindings,
  );
  return {
    status: response.status,
    body: (await response.json()) as AccountBody,
  };
};

const account = (person: Person) =>
  call(person, "/v1/settings/personal/account");

const rename = (person: Person, username: string, displayName = "Person") =>
  call(person, "/v1/settings/personal/account", {
    method: "PATCH",
    body: { displayName, username },
  });

const stored = (userId: string) =>
  env.DB.prepare(
    "SELECT username, username_changed_at FROM personal_account WHERE user_id = ?",
  )
    .bind(userId)
    .first<{ username: string; username_changed_at: string | null }>();

const retiredBy = async (username: string) =>
  (
    await env.DB.prepare(
      "SELECT user_id FROM retired_username WHERE username = ?",
    )
      .bind(username)
      .first<{ user_id: string }>()
  )?.user_id;

/** A user row as Better Auth writes it; the insert trigger derives a name. */
const derivedUsername = async (email: string) => {
  const id = `usr-${crypto.randomUUID()}`;
  await env.DB.prepare(
    'INSERT INTO "user" (id, name, email, emailVerified, createdAt, updatedAt) VALUES (?, ?, ?, 1, 1, 1)',
  )
    .bind(id, "Derived", email)
    .run();
  return (await stored(id))?.username;
};

const setUsername = (userId: string, username: string) =>
  env.DB.prepare("UPDATE personal_account SET username = ? WHERE user_id = ?")
    .bind(username, userId)
    .run();

describe("username rules", () => {
  it("allows one change, retires the old name for everyone, and refuses a second change", async () => {
    const local = `rowan-${unique()}`;
    const rowan = await signUp(`${local}@example.com`);
    expect((await account(rowan)).body.data).toMatchObject({
      username: local,
      usernameChangeAvailable: true,
      usernameNeedsPick: false,
    });

    const first = await rename(rowan, `rowan-new-${unique()}`);
    expect(first.status).toBe(200);
    expect(first.body.data).toMatchObject({
      usernameChangeAvailable: false,
      usernameNeedsPick: false,
    });
    const after = await stored(rowan.userId);
    expect(after?.username_changed_at).not.toBeNull();
    expect(await retiredBy(local)).toBe(rowan.userId);

    const second = await rename(rowan, `rowan-again-${unique()}`);
    expect(second).toEqual({
      status: 409,
      body: {
        status: "error",
        data: expect.objectContaining({
          code: "USERNAME_CHANGE_LOCKED",
          message: "You already changed your username once.",
          fieldErrors: [
            {
              field: "username",
              message: "You already changed your username once.",
            },
          ],
        }),
      },
    });
    expect((await stored(rowan.userId))?.username).toBe(after?.username);

    // The display name still saves with the fixed username.
    const nameOnly = await rename(rowan, after?.username ?? "", "Rowan Two");
    expect(nameOnly.status).toBe(200);

    // No one else can take the retired name, in any case.
    const other = await signUp();
    for (const attempt of [local, local.toUpperCase()]) {
      const taken = await rename(other, attempt);
      expect(taken.status).toBe(409);
      expect(taken.body.data.code).toBe("USERNAME_UNAVAILABLE");
    }

    // Sign-up derivation skips it too.
    const derived = await derivedUsername(`${local}@elsewhere.test`);
    expect(derived).not.toBe(local);
    expect(derived).toMatch(new RegExp(`^${local}\\d{2,3}$`));
  });

  it("lets a placeholder or reserved name holder pick a name without spending the change", async () => {
    const pat = await signUp();
    const placeholder = `user-${"a1".repeat(12)}`;
    await setUsername(pat.userId, placeholder);
    expect((await account(pat)).body.data).toMatchObject({
      usernameChangeAvailable: true,
      usernameNeedsPick: true,
    });
    const picked = `pat-${unique()}`;
    const pick = await rename(pat, picked);
    expect(pick.status).toBe(200);
    expect(pick.body.data).toMatchObject({
      username: picked,
      usernameChangeAvailable: true,
      usernameNeedsPick: false,
    });
    expect((await stored(pat.userId))?.username_changed_at).toBeNull();

    // The one change is still there, and then it is spent.
    expect((await rename(pat, `pat-later-${unique()}`)).status).toBe(200);
    expect((await rename(pat, `pat-third-${unique()}`)).status).toBe(409);

    // A reserved name's holder picks freely, even after spending the change,
    // and the reserved name stays reserved instead of retired.
    await env.DB.prepare(
      "UPDATE personal_account SET username = 'support' WHERE user_id = ?",
    )
      .bind(pat.userId)
      .run();
    expect((await account(pat)).body.data).toMatchObject({
      usernameChangeAvailable: true,
      usernameNeedsPick: true,
    });
    const away = await rename(pat, `pat-free-${unique()}`);
    expect(away.status).toBe(200);
    expect(await retiredBy("support")).toBeUndefined();
  });

  it("refuses reserved and placeholder-shaped names on change and at sign-up", async () => {
    const person = await signUp();
    for (const name of ["admin", "Postmaster", "mailer-daemon", "no-reply"]) {
      const refused = await rename(person, name);
      expect(refused.status).toBe(400);
      expect(refused.body.data.fieldErrors).toEqual([
        { field: "username", message: "That username is reserved." },
      ]);
    }
    const placeholder = await rename(person, `user-${"0f".repeat(12)}`);
    expect(placeholder.status).toBe(400);
    expect(placeholder.body.data.fieldErrors).toEqual([
      {
        field: "username",
        message: "Choose a username that is not a placeholder.",
      },
    ]);
    // Refusals spend nothing.
    expect((await account(person)).body.data.usernameChangeAvailable).toBe(
      true,
    );

    // Migration 0202's sign-up list matches RESERVED_USERNAMES.
    for (const name of RESERVED_USERNAMES) {
      const derived = await derivedUsername(`${name}@${unique()}.test`);
      expect(derived).not.toBe(name);
    }
  });

  it("retires a deleted account's username", async () => {
    const local = `gone-${unique()}`;
    const gone = await signUp(`${local}@example.com`);
    await env.DB.prepare('DELETE FROM "user" WHERE id = ?')
      .bind(gone.userId)
      .run();
    expect(await stored(gone.userId)).toBeNull();
    expect(await retiredBy(local)).toBe(gone.userId);
    expect(await derivedUsername(`${local}@example.com`)).not.toBe(local);
  });

  it("lets only a deployment admin give the change back, audited", async () => {
    const admin = await signUp(ADMIN_EMAIL);
    const person = await signUp();
    const original = (await stored(person.userId))?.username ?? "";
    const changed = `changed-${unique()}`;
    expect((await rename(person, changed)).status).toBe(200);
    expect((await rename(person, `again-${unique()}`)).status).toBe(409);

    const reset = `/v1/deployment-admin/users/${person.userId}/username-change/reset`;
    expect((await call(person, reset, { method: "POST" })).status).toBe(403);
    expect(
      (
        await call(
          admin,
          "/v1/deployment-admin/users/usr-missing/username-change/reset",
          { method: "POST" },
        )
      ).status,
    ).toBe(404);

    const audit = vi
      .spyOn(settingsAuditLogger, "info")
      .mockImplementation(() => {});
    const unlocked = await call(admin, reset, { method: "POST" });
    expect(unlocked).toEqual({
      status: 200,
      body: {
        status: "success",
        data: {
          userId: person.userId,
          username: changed,
          usernameChangeAvailable: true,
        },
      },
    });
    expect(audit).toHaveBeenCalledWith(
      "Settings mutation audited.",
      expect.objectContaining({
        action: "personal_account.username_change_reset",
        outcome: "success",
        userId: admin.userId,
        targetUserId: person.userId,
      }),
    );
    audit.mockRestore();

    expect((await account(person)).body.data.usernameChangeAvailable).toBe(
      true,
    );
    // The person who left a name may take it back (it still reaches only
    // them); doing so uses the change, and both names stay theirs.
    expect((await rename(person, original)).status).toBe(200);
    expect(await retiredBy(changed)).toBe(person.userId);
    expect(await retiredBy(original)).toBe(person.userId);
    expect((await rename(person, `more-${unique()}`)).status).toBe(409);
  });
});
