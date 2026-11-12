import { env } from "cloudflare:test";
import type { UserId } from "@dx/domain";
import { HttpResponse, http } from "msw";
import { describe, expect, it } from "vitest";
import app from "../../src/app.js";
import type { Bindings } from "../../src/http/types.js";
import { buildZip } from "../../src/settings/plugins/bundles/zip-fixture.js";
import { TEST_CONFIG_ENCRYPTION_KEYS } from "../../src/testing/bindings.js";
import { network } from "./network-boundary.js";

/*
 * Ways a catalog can go wrong, each covered below:
 * - the repository has no marketplace.json, or an invalid one;
 * - an entry's path leaves the repository, or its source isn't GitHub;
 * - the same catalog is added twice;
 * - a publisher claims a domain without proof, or with proof for another
 *   catalog, or the DNS lookup fails;
 * - a client forges the catalog identity on install;
 * - someone other than dx publishes `dev.dxcode.*`, in a catalog or not;
 * - the catalog is removed between preview and install.
 */

const origin = "http://dx.test";
const bindings: Bindings = {
  DB: env.DB,
  DX_ENV: "local",
  DX_AUTH_URL: origin,
  DX_AUTH_TRUSTED_ORIGINS: origin,
  BETTER_AUTH_SECRET: "plugin-catalog-route-secret-000000000",
  DX_CONFIG_ENCRYPTION_KEYS: TEST_CONFIG_ENCRYPTION_KEYS,
};
const catalogs = "/v1/settings/personal/plugin-catalogs";
const bundles = "/v1/settings/personal/plugin-bundles";
const commit = "abcdefabcdefabcdefabcdefabcdefabcdefabcd";

let signups = 120;
const signup = async (email: string) => {
  signups += 1;
  const response = await app.request(
    "/api/auth/sign-up/email",
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        origin,
        "cf-connecting-ip": `203.0.113.${signups}`,
      },
      body: JSON.stringify({
        name: "Catalog Owner",
        email,
        password: "plugin-catalog-password-123",
      }),
    },
    bindings,
  );
  expect(response.status).toBe(200);
  const cookie = response.headers.get("set-cookie")?.split(";", 1)[0];
  if (cookie === undefined) throw new Error("Expected session cookie.");
  const { user } = await response.json<{ user: { id: string } }>();
  return { cookie, userId: user.id as UserId };
};

const call = (
  path: string,
  cookie: string,
  init: { method?: string; json?: unknown } = {},
) =>
  app.request(
    path,
    {
      method: init.method ?? (init.json === undefined ? "GET" : "POST"),
      headers: {
        cookie,
        origin,
        ...(init.json === undefined
          ? {}
          : { "content-type": "application/json" }),
      },
      ...(init.json === undefined ? {} : { body: JSON.stringify(init.json) }),
    },
    bindings,
  );

/** One repository archive with a plugin folder per name. */
const archive = (repo: string, names: ReadonlyArray<string>) =>
  buildZip(
    names.flatMap((name) => [
      {
        name: `${repo}-main/plugins/${name}/.claude-plugin/plugin.json`,
        content: JSON.stringify({ name, version: "1.0.0" }),
      },
      {
        name: `${repo}-main/plugins/${name}/skills/${name.replaceAll(".", "-")}/SKILL.md`,
        content: `---\nname: ${name.replaceAll(".", "-")}\ndescription: Use it.\n---\n\nDo it.\n`,
      },
    ]),
    commit,
  );

interface Catalog {
  readonly id: string;
  readonly name: string;
  readonly entries: ReadonlyArray<{
    readonly name: string;
    readonly publisher?: string;
    readonly source: { readonly type: string; readonly reason?: string };
  }>;
  readonly publishers: ReadonlyArray<{
    readonly domain: string;
    readonly proof: string;
  }>;
}

interface Preview {
  readonly integrity: string;
  readonly conflicts: ReadonlyArray<string>;
  readonly source: {
    readonly type: string;
    readonly repository: string;
    readonly path: string;
    readonly catalog?: { readonly id: string; readonly name: string };
  };
  readonly manifest: { readonly name: string };
}

