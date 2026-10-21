export const ORB_CONTAINER_CLASS: "OrbContainerObject";
export const ORB_IMAGE_NAME: "orb";
export const ORB_COMPATIBILITY_DATE: string;
export const orbRecipeFiles: ReadonlyArray<string>;
export function orbRecipeHash(workspaceRoot: string): string;
export function orbDockerEnvironment(input: {
  environment?: NodeJS.ProcessEnv;
  stateDirectory: string;
}): NodeJS.ProcessEnv;
export function assertDockerReady(
  environment?: NodeJS.ProcessEnv,
  options?: { daemon?: (environment: NodeJS.ProcessEnv) => boolean },
): void;
export function retryContainerSettings<
  Result extends { status: number | null; stdout?: string; stderr?: string },
>(input: {
  deploy: () => Result;
  wait?: (milliseconds: number) => void;
  runs?: number;
  delayMilliseconds?: number;
}): Result;
export function deployOrbWorker(input: {
  workerName: string;
  workspaceRoot: string;
  stateDirectory: string;
  environment?: NodeJS.ProcessEnv;
}): { workerName: string };
export function orbWorkerExists(input: {
  workerName: string;
  accountId: string;
  apiToken: string;
  fetch?: typeof globalThis.fetch;
}): Promise<boolean>;
export function destroyOrbWorker(input: {
  workerName: string;
  accountId: string;
  apiToken: string;
  workspaceRoot: string;
  environment?: NodeJS.ProcessEnv;
  fetch?: typeof globalThis.fetch;
  run?: (args: string[]) => { status: number | null; stdout: string };
}): Promise<void>;
