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

const exactReadyBuild = (templates, name) => {
  const matches = templates.filter((template) =>
    template.names?.includes(name),
  );
  if (matches.length > 1)
    throw new Error(`E2B returned more than one template named ${name}.`);
  if (matches.length === 0) return undefined;
  const [match] = matches;
  if (match.buildStatus !== "ready" || !match.buildID)
    throw new Error(
      `E2B template ${name} exists but has no immutable ready build.`,
    );
  return { name, buildId: match.buildID };
};

export const reconcileE2BProfiles = async ({
  deploymentName,
  apiKey,
  listTemplates,
  buildTemplate,
  recipeHash,
}) => {
  const prefix = `dx-${deploymentName}-${recipeHash.slice(0, 16)}`;
  let templates = await listTemplates(apiKey);
  let base = exactReadyBuild(templates, `${prefix}-base`);
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
    let build = exactReadyBuild(templates, name);
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
