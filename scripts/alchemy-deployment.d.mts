export function bootstrapIdentity(stage: string): {
  readonly userId: string;
  readonly accountId: string;
  readonly projectId: string;
};

export function configureHostedDeploymentPolicy<T>(policy: T): Readonly<T>;

export interface BranchDeploymentCredentials {
  readonly version: 1;
  readonly target: "branch";
  readonly stage: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly accountId: string;
  readonly projectId: string;
}

export interface StagingDeploymentCredentials {
  readonly version: 1;
  readonly target: "staging";
  readonly stage: "staging";
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly accountId: string;
  readonly projectId: string;
}

export interface SharedDeploymentCredentials {
  readonly version: 2;
  readonly source: "project-reviewer-v1";
  readonly target: "branch" | "staging";
  readonly stage: string;
  readonly username: string;
  readonly email: string;
  readonly password: string;
  readonly userId: string;
  readonly accountId: string;
  readonly projectId: string;
}

export function assertBranchDeploymentCredentials(
  value: unknown,
  stage: string,
): BranchDeploymentCredentials | SharedDeploymentCredentials;

export function assertDeploymentCredentials(
  value: unknown,
  stage: string,
  target: "branch" | "staging",
):
  | BranchDeploymentCredentials
  | StagingDeploymentCredentials
  | SharedDeploymentCredentials;

export function deploymentCredentialsFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
  stage: string,
  target: "branch" | "staging",
): SharedDeploymentCredentials;

export function e2bApiKeyFromEnvironment(
  environment: Readonly<Record<string, string | undefined>>,
): string;

export function deploymentSelection(input: {
  readonly branch: string;
  readonly stage: string;
  readonly target: "branch" | "staging";
}): {
  readonly accountId: string;
  readonly branch: string;
  readonly target: "branch" | "staging";
  readonly stage: string;
  readonly domain: string;
  readonly workerName: string;
  readonly databaseName: string;
  readonly bucketName: string;
};

export function resourceName(
  kind: string,
  stage: string,
  maximumLength?: number,
): string;

/** The Cloudflare Containers Orb Worker's script name for a stage. */
export function orbWorkerName(stage: string): string;

export function abortBranchPreviewUploads(options: {
  readonly operation: string;
  readonly target: string;
  readonly bucketName: string;
  readonly s3: (method: "GET" | "DELETE", path: string) => Promise<Response>;
}): Promise<number>;

export function emptyBranchPreviewBucket(options: {
  readonly operation: string;
  readonly target: string;
  readonly accountId: string;
  readonly bucketName: string;
  readonly request: (
    method: "GET" | "DELETE",
    path: string,
    body?: readonly string[],
  ) => Promise<unknown>;
}): Promise<number>;
