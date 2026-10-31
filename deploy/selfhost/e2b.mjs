import { createHash } from "node:crypto";
import { Template } from "e2b";
import profiles from "../../packages/domain/e2b-orb-profiles.json" with {
  type: "json",
};
import { dxOrbTemplate, dxWorkspaceTemplate } from "../e2b/template.mjs";

export const hashE2BRecipe = ({ workspaceRecipe, orbRecipe, profileCatalog }) =>
  createHash("sha256")
    .update(workspaceRecipe)
    .update("\0")
    .update(orbRecipe)
    .update("\0")
    .update(JSON.stringify(profileCatalog))
    .digest("hex");

export const e2bRecipeHash = async () =>
  hashE2BRecipe({
    workspaceRecipe: await Template.toJSON(dxWorkspaceTemplate, true),
    orbRecipe: await Template.toJSON(
      dxOrbTemplate("dx-recipe-base:immutable-build"),
      true,
    ),
    profileCatalog: profiles,
  });

const BUILDING = new Set(["building", "waiting"]);

/**
 * The template's ready build, or undefined when there is none. E2B lists a
 * team's template as `team/name`, with the bare name as an alias.
 */
const exactReadyBuild = (templates, name) => {
  const matches = templates.filter(
    (template) =>
      template.names?.includes(name) ||
      template.aliases?.includes(name) ||
      template.names?.some((full) => full.endsWith(`/${name}`)),
  );
  if (matches.length > 1)
    throw new Error(`E2B returned more than one template named ${name}.`);
  if (matches.length === 0) return undefined;
  const [match] = matches;
  if (BUILDING.has(match.buildStatus)) return { name, building: true };
  if (match.buildStatus !== "ready" || !match.buildID)
    throw new Error(
      `E2B template ${name} exists but has no immutable ready build.`,
    );
  return { name, buildId: match.buildID };
};

/**
 * Another deployment of the same E2B team (a parallel branch preview) may be
 * building a template this one needs; wait for its build instead of
 * starting a second one.
 */
const settledBuild = async (
  listTemplates,
  apiKey,
  templates,
  name,
  { pollMs, timeoutMs },
) => {
  const deadline = Date.now() + timeoutMs;
  let build = exactReadyBuild(templates, name);
  while (build?.building) {
    if (Date.now() > deadline)
      throw new Error(`E2B is still building ${name}; deploy again later.`);
    await new Promise((resolve) => setTimeout(resolve, pollMs));
    build = exactReadyBuild(await listTemplates(apiKey), name);
  }
  return build;
};

export const reconcileE2BProfiles = async ({
  deploymentName,
  apiKey,
  listTemplates,
  buildTemplate,
  recipeHash,
  wait = { pollMs: 15_000, timeoutMs: 45 * 60_000 },
}) => {
  const prefix = `dx-${deploymentName}-${recipeHash.slice(0, 16)}`;
  let templates = await listTemplates(apiKey);
  let base = await settledBuild(
    listTemplates,
    apiKey,
    templates,
    `${prefix}-base`,
    wait,
  );
  if (base === undefined) {
    try {
      base = await buildTemplate(dxWorkspaceTemplate, `${prefix}-base`, {
        apiKey,
        cpuCount: 2,
        memoryMB: 4096,
      });
    } catch (cause) {
      throw new Error(
        "E2B could not build the base template (2 vCPU, 4096 MB). Confirm that the E2B team plan permits this template size and four immutable builds.",
        { cause },
      );
    }
    templates = await listTemplates(apiKey);
  }
  const result = [];
  for (const profile of profiles) {
    const name = `${prefix}-${profile.templateSuffix}`;
    let build = await settledBuild(
      listTemplates,
      apiKey,
      templates,
      name,
      wait,
    );
    if (build === undefined) {
      try {
        build = await buildTemplate(
          dxOrbTemplate(`${base.name}:${base.buildId}`),
          name,
          {
            apiKey,
            cpuCount: profile.resources.cpuCores,
            memoryMB: profile.resources.memoryMb,
          },
        );
      } catch (cause) {
        throw new Error(
          `E2B could not build ${profile.id} (${profile.resources.cpuCores} vCPU, ${profile.resources.memoryMb} MB). Confirm that the E2B team plan permits this template size and three immutable profile builds.`,
          { cause },
        );
      }
    }
    result.push({ ...profile, template: build.name, buildId: build.buildId });
  }
  return Object.freeze({ recipeHash, base, profiles: result });
};
