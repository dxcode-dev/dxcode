import type {
  ThreadChangedFile,
  ThreadChangesCaptureId,
  ThreadChangesCommitSha,
  ThreadChangesData,
  ThreadChangesPath,
  ThreadChangesRange,
  ThreadChangesWorktree,
  ThreadChangesWorktreeId,
  ThreadFilesPath,
  ThreadFileTreeData,
  ThreadFileVersion,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import type { ChangesTransport } from "../features/threads/changes/changes-api.js";
import type { ThreadFilesApi } from "../features/threads/files/files-api.js";

/**
 * A Thread workspace with several checkouts, for the Files and Changes
 * stories: the Project's repository, then repositories and worktrees under
 * ~/workspace/repos, each with its own files and changes.
 */
export const checkoutsThreadId =
  "thr_00000000-0000-4000-8000-00000000c0de" as ThreadId;

const captureId =
  "chg_00000000-0000-4000-8000-00000000c0de" as ThreadChangesCaptureId;
const version = `sha256:${"c".repeat(64)}` as ThreadFileVersion;
const sha = (seed: string) =>
  seed.repeat(40).slice(0, 40) as ThreadChangesCommitSha;

/** One checkout: its tab, the files at its root, and what changed. */
export interface FixtureCheckout {
  readonly name: string;
  readonly kind: "primary" | "repository" | "worktree";
  readonly branch: string | null;
  readonly tree: ReadonlyArray<string>;
  readonly changes: ReadonlyArray<
    Pick<ThreadChangedFile, "path" | "status" | "additions" | "deletions">
  >;
}

export type CheckoutsScenario =
  | "single"
  | "several"
  | "worktree"
  | "empty"
  | "many"
  | "long-names";

const app: FixtureCheckout = {
  name: "dx",
  kind: "primary",
  branch: "main",
  tree: ["apps/", "packages/", "AGENTS.md", "README.md", "package.json"],
  changes: [
    {
      path: "apps/web/src/features/threads/files/files-panel.tsx" as ThreadChangesPath,
      status: "modified",
      additions: 42,
      deletions: 18,
    },
    {
      path: "apps/web/src/shared/ui/repository-tabs.tsx" as ThreadChangesPath,
      status: "added",
      additions: 96,
      deletions: 0,
    },
  ],
};

const api: FixtureCheckout = {
  name: "api",
  kind: "repository",
  branch: "main",
  tree: ["src/", "migrations/", "Cargo.toml", "README.md"],
  changes: [
    {
      path: "src/routes/projects.rs" as ThreadChangesPath,
      status: "modified",
      additions: 12,
      deletions: 3,
    },
    {
      path: "migrations/0042_project_repos.sql" as ThreadChangesPath,
      status: "untracked",
      additions: 9,
      deletions: 0,
    },
    {
      path: "src/routes/legacy.rs" as ThreadChangesPath,
      status: "deleted",
      additions: 0,
      deletions: 57,
    },
  ],
};

const docs: FixtureCheckout = {
  name: "docs",
  kind: "repository",
  branch: "main",
  tree: ["content/", "astro.config.mjs", "README.md"],
  changes: [],
};

const featureWorktree: FixtureCheckout = {
  name: "dx-login-redesign",
  kind: "worktree",
  branch: "login-redesign",
  tree: ["apps/", "packages/", "AGENTS.md", "README.md", "package.json"],
  changes: [
    {
      path: "apps/web/src/features/authentication/sign-in.tsx" as ThreadChangesPath,
      status: "modified",
      additions: 31,
      deletions: 22,
    },
  ],
};

const emptyRepository: FixtureCheckout = {
  name: "scratch",
  kind: "repository",
  branch: "main",
  tree: [],
  changes: [],
};

const many: ReadonlyArray<FixtureCheckout> = [
  app,
  api,
  docs,
  featureWorktree,
  ...[
    "billing",
    "mobile",
    "infra",
    "design-tokens",
    "sdk-python",
    "sdk-node",
    "status-page",
  ].map(
    (name, index): FixtureCheckout => ({
      name,
      kind: "repository",
      branch: "main",
      tree: ["src/", "README.md"],
      changes:
        index % 2 === 0
          ? [
              {
                path: "src/index.ts" as ThreadChangesPath,
                status: "modified",
                additions: index + 1,
                deletions: 1,
              },
            ]
          : [],
    }),
  ),
  {
    name: "dx-hotfix-sessions",
    kind: "worktree",
    branch: "hotfix/sessions",
    tree: ["apps/", "README.md"],
    changes: [],
  },
];

const longNames: ReadonlyArray<FixtureCheckout> = [
  { ...app, name: "launch-readiness-platform-monorepo" },
  {
    ...api,
    name: "acme-internal-billing-and-invoicing-service-api",
    branch: "feature/very-long-branch-name-for-invoice-reconciliation",
  },
  {
    ...featureWorktree,
    name: "launch-readiness-platform-monorepo-onboarding-flow",
    branch: "onboarding/first-run-checklist-with-guided-project-setup",
  },
];

export const checkoutsScenarios: Record<
  CheckoutsScenario,
  ReadonlyArray<FixtureCheckout>
> = {
  single: [app],
  several: [app, api, docs],
  worktree: [app, featureWorktree],
  empty: [app, docs, emptyRepository],
  many,
  "long-names": longNames,
};

const idOf = (checkout: FixtureCheckout, index: number) =>
  (checkout.kind === "primary"
    ? "primary"
    : `wt_${(index + 1).toString(16).padStart(16, "0")}`) as ThreadChangesWorktreeId;

const worktreesOf = (
  checkouts: ReadonlyArray<FixtureCheckout>,
): Array<ThreadChangesWorktree> =>
  checkouts.map((checkout, index) => ({
    id: idOf(checkout, index),
    name: checkout.name,
    head: sha(String((index % 9) + 1)),
    branch: checkout.branch,
    kind: checkout.kind,
  }));

const filesOf = (checkouts: ReadonlyArray<FixtureCheckout>) =>
  checkouts.flatMap((checkout, index) =>
    checkout.changes.map(
      (change): ThreadChangedFile => ({
        ...change,
        worktree: idOf(checkout, index),
        binary: false,
        truncated: false,
      }),
    ),
  );

const changesOf = (
  checkouts: ReadonlyArray<FixtureCheckout>,
  range: ThreadChangesRange,
): ThreadChangesData => {
  const files = filesOf(checkouts);
  return {
    kind: "changes",
    captureId,
    freshness: "complete",
    capturedAt: "2026-11-20T09:30:00.000Z",
    range,
    truncated: false,
    baseline: sha("a"),
    head: sha("1"),
    branch: checkouts[0]?.branch ?? "main",
    upstreamLabel: "origin/main",
    ahead: 1,
    summary: {
      additions: files.reduce((total, file) => total + file.additions, 0),
      deletions: files.reduce((total, file) => total + file.deletions, 0),
      files: files.length,
    },
    files,
    commits: [
      { sha: sha("1"), shortSha: "1111111", subject: "Show checkouts as tabs" },
    ],
    // One checkout is how a capture without repositories looks.
    ...(checkouts.length > 1 ? { worktrees: worktreesOf(checkouts) } : {}),
  };
};

const patchFor = (file: ThreadChangedFile) =>
  file.status === "deleted"
    ? `@@ -1,3 +0,0 @@\n-// ${file.path}\n-export const legacy = true;\n-export default legacy;\n`
    : file.status === "modified"
      ? `@@ -1,3 +1,3 @@\n // ${file.path}\n-export const shown = "stacked";\n+export const shown = "tabs";\n export default shown;\n`
      : `@@ -0,0 +1,2 @@\n+// ${file.path}\n+export const added = true;\n`;

/** How the transports answer: with data, never, or with an error. */
export type FixtureState = "ready" | "loading" | "error";

const never = <T>() => new Promise<T>(() => undefined);
const unavailable = () =>
  Promise.reject(new Error("The workspace is waking up. Try again shortly."));

/** The Changes transport for a scenario. */
export const checkoutsChangesTransport = (
  scenario: CheckoutsScenario,
  state: FixtureState = "ready",
): ChangesTransport => {
  const checkouts = checkoutsScenarios[scenario];
  return {
    getChanges: async (_thread, range) =>
      state === "loading"
        ? never()
        : state === "error"
          ? unavailable()
          : changesOf(checkouts, range),
    getDiff: async (_thread, path, range, requestedCapture, _signal, tree) => {
      const file = filesOf(checkouts).find(
        (candidate) =>
          candidate.path === path &&
          (candidate.worktree ?? "primary") === (tree ?? "primary"),
      );
      if (file === undefined) throw new Error("No such changed file.");
      return {
        kind: "diff",
        captureId: requestedCapture,
        freshness: "complete",
        capturedAt: "2026-11-20T09:30:00.000Z",
        range,
        file,
        patch: patchFor(file),
      };
    },
    push: async () => never(),
  };
};

/** The Files transport for a scenario: each checkout's own tree. */
export const checkoutsFilesTransport = (
  scenario: CheckoutsScenario,
  state: FixtureState = "ready",
): ThreadFilesApi => {
  const checkouts = checkoutsScenarios[scenario];
  return {
    list: async (_thread, path, _cursor, tree) => {
      if (state === "loading") return never();
      if (state === "error") return unavailable();
      const index = checkouts.findIndex(
        (checkout, position) =>
          idOf(checkout, position) === (tree ?? "primary"),
      );
      const checkout = checkouts[index];
      const names =
        path === undefined
          ? (checkout?.tree ?? [])
          : ["index.ts", "routes.ts", "README.md"];
      const data: ThreadFileTreeData = {
        kind: "tree",
        version,
        ...(path === undefined ? {} : { path }),
        entries: names.map((name) => {
          const directory = name.endsWith("/");
          const base = directory ? name.slice(0, -1) : name;
          const full = (
            path === undefined ? base : `${path}/${base}`
          ) as ThreadFilesPath;
          return directory
            ? { path: full, name: base, kind: "directory" as const }
            : { path: full, name: base, kind: "file" as const, sizeBytes: 640 };
        }),
      };
      return data;
    },
    read: async () => never(),
    save: async () => never(),
  };
};
