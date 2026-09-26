import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { inspectWebArchitecture } from "./check-web-architecture.mjs";

const temporaryRoot = mkdtempSync(join(tmpdir(), "dx-web-architecture-"));

const write = (sourceRoot, path, source) => {
  const target = join(sourceRoot, path);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, source);
};

let fixtureIndex = 0;
const fixture = (rule, path, source, supporting = {}) => {
  const displayRoot = join(temporaryRoot, `${fixtureIndex}-${rule}`);
  fixtureIndex += 1;
  const sourceRoot = join(displayRoot, "apps/web/src");
  write(sourceRoot, path, source);
  for (const [supportPath, supportSource] of Object.entries(supporting))
    write(sourceRoot, supportPath, supportSource);
  const violations = inspectWebArchitecture({ sourceRoot, displayRoot });
  const matching = violations.filter((violation) => violation.rule === rule);
  assert(matching.length > 0, `${rule} must fail`);
  assert(matching[0].message.length > 40, `${rule} needs actionable guidance`);
};

try {
  fixture(
    "browser-persistence-ownership",
    "shared/draft-store.ts",
    `export const draft = localStorage.getItem("draft");`,
  );
  fixture(
    "feature-import-boundary",
    "features/projects/project-card.tsx",
    `import { ThreadWorkspace } from "../threads/thread-workspace.js"; export const ProjectCard = ThreadWorkspace;`,
    {
      "features/threads/thread-workspace.tsx": `export const ThreadWorkspace = () => null;`,
    },
  );
  fixture(
    "feature-data-imperative-api",
    "features/projects/project-queries.ts",
    `export const fetchProject = (client) => client.fetchQuery({ queryKey: ["project"] });`,
  );
  fixture(
    "feature-data-imperative-api",
    "shared/project-action.ts",
    `export const projectAction = (request: () => Promise<unknown>) => ({ mutationFn: request });`,
  );
  fixture(
    "feature-data-raw-api-export",
    "features/projects/project-queries.ts",
    `export { getProject } from "../../shared/api/client.js";`,
  );
  fixture(
    "feature-data-raw-api-export",
    "shared/project-helper.ts",
    `export { getProject } from "./api/client.js";`,
    {
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "feature-data-raw-api-export",
    "shared/project-helper.ts",
    `export * from "./api/client.js";`,
    {
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "feature-data-raw-api-export",
    "features/projects/project-queries.ts",
    `import * as api from "../../shared/api/client.js"; export { api };`,
    {
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "no-component-dx-api",
    "features/projects/project-card.tsx",
    `import { getProject } from "../../shared/api/client.js"; export const ProjectCard = () => getProject("id");`,
  );
  fixture(
    "no-component-dx-api",
    "shared/ui/project-card.tsx",
    `import { getProject } from "../api/client.js"; export const ProjectCard = () => getProject("id");`,
    {
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "no-component-dx-api",
    "app.tsx",
    `import { getProject } from "./shared/api/client.js"; export const App = () => getProject("id");`,
    {
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "no-component-dx-api",
    "shared/project-helper.ts",
    `import { getProject } from "./api/client.js"; export const loadProject = (id) => getProject(id);`,
    {
      "features/projects/project-card.tsx": `import { loadProject } from "../../shared/project-helper.js"; export const ProjectCard = () => loadProject("id");`,
      "shared/api/client.ts": `export const getProject = (id) => id;`,
    },
  );
  fixture(
    "no-component-fetch",
    "features/projects/project-card.tsx",
    `export const ProjectCard = () => { void fetch("/v1/projects"); return null; };`,
  );
  fixture(
    "no-component-fetch",
    "app.tsx",
    `export const App = () => { void fetch("/v1/projects"); return null; };`,
  );
  fixture(
    "no-component-fetch",
    "shared/project-helper.ts",
    `export const loadProject = () => fetch("/v1/projects");`,
  );
  fixture(
    "no-component-fetch",
    "shared/project-helper.ts",
    `const request = fetch; export const loadProject = () => request("/v1/projects");`,
  );
  fixture(
    "no-component-fetch",
    "shared/project-helper.ts",
    `const fetch = globalThis.fetch; export const loadProject = () => fetch("/v1/projects");`,
  );
  fixture(
    "no-component-fetch",
    "shared/project-helper.ts",
    `export const loadProject = () => globalThis.fetch("/v1/projects");`,
  );
  fixture(
    "no-component-browser-storage",
    "features/projects/project-card.tsx",
    `export const ProjectCard = () => { localStorage.setItem("draft", "secret"); return null; };`,
  );
  fixture(
    "no-component-query-client",
    "features/projects/project-card.tsx",
    `import { QueryClient } from "@tanstack/react-query"; export const ProjectCard = () => { void new QueryClient(); return null; };`,
  );
  fixture(
    "no-component-query-client",
    "shared/ui/project-card.tsx",
    `import { queryClient } from "../query/query-client.js"; export const ProjectCard = () => String(queryClient);`,
    {
      "shared/query/query-client.ts": `export const queryClient = {};`,
    },
  );
  fixture(
    "no-component-query-client",
    "shared/query-client-helper.ts",
    `export { queryClient } from "./query/query-client.js";`,
    {
      "shared/query/query-client.ts": `export const queryClient = {};`,
    },
  );
  fixture(
    "no-component-query-client",
    "shared/query-client-helper.ts",
    `import { queryClient } from "./query/query-client.js"; export { queryClient };`,
    {
      "shared/query/query-client.ts": `export const queryClient = {};`,
    },
  );
  fixture(
    "no-component-use-effect",
    "features/projects/project-card.tsx",
    `import * as React from "react"; export const ProjectCard = () => { React.useEffect(() => {}, []); return null; };`,
  );
  fixture(
    "no-component-use-effect",
    "shared/ui/project-card.tsx",
    `import * as React from "react"; export const ProjectCard = () => { React.useEffect(() => {}, []); return null; };`,
  );
  fixture(
    "no-global-client-store",
    "features/projects/project-store.ts",
    `import { Store } from "@tanstack/react-store"; export const store = new Store({});`,
  );
  fixture(
    "no-use-async-data",
    "features/projects/project-card.tsx",
    `import { useAsyncData } from "../../shared/hooks/use-async-data.js"; export const ProjectCard = () => useAsyncData(async () => ({}));`,
  );
  fixture(
    "query-definition-ownership",
    "features/projects/project-loader.ts",
    `import { queryOptions } from "@tanstack/react-query"; export const options = queryOptions({ queryKey: ["projects"], queryFn: async () => ({}) });`,
  );
  fixture(
    "query-definition-ownership",
    "shared/project-loader.ts",
    `import * as Query from "@tanstack/react-query"; export const options = Query.queryOptions({ queryKey: ["projects"], queryFn: async () => ({}) });`,
  );
  fixture(
    "query-definition-ownership",
    "shared/project-action.ts",
    `import * as Query from "@tanstack/react-query"; export const options = Query.mutationOptions({ mutationFn: async () => ({}) });`,
  );
  fixture(
    "query-module-component-dependency",
    "features/projects/project-queries.ts",
    `import { ProjectCard } from "./project-card.js"; export const invalid = ProjectCard;`,
    {
      "features/projects/project-card.tsx": `export const ProjectCard = () => null;`,
    },
  );
  fixture(
    "server-state-client-store",
    "features/projects/project-store.ts",
    `import { Store } from "@tanstack/react-store"; import { useQuery } from "@tanstack/react-query"; export const store = new Store({ useQuery });`,
  );
  fixture(
    "shared-import-boundary",
    "shared/project-helper.ts",
    `import { ProjectCard } from "../features/projects/project-card.js"; export const helper = ProjectCard;`,
    {
      "features/projects/project-card.tsx": `export const ProjectCard = () => null;`,
    },
  );

  const validRoot = join(temporaryRoot, "valid/apps/web/src");
  write(
    validRoot,
    "features/projects/project-queries.ts",
    `
import { infiniteQueryOptions, queryOptions } from "@tanstack/react-query";
import { getProject, listProjects } from "../../shared/api/client.js";
export const projectKeys = {
  all: (userId) => ["projects", userId],
  detail: (userId, scope, projectId) => ["projects", userId, scope, "detail", projectId],
};
export const projectOptions = (userId, scope, projectId) => queryOptions({
  queryKey: projectKeys.detail(userId, scope, projectId),
  queryFn: ({ signal }) => getProject(projectId, signal),
  staleTime: 30_000,
});
export const projectsOptions = (userId, scope) => infiniteQueryOptions({
  queryKey: [...projectKeys.all(userId), scope, "list"],
  queryFn: ({ pageParam, signal }) => listProjects(scope, pageParam, signal),
  initialPageParam: undefined,
  getNextPageParam: (page) => page.nextCursor,
  staleTime: 30_000,
});
`,
  );
  write(
    validRoot,
    "features/projects/project-mutations.ts",
    `
import { mutationOptions } from "@tanstack/react-query";
import { updateProject } from "../../shared/api/client.js";
export const updateProjectOptions = (queryClient, userId, scope, projectId) => mutationOptions({
  mutationKey: ["projects", userId, scope, "detail", projectId, "update"],
  mutationFn: (input) => updateProject(projectId, input),
  onSuccess: (project) => queryClient.setQueryData(["projects", userId, scope, "detail", projectId], project),
});
`,
  );
  write(
    validRoot,
    "features/projects/project-card.tsx",
    `import { useQuery } from "@tanstack/react-query"; import { projectOptions } from "./project-queries.js"; export const ProjectCard = ({ userId, scope, projectId }) => useQuery(projectOptions(userId, scope, projectId)).data;`,
  );
  write(
    validRoot,
    "shared/api/client.ts",
    `export const request = (path) => fetch(path); export const getProject = request; export const listProjects = request; export const updateProject = request; export class ApiError extends Error {}`,
  );
  write(
    validRoot,
    "shared/auth/auth-client.ts",
    `export const exchangeAccessIdentity = () => fetch("/api/auth/access/exchange");`,
  );
  write(
    validRoot,
    "shared/same-origin-fetch.ts",
    `export const sameOriginFetch = (input, init) => fetch(input, { ...init, credentials: "same-origin" });`,
  );
  write(
    validRoot,
    "shared/query/query-client.ts",
    `import { QueryClient } from "@tanstack/react-query"; export const queryClient = new QueryClient();`,
  );
  write(
    validRoot,
    "main.tsx",
    `import { queryClient } from "./shared/query/query-client.js"; export const Root = () => String(queryClient);`,
  );
  write(
    validRoot,
    "shared/auth/auth-gate.tsx",
    `import { queryClient } from "../query/query-client.js"; export const AuthGate = () => String(queryClient);`,
  );
  write(
    validRoot,
    "shared/cache.ts",
    `
const cache = { fetch: (key) => key };
const fetch = (key) => key;
export const cached = cache.fetch("project");
export const local = fetch("project");
export const text = "fetch('/not-a-request')";
// fetch("/not-a-request");
`,
  );
  assert.deepEqual(
    inspectWebArchitecture({
      sourceRoot: validRoot,
      displayRoot: join(temporaryRoot, "valid"),
    }),
    [],
    "Feature-owned Query reads and mutations must remain valid",
  );
  const selectiveInvalid = join(validRoot, "shared/selective-invalid.ts");
  writeFileSync(selectiveInvalid, 'export const request = () => fetch("/v1");');
  assert.deepEqual(
    inspectWebArchitecture({
      sourceRoot: validRoot,
      displayRoot: join(temporaryRoot, "valid"),
      sourceFiles: [join(validRoot, "shared/cache.ts")],
    }),
    [],
    "Changed-file inspection must not report untouched baseline violations",
  );
  assert.equal(
    inspectWebArchitecture({
      sourceRoot: validRoot,
      displayRoot: join(temporaryRoot, "valid"),
      sourceFiles: [selectiveInvalid],
    })[0]?.rule,
    "no-component-fetch",
    "Changed-file inspection must retain architecture enforcement",
  );
  console.log(
    "Frontend architecture fixtures prove every rule and valid Query ownership.",
  );
} finally {
  rmSync(temporaryRoot, { recursive: true, force: true });
}
