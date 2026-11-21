/**
 * Answers the New Thread composer's routes from memory, for Storybook: what
 * it reads as it opens (settings, remembered choices, Projects, models, Orbs,
 * plugins, the draft) and the create it sends. Every create lands in `sent`
 * with its path and body, so a story can check what the composer asked for.
 */

export interface SentCreate {
  readonly path: string;
  readonly body: {
    readonly projectId?: string;
    readonly title?: string;
    readonly threadId?: string;
    readonly visibility?: string;
    readonly initialMessage?: { readonly body: string };
  };
}

export interface ComposerFixtureOptions {
  /** The person is in a workspace: the composer offers sharing and `@`. */
  readonly workspace?: boolean;
  /** No Orb can start, so the composer asks to set one up. */
  readonly noOrb?: boolean;
  /** Creates never answer: the composer stays sending. */
  readonly hangCreate?: boolean;
  /**
   * Where every Project's Orb setup stands: `configured` (the default) has a
   * setup script, `missing` has none and the person may add one, `read-only`
   * has none and only its creator or an admin may, `checking` never answers,
   * and `mixed` sets up only the first Project.
   */
  readonly projectSetup?:
    | "configured"
    | "missing"
    | "read-only"
    | "checking"
    | "mixed";
}

/** The Projects the composer lists, as the Mail fixture names them. */
export const composerProjectId = (n: number) =>
  `prj_00000000-0000-4000-8000-${String(n).padStart(12, "0")}`;

const WORKSPACE = {
  id: "00000000-0000-4000-8000-00000000a11e",
  displayName: "Acme",
  shortName: "acme",
  lifecycleState: "active",
  revision: 0,
  role: "owner",
};

const CONNECTION = "mcon_00000000-0000-4000-8000-0000000000a1";

const MODES = [
  ["low", "anthropic/claude-haiku-5-5", "Claude Haiku 5.5", "medium"],
  ["medium", "anthropic/claude-sonnet-5-5", "Claude Sonnet 5.5", "high"],
  ["high", "anthropic/claude-opus-5-5", "Claude Opus 5.5", "high"],
  ["ultra", "anthropic/claude-fable-5-2", "Claude Fable 5.2", "high"],
] as const;

const choices = {
  modes: MODES.map(([mode, model, modelName, thinking]) => ({
    mode,
    config: { model, thinking },
    modelName,
    source: "default",
    served: true,
    servingConnectionName: "Anthropic",
  })),
  models: MODES.map(([, canonical, name]) => ({
    canonical,
    name,
    connectionId: CONNECTION,
    connectionName: "Anthropic",
    connectionKind: "provider",
    connectionProviderId: "anthropic",
    connectionScope: "personal",
    contextWindow: 200_000,
    reasoning: true,
    vision: true,
  })),
  claudePlans: [],
};

const graph = {
  modes: choices.modes.map(({ servingConnectionName: _, ...mode }) => mode),
  connections: [
    {
      connectionId: CONNECTION,
      name: "Anthropic",
      kind: "provider",
      scope: "personal",
      priority: 0,
      enabled: true,
    },
  ],
  edges: MODES.map(([mode, model]) => ({
    mode,
    model,
    connectionId: CONNECTION,
  })),
};

const SIZE = {
  id: "cf.standard-1",
  label: "standard-1",
  resources: { cpuCores: 1, memoryMb: 4096, diskGb: 8 },
};

