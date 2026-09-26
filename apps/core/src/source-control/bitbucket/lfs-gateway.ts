import { EnvironmentVariableEnvelope } from "@dx/domain";
import { Effect, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  decryptConfigValue,
  encryptConfigValue,
  loadConfigEncryptionKeyring,
} from "../../settings/config-encryption.js";
import { sourceAccessDenied } from "../authority.js";
import type { BitbucketGitLease } from "./git-gateway.js";
import { BitbucketProviderError } from "./provider-http.js";

const LFS_JSON = "application/vnd.git-lfs+json";
const MAX_BATCH_BYTES = 256 * 1024;
const MAX_OBJECTS = 100;
const MAX_OBJECT_SIZE = 5 * 1024 * 1024 * 1024;
const MAX_RESPONSE_BYTES = 512 * 1024;
const OID = /^[a-f0-9]{64}$/;
const ACTION_ID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

const Batch = Schema.Struct({
  operation: Schema.Literals(["download", "upload"]),
  transfers: Schema.optional(Schema.Array(Schema.String)),
  ref: Schema.optional(Schema.Struct({ name: Schema.String })),
  objects: Schema.Array(
    Schema.Struct({ oid: Schema.String, size: Schema.Number }),
  ),
  hash_algo: Schema.optional(Schema.String),
});

type StoredAction = {
  href: string;
  headers: Record<string, string>;
};
type ActionRow = {
  method: string;
  oid: string;
  size: number;
  envelope_json: string;
};

const deny = () =>
  sourceAccessDenied("provider-permission-denied", "reconnect");
const invalid = (): never => {
  throw new BitbucketProviderError({ category: "invalid-response" });
};
const readBoundedText = async (
  request: Request | Response,
  maximum: number,
) => {
  const declared = request.headers.get("content-length");
  if (
    declared !== null &&
    (!/^\d+$/.test(declared) || Number(declared) > maximum)
  )
    invalid();
  if (!request.body) return "";
  const reader = request.body.getReader();
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let result = "";
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read();
      if (chunk.done) break;
      bytes += chunk.value.byteLength;
      if (bytes > maximum) invalid();
      result += decoder.decode(chunk.value, { stream: true });
    }
    return result + decoder.decode();
  } catch (cause) {
    await reader.cancel();
    throw cause;
  }
};
const parseJson = async (
  request: Request | Response,
  maximum: number,
): Promise<unknown> => {
  try {
    return JSON.parse(await readBoundedText(request, maximum)) as unknown;
  } catch (cause) {
    if (cause instanceof BitbucketProviderError) throw cause;
    return invalid();
  }
};

