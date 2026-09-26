export interface E2BProfileBuild {
  id: string;
  label: string;
  templateSuffix: string;
  resources: { cpuCores: number; memoryMb: number; diskGb: number };
  template: string;
  buildId: string;
}

export function hashE2BRecipe(input: {
  workspaceRecipe: string;
  orbRecipe: string;
  profileCatalog: unknown;
}): string;
export function e2bRecipeHash(): Promise<string>;
export function reconcileE2BProfiles(input: {
  deploymentName: string;
  apiKey: string;
  recipeHash: string;
  listTemplates(apiKey: string): Promise<unknown[]>;
  buildTemplate(
    template: unknown,
    name: string,
    options: { apiKey: string; cpuCount: number; memoryMB: number },
  ): Promise<{ name: string; buildId: string }>;
}): Promise<{
  recipeHash: string;
  base: { name: string; buildId: string };
  profiles: E2BProfileBuild[];
}>;
