import { Effect, Schema } from "effect";
import {
  type ConfigEncryptionKeyring,
  decryptConfigValue,
  encryptConfigValue,
} from "../config-encryption.js";
import type { createGitHubCopilotProvider } from "./github-copilot/provider.js";
import {
  CopilotError,
  GITHUB_COPILOT_CATALOG,
  type GitHubOAuthCredential,
} from "./github-copilot/provider.js";
import type {
  AuthorizationRow,
  PersonalModelSubscriptionRepositoryD1,
  SubscriptionRow,
} from "./repository-d1.js";

export class PersonalModelSubscriptionNotFound extends Schema.TaggedError<PersonalModelSubscriptionNotFound>()(
  "PersonalModelSubscriptionNotFound",
  {},
) {}
export class PersonalModelSubscriptionConflict extends Schema.TaggedError<PersonalModelSubscriptionConflict>()(
  "PersonalModelSubscriptionConflict",
  {},
) {}
export class PersonalModelSubscriptionUnavailable extends Schema.TaggedError<PersonalModelSubscriptionUnavailable>()(
  "PersonalModelSubscriptionUnavailable",
  {},
) {}

type Provider = ReturnType<typeof createGitHubCopilotProvider>;
const iso = (n: number) => new Date(n).toISOString();
const dateTime = Schema.decodeUnknownSync(Schema.DateTimeUtcFromString);
const ENTITLEMENT_REFRESH_INTERVAL_MS = 60 * 60 * 1_000;
const GitHubOAuthCredentialSchema = Schema.Struct({
  accessToken: Schema.String,
  expiresAt: Schema.optional(Schema.Number),
  refreshToken: Schema.optional(Schema.String),
  refreshExpiresAt: Schema.optional(Schema.Number),
});
const AuthorizationSecretSchema = Schema.Union([
  Schema.Struct({ deviceCode: Schema.String }),
  Schema.Struct({ credential: GitHubOAuthCredentialSchema }),
]);
const credentialsEqual = (
  left: GitHubOAuthCredential,
  right: GitHubOAuthCredential,
) =>
  left.accessToken === right.accessToken &&
  left.expiresAt === right.expiresAt &&
  left.refreshToken === right.refreshToken &&
  left.refreshExpiresAt === right.refreshExpiresAt;
export const modelSubscriptionEncryptionContext = (
  purpose: "authorization" | "credential",
  ownerUserId: string,
  recordId: string,
  credentialRevision: number,
  browserSessionId?: string,
) => ({
  purpose: `personal-model-subscription-${purpose}`,
  ownerUserId,
  provider: "github-copilot",
  recordId,
  credentialRevision,
  ...(browserSessionId === undefined ? {} : { browserSessionId }),
});
const publicConnection = (r: SubscriptionRow) => ({
  id: r.id,
  provider: r.provider,
  providerAccountLogin: r.providerAccountLogin,
  status: r.status,
  modelIds: r.modelIds,
  catalogRevision: r.catalogRevision,
  observedAt: dateTime(r.observedAt),
  refreshAfter: dateTime(r.refreshAfter),
  connectedAt: dateTime(r.connectedAt),
  updatedAt: dateTime(r.updatedAt),
});
const publicAuthorization = (r: AuthorizationRow) => ({
  id: r.id,
  provider: r.provider,
  verificationUrl: r.verificationUrl,
  userCode: r.userCode,
  expiresAt: dateTime(r.expiresAt),
  intervalSeconds: r.intervalSeconds,
  nextPollAt: dateTime(r.nextPollAt),
  state: "pending" as const,
});
const models = (ids: readonly string[]) =>
  GITHUB_COPILOT_CATALOG.filter((m) => ids.includes(m.id)).map(
    ({ id, name, protocol, capabilities, cost }) => ({
      id,
      name,
      protocol,
      capabilities,
      cost: {
        input: cost.input,
        output: cost.output,
        cacheRead: cost.cacheRead,
        cacheWrite: cost.cacheWrite,
      },
    }),
  );

