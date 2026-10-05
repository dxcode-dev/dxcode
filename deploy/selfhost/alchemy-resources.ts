import { createHash } from "node:crypto";
import { resolve } from "node:path";
import * as Alchemy from "alchemy";
import * as Provider from "alchemy/Provider";
import { ApiClient, ConnectionConfig, Template } from "e2b";
import { Effect, Layer, Redacted } from "effect";
import {
  deployOrbWorker,
  destroyOrbWorker,
  orbRecipeHash,
} from "../orb/containers.mjs";
import { e2bRecipeHash, reconcileE2BProfiles } from "./e2b.mjs";

type HeldSecretResource = Alchemy.Resource<
  "Dx.HeldSecret",
  { value?: Redacted.Redacted<string> },
  { value: Redacted.Redacted<string> }
>;
type E2BProfilesResource = Alchemy.Resource<
  "Dx.E2BProfiles",
  {
    apiKey: Redacted.Redacted<string>;
    deploymentName: string;
    recipeHash: string;
  },
  {
    apiKeyHash: string;
    recipeHash: string;
    profilesJson: string;
    defaultTemplate: string;
    defaultBuildId: string;
  }
>;

/**
 * The Cloudflare Containers Orb provider's Worker (deploy/orb/containers.mjs).
 * It is redeployed only when its recipe (Worker source, image, wrangler)
 * changes, because a redeploy restarts every Orb container object.
 */
type OrbContainersResource = Alchemy.Resource<
  "Dx.OrbContainers",
  { workerName: string; recipeHash: string },
  { workerName: string; recipeHash: string }
>;

export const HeldSecret = Alchemy.Resource<HeldSecretResource>("Dx.HeldSecret");
export const OrbContainers =
  Alchemy.Resource<OrbContainersResource>("Dx.OrbContainers");
export const E2BProfiles =
  Alchemy.Resource<E2BProfilesResource>("Dx.E2BProfiles");

export const reconcileHeldSecret = <Value>({
  output,
  value,
}: {
  output?: { value: Value };
  value?: Value;
}) => {
  if (value !== undefined) return { value };
  if (output !== undefined) return output;
  throw new Error(
    "A required deployment secret is missing on its first deployment.",
  );
};

const heldSecretProvider = () =>
  Provider.succeed(HeldSecret, {
    reconcile: ({ output, news }) =>
      Effect.try({
        try: () => reconcileHeldSecret({ output, value: news.value }),
        catch: (cause) => cause,
      }).pipe(Effect.orDie),
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  });

const e2bProfilesProvider = () =>
  Provider.succeed(E2BProfiles, {
    reconcile: ({ output, news }) => {
      const apiKey = Redacted.value(news.apiKey);
      const apiKeyHash = createHash("sha256").update(apiKey).digest("hex");
      return output?.recipeHash === news.recipeHash &&
        output.apiKeyHash === apiKeyHash
        ? Effect.succeed(output)
        : Effect.tryPromise({
            try: async () => {
              const result = await reconcileE2BProfiles({
                deploymentName: news.deploymentName,
                apiKey,
                recipeHash: news.recipeHash,
                listTemplates: async (apiKey) => {
                  const config = new ConnectionConfig({ apiKey });
                  const response = await new ApiClient(config).api.GET(
                    "/templates",
                  );
                  if (!response.data)
                    throw new Error(
                      `E2B template preflight failed (${response.response.status}). Check the API key and team plan.`,
                    );
                  return response.data;
                },
                buildTemplate: (template, name, options) =>
                  Template.build(template as never, name, options),
              });
              const selected = result.profiles.find(
                ({ id }) => id === "a1.medium",
              );
              if (selected === undefined)
                throw new Error("E2B default profile build is missing.");
              return {
                apiKeyHash,
                recipeHash: result.recipeHash,
                profilesJson: JSON.stringify(result.profiles),
                defaultTemplate: selected.template,
                defaultBuildId: selected.buildId,
              };
            },
            catch: (cause) =>
              new Error("E2B profile reconciliation failed.", { cause }),
          });
    },
    delete: () => Effect.void,
    read: ({ output }) => Effect.succeed(output),
  });

const workspaceRoot = resolve(import.meta.dirname, "../..");

const orbContainersProvider = () =>
  Provider.succeed(OrbContainers, {
    reconcile: ({ output, news }) =>
      output?.recipeHash === news.recipeHash &&
      output.workerName === news.workerName
        ? Effect.succeed(output)
        : Effect.try({
            try: () => {
              deployOrbWorker({
                workerName: news.workerName,
                workspaceRoot,
                stateDirectory: resolve(
                  workspaceRoot,
                  ".dx/alchemy/orb",
                  news.workerName,
                ),
              });
              return {
                workerName: news.workerName,
                recipeHash: news.recipeHash,
              };
            },
            catch: (cause) =>
              new Error("Orb Worker deployment failed.", { cause }),
          }),
    delete: ({ output }) =>
      Effect.tryPromise({
        try: () =>
          destroyOrbWorker({
            workerName: output.workerName,
            accountId: process.env.CLOUDFLARE_ACCOUNT_ID ?? "",
            apiToken: process.env.CLOUDFLARE_API_TOKEN ?? "",
            workspaceRoot,
          }),
        catch: (cause) => new Error("Orb Worker removal failed.", { cause }),
      }),
    read: ({ output }) => Effect.succeed(output),
  });

export const selfhostProviders = () =>
  Layer.mergeAll(
    heldSecretProvider(),
    e2bProfilesProvider(),
    orbContainersProvider(),
  );

export { e2bRecipeHash, orbRecipeHash };
