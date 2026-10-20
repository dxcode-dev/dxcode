import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import * as Alchemist from "alchemy/Alchemist";
import { AuthProviders } from "alchemy/Auth/AuthProvider";
import { CloudflareApiLive } from "alchemy/Cloudflare";
import * as Interaction from "alchemy/Interaction";
import * as ConfigProvider from "effect/ConfigProvider";
import * as Effect from "effect/Effect";
import * as FetchHttpClient from "effect/http/FetchHttpClient";
import * as Layer from "effect/Layer";
import { afterEach, describe, expect, it, vi } from "vitest";

/**
 * The two behaviours dx's Alchemy patch adds, run through Alchemy's own code.
 * Ways the patch could fail after an Alchemy upgrade:
 * - the state-store login binds the first Secrets Store on an account with
 *   several, so the edge probe reads a store without the token;
 * - an account without the token gets a vague error, or none;
 * - Basic Scopes omits the Portal DNS scope the wizard asked for;
 * - Custom Scopes does not preselect it;
 * - an unknown extra scope reaches the authorize URL and invalidates it.
 */

const accountId = "a".repeat(32);
// Modules Alchemy does not export; a file URL loads the same instance.
const alchemyLib = (path) =>
  import(
    pathToFileURL(
      resolve(import.meta.dirname, "../../node_modules/alchemy/lib", path),
    ).href
  );

afterEach(() => {
  vi.unstubAllEnvs();
});

const page = (result) =>
  Response.json({
    success: true,
    errors: [],
    messages: [],
    result,
    result_info: {
      page: 1,
      per_page: 100,
      count: result.length,
      total_count: result.length,
      total_pages: 1,
    },
  });

/**
 * A Cloudflare API with the given Secrets Stores. Records the store each edge
 * probe binds, then fails it so the login stops there.
 */
const cloudflareApi = (stores) => {
  const probed = [];
  const fetch = async (input, init) => {
    const request = new Request(input, init);
    const path = new URL(request.url).pathname.replace("/client/v4", "");
    if (path === `/accounts/${accountId}/secrets_store/stores`)
      return page(stores.map(({ id }) => ({ id, name: id })));
    const secrets = path.match(
      /^\/accounts\/\w+\/secrets_store\/stores\/([^/]+)\/secrets$/,
    );
    if (secrets !== null)
      return page(
        stores
          .find(({ id }) => id === secrets[1])
          .secrets.map((name) => ({ id: `${secrets[1]}-${name}`, name })),
      );
    const result = (value) =>
      Response.json({ success: true, errors: [], messages: [], result: value });
    if (path === `/accounts/${accountId}/workers/subdomain/edge-preview`)
      return result({ token: "preview-session" });
    if (path === `/accounts/${accountId}/workers/subdomain`)
      return result({ subdomain: "test" });
    const body = await request.text();
    const binding = body.match(/"store_id":"([^"]+)"/);
    if (binding !== null) probed.push(binding[1]);
    return Response.json(
      { success: false, errors: [{ code: 10000, message: "test stop" }] },
      { status: 400 },
    );
  };
  return { fetch, probed };
};

const stateStoreLogin = async (fetch) => {
  const { loginWithCloudflare } = await alchemyLib(
    "Cloudflare/StateStore/State.js",
  );
  const home = mkdtempSync(join(tmpdir(), "dx-alchemy-patch-"));
  vi.stubEnv("ALCHEMY_HOME", home);
  try {
    return await Effect.runPromise(
      loginWithCloudflare("dx-test", true).pipe(
        Effect.provide(
          CloudflareApiLive().pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Alchemist.layer(),
                Layer.succeed(FetchHttpClient.Fetch, fetch),
                Layer.succeed(AuthProviders, {}),
                ConfigProvider.layer(
                  ConfigProvider.fromUnknown({
                    CI: "true",
                    CLOUDFLARE_ACCOUNT_ID: accountId,
                    CLOUDFLARE_API_TOKEN: "test-token",
                  }),
                ),
              ),
            ),
          ),
        ),
        Effect.scoped,
        Effect.flip,
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
};