/** Serves a marketplace.json, plugin archives, and DNS TXT answers. */
const serve = (options: {
  readonly repository: string;
  readonly marketplace: unknown;
  readonly plugins: ReadonlyArray<string>;
  readonly txt?: Record<string, ReadonlyArray<string>>;
  readonly dnsDown?: boolean;
}) => {
  const [, repo = ""] = options.repository.split("/");
  network.use(
    http.get(
      `https://raw.githubusercontent.com/${options.repository}/HEAD/.claude-plugin/marketplace.json`,
      () => HttpResponse.json(options.marketplace),
    ),
    http.get(
      `https://raw.githubusercontent.com/${options.repository}/*`,
      () => new HttpResponse(null, { status: 404 }),
    ),
    http.get(
      `https://codeload.github.com/${options.repository}/zip/:ref`,
      async () =>
        new HttpResponse((await archive(repo, options.plugins)).slice(), {
          headers: { "content-type": "application/zip" },
        }),
    ),
    http.get("https://cloudflare-dns.com/dns-query", ({ request }) => {
      if (options.dnsDown === true) {
        return new HttpResponse(null, { status: 503 });
      }
      const name = new URL(request.url).searchParams.get("name") ?? "";
      const values = options.txt?.[name] ?? [];
      return HttpResponse.json({
        Status: values.length === 0 ? 3 : 0,
        Answer: values.map((value) => ({
          name,
          type: 16,
          data: `"${value}"`,
        })),
      });
    }),
  );
};

const addCatalog = async (cookie: string, url: string) => {
  const response = await call(catalogs, cookie, { json: { url } });
  return {
    status: response.status,
    body: await response.json<{
      data: Catalog & { message?: string };
    }>(),
  };
};

const previewEntry = async (cookie: string, id: string, name: string) => {
  const response = await call(`${catalogs}/${id}/entries/preview`, cookie, {
    json: { name },
  });
  expect(response.status).toBe(200);
  return (await response.json<{ data: Preview }>()).data;
};

const install = (cookie: string, preview: Preview) =>
  call(bundles, cookie, {
    json: { source: preview.source, reviewedIntegrity: preview.integrity },
  });

