import { GitAuthorEmail, GitAuthorName } from "@dx/domain";
import { Effect, Schema } from "effect";
import { loadRunnerProfileCatalog } from "../../execution/runner-profiles/catalog.js";
import { resolveExecutionRunnerProfile } from "../../execution/runner-profiles/execution.js";
import type { Bindings } from "../../http/types.js";
import type { ExecutionEnvironmentSnapshot } from "../../settings/environment-variables/execution.js";
import type { SigningExecutionPlan } from "../../settings/keys/execution.js";
import { loadPluginOrb } from "./orb-owner.js";

/**
 * What a plugin Orb's environment activation applies: nothing. A Thread's
 * Orb gets its person's, Project's, and workspace's variables and their
 * commit signing; a plugin Orb has no Thread or Project, and each service
 * gets its own variables (its granted secrets) when dxd starts it. Signing
 * is off: a plugin Orb has no repository.
 */
export const pluginOrbEnvironmentReads = async (
  bindings: Bindings,
  orbId: string,
): Promise<{
  readonly snapshot: ExecutionEnvironmentSnapshot;
  readonly signing: SigningExecutionPlan;
  readonly bitbucketConnection: null;
}> => {
  const db = bindings.DB;
  const orb = db === undefined ? undefined : await loadPluginOrb(db, orbId);
  if (orb === undefined) throw new Error("plugin Orb unavailable");
  const [profile, catalog] = await Promise.all([
    Effect.runPromise(
      resolveExecutionRunnerProfile(bindings, orbId, { admission: false }),
    ),
    Effect.runPromise(loadRunnerProfileCatalog(bindings)),
  ]);
  return {
    snapshot: {
      values: [],
      revision: {
        personal: { targetId: orb.payerUserId, revision: 0 },
        project: { targetId: orb.id, revision: 0 },
        workspace: { targetId: orb.workspaceId ?? null, revision: 0 },
      },
    },
    signing: {
      policy: "disabled",
      author: {
        name: Schema.decodeUnknownSync(GitAuthorName)("dx plugins"),
        email: Schema.decodeUnknownSync(GitAuthorEmail)("plugins@dx.invalid"),
      },
      dxCoAuthor: false,
      runnerProfileId: profile.id,
      runnerProfileVersion: catalog.configuration.version,
      runnerAdapter: profile.adapter,
    },
    bitbucketConnection: null,
  };
};