// Bitbucket Cloud's basic adapter currently uses its own web origin and the
// Atlassian Media API. New storage origins must be reviewed before being added.
const approvedActionUrl = (raw: unknown) => {
  if (typeof raw !== "string" || raw.length > 8_192) invalid();
  let url: URL;
  try {
    url = new URL(raw as string);
  } catch {
    return invalid();
  }
  if (
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    (url.hostname !== "bitbucket.org" &&
      url.hostname !== "api.media.atlassian.com")
  )
    invalid();
  return url.href;
};
const approvedHeaders = (raw: unknown) => {
  if (raw === undefined) return {};
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const result: Record<string, string> = {};
  const entries = Object.entries(raw as Record<string, unknown>);
  if (entries.length > 16) invalid();
  for (const [name, value] of entries) {
    if (
      !/^[!#$%&'*+.^_`|~0-9A-Za-z-]{1,64}$/.test(name) ||
      typeof value !== "string" ||
      value.length > 8_192 ||
      /[\r\n]/.test(value)
    )
      invalid();
    result[name] = value as string;
  }
  return result;
};
const mapUpstreamFailure = async (response: Response): Promise<never> => {
  await response.body?.cancel();
  if (response.status === 401)
    throw new BitbucketProviderError({ category: "unauthorized" });
  if (response.status === 403 || response.status === 404) throw deny();
  throw new BitbucketProviderError({
    category: response.status >= 500 ? "unavailable" : "invalid-response",
  });
};

export const handleBitbucketLfs = async (input: {
  request: Request;
  suffix: string;
  gatewayRepositoryUrl: string;
  lease: BitbucketGitLease;
  leaseToken: string;
  accessToken: string;
  db: D1Database;
  bindings: Bindings;
  fetcher?: typeof fetch;
}): Promise<Response> => {
  const fetcher = input.fetcher ?? globalThis.fetch;
  const objectMatch = /^\/info\/lfs\/dx-objects\/([0-9a-f-]+)$/i.exec(
    input.suffix,
  );
  if (objectMatch) {
    const id = objectMatch[1] as string;
    if (!ACTION_ID.test(id)) throw deny();
    const expectedMethod = input.request.method;
    if (!(["GET", "PUT", "POST"] as const).includes(expectedMethod as "GET"))
      throw deny();
    if (expectedMethod !== "GET" && input.lease.operation !== "contents-push")
      throw deny();
    const row = await input.db
      .prepare(
        "SELECT method, oid, size, envelope_json FROM bitbucket_lfs_action WHERE id = ? AND lease_id_hash = ? AND method = ?",
      )
      .bind(id, input.lease.id_hash, expectedMethod)
      .first<ActionRow>();
    if (!row) throw deny();
    let envelope: typeof EnvironmentVariableEnvelope.Type;
    try {
      envelope = Schema.decodeUnknownSync(EnvironmentVariableEnvelope)(
        JSON.parse(row.envelope_json),
      );
    } catch {
      return invalid();
    }
    const keyring = await Effect.runPromise(
      loadConfigEncryptionKeyring(input.bindings),
    );
    const plaintext = await Effect.runPromise(
      decryptConfigValue(
        keyring,
        {
          purpose: "bitbucket-lfs-action",
          id,
          leaseIdHash: input.lease.id_hash,
        },
        envelope,
      ),
    );
    let action: StoredAction;
    try {
      action = JSON.parse(plaintext) as StoredAction;
    } catch {
      return invalid();
    }
    const href = approvedActionUrl(action.href);
    const headers = new Headers(approvedHeaders(action.headers));
    let body: BodyInit | null | undefined;
    if (expectedMethod === "PUT") {
      const length = input.request.headers.get("content-length");
      if (
        length === null ||
        !/^\d+$/.test(length) ||
        Number(length) !== row.size
      )
        throw deny();
      body = input.request.body;
    } else if (expectedMethod === "POST") {
      headers.set("accept", LFS_JSON);
      headers.set("content-type", LFS_JSON);
      body = JSON.stringify({ oid: row.oid, size: row.size });
    }
    let upstream: Response;
    try {
      upstream = await fetcher(href, {
        method: expectedMethod,
        headers,
        body,
        redirect: "manual",
        signal: AbortSignal.timeout(120_000),
      });
    } catch {
      throw new BitbucketProviderError({ category: "unavailable" });
    }
    if (!upstream.ok) return mapUpstreamFailure(upstream);
    return new Response(upstream.body, {
      status: upstream.status,
      headers: {
        "Content-Type":
          upstream.headers.get("content-type") ?? "application/octet-stream",
        "Cache-Control": "no-store",
      },
    });
  }

  if (
    input.suffix !== "/info/lfs/objects/batch" ||
    input.request.method !== "POST" ||
    input.request.headers.get("content-encoding")
  )
    throw deny();
  let batch: typeof Batch.Type;
  try {
    batch = Schema.decodeUnknownSync(Batch)(
      await parseJson(input.request, MAX_BATCH_BYTES),
    );
  } catch (cause) {
    if (cause instanceof BitbucketProviderError) throw cause;
    throw deny();
  }
  if (
    batch.objects.length < 1 ||
    batch.objects.length > MAX_OBJECTS ||
    (batch.hash_algo !== undefined && batch.hash_algo !== "sha256") ||
    batch.transfers?.some((transfer) => transfer !== "basic") ||
    batch.objects.some(
      (object) =>
        !OID.test(object.oid) ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > MAX_OBJECT_SIZE,
    )
  )
    throw deny();
  if (batch.operation === "upload") {
    if (input.lease.operation !== "contents-push") throw deny();
  }
  const approvedBody = {
    operation: batch.operation,
    transfers: ["basic"],
    ...(batch.ref ? { ref: { name: batch.ref.name } } : {}),
    objects: batch.objects.map(({ oid, size }) => ({ oid, size })),
    hash_algo: "sha256",
  };
  let upstream: Response;
  try {
    upstream = await fetcher(
      `https://bitbucket.org/${input.lease.repository_name}.git/info/lfs/objects/batch`,
      {
        method: "POST",
        redirect: "manual",
        signal: AbortSignal.timeout(30_000),
        headers: {
          accept: LFS_JSON,
          "content-type": LFS_JSON,
          authorization: `Basic ${btoa(`x-token-auth:${input.accessToken}`)}`,
        },
        body: JSON.stringify(approvedBody),
      },
    );
  } catch {
    throw new BitbucketProviderError({ category: "unavailable" });
  }
  if (!upstream.ok) return mapUpstreamFailure(upstream);
  const raw = await parseJson(upstream, MAX_RESPONSE_BYTES);
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) invalid();
  const source = raw as Record<string, unknown>;
  if (
    (source.transfer !== undefined && source.transfer !== "basic") ||
    !Array.isArray(source.objects) ||
    source.objects.length > MAX_OBJECTS
  )
    invalid();
  const sourceObjects = source.objects as unknown[];
  const requested = new Map(
    batch.objects.map((object) => [object.oid, object.size]),
  );
  const keyring = await Effect.runPromise(
    loadConfigEncryptionKeyring(input.bindings),
  );
  const guestAuth = `Basic ${btoa(`dx:${input.leaseToken}`)}`;
  const actionStatements: D1PreparedStatement[] = [];
  const objects = await Promise.all(
    sourceObjects.map(async (unknownObject: unknown) => {
      if (
        !unknownObject ||
        typeof unknownObject !== "object" ||
        Array.isArray(unknownObject)
      )
        invalid();
      const object = unknownObject as Record<string, unknown>;
      if (
        typeof object.oid !== "string" ||
        !OID.test(object.oid) ||
        typeof object.size !== "number" ||
        !Number.isSafeInteger(object.size) ||
        object.size < 0 ||
        object.size > MAX_OBJECT_SIZE
      )
        invalid();
      if (requested.get(object.oid as string) !== object.size) invalid();
      const output: Record<string, unknown> = {
        oid: object.oid,
        size: object.size,
        authenticated: true,
      };
      if (object.error !== undefined) {
        const error = object.error as Record<string, unknown>;
        if (
          !error ||
          typeof error.code !== "number" ||
          !Number.isInteger(error.code)
        )
          invalid();
        output.error = { code: error.code, message: "LFS object unavailable." };
        return output;
      }
      if (object.actions === undefined) return output;
      if (
        !object.actions ||
        typeof object.actions !== "object" ||
        Array.isArray(object.actions)
      )
        invalid();
      const rewritten: Record<string, unknown> = {};
      for (const [kind, method] of Object.entries({
        download: "GET",
        upload: "PUT",
        verify: "POST",
      })) {
        const rawAction = (object.actions as Record<string, unknown>)[kind];
        if (rawAction === undefined) continue;
        if (
          !rawAction ||
          typeof rawAction !== "object" ||
          Array.isArray(rawAction)
        )
          invalid();
        if (
          (batch.operation === "download" && kind !== "download") ||
          (batch.operation === "upload" && kind === "download")
        )
          invalid();
        const actionValue = rawAction as Record<string, unknown>;
        const action = {
          href: approvedActionUrl(actionValue.href),
          headers: approvedHeaders(actionValue.header),
        };
        if (
          new URL(action.href).hostname !== "bitbucket.org" &&
          Object.values(action.headers).some((value) =>
            value.includes(input.accessToken),
          )
        )
          invalid();
        const id = crypto.randomUUID();
        const envelope = await Effect.runPromise(
          encryptConfigValue(
            keyring,
            {
              purpose: "bitbucket-lfs-action",
              id,
              leaseIdHash: input.lease.id_hash,
            },
            JSON.stringify(action),
          ),
        );
        actionStatements.push(
          input.db
            .prepare(
              "INSERT INTO bitbucket_lfs_action (id, lease_id_hash, method, oid, size, envelope_json) VALUES (?, ?, ?, ?, ?, ?)",
            )
            .bind(
              id,
              input.lease.id_hash,
              method,
              object.oid,
              object.size,
              JSON.stringify(envelope),
            ),
        );
        rewritten[kind] = {
          href: `${input.gatewayRepositoryUrl}/info/lfs/dx-objects/${id}`,
          header: { Authorization: guestAuth },
        };
      }
      output.actions = rewritten;
      return output;
    }),
  );
  if (actionStatements.length > 0) await input.db.batch(actionStatements);
  return Response.json(
    { transfer: "basic", objects, hash_algo: "sha256" },
    { headers: { "Content-Type": LFS_JSON, "Cache-Control": "no-store" } },
  );
};
