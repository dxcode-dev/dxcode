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
