import { createVerify, generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { GITHUB_APP_EVENTS } from "../../packages/domain/src/source-control/github-app-configuration.ts";
import { checkGitHubApp, GITHUB_APP_EVENT_NAMES } from "./github-app-check.mjs";
import { DERIVED_BINDINGS, settingBindings } from "./settings.mjs";

const workspaceRoot = resolve(import.meta.dirname, "../..");

describe("the settings registry", () => {
  it("covers every operator binding a release adds, or lists it as derived", () => {
    const bindings = JSON.parse(
      readFileSync(
        resolve(workspaceRoot, "apps/core/production-bindings.json"),
        "utf8",
      ),
    ).bindings.filter((binding) => binding.provenance === "alchemy");
    const covered = settingBindings();
    expect(
      bindings
        .map((binding) => binding.name)
        .filter(
          (name) => !covered.has(name) && !DERIVED_BINDINGS.includes(name),
        ),
    ).toEqual([]);
  });

  it("checks exactly the events dx's GitHub App subscribes to", () => {
    expect(Object.keys(GITHUB_APP_EVENT_NAMES)).toEqual([...GITHUB_APP_EVENTS]);
  });
});

describe("the GitHub App check", () => {
  const { privateKey, publicKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
  });
  const privateKeyPem = privateKey.export({ type: "pkcs8", format: "pem" });
  const appJson = JSON.stringify({ appId: "123456", privateKeyPem });
  const github = (app, status = 200) => {
    const requests = [];
    return {
      requests,
      fetch: async (url, init) => {
        requests.push({ url, init });
        return new Response(JSON.stringify(app), { status });
      },
    };
  };

  it("names each missing event and permission in GitHub's words, with the click path", async () => {
    const server = github({
      slug: "dx-example",
      events: ["repository", "pull_request", "issues"],
      permissions: {
        actions: "write",
        issues: "write",
        pull_requests: "read",
        contents: "write",
      },
    });
    const report = await checkGitHubApp({ appJson, fetch: server.fetch });
    const text = report.join("\n");
    expect(text).toContain(
      "set each of these to at least Read-only: Checks, Commit statuses.",
    );
    expect(text).toContain(
      "tick: Check run, Check suite, Status, Workflow run, Pull request review, Pull request review comment, Issue comment.",
    );
    expect(text).toContain("GitHub Apps → Edit next to dx-example");
    expect(text).toContain("Review request → Accept new permissions");
    expect(text).not.toContain("BEGIN PRIVATE KEY");

    // The request is GET /app with an RS256 App JWT signed by the App's key.
    const { url, init } = server.requests[0];
    expect(url).toBe("https://api.github.com/app");
    const jwt = init.headers.Authorization.replace("Bearer ", "");
    const [header, payload, signature] = jwt.split(".");
    expect(
      createVerify("RSA-SHA256")
        .update(`${header}.${payload}`)
        .verify(publicKey, signature, "base64url"),
    ).toBe(true);
    const claims = JSON.parse(Buffer.from(payload, "base64url").toString());
    expect(claims.iss).toBe("123456");
    expect(claims.exp - claims.iat).toBeLessThanOrEqual(600);
  });

  it("reports nothing when every event and permission is there", async () => {
    const server = github({
      slug: "dx-example",
      events: [...GITHUB_APP_EVENTS],
      permissions: {
        actions: "read",
        checks: "read",
        statuses: "read",
        issues: "write",
        pull_requests: "write",
      },
    });
    expect(await checkGitHubApp({ appJson, fetch: server.fetch })).toEqual([]);
  });

  it("fails with GitHub's status and never the key when GitHub refuses", async () => {
    const server = github({ message: "Bad credentials" }, 401);
    await expect(
      checkGitHubApp({ appJson, fetch: server.fetch }),
    ).rejects.toThrow(/HTTP 401/);
    await expect(
      checkGitHubApp({ appJson, fetch: server.fetch }),
    ).rejects.not.toThrow(/PRIVATE KEY/);
  });
});