const projectDefaults = (workspace: boolean) => ({
  scope: workspace ? "workspace" : "personal",
  revision: 0,
  overrides: {
    shipAction: null,
    commitAuthor: null,
    signingPreference: null,
    runnerProfileId: null,
    dxCoAuthor: null,
  },
  resolved: {
    shipAction: { value: "ship", source: "deployment" },
    commitAuthor: { value: "dx", source: "deployment" },
    signingPreference: { value: "disabled", source: "deployment" },
    runnerProfileId: { value: SIZE.id, source: "deployment" },
    dxCoAuthor: { value: true, source: "deployment" },
  },
  catalog: {
    version: 1,
    defaultProfileId: SIZE.id,
    profiles: [
      {
        ...SIZE,
        isolation: "container",
        availability: "available",
        costLabel: "Cloudflare Containers",
        capabilities: ["git", "environment-variables", "persistent-workspace"],
        adapter: "cloudflare",
      },
    ],
    adapterStates: [{ kind: "cloudflare", state: "available" }],
    providers: [
      {
        adapter: "cloudflare",
        displayName: "Cloudflare Containers",
        shortName: "Cloudflare",
        pauseResume: "filesystem",
      },
    ],
  },
  restrictions: {
    allowProjectCreation: true,
    allowPublicCodeAccess: false,
    allowedRunnerProfileIds: null,
    source: "workspace",
  },
  canUpdate: true,
});

const orbProviders = (noOrb: boolean) => ({
  scope: "personal",
  canUpdate: true,
  localRuntime: false,
  providers: [
    {
      id: "cloudflare",
      displayName: "Cloudflare Containers",
      description: "Runs Orbs on this deployment's own account.",
      fields: [],
      sizes: [SIZE],
      pauseResume: "filesystem",
      deployment: true,
      connection: null,
      workspaceConnection: null,
    },
  ],
  personalKeysOnWorkspaceProjects: null,
  resolved: noOrb
    ? []
    : [
        {
          providerId: "cloudflare",
          scope: "deployment",
          account: null,
          status: "ready",
          unavailableSizes: [],
        },
      ],
});

const MEMBERS = [
  ["usr_story", "Alex Rivera", "alex", "owner"],
  ["usr_00000000-0000-4000-8000-0000000000b1", "Priya Shah", "priya", "member"],
  ["usr_00000000-0000-4000-8000-0000000000b2", "Ben Ortiz", "ben", "member"],
].map(([userId, name, handle, role]) => ({
  userId,
  email: `${handle}@acme.example`,
  name,
  role,
  joinedAt: "2026-08-25T00:00:00.000Z",
  lastActiveAt: "2026-11-19T00:00:00.000Z",
  handle,
}));

export const composerProjectData = (id: string, name: string) => ({
  id,
  name,
  viewerAccess: { canManage: true, threads: { status: "available" } },
  configuration: {
    shipAction: "ship",
    commitAuthor: { preference: "dx", name: "dx", email: "noreply@dx.local" },
    signingPreference: "disabled",
    runnerProfileId: SIZE.id,
    publicCodeEnabled: false,
    dxCoAuthor: true,
  },
  revision: 0,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
});

const threadDetail = (body: SentCreate["body"]) => ({
  id: body.threadId,
  title: body.title,
  // A No Project Thread gets a Project of its own.
  projectId: body.projectId ?? composerProjectId(99),
  visibility: body.visibility ?? "private",
  lifecycleState: "active",
  activityStatus: "working",
  createdAt: "2026-11-20T09:00:00.000Z",
  updatedAt: "2026-11-20T09:00:00.000Z",
  lastActivityAt: "2026-11-20T09:00:00.000Z",
  agentUrl: `/v1/agents/dx/${body.threadId}`,
  executionWorkspace: { ready: false, preparationStatus: null },
  agentInitialization: {
    personalInstructions: "",
    settingsRevision: 0,
    settingsVersion: 1,
    selection: { kind: "mode", profileId: "default", mode: "medium" },
    mcpConnections: [],
    plugins: [],
    skills: [],
  },
});

const ok = (data: unknown) =>
  Response.json({ status: "success", data }, { status: 200 });

const never = () => new Promise<Response>(() => {});

const isCreate = (path: string) =>
  path === "/v1/threads" ||
  /^\/v1\/mailbox\/messages\/[^/]+\/start-thread$/.test(path);

