import { Hono } from "hono";
import { describe, expect, it, vi } from "vitest";
import type { AppEnv, Bindings } from "../http/types.js";
import { makeWorkloadIdentityRoutes } from "./routes.js";

const issuer = "https://identity.example/api/workload-identity";

const setup = () => {
  const broker = {
    discovery: vi.fn(() => ({
      issuer,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ["id_token"] as const,
      subject_types_supported: ["public"] as const,
      id_token_signing_alg_values_supported: ["RS256"] as const,
      claims_supported: ["iss", "sub", "aud"],
    })),
    jwks: vi.fn(() => ({
      keys: [
        {
          kty: "RSA" as const,
          use: "sig" as const,
          alg: "RS256" as const,
          kid: "test-key-01",
          n: "n".repeat(342),
          e: "AQAB",
        },
      ],
    })),
  };
  const app = new Hono<AppEnv>();
  app.use("*", async (context, next) => {
    context.set("requestId", "request-test");
    await next();
  });
  app.route("/", makeWorkloadIdentityRoutes(broker));
  return { app, broker, bindings: {} satisfies Bindings };
};

describe("workload identity public routes", () => {
  it("publishes deterministic discovery and JWKS documents", async () => {
    const { app, broker, bindings } = setup();

    const discovery = await app.request(
      "/.well-known/openid-configuration",
      {},
      bindings,
    );
    expect(discovery.status).toBe(200);
    expect(discovery.headers.get("cache-control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    await expect(discovery.json()).resolves.toMatchObject({
      issuer,
      jwks_uri: `${issuer}/jwks.json`,
    });

    const jwks = await app.request("/jwks.json", {}, bindings);
    expect(jwks.status).toBe(200);
    expect(jwks.headers.get("cache-control")).toBe(
      "public, max-age=300, must-revalidate",
    );
    await expect(jwks.json()).resolves.toMatchObject({
      keys: [{ kid: "test-key-01" }],
    });
    expect(broker.discovery).toHaveBeenCalledOnce();
    expect(broker.jwks).toHaveBeenCalledOnce();
  });

  it("has no public token-minting endpoint", async () => {
    const { app, broker, bindings } = setup();

    const response = await app.request(
      "/e2b/exchange",
      { method: "POST", body: "{}" },
      bindings,
    );

    expect(response.status).toBe(404);
    expect(broker.discovery).not.toHaveBeenCalled();
    expect(broker.jwks).not.toHaveBeenCalled();
  });

  it("fails public metadata closed without reflecting configuration errors", async () => {
    const { app, broker, bindings } = setup();
    broker.discovery.mockImplementation(() => {
      throw new Error("sensitive signer detail");
    });

    const response = await app.request(
      "/.well-known/openid-configuration",
      {},
      bindings,
    );

    expect(response.status).toBe(503);
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("pragma")).toBe("no-cache");
    const body = await response.text();
    expect(body).toContain("WORKLOAD_IDENTITY_UNAVAILABLE");
    expect(body).toContain("request-test");
    expect(body).not.toContain("sensitive signer detail");
  });
});
