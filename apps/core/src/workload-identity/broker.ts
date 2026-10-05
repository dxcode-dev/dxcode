import type {
  IssueWorkloadIdentityRequest,
  WorkloadIdentityDiscoveryResponse,
  WorkloadIdentityJwksResponse,
  WorkloadIdentityPublicJwkSchema,
} from "@dx/api";
import {
  type ThreadId,
  WORKLOAD_IDENTITY_TOKEN_USE,
  WorkloadIdentityAudience,
  type WorkloadIdentityRuntimeAssuranceType,
  type WorkloadIdentityRuntimeProviderType,
  WorkloadIdentityUnauthorized,
  WorkloadIdentityUnavailable,
} from "@dx/domain";
import { Schema } from "effect";
import { importJWK, importPKCS8, jwtVerify, SignJWT } from "jose";
import { encodeBase64Url } from "../encoding/base64.js";
import type { Bindings } from "../http/types.js";
import { workloadIdentityLogger } from "../logging.js";

const DEFAULT_TTL_SECONDS = 300;
const MAX_SIGNING_SECRET_BYTES = 64 * 1024;
const MAX_SIGNING_KEYS = 8;
const MAX_AUDIENCE_POLICIES = 128;

type PublicJwk = typeof WorkloadIdentityPublicJwkSchema.Type;

interface SigningKeyConfiguration {
  readonly kid: string;
  readonly publicJwk: PublicJwk;
  readonly privateKeyPkcs8?: string;
}

interface SigningKeyringConfiguration {
  readonly activeKid: string;
  readonly keys: readonly SigningKeyConfiguration[];
}

interface WorkloadAuthority {
  readonly userId: string;
  readonly projectId: string;
  readonly workspaceId?: string;
  readonly threadId: string;
  readonly runtimeId: string;
  readonly runtimeIdentityDigest: string;
}

interface AuthorityRow {
  readonly user_id: unknown;
  readonly project_id: unknown;
  readonly workspace_id: unknown;
  readonly thread_id: unknown;
  readonly runtime_id: unknown;
}

export interface ResidentWorkloadIdentityAuthority {
  readonly threadId: ThreadId;
  readonly runtimeProvider: WorkloadIdentityRuntimeProviderType;
  readonly runtimeAssurance: WorkloadIdentityRuntimeAssuranceType;
  readonly isCurrent: () => boolean;
}

export interface WorkloadIdentityBrokerDependencies {
  readonly now: () => number;
  readonly randomBytes: (length: number) => Uint8Array;
  readonly randomUuid: () => string;
  readonly beforeAudit?: () => Promise<void>;
}

const exactKeys = (value: object, expected: readonly string[]) =>
  JSON.stringify(Object.keys(value).sort()) ===
  JSON.stringify([...expected].sort());