export class PersonalModelSubscriptionService {
  constructor(
    private readonly repository: PersonalModelSubscriptionRepositoryD1,
    private readonly provider: Provider,
    private readonly keyring: ConfigEncryptionKeyring,
    private readonly clock: () => number = Date.now,
  ) {}
  async list(owner: string) {
    return (await this.repository.list(owner)).map(publicConnection);
  }
  async begin(owner: string, browserSessionId: string, provider: string) {
    if (provider !== "github-copilot")
      throw new PersonalModelSubscriptionNotFound();
    const challenge = await this.provider.startDeviceAuthorization();
    const id = crypto.randomUUID(),
      now = iso(this.clock()),
      revision = 1;
    const envelope = await Effect.runPromise(
      encryptConfigValue(
        this.keyring,
        modelSubscriptionEncryptionContext(
          "authorization",
          owner,
          id,
          revision,
          browserSessionId,
        ),
        JSON.stringify({ deviceCode: challenge.deviceCode }),
      ),
    );
    const row: AuthorizationRow = {
      id,
      ownerUserId: owner,
      browserSessionId,
      provider,
      envelope,
      credentialRevision: revision,
      verificationUrl: challenge.verificationUri,
      userCode: challenge.userCode,
      expiresAt: iso(challenge.expiresAt),
      intervalSeconds: challenge.intervalSeconds,
      nextPollAt: iso(challenge.nextPollAt),
      createdAt: now,
      updatedAt: now,
    };
    await this.repository.replaceAuthorization(row);
    return publicAuthorization(row);
  }
  private async credential(
    owner: string,
    id: string,
    revision: number,
    envelope: NonNullable<SubscriptionRow["credentialEnvelope"]>,
  ) {
    return Schema.decodeUnknownSync(GitHubOAuthCredentialSchema)(
      JSON.parse(
        await Effect.runPromise(
          decryptConfigValue(
            this.keyring,
            modelSubscriptionEncryptionContext(
              "credential",
              owner,
              id,
              revision,
            ),
            envelope,
          ),
        ),
      ),
    );
  }
  private async credentialEnvelope(
    owner: string,
    id: string,
    revision: number,
    credential: GitHubOAuthCredential,
  ) {
    return Effect.runPromise(
      encryptConfigValue(
        this.keyring,
        modelSubscriptionEncryptionContext("credential", owner, id, revision),
        JSON.stringify(credential),
      ),
    );
  }
  private async authorizationSecret(auth: AuthorizationRow) {
    return Schema.decodeUnknownSync(AuthorizationSecretSchema)(
      JSON.parse(
        await Effect.runPromise(
          decryptConfigValue(
            this.keyring,
            modelSubscriptionEncryptionContext(
              "authorization",
              auth.ownerUserId,
              auth.id,
              auth.credentialRevision,
              auth.browserSessionId,
            ),
            auth.envelope,
          ),
        ),
      ),
    );
  }
  private async saveAuthorizationCredential(
    auth: AuthorizationRow,
    credential: GitHubOAuthCredential,
  ) {
    const revision = auth.credentialRevision + 1;
    const next: AuthorizationRow = {
      ...auth,
      envelope: await Effect.runPromise(
        encryptConfigValue(
          this.keyring,
          modelSubscriptionEncryptionContext(
            "authorization",
            auth.ownerUserId,
            auth.id,
            revision,
            auth.browserSessionId,
          ),
          JSON.stringify({ credential }),
        ),
      ),
      credentialRevision: revision,
      updatedAt: iso(this.clock()),
    };
    if (!(await this.repository.updateAuthorizationSecret(auth, next)))
      throw new PersonalModelSubscriptionNotFound();
    return next;
  }
  async poll(owner: string, session: string, id: string) {
    let auth = await this.repository.findAuthorization(owner, session, id);
    if (!auth) throw new PersonalModelSubscriptionNotFound();
    const at = this.clock();
    const privateValue = await this.authorizationSecret(auth);
    let credential: GitHubOAuthCredential;
    if ("credential" in privateValue) {
      credential = privateValue.credential;
    } else {
      if (at >= Date.parse(auth.expiresAt)) {
        await this.repository.deleteAuthorization(owner, session, id);
        return { state: "expired" as const };
      }
      if (at < Date.parse(auth.nextPollAt)) return publicAuthorization(auth);
      const challenge = {
        deviceCode: privateValue.deviceCode,
        userCode: auth.userCode,
        verificationUri: auth.verificationUrl,
        expiresAt: Date.parse(auth.expiresAt),
        intervalSeconds: auth.intervalSeconds,
        nextPollAt: Date.parse(auth.nextPollAt),
      };
      const reserved = {
        ...auth,
        nextPollAt: iso(at + auth.intervalSeconds * 1_000),
        updatedAt: iso(at),
      };
      if (!(await this.repository.updatePoll(auth, reserved)))
        throw new PersonalModelSubscriptionNotFound();
      auth = reserved;
      const result = await this.provider.pollDeviceAuthorization(challenge);
      if (result.status === "denied" || result.status === "expired") {
        await this.repository.deleteAuthorization(owner, session, id);
        return { state: result.status };
      }
      if (result.status === "pending" || result.status === "slow_down") {
        const next = {
          ...auth,
          intervalSeconds: result.intervalSeconds,
          nextPollAt: iso(result.nextPollAt),
          updatedAt: iso(at),
        };
        if (!(await this.repository.updatePoll(auth, next)))
          throw new PersonalModelSubscriptionNotFound();
        return publicAuthorization(next);
      }
      if (result.status !== "authorized")
        throw new PersonalModelSubscriptionUnavailable();
      credential = result.credential;
      auth = await this.saveAuthorizationCredential(auth, credential);
    }
    const resolved = await this.provider.resolveCopilotAccess(credential);
    if (!credentialsEqual(credential, resolved.credential)) {
      auth = await this.saveAuthorizationCredential(auth, resolved.credential);
    }
    const identity = await this.provider.getGitHubIdentity(
      resolved.credential.accessToken,
    );
    const entitlement = await this.provider.discoverModels(resolved.access);
    const existing = (await this.repository.list(owner)).find(
      (connection) => connection.provider === "github-copilot",
    );
    const connectionId = existing?.id ?? crypto.randomUUID(),
      revision = (existing?.credentialRevision ?? 0) + 1,
      observed = iso(entitlement.observedAt),
      updated = iso(this.clock());
    const envelope = await this.credentialEnvelope(
      owner,
      connectionId,
      revision,
      resolved.credential,
    );
    const row: SubscriptionRow = {
      id: connectionId,
      ownerUserId: owner,
      provider: "github-copilot",
      providerAccountId: identity.id,
      providerAccountLogin: identity.login,
      status: "connected",
      credentialEnvelope: envelope,
      credentialRevision: revision,
      modelIds: [...entitlement.enabledModelIds],
      catalogRevision: entitlement.catalogRevision,
      observedAt: observed,
      refreshAfter: iso(
        entitlement.observedAt + ENTITLEMENT_REFRESH_INTERVAL_MS,
      ),
      createdAt: updated,
      updatedAt: updated,
      connectedAt: updated,
    };
    const saved = await this.repository.complete(
      auth,
      row,
      models(row.modelIds),
    );
    if (!saved) throw new PersonalModelSubscriptionNotFound();
    return { state: "connected" as const, connection: publicConnection(saved) };
  }
  private async resolvedCredential(
    owner: string,
    id: string,
    current: SubscriptionRow,
  ) {
    if (current.status !== "connected" || current.credentialEnvelope === null)
      throw new PersonalModelSubscriptionNotFound();
    const old = await this.credential(
      owner,
      id,
      current.credentialRevision,
      current.credentialEnvelope,
    );
    const resolved = await this.provider.resolveCopilotAccess(old);
    if (credentialsEqual(old, resolved.credential)) {
      return { connection: current, ...resolved };
    }
    const revision = current.credentialRevision + 1;
    const rotated: SubscriptionRow = {
      ...current,
      credentialEnvelope: await this.credentialEnvelope(
        owner,
        id,
        revision,
        resolved.credential,
      ),
      credentialRevision: revision,
      updatedAt: iso(this.clock()),
    };
    if (!(await this.repository.rotateCredential(current, rotated)))
      throw new PersonalModelSubscriptionNotFound();
    return { connection: rotated, ...resolved };
  }
  async resolveAccess(owner: string, id: string) {
    const current = await this.repository.find(owner, id);
    if (current === undefined) throw new PersonalModelSubscriptionNotFound();
    const resolved = await this.resolvedCredential(owner, id, current);
    return {
      access: resolved.access,
      credentialRevision: resolved.connection.credentialRevision,
    };
  }
  async refresh(owner: string, id: string) {
    const current = await this.repository.find(owner, id);
    if (!current?.credentialEnvelope)
      throw new PersonalModelSubscriptionNotFound();
    let expected = current;
    const now = iso(this.clock());
    try {
      const resolved = await this.resolvedCredential(owner, id, current);
      expected = resolved.connection;
      const entitlement = await this.provider.discoverModels(resolved.access);
      const revision = expected.credentialRevision + 1;
      const next = {
        ...expected,
        status: "connected" as const,
        credentialEnvelope: await this.credentialEnvelope(
          owner,
          id,
          revision,
          resolved.credential,
        ),
        credentialRevision: revision,
        modelIds: [...entitlement.enabledModelIds],
        catalogRevision: entitlement.catalogRevision,
        observedAt: iso(entitlement.observedAt),
        refreshAfter: iso(
          entitlement.observedAt + ENTITLEMENT_REFRESH_INTERVAL_MS,
        ),
        updatedAt: now,
      };
      if (
        !(await this.repository.refresh(expected, next, models(next.modelIds)))
      )
        throw new PersonalModelSubscriptionNotFound();
      return publicConnection(next);
    } catch (error) {
      if (
        error instanceof CopilotError &&
        (error.code === "REAUTHORIZATION_REQUIRED" ||
          error.code === "UNAUTHORIZED")
      ) {
        const revision = expected.credentialRevision + 1;
        const next = {
          ...expected,
          status: "needs-reauthorization" as const,
          credentialEnvelope: null,
          credentialRevision: revision,
          modelIds: [],
          updatedAt: now,
        };
        if (!(await this.repository.refresh(expected, next, [])))
          throw new PersonalModelSubscriptionNotFound();
        return publicConnection(next);
      }
      throw error;
    }
  }
  async disconnect(owner: string, id: string) {
    const result = await this.repository.disconnect(owner, id);
    if (result === "missing") throw new PersonalModelSubscriptionNotFound();
    if (result === "conflict") throw new PersonalModelSubscriptionConflict();
    return { disconnectedConnectionId: id };
  }
}