/** Installs the routes; `restore` puts the page's fetch back. */
export const installComposerApi = (options: ComposerFixtureOptions = {}) => {
  const sent: SentCreate[] = [];
  const workspace = options.workspace === true;
  const original = window.fetch;
  let draft = "";
  const files = new Map<string, Record<string, unknown>>();
  const handle = async (
    url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const path = url.pathname;
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    if (method === "POST" && isCreate(path)) {
      sent.push({ path, body });
      if (options.hangCreate) return never();
      return Response.json(
        {
          status: "success",
          data: threadDetail(body),
          initialSubmission: { submissionId: `sub_${sent.length}` },
        },
        { status: 201 },
      );
    }
    // Files upload in no parts, so nothing leaves the page.
    if (path === "/v1/attachments" && method === "POST") {
      const id = `att_${(files.size + 1).toString(16).padStart(32, "0")}`;
      files.set(id, { ...body, id, url: `/story-files/${id}` });
      return Response.json({
        id,
        partSize: 5_242_880,
        partCount: 0,
        parts: [],
      });
    }
    const completed = /^\/v1\/attachments\/([^/]+)\/complete$/.exec(path);
    if (completed !== null)
      return Response.json(files.get(completed[1] as string));
    if (path === "/v1/settings/personal")
      return ok({
        activeScope: "personal",
        ...(workspace ? { workspace: WORKSPACE } : {}),
        dictationAvailable: false,
      });
    if (path === "/v1/settings/personal/account/composer")
      return ok({
        project: null,
        mode: null,
        model: null,
        runnerProfileId: null,
        autosaveFiles: false,
      });
    if (path === "/v1/projects")
      return ok({
        items: [
          composerProjectData(composerProjectId(1), "dx web"),
          composerProjectData(composerProjectId(2), "dx api"),
          composerProjectData(composerProjectId(3), "docs"),
        ],
      });
    if (
      path === "/v1/settings/personal/projects" ||
      path === `/v1/settings/workspaces/${WORKSPACE.shortName}/projects`
    )
      return ok(projectDefaults(path !== "/v1/settings/personal/projects"));
    const orbScripts = /^\/v1\/projects\/([^/]+)\/orb-scripts$/.exec(path);
    if (orbScripts !== null) {
      const chosen = options.projectSetup ?? "configured";
      const setup =
        chosen !== "mixed"
          ? chosen
          : decodeURIComponent(orbScripts[1] as string) === composerProjectId(1)
            ? "configured"
            : "missing";
      if (setup === "checking") return never();
      return ok({
        canManage: setup !== "read-only",
        scripts:
          setup === "configured"
            ? [
                {
                  kind: "setup",
                  body: "#!/usr/bin/env bash\nset -euo pipefail\npnpm install --frozen-lockfile\n",
                  updatedAt: "2026-11-20T10:00:00.000Z",
                },
              ]
            : [],
      });
    }
    if (path === "/v1/settings/personal/orb-providers")
      return ok(orbProviders(options.noOrb === true));
    if (path === "/v1/settings/personal/model-routing/choices")
      return ok(choices);
    if (path === "/v1/settings/personal/model-routing/graph") return ok(graph);
    if (path === "/v1/plugins/views") return ok({ pages: [], threadTypes: [] });
    if (path === "/v1/plugin-agents/modes")
      return Response.json({ status: "ok", data: { modes: [] } });
    if (path.startsWith("/v1/drafts/")) {
      if (method === "PUT" || method === "PATCH") draft = body?.text ?? "";
      if (method === "DELETE") draft = "";
      return ok({ text: draft });
    }
    if (path === `/v1/settings/workspaces/${WORKSPACE.shortName}/members`)
      return ok({
        members: MEMBERS,
        viewer: { userId: "usr_story", role: "owner" },
      });
    console.warn("composer fixture: unhandled", method, path);
    return original(url, init);
  };
  window.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    if (!url.pathname.startsWith("/v1/")) return original(input, init);
    return handle(url, init);
  };
  return {
    sent,
    restore: () => {
      window.fetch = original;
    },
  };
};