const publicJwk = (value: unknown, kid: string): PublicJwk => {
  if (
    typeof value !== "object" ||
    value === null ||
    Array.isArray(value) ||
    !exactKeys(value, ["alg", "e", "kid", "kty", "n", "use"])
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  const jwk = value as Record<string, unknown>;
  if (
    jwk.kty !== "RSA" ||
    jwk.use !== "sig" ||
    jwk.alg !== "RS256" ||
    jwk.kid !== kid ||
    typeof jwk.n !== "string" ||
    !/^[A-Za-z0-9_-]{342,}$/.test(jwk.n) ||
    typeof jwk.e !== "string" ||
    !/^[A-Za-z0-9_-]{2,16}$/.test(jwk.e)
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  return jwk as unknown as PublicJwk;
};

const parseSigningKeyring = (
  bindings: Bindings,
): SigningKeyringConfiguration => {
  const secret = bindings.DX_WORKLOAD_IDENTITY_SIGNING_KEYS;
  if (
    secret === undefined ||
    secret.length === 0 ||
    new TextEncoder().encode(secret).byteLength > MAX_SIGNING_SECRET_BYTES
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  let decoded: unknown;
  try {
    decoded = JSON.parse(secret);
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    !exactKeys(decoded, ["activeKid", "keys", "version"])
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  const input = decoded as Record<string, unknown>;
  if (
    input.version !== 1 ||
    typeof input.activeKid !== "string" ||
    !/^[A-Za-z0-9_-]{8,64}$/.test(input.activeKid) ||
    !Array.isArray(input.keys) ||
    input.keys.length < 1 ||
    input.keys.length > MAX_SIGNING_KEYS
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  const seen = new Set<string>();
  const keys = input.keys.map((candidate): SigningKeyConfiguration => {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate)
    ) {
      throw new WorkloadIdentityUnavailable();
    }
    const key = candidate as Record<string, unknown>;
    const hasPrivateKey = key.privateKeyPkcs8 !== undefined;
    if (
      !exactKeys(
        key,
        hasPrivateKey
          ? ["kid", "privateKeyPkcs8", "publicJwk"]
          : ["kid", "publicJwk"],
      ) ||
      typeof key.kid !== "string" ||
      !/^[A-Za-z0-9_-]{8,64}$/.test(key.kid) ||
      seen.has(key.kid) ||
      (hasPrivateKey &&
        (typeof key.privateKeyPkcs8 !== "string" ||
          key.privateKeyPkcs8.length > 16 * 1024 ||
          !/^-----BEGIN PRIVATE KEY-----\n[\s\S]+\n-----END PRIVATE KEY-----\n?$/.test(
            key.privateKeyPkcs8,
          )))
    ) {
      throw new WorkloadIdentityUnavailable();
    }
    seen.add(key.kid);
    return {
      kid: key.kid,
      publicJwk: publicJwk(key.publicJwk, key.kid),
      ...(hasPrivateKey
        ? { privateKeyPkcs8: key.privateKeyPkcs8 as string }
        : {}),
    };
  });
  const active = keys.find(({ kid }) => kid === input.activeKid);
  if (active?.privateKeyPkcs8 === undefined)
    throw new WorkloadIdentityUnavailable();
  return { activeKid: input.activeKid, keys };
};

const configuredIssuer = (bindings: Bindings) => {
  const value = bindings.DX_WORKLOAD_IDENTITY_ISSUER;
  if (value === undefined) throw new WorkloadIdentityUnavailable();
  let issuer: URL;
  try {
    issuer = new URL(value);
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
  const localLoopback =
    bindings.DX_ENV === "local" &&
    issuer.protocol === "http:" &&
    ["127.0.0.1", "localhost", "[::1]"].includes(issuer.hostname);
  if (
    (issuer.protocol !== "https:" && !localLoopback) ||
    issuer.username !== "" ||
    issuer.password !== "" ||
    issuer.search !== "" ||
    issuer.hash !== "" ||
    issuer.pathname !== "/api/workload-identity" ||
    issuer.href !== value
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  return issuer.href;
};

const parseAudiencePolicies = (bindings: Bindings) => {
  const encoded =
    bindings.DX_WORKLOAD_IDENTITY_AUDIENCE_POLICIES ??
    '{"version":1,"policies":[]}';
  if (new TextEncoder().encode(encoded).byteLength > 64 * 1024)
    throw new WorkloadIdentityUnavailable();
  let decoded: unknown;
  try {
    decoded = JSON.parse(encoded);
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
  if (
    typeof decoded !== "object" ||
    decoded === null ||
    Array.isArray(decoded) ||
    !exactKeys(decoded, ["policies", "version"])
  )
    throw new WorkloadIdentityUnavailable();
  const input = decoded as Record<string, unknown>;
  if (
    input.version !== 1 ||
    !Array.isArray(input.policies) ||
    input.policies.length > MAX_AUDIENCE_POLICIES
  )
    throw new WorkloadIdentityUnavailable();
  const policies = new Map<string, WorkloadIdentityRuntimeAssuranceType>();
  for (const candidate of input.policies) {
    if (
      typeof candidate !== "object" ||
      candidate === null ||
      Array.isArray(candidate) ||
      !exactKeys(candidate, ["audience", "minimumRuntimeAssurance"])
    )
      throw new WorkloadIdentityUnavailable();
    const policy = candidate as Record<string, unknown>;
    let audience: string;
    try {
      audience = Schema.decodeUnknownSync(WorkloadIdentityAudience)(
        policy.audience,
      );
    } catch {
      throw new WorkloadIdentityUnavailable();
    }
    if (
      policy.minimumRuntimeAssurance !== "dx_dxd_channel_v1" &&
      policy.minimumRuntimeAssurance !== "dx_provider_attested_v1"
    )
      throw new WorkloadIdentityUnavailable();
    if (policies.has(audience)) throw new WorkloadIdentityUnavailable();
    policies.set(audience, policy.minimumRuntimeAssurance);
  }
  return policies;
};

const string = (value: unknown) =>
  typeof value === "string" && value.length >= 1 && value.length <= 128
    ? value
    : undefined;

const digest = async (value: string) =>
  encodeBase64Url(
    new Uint8Array(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(value)),
    ),
  );

const runtimeDigest = (
  provider: WorkloadIdentityRuntimeProviderType,
  runtimeId: string,
) => digest(`${provider.length}:${provider}${runtimeId.length}:${runtimeId}`);

const subjectFor = async (authority: WorkloadAuthority) => {
  const segments = await Promise.all([
    digest(authority.userId),
    digest(authority.projectId),
    digest(authority.threadId),
    ...(authority.workspaceId === undefined
      ? []
      : [digest(authority.workspaceId)]),
  ]);
  const [user, project, thread, workspace] = segments;
  return workspace === undefined
    ? `dx:wid:v1:u:${user}:p:${project}:t:${thread}`
    : `dx:wid:v1:w:${workspace}:u:${user}:p:${project}:t:${thread}`;
};

const resolveAuthority = async (
  db: D1Database,
  threadId: ThreadId,
  runtimeProvider: WorkloadIdentityRuntimeProviderType,
): Promise<WorkloadAuthority> => {
  let rows: AuthorityRow[];
  try {
    const result = await db
      .prepare(
        `SELECT thread.owner_user_id AS user_id,
                thread.project_id,
                project.workspace_id,
                thread.id AS thread_id,
                CASE WHEN ? = 'local'
                  THEN thread.id
                  ELSE execution.provider_sandbox_id
                END AS runtime_id
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
            AND project.owner_user_id = thread.owner_user_id
           JOIN execution_workspace AS execution
             ON execution.thread_id = thread.id
           LEFT JOIN organization
             ON organization.id = project.workspace_id
           LEFT JOIN member
             ON member.organizationId = project.workspace_id
            AND member.userId = thread.owner_user_id
          WHERE thread.id = ?
            AND thread.lifecycle_state = 'active'
            AND (
              project.workspace_id IS NULL
              OR (
                organization.lifecycleState = 'active'
                AND member.userId = thread.owner_user_id
              )
            )
            AND (
              (? = 'local' AND execution.ready_at IS NOT NULL)
              OR (
                -- The Thread's pinned provider (e2b or cloudflare).
                execution.provider = ?
                AND execution.state = 'initialized'
                AND execution.provider_sandbox_id IS NOT NULL
              )
            )
          LIMIT 2`,
      )
      .bind(runtimeProvider, threadId, runtimeProvider, runtimeProvider)
      .all<AuthorityRow>();
    rows = result.results;
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
  if (rows.length !== 1) throw new WorkloadIdentityUnauthorized();
  const row = rows[0] as AuthorityRow;
  const userId = string(row.user_id);
  const projectId = string(row.project_id);
  const resolvedThreadId = string(row.thread_id);
  const runtimeId = string(row.runtime_id);
  const workspaceId =
    row.workspace_id === null ? undefined : string(row.workspace_id);
  if (
    userId === undefined ||
    projectId === undefined ||
    resolvedThreadId !== threadId ||
    runtimeId === undefined ||
    (row.workspace_id !== null && workspaceId === undefined)
  ) {
    throw new WorkloadIdentityUnavailable();
  }
  return {
    userId,
    projectId,
    threadId: resolvedThreadId,
    runtimeId,
    runtimeIdentityDigest: await runtimeDigest(runtimeProvider, runtimeId),
    ...(workspaceId === undefined ? {} : { workspaceId }),
  };
};

const activeSigningKey = async (bindings: Bindings) => {
  const keyring = parseSigningKeyring(bindings);
  const active = keyring.keys.find(({ kid }) => kid === keyring.activeKid);
  if (active?.privateKeyPkcs8 === undefined)
    throw new WorkloadIdentityUnavailable();
  try {
    const [privateKey, verificationKey] = await Promise.all([
      importPKCS8(active.privateKeyPkcs8, "RS256"),
      importJWK(active.publicJwk, "RS256"),
    ]);
    const proof = await new SignJWT({
      purpose: "dx-workload-identity-key-pair-v1",
    })
      .setProtectedHeader({ alg: "RS256", kid: active.kid })
      .sign(privateKey);
    await jwtVerify(proof, verificationKey, { algorithms: ["RS256"] });
    return { ...active, privateKey };
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
};

const recordIssued = async (
  db: D1Database,
  record: {
    readonly issuanceId: string;
    readonly occurredAt: string;
    readonly authority: WorkloadAuthority;
    readonly runtimeProvider: WorkloadIdentityRuntimeProviderType;
    readonly runtimeAssurance: WorkloadIdentityRuntimeAssuranceType;
    readonly audience: string;
    readonly requestedTtlSeconds?: number;
    readonly effectiveTtlSeconds: number;
    readonly expiresAt: number;
    readonly signingKid: string;
    readonly durationMs: number;
  },
) => {
  let result: D1Result<unknown>;
  try {
    result = await db
      .prepare(
        `INSERT INTO workload_identity_issuance_audit (
           issuance_id, occurred_at, actor_user_id, project_id, workspace_id,
           thread_id, runtime_provider, runtime_identity_digest,
           runtime_assurance, audience, requested_ttl_seconds,
           effective_ttl_seconds, expires_at, signing_kid, outcome, reason,
           duration_ms
         )
         SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'issued', NULL, ?
           FROM threads AS thread
           JOIN projects AS project ON project.id = thread.project_id
            AND project.owner_user_id = thread.owner_user_id
           JOIN execution_workspace AS execution
             ON execution.thread_id = thread.id
           LEFT JOIN organization
             ON organization.id = project.workspace_id
           LEFT JOIN member
             ON member.organizationId = project.workspace_id
            AND member.userId = thread.owner_user_id
          WHERE thread.id = ?
            AND thread.owner_user_id = ?
            AND thread.project_id = ?
            AND thread.lifecycle_state = 'active'
            AND project.workspace_id IS ?
            AND (
              project.workspace_id IS NULL
              OR (
                organization.lifecycleState = 'active'
                AND member.userId = thread.owner_user_id
              )
            )
            AND (
              (? = 'local'
                AND execution.ready_at IS NOT NULL
                AND thread.id = ?)
              OR (
                -- The Thread's pinned provider (e2b or cloudflare).
                execution.provider = ?
                AND execution.state = 'initialized'
                AND execution.provider_sandbox_id = ?
              )
            )`,
      )
      .bind(
        record.issuanceId,
        record.occurredAt,
        record.authority.userId,
        record.authority.projectId,
        record.authority.workspaceId ?? null,
        record.authority.threadId,
        record.runtimeProvider,
        record.authority.runtimeIdentityDigest,
        record.runtimeAssurance,
        record.audience,
        record.requestedTtlSeconds ?? null,
        record.effectiveTtlSeconds,
        record.expiresAt,
        record.signingKid,
        Math.max(0, Math.round(record.durationMs)),
        record.authority.threadId,
        record.authority.userId,
        record.authority.projectId,
        record.authority.workspaceId ?? null,
        record.runtimeProvider,
        record.authority.runtimeId,
        record.runtimeProvider,
        record.authority.runtimeId,
      )
      .run();
  } catch {
    throw new WorkloadIdentityUnavailable();
  }
  if (result.meta.changes !== 1) throw new WorkloadIdentityUnauthorized();
};

const recordFailure = async (
  db: D1Database,
  record: {
    readonly issuanceId: string;
    readonly occurredAt: string;
    readonly authority?: WorkloadAuthority;
    readonly threadId: ThreadId;
    readonly runtimeProvider: WorkloadIdentityRuntimeProviderType;
    readonly runtimeAssurance: WorkloadIdentityRuntimeAssuranceType;
    readonly audience: string;
    readonly requestedTtlSeconds?: number;
    readonly effectiveTtlSeconds: number;
    readonly outcome: "denied" | "error";
    readonly reason: "authority" | "configuration" | "signing" | "audit";
    readonly durationMs: number;
  },
) => {
  try {
    await db
      .prepare(
        `INSERT INTO workload_identity_issuance_audit (
           issuance_id, occurred_at, actor_user_id, project_id, workspace_id,
           thread_id, runtime_provider, runtime_identity_digest,
           runtime_assurance, audience, requested_ttl_seconds,
           effective_ttl_seconds, expires_at, signing_kid, outcome, reason,
           duration_ms
         ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL, ?, ?, ?)`,
      )
      .bind(
        record.issuanceId,
        record.occurredAt,
        record.authority?.userId ?? null,
        record.authority?.projectId ?? null,
        record.authority?.workspaceId ?? null,
        record.threadId,
        record.runtimeProvider,
        record.authority?.runtimeIdentityDigest ?? null,
        record.runtimeAssurance,
        record.audience,
        record.requestedTtlSeconds ?? null,
        record.effectiveTtlSeconds,
        record.outcome,
        record.reason,
        Math.max(0, Math.round(record.durationMs)),
      )
      .run();
  } catch {
    // The primary failure is returned without exposing audit or storage detail.
  }
};

const liveDependencies: WorkloadIdentityBrokerDependencies = {
  now: Date.now,
  randomBytes: (length) => crypto.getRandomValues(new Uint8Array(length)),
  randomUuid: () => crypto.randomUUID(),
};

export const makeWorkloadIdentityBroker = (
  dependencies: WorkloadIdentityBrokerDependencies = liveDependencies,
) => ({
  discovery(bindings: Bindings): WorkloadIdentityDiscoveryResponse {
    const issuer = configuredIssuer(bindings);
    return {
      issuer,
      jwks_uri: `${issuer}/jwks.json`,
      response_types_supported: ["id_token"],
      subject_types_supported: ["public"],
      id_token_signing_alg_values_supported: ["RS256"],
      claims_supported: [
        "iss",
        "sub",
        "aud",
        "iat",
        "exp",
        "jti",
        "token_use",
        "runtime_assurance",
        "user_id",
        "project_id",
        "workspace_id",
        "thread_id",
      ],
    };
  },

  jwks(bindings: Bindings): WorkloadIdentityJwksResponse {
    return {
      keys: parseSigningKeyring(bindings).keys.map(
        ({ publicJwk }) => publicJwk,
      ),
    };
  },

  async validateConfiguration(bindings: Bindings) {
    configuredIssuer(bindings);
    parseAudiencePolicies(bindings);
    await activeSigningKey(bindings);
  },

  async issue(
    bindings: Bindings,
    resident: ResidentWorkloadIdentityAuthority,
    request: IssueWorkloadIdentityRequest,
  ) {
    const startedAt = dependencies.now();
    const issuedAt = Math.floor(startedAt / 1_000);
    const effectiveTtlSeconds = request.ttlSeconds ?? DEFAULT_TTL_SECONDS;
    const issuanceId = `wid_${dependencies.randomUuid()}`;
    let stage: "authority" | "configuration" | "signing" | "audit" =
      "authority";
    let authority: WorkloadAuthority | undefined;
    const db = bindings.DB;
    if (db === undefined) throw new WorkloadIdentityUnavailable();
    try {
      if (!resident.isCurrent()) throw new WorkloadIdentityUnauthorized();
      stage = "configuration";
      const requiredAssurance = parseAudiencePolicies(bindings).get(
        request.audience,
      );
      if (
        requiredAssurance === "dx_provider_attested_v1" &&
        resident.runtimeAssurance !== "dx_provider_attested_v1"
      )
        throw new WorkloadIdentityUnauthorized();
      stage = "authority";
      authority = await resolveAuthority(
        db,
        resident.threadId,
        resident.runtimeProvider,
      );
      if (!resident.isCurrent()) throw new WorkloadIdentityUnauthorized();
      stage = "configuration";
      const issuer = configuredIssuer(bindings);
      const active = await activeSigningKey(bindings);
      const expiresAt = issuedAt + effectiveTtlSeconds;
      const jti = dependencies.randomBytes(16);
      if (jti.byteLength !== 16) throw new WorkloadIdentityUnavailable();
      stage = "signing";
      let token: string;
      try {
        token = await new SignJWT({
          token_use: WORKLOAD_IDENTITY_TOKEN_USE,
          runtime_assurance: resident.runtimeAssurance,
          user_id: authority.userId,
          project_id: authority.projectId,
          thread_id: authority.threadId,
          ...(authority.workspaceId === undefined
            ? {}
            : { workspace_id: authority.workspaceId }),
        })
          .setProtectedHeader({ alg: "RS256", kid: active.kid, typ: "JWT" })
          .setIssuer(issuer)
          .setAudience(request.audience)
          .setSubject(await subjectFor(authority))
          .setIssuedAt(issuedAt)
          .setExpirationTime(expiresAt)
          .setJti(encodeBase64Url(jti))
          .sign(active.privateKey);
      } catch {
        throw new WorkloadIdentityUnavailable();
      }
      stage = "audit";
      await dependencies.beforeAudit?.();
      if (!resident.isCurrent()) throw new WorkloadIdentityUnauthorized();
      await recordIssued(db, {
        issuanceId,
        occurredAt: new Date(startedAt).toISOString(),
        authority,
        runtimeProvider: resident.runtimeProvider,
        runtimeAssurance: resident.runtimeAssurance,
        audience: request.audience,
        requestedTtlSeconds: request.ttlSeconds,
        effectiveTtlSeconds,
        expiresAt,
        signingKid: active.kid,
        durationMs: dependencies.now() - startedAt,
      });
      workloadIdentityLogger.info("Workload identity issued.", {
        event: "workload_identity_issuance",
        issuanceId,
        actorUserId: authority.userId,
        projectId: authority.projectId,
        workspaceId: authority.workspaceId,
        threadId: authority.threadId,
        runtimeProvider: resident.runtimeProvider,
        runtimeAssurance: resident.runtimeAssurance,
        outcome: "issued",
        durationMs: Math.max(0, Math.round(dependencies.now() - startedAt)),
      });
      return { token, expiresAt };
    } catch (cause) {
      const unauthorized = cause instanceof WorkloadIdentityUnauthorized;
      await recordFailure(db, {
        issuanceId,
        occurredAt: new Date(startedAt).toISOString(),
        authority,
        threadId: resident.threadId,
        runtimeProvider: resident.runtimeProvider,
        runtimeAssurance: resident.runtimeAssurance,
        audience: request.audience,
        requestedTtlSeconds: request.ttlSeconds,
        effectiveTtlSeconds,
        outcome: unauthorized ? "denied" : "error",
        reason: unauthorized ? "authority" : stage,
        durationMs: dependencies.now() - startedAt,
      });
      workloadIdentityLogger.info("Workload identity request completed.", {
        event: "workload_identity_issuance",
        issuanceId,
        threadId: resident.threadId,
        runtimeProvider: resident.runtimeProvider,
        runtimeAssurance: resident.runtimeAssurance,
        outcome: unauthorized ? "denied" : "error",
        reason: unauthorized ? "authority" : stage,
        durationMs: Math.max(0, Math.round(dependencies.now() - startedAt)),
      });
      if (unauthorized) throw cause;
      throw new WorkloadIdentityUnavailable();
    }
  },
});

export const workloadIdentityBroker = makeWorkloadIdentityBroker();
