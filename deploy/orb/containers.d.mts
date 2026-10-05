export const ORB_CONTAINER_CLASS: "OrbContainerObject";
export const ORB_IMAGE_NAME: "orb";
export const ORB_COMPATIBILITY_DATE: string;
export const orbRecipeFiles: ReadonlyArray<string>;
export function orbRecipeHash(workspaceRoot: string): string;
export function orbWorkerConfig(input: {
  workerName: string;
  workspaceRoot: string;
}): Record<string, unknown>;
export function assertDockerAvailable(environment?: NodeJS.ProcessEnv): void;
export function deployOrbWorker(input: {
  workerName: string;
  workspaceRoot: string;
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
}): { workerName: string };
export function destroyOrbWorker(input: {
  workerName: string;
  accountId: string;
  apiToken: string;
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  run?: (args: string[]) => { status: number | null; stdout: string };
}): Promise<void>;