describe("plugin catalog routes with D1", () => {
  it("lists a catalog, proves a DNS publisher, and installs its plugin as name@catalog", async () => {
    const { cookie } = await signup("catalog-dns@example.com");
    serve({
      repository: "acme/catalog",
      plugins: ["com.acme.release-helper", "plain-tool", "dev.dxcode.fake"],
      txt: {
        "_dx-plugins.acme.com": [
          "dx-catalog=github.com/someone/else",
          "dx-catalog=github.com/acme/catalog",
        ],
      },
      marketplace: {
        name: "acme-tools",
        owner: { name: "Acme" },
        description: "Acme's plugins.",
        plugins: [
          {
            name: "com.acme.release-helper",
            description: "Ships releases.",
            source: "./plugins/com.acme.release-helper",
          },
          { name: "plain-tool", source: "./plugins/plain-tool" },
          { name: "dev.dxcode.fake", source: "./plugins/dev.dxcode.fake" },
          { name: "escape", source: "../outside" },
          { name: "from-npm", source: { source: "npm", package: "x" } },
          {
            name: "elsewhere",
            source: { source: "url", url: "https://gitlab.com/a/b.git" },
          },
          {
            name: "Bad Name",
            source: "./plugins/bad",
          },
        ],
      },
    });

    const missing = await addCatalog(cookie, "https://example.com/catalog");
    expect(missing.status).toBe(400);

    const added = await addCatalog(cookie, "https://github.com/acme/catalog");
    expect(added.status).toBe(201);
    const catalog = added.body.data;
    expect(catalog.name).toBe("acme-tools");
    expect(
      Object.fromEntries(
        catalog.entries.map(({ name, source }) => [name, source.type]),
      ),
    ).toEqual({
      "com.acme.release-helper": "github",
      "plain-tool": "github",
      "dev.dxcode.fake": "github",
      escape: "unsupported",
      "from-npm": "unsupported",
      elsewhere: "unsupported",
      "Bad Name": "unsupported",
    });
    expect(catalog.publishers).toEqual(
      expect.arrayContaining([
        { domain: "acme.com", proof: "dns" },
        { domain: "dxcode.dev", proof: "none" },
      ]),
    );

    const again = await addCatalog(cookie, "https://github.com/acme/catalog");
    expect(again.status).toBe(400);

    const listed = await call(catalogs, cookie);
    expect(
      (await listed.json<{ data: { items: ReadonlyArray<Catalog> } }>()).data
        .items,
    ).toHaveLength(1);

    // A proven publisher keeps the catalog identity.
    const verified = await previewEntry(
      cookie,
      catalog.id,
      "com.acme.release-helper",
    );
    expect(verified.conflicts).toEqual([]);
    expect(verified.source).toMatchObject({
      type: "github",
      repository: "acme/catalog",
      path: "plugins/com.acme.release-helper",
      catalog: { id: catalog.id, name: "acme-tools" },
    });
    const installed = await install(cookie, verified);
    expect(installed.status).toBe(201);
    expect(
      (await installed.json<{ data: { source: Preview["source"] } }>()).data
        .source.catalog,
    ).toEqual({ id: catalog.id, name: "acme-tools" });

    // A plain name installs as an ordinary GitHub plugin.
    const plain = await previewEntry(cookie, catalog.id, "plain-tool");
    expect(plain.conflicts).toEqual([]);
    expect(plain.source.catalog).toBeUndefined();
    expect((await install(cookie, plain)).status).toBe(201);

    // dx's prefix is refused outside dx's own catalogs.
    const reserved = await previewEntry(cookie, catalog.id, "dev.dxcode.fake");
    expect(reserved.conflicts).toEqual([
      "Names starting with dev.dxcode. are reserved for dx's own plugins.",
    ]);
    expect((await install(cookie, reserved)).status).toBe(400);

    const unsupported = await call(
      `${catalogs}/${catalog.id}/entries/preview`,
      cookie,
      { json: { name: "from-npm" } },
    );
    expect(unsupported.status).toBe(400);

    // Removing the catalog takes its identity from new installs.
    const removed = await call(`${catalogs}/${catalog.id}`, cookie, {
      method: "DELETE",
    });
    expect(removed.status).toBe(200);
    const orphan = await install(cookie, {
      ...verified,
      source: { ...verified.source, path: "plugins/com.acme.release-helper" },
    });
    expect(orphan.status).toBe(400);
    expect(
      (await orphan.json<{ data: { message: string } }>()).data.message,
    ).toBe("The catalog acme-tools isn't added here anymore.");
  });

  it("refuses a forged catalog identity and an unproven publisher", async () => {
    const { cookie } = await signup("catalog-forged@example.com");
    serve({
      repository: "squat/catalog",
      plugins: ["com.acme.release-helper"],
      // acme.com names a different catalog.
      txt: { "_dx-plugins.acme.com": ["dx-catalog=github.com/acme/catalog"] },
      marketplace: {
        name: "squat",
        plugins: [
          {
            name: "com.acme.release-helper",
            source: "./plugins/com.acme.release-helper",
          },
        ],
      },
    });
    const added = await addCatalog(cookie, "https://github.com/squat/catalog");
    expect(added.status).toBe(201);
    const catalog = added.body.data;
    expect(catalog.publishers).toEqual([{ domain: "acme.com", proof: "none" }]);

    const preview = await previewEntry(
      cookie,
      catalog.id,
      "com.acme.release-helper",
    );
    expect(preview.source.catalog).toBeUndefined();

    const forged = await install(cookie, {
      ...preview,
      source: {
        ...preview.source,
        catalog: { id: catalog.id, name: catalog.name },
      },
    });
    expect(forged.status).toBe(400);
    expect(
      (await forged.json<{ data: { message: string } }>()).data.message,
    ).toBe("squat hasn't proven that it publishes for acme.com.");
  });

  it("proves github.io and dx's own names by GitHub owner, and survives DNS failures", async () => {
    const { cookie } = await signup("catalog-github@example.com");
    serve({
      repository: "dxcode-dev/plugins",
      plugins: ["dev.dxcode.helper", "io.github.dxcode-dev.extra"],
      dnsDown: true,
      marketplace: {
        name: "dx",
        plugins: [
          { name: "dev.dxcode.helper", source: "./plugins/dev.dxcode.helper" },
          {
            name: "io.github.dxcode-dev.extra",
            source: "./plugins/io.github.dxcode-dev.extra",
          },
          { name: "com.unreachable.tool", source: "./plugins/none" },
        ],
      },
    });
    const added = await addCatalog(
      cookie,
      "https://github.com/dxcode-dev/plugins",
    );
    expect(added.status).toBe(201);
    const catalog = added.body.data;
    expect(catalog.publishers).toEqual(
      expect.arrayContaining([
        { domain: "dxcode.dev", proof: "first-party" },
        { domain: "dxcode-dev.github.io", proof: "github" },
        { domain: "unreachable.com", proof: "none" },
      ]),
    );
    const firstParty = await previewEntry(
      cookie,
      catalog.id,
      "dev.dxcode.helper",
    );
    expect(firstParty.conflicts).toEqual([]);
    expect(firstParty.source.catalog?.name).toBe("dx");
    expect((await install(cookie, firstParty)).status).toBe(201);
  });

  it("reads a claimed identity where the catalog says, and never grants one on update", async () => {
    const { cookie } = await signup("catalog-pinned@example.com");
    // A plain GitHub import of a prefixed name, from someone else's repo.
    serve({
      repository: "evil/x",
      plugins: ["com.acme.release-helper"],
      marketplace: { name: "unused", plugins: [] },
    });
    serve({
      repository: "acme/catalog",
      plugins: ["com.acme.release-helper"],
      txt: { "_dx-plugins.acme.com": ["dx-catalog=github.com/acme/catalog"] },
      marketplace: {
        name: "acme-tools",
        plugins: [
          {
            name: "com.acme.release-helper",
            source: "./plugins/com.acme.release-helper",
          },
          {
            name: "com.acme.walker",
            source: {
              source: "github",
              repo: "acme/tool",
              ref: "../../evil/x/zip/main",
            },
          },
          {
            name: "com.acme.dots",
            source: { source: "github", repo: "acme/.." },
          },
        ],
      },
    });
    const added = await addCatalog(cookie, "https://github.com/acme/catalog");
    expect(added.status).toBe(201);
    const catalog = added.body.data;
    expect(
      catalog.entries
        .filter(({ name }) => name !== "com.acme.release-helper")
        .map(({ source }) => source.type),
    ).toEqual(["unsupported", "unsupported"]);

    const verified = await previewEntry(
      cookie,
      catalog.id,
      "com.acme.release-helper",
    );
    // Another commit (a fork's, say) under the catalog's identity conflicts.
    const forkCommit = await install(cookie, {
      ...verified,
      source: { ...verified.source, commit: "f".repeat(40) } as never,
    });
    expect(forkCommit.status).toBe(409);
    // A client-chosen ref is ignored: the catalog's ref is what installs.
    const otherRef = await install(cookie, {
      ...verified,
      source: { ...verified.source, ref: "attacker-branch" } as never,
    });
    expect(otherRef.status).toBe(201);
    expect(
      (await otherRef.json<{ data: { source: { ref: string } } }>()).data.source
        .ref,
    ).toBe("HEAD");

    // A plain install can't pick up the identity through an update.
    const other = await signup("catalog-update@example.com");
    const plainPreview = await call(`${bundles}/preview`, other.cookie, {
      json: {
        url: "https://github.com/evil/x/tree/main/plugins/com.acme.release-helper",
      },
    });
    const plain = (await plainPreview.json<{ data: Preview }>()).data;
    expect(plain.conflicts).toEqual([]);
    const plainInstalled = await install(other.cookie, plain);
    expect(plainInstalled.status).toBe(201);
    const { id } = (await plainInstalled.json<{ data: { id: string } }>()).data;
    const theirs = await addCatalog(
      other.cookie,
      "https://github.com/acme/catalog",
    );
    expect(theirs.status).toBe(201);
    const forged = await call(`${bundles}/${id}/update`, other.cookie, {
      json: {
        source: {
          ...plain.source,
          catalog: { id: theirs.body.data.id, name: "acme-tools" },
        },
        reviewedIntegrity: plain.integrity,
      },
    });
    expect(forged.status).toBe(400);
    const listed = await call(bundles, other.cookie);
    const [bundle] = (
      await listed.json<{
        data: { items: ReadonlyArray<{ source: Preview["source"] }> };
      }>()
    ).data.items;
    expect(bundle?.source.catalog).toBeUndefined();
  });

  it("holds the catalog limit when many adds race", async () => {
    const { cookie } = await signup("catalog-race@example.com");
    network.use(
      http.get(
        "https://raw.githubusercontent.com/racer/:repo/HEAD/.claude-plugin/marketplace.json",
        ({ params }) =>
          HttpResponse.json({ name: String(params.repo), plugins: [] }),
      ),
    );
    const results = await Promise.all(
      Array.from({ length: 12 }, (_, index) =>
        addCatalog(cookie, `https://github.com/racer/catalog-${index}`),
      ),
    );
    expect(results.filter(({ status }) => status === 201)).toHaveLength(10);
    expect(results.filter(({ status }) => status === 400)).toHaveLength(2);
    const listed = await call(catalogs, cookie);
    expect(
      (await listed.json<{ data: { items: ReadonlyArray<Catalog> } }>()).data
        .items,
    ).toHaveLength(10);
  });

  it("refuses dx's reserved prefix in a GitHub import outside any catalog", async () => {
    const { cookie } = await signup("catalog-reserved@example.com");
    serve({
      repository: "mallory/fake",
      plugins: ["dev.dxcode.search"],
      marketplace: { name: "unused", plugins: [] },
    });
    const preview = await call(`${bundles}/preview`, cookie, {
      json: {
        url: "https://github.com/mallory/fake/tree/main/plugins/dev.dxcode.search",
      },
    });
    expect(preview.status).toBe(200);
    expect((await preview.json<{ data: Preview }>()).data.conflicts).toContain(
      "Names starting with dev.dxcode. are reserved for dx's own plugins.",
    );
  });
});