/**
 * Runs Cloudflare's OAuth configure with `mode` chosen at the scope prompt,
 * and returns the scopes the authorize URL requests, plus the Custom Scopes
 * preselection when that prompt ran.
 */
const requestedScopes = async (mode) => {
  const { CloudflareAuth } = await alchemyLib(
    "Cloudflare/Auth/AuthProvider.js",
  );
  const home = mkdtempSync(join(tmpdir(), "dx-alchemy-patch-"));
  vi.stubEnv("ALCHEMY_HOME", home);
  // No browser opens: `xdg-open` is not on an empty PATH.
  vi.stubEnv("PATH", home);
  let preselected;
  let authorizeUrl;
  const answers = Layer.effect(
    Interaction.Interaction,
    Effect.map(Interaction.Interaction, (interaction) => ({
      ...interaction,
      prompt: {
        ...interaction.prompt,
        select: ({ message }) =>
          Effect.succeed(
            message === "Cloudflare authentication method" ? "oauth" : mode,
          ),
        multiSelect: ({ initialValues }) => {
          preselected = [...initialValues];
          return Effect.succeed(initialValues);
        },
        awaitExternal: ({ url }) => {
          authorizeUrl = url;
          return Effect.fail(new Error("test stop at the browser"));
        },
      },
    })),
  ).pipe(Layer.provide(Interaction.layerNonInteractive()));
  try {
    await Effect.runPromise(
      Effect.flatMap(AuthProviders, (providers) =>
        providers.Cloudflare.configure("dx-test"),
      ).pipe(
        Effect.provide(
          CloudflareAuth.pipe(
            Layer.provideMerge(
              Layer.mergeAll(
                Alchemist.layer(),
                answers,
                Layer.succeed(AuthProviders, {}),
              ),
            ),
          ),
        ),
        Effect.scoped,
        Effect.flip,
      ),
    );
  } finally {
    rmSync(home, { recursive: true, force: true });
  }
  return {
    scopes: new URL(authorizeUrl).searchParams.get("scope").split(" "),
    preselected,
  };
};

describe("dx's Alchemy patch", () => {
  it("logs in to the state store through the Secrets Store that holds its token", async () => {
    const api = cloudflareApi([
      { id: "unrelated-store", secrets: ["OTHER_SECRET"] },
      {
        id: "alchemy-store",
        secrets: ["AlchemyStateStoreEncryptionKey", "AlchemyStateStoreToken"],
      },
    ]);
    await stateStoreLogin(api.fetch);
    expect(api.probed.length).toBeGreaterThan(0);
    expect(new Set(api.probed)).toEqual(new Set(["alchemy-store"]));
  }, 60_000);

  it("names the missing state-store token when no store holds it", async () => {
    const api = cloudflareApi([
      { id: "unrelated-store", secrets: ["OTHER_SECRET"] },
    ]);
    const error = await stateStoreLogin(api.fetch);
    expect(error.message).toBe(
      "No Secrets Store containing the Alchemy state-store token was found on this account. Deploy the state store first.",
    );
    expect(api.probed).toEqual([]);
  }, 60_000);

  it("adds the requested extra OAuth scopes to Basic and Custom scopes", async () => {
    const { BASIC_SCOPES } = await alchemyLib("Cloudflare/Auth/OAuthScopes.js");
    expect(BASIC_SCOPES).not.toContain("dns.write");

    const plain = await requestedScopes("basic");
    expect(plain.scopes).not.toContain("dns.write");

    vi.stubEnv(
      "ALCHEMY_CLOUDFLARE_OAUTH_EXTRA_SCOPES",
      "dns.write not-a-scope,zone.read",
    );
    const basic = await requestedScopes("basic");
    expect(new Set(basic.scopes)).toEqual(
      new Set([...plain.scopes, "dns.write"]),
    );
    expect(basic.scopes).not.toContain("not-a-scope");
    // Every scope is the Custom Scopes default already; the extra stays in.
    const custom = await requestedScopes("custom");
    expect(custom.preselected).toContain("dns.write");
    expect(custom.scopes).not.toContain("not-a-scope");
  }, 60_000);
});
