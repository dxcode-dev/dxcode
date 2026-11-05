import { env } from "cloudflare:test";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import {
  apiPolicy,
  apiPolicyHeader,
} from "../../src/security/content-security-policy.mjs";
import { resetCspReportLimits } from "../../src/security/reports.js";

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "csp-route-secret-0000000000000000000000",
};

const report = (body: unknown, ip = "203.0.113.7", policy = "app") =>
  app.request(
    `/api/csp-reports?policy=${policy}`,
    {
      method: "POST",
      headers: {
        "content-type": "application/csp-report",
        "cf-connecting-ip": ip,
        "user-agent": "Mozilla/5.0 (Person's Laptop)",
      },
      body: typeof body === "string" ? body : JSON.stringify(body),
    },
    bindings,
  );

const violationLines = (warn: ReturnType<typeof vi.spyOn>) =>
  warn.mock.calls
    .map(([line]) => line as Record<string, unknown>)
    .filter((line) => line?.event === "csp_violation");

describe("Core's Content Security Policy", () => {
  let warn: ReturnType<typeof vi.spyOn>;
  beforeEach(() => {
    resetCspReportLimits();
    warn = vi.spyOn(console, "warn").mockImplementation(() => undefined);
  });
  afterEach(() => warn.mockRestore());

  it("puts its policy on JSON, error, and page responses, and keeps their cookies", async () => {
    for (const path of [
      "/healthz",
      "/v1/projects",
      "/api/notifications/unsubscribe?token=x",
    ]) {
      const response = await app.request(path, {}, bindings);
      expect(response.headers.get(apiPolicyHeader()), path).toBe(apiPolicy);
      expect(response.headers.get("reporting-endpoints"), path).toContain(
        'csp-api="/api/csp-reports?policy=api"',
      );
    }
    const signup = await app.request(
      "/api/auth/sign-up/email",
      {
        method: "POST",
        headers: {
          "content-type": "application/json",
          origin,
          "cf-connecting-ip": "198.51.100.4",
        },
        body: JSON.stringify({
          name: "Policy Reader",
          email: "csp-reader@dx.test",
          password: "csp-password-123",
        }),
      },
      bindings,
    );
    expect(signup.status).toBe(200);
    expect(signup.headers.get(apiPolicyHeader())).toBe(apiPolicy);
    const cookies = signup.headers.getSetCookie();
    expect(cookies.length).toBeGreaterThan(0);
    expect(new Set(cookies).size).toBe(cookies.length);
    const session = cookies[0]?.split(";", 1)[0] ?? "";
    const projects = await app.request(
      "/v1/projects",
      { headers: { origin, cookie: session } },
      bindings,
    );
    expect(projects.status).toBe(200);
  });

  it("logs a report as its policy, directive, and blocked URL only", async () => {
    const response = await report({
      "csp-report": {
        "document-uri": "https://dx.test/w/acme/threads/thr_secret?draft=hello",
        referrer: "https://dx.test/private",
        "violated-directive": "script-src-elem",
        "effective-directive": "script-src-elem",
        "original-policy": "default-src 'self'",
        disposition: "report",
        "blocked-uri": "https://evil.example/steal.js?token=abc#frag",
        "source-file": "https://dx.test/assets/app.js",
        "script-sample": "fetch('/v1/me')",
        "status-code": 200,
      },
    });
    expect(response.status).toBe(204);
    expect(violationLines(warn)).toEqual([
      expect.objectContaining({
        event: "csp_violation",
        policy: "app",
        directive: "script-src-elem",
        blockedUrl: "https://evil.example/steal.js",
        disposition: "report",
      }),
    ]);
    const logged = JSON.stringify(warn.mock.calls);
    for (const secret of [
      "thr_secret",
      "draft",
      "token=abc",
      "frag",
      "private",
      "fetch(",
      "203.0.113.7",
      "Laptop",
    ])
      expect(logged).not.toContain(secret);
  });

  it("reads Reporting API batches and keeps keywords such as inline", async () => {
    const response = await report(
      [
        {
          type: "csp-violation",
          url: "https://dx.test/threads/thr_x",
          body: {
            documentURL: "https://dx.test/threads/thr_x",
            blockedURL: "inline",
            effectiveDirective: "style-src-elem",
            disposition: "report",
            sample: ".toast{}",
          },
        },
        { type: "deprecation", body: { id: "x" } },
        {
          type: "csp-violation",
          body: {
            blockedURL: "data:image/png;base64,AAAA",
            effectiveDirective: "img-src",
            disposition: "enforce",
          },
        },
      ],
      undefined,
      "docs",
    );
    expect(response.status).toBe(204);
    expect(
      violationLines(warn).map(
        ({ policy, directive, blockedUrl, disposition }) => ({
          policy,
          directive,
          blockedUrl,
          disposition,
        }),
      ),
    ).toEqual([
      {
        policy: "docs",
        directive: "style-src-elem",
        blockedUrl: "inline",
        disposition: "report",
      },
      {
        policy: "docs",
        directive: "img-src",
        blockedUrl: "data",
        disposition: "enforce",
      },
    ]);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(".toast");
  });

  it("refuses floods, oversized bodies, and garbage without logging them", async () => {
    const one = {
      "csp-report": {
        "effective-directive": "img-src",
        "blocked-uri": "https://a.example/x.png",
        disposition: "report",
      },
    };
    for (let index = 0; index < 30; index += 1)
      expect((await report(one, "192.0.2.1")).status).toBe(204);
    expect((await report(one, "192.0.2.1")).status).toBe(429);
    expect((await report(one, "192.0.2.2")).status).toBe(204);
    expect(violationLines(warn)).toHaveLength(31);

    expect((await report("x".repeat(17 * 1_024), "192.0.2.3")).status).toBe(
      413,
    );
    expect((await report("{not json", "192.0.2.3")).status).toBe(400);
    expect((await report(one, "192.0.2.3", "made-up")).status).toBe(204);
    expect(violationLines(warn).at(-1)?.policy).toBe("unknown");
    expect(violationLines(warn)).toHaveLength(32);
  });
});
