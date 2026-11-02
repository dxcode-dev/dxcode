import { env } from "cloudflare:test";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";

/**
 * With read replicas, a request that carries no D1 bookmark reads a replica
 * that may not have applied a recent write (#1386). Ending a browser session
 * or revoking an API token must still stop the next request from any client,
 * so credential checks read the primary: Better Auth (sessions, the session
 * revocation view, API keys) and external application credentials. Each
 * case revokes access from one client, then calls from the revoked client
 * with no bookmark, and checks where the credential reads ran.
 *
 * Local D1 has no replicas, so the binding records the constraint each
 * statement's session opened with; `binding` is the bare binding, which
 * always reaches the primary.
 */

const origin = "http://dx.test";
interface Read {
  readonly via: string;
  readonly sql: string;
}
const reads: Read[] = [];

const recorded = <T extends D1Database | D1DatabaseSession>(
  target: T,
  via: string,
): T =>
  new Proxy(target, {
    get(inner, property) {
      if (property === "prepare")
        return (sql: string) => {
          reads.push({ via, sql });
          return inner.prepare(sql);
        };
      if (property === "withSession" && "withSession" in inner)
        return (constraint?: string) =>
          recorded(
            inner.withSession(constraint),
            constraint ?? "first-unconstrained",
          );
      const value = Reflect.get(inner, property, inner);
      return typeof value === "function" ? value.bind(inner) : value;
    },
  });

const bindings: Bindings = {
  DB: recorded(env.DB, "binding"),
  DX_ENV: "local",
  DX_RUNTIME_MODE: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "revocation-reads-secret-0000000000000000",
  DX_STORAGE: env.DX_STORAGE,
  REALTIME_HUB: env.REALTIME_HUB,
};

const credentialTables =
  /\b(?:from|into|update)\s+"?(?:session|session_revocation|apikey|user)"?(?:\s|$)/i;

/** Credential reads served by anything but the primary. */
const replicaCredentialReads = () =>
  reads.filter(
    (read) =>
      read.via !== "binding" &&
      read.via !== "first-primary" &&
      credentialTables.test(read.sql),
  );

let address = 0;
const browser = () => {
  const jar = new Map<string, string>();
  const ip = `203.0.113.${++address}`;
  const request = async (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("origin", origin);
    headers.set("cf-connecting-ip", ip);
    const cookie = [...jar]
      .filter(([name]) => name !== "dx-d1-bookmark")
      .map(([name, value]) => `${name}=${value}`)
      .join("; ");
    if (cookie !== "") headers.set("cookie", cookie);
    const response = await app.request(path, { ...init, headers }, bindings);
    for (const line of response.headers.getSetCookie()) {
      const [pair = ""] = line.split(";", 1);
      const separator = pair.indexOf("=");
      jar.set(pair.slice(0, separator), pair.slice(separator + 1));
    }
    return response;
  };
  const post = (path: string, body: unknown) =>
    request(path, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(body),
    });
  return {
    request,
    post,
    /** Drops Better Auth's signed cache, so every lookup reads D1. */
    tokenOnly() {
      for (const name of [...jar.keys()])
        if (name.includes("session_data")) jar.delete(name);
    },
  };
};

const password = "revocation-reads-password-123";

describe("revocation with read replicas", () => {
  it.each([
    ["with the signed cookie cache", false],
    ["with the session token alone", true],
  ])(
    "refuses a browser session ended on another device, %s, reading credentials at the primary",
    async (_name, tokenOnly) => {
      const email = `ended-${crypto.randomUUID()}@example.com`;
      const laptop = browser();
      const phone = browser();
      expect(
        (
          await laptop.post("/api/auth/sign-up/email", {
            name: "Revocation",
            email,
            password,
          })
        ).status,
      ).toBe(200);
      expect(
        (await phone.post("/api/auth/sign-in/email", { email, password }))
          .status,
      ).toBe(200);
      if (tokenOnly) phone.tokenOnly();
      expect((await phone.request("/v1/projects")).status).toBe(200);

      const sessions = (await (
        await laptop.request("/v1/settings/personal/security/sessions")
      ).json()) as {
        data: { items: Array<{ id: string; isCurrent: boolean }> };
      };
      const other = sessions.data.items.find((session) => !session.isCurrent);
      if (other === undefined) throw new Error("Expected the phone's session");
      expect(
        (
          await laptop.request(
            `/v1/settings/personal/security/sessions/${other.id}`,
            { method: "DELETE" },
          )
        ).status,
      ).toBe(200);

      reads.length = 0;
      expect((await phone.request("/v1/projects")).status).toBe(401);
      const session = await phone.request("/api/auth/get-session");
      expect(await session.json()).toBeNull();
      expect(replicaCredentialReads()).toEqual([]);
    },
  );

  it("refuses a revoked API token, reading the key at the primary", async () => {
    const owner = browser();
    expect(
      (
        await owner.post("/api/auth/sign-up/email", {
          name: "Token Owner",
          email: `token-${crypto.randomUUID()}@example.com`,
          password,
        })
      ).status,
    ).toBe(200);
    const created = (await (
      await owner.post("/v1/settings/personal/security/tokens", {
        name: "CLI",
        scopes: ["projects:read"],
      })
    ).json()) as { data: { plaintext: string; token: { id: string } } };
    const cli = (path: string) =>
      app.request(
        path,
        { headers: { authorization: `Bearer ${created.data.plaintext}` } },
        bindings,
      );

    reads.length = 0;
    expect((await cli("/v1/projects")).status).toBe(200);
    expect(replicaCredentialReads()).toEqual([]);

    expect(
      (
        await owner.request(
          `/v1/settings/personal/security/tokens/${created.data.token.id}`,
          { method: "DELETE" },
        )
      ).status,
    ).toBe(200);
    reads.length = 0;
    expect((await cli("/v1/projects")).status).toBe(401);
    expect(replicaCredentialReads()).toEqual([]);
  });
});
