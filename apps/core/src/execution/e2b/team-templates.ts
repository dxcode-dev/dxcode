import { E2B_ORB_PROFILES, type E2BOrbProfile } from "@dx/domain";
import { ApiClient, ConnectionConfig, Template, waitForFile } from "e2b";
import orbDockerfile from "../../../../../deploy/orb/Dockerfile?raw";
import orbHostname from "../../../../../deploy/orb/dx-orb-hostname.sh?raw";
import orbInit from "../../../../../deploy/orb/dx-orb-init?raw";
import terminalStub from "../../../../dxd/assets/dx-terminal-stub.sh?raw";

/**
 * The standard Orb template built into a person's or workspace's own E2B
 * team (bring-your-own keys). A user's team does not have dx's templates,
 * so saving a key builds them there with the deployment's recipe
 * (deploy/e2b/template.mjs): the base from deploy/orb/Dockerfile, started
 * by dx-orb-init, then one template per E2B Orb size from that base. The
 * Worker has no build context, so the Dockerfile's COPY instructions
 * become RUN steps that write the same bytes; the following RUN sets their
 * owner and mode, as for the copied files.
 */
const COPIED_FILES: Readonly<Record<string, string>> = {
  "apps/dxd/assets/dx-terminal-stub.sh": terminalStub,
  "deploy/orb/dx-orb-init": orbInit,
  "deploy/orb/dx-orb-hostname.sh": orbHostname,
};

const START_COMMAND = "/usr/local/bin/dx-orb-init";
const READY_FILE = "/home/user/.local/state/dxd/supervisor.pid";
const BASE_RESOURCES = { cpuCount: 2, memoryMB: 4096 } as const;

const base64 = (value: string) => {
  const bytes = new TextEncoder().encode(value);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
};

/** The Dockerfile with each COPY written inline; unknown sources fail. */
export const inlineOrbDockerfile = (
  dockerfile: string = orbDockerfile,
  files: Readonly<Record<string, string>> = COPIED_FILES,
) =>
  dockerfile
    .split("\n")
    .map((line) => {
      const copy = /^COPY\s+(\S+)\s+(\S+)\s*$/.exec(line);
      if (copy === null) return line;
      const [, source, destination] = copy as unknown as [
        string,
        string,
        string,
      ];
      const content = files[source];
      if (content === undefined)
        throw new Error(`The Orb recipe does not inline ${source}.`);
      const directory = destination.slice(0, destination.lastIndexOf("/"));
      return `RUN mkdir -p ${directory || "/"} && echo ${base64(content)} | base64 -d >${destination}`;
    })
    .join("\n");

/**
 * The recipe version: the inlined Dockerfile, start command, and the size
 * catalog. Template names carry it, so a recipe change builds new templates
 * next to the old ones and pinned Threads keep theirs.
 */
export const orbTemplateRecipe = async (
  dockerfile: string = inlineOrbDockerfile(),
  profiles: ReadonlyArray<E2BOrbProfile> = E2B_ORB_PROFILES,
) => {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(
      [dockerfile, START_COMMAND, READY_FILE, JSON.stringify(profiles)].join(
        "\0",
      ),
    ),
  );
  return [...new Uint8Array(digest)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 16);
};

let currentRecipe: Promise<string> | undefined;

/** This build's recipe version, computed once per isolate. */
export const currentOrbTemplateRecipe = () => {
  currentRecipe ??= orbTemplateRecipe();
  return currentRecipe;
};

export const teamTemplateName = (recipe: string, profile?: E2BOrbProfile) =>
  `dx-orb-${recipe}-${profile?.templateSuffix ?? "base"}`;

export type TeamTemplateBuildStatus = "building" | "ready" | "error";

export interface TeamTemplateBuild {
  /** Null for the base template. */
  readonly profileId: string | null;
  readonly name: string;
  readonly templateId: string;
  readonly buildId: string;
  readonly status: TeamTemplateBuildStatus;
}

export interface TeamTemplateState {
  readonly state: "building" | "ready" | "failed";
  /** The E2B team the key belongs to, once known. */
  readonly account: string | null;
  readonly builds: ReadonlyArray<TeamTemplateBuild>;
  readonly error: string | null;
}

export interface ListedTeamTemplate {
  readonly templateID: string;
  readonly buildID: string;
  readonly buildStatus: string;
  readonly names: ReadonlyArray<string>;
  readonly aliases: ReadonlyArray<string>;
}

export interface E2BTeamApi {
  /** Rejects with E2BKeyRejected when E2B refuses the key. */
  readonly listTemplates: (
    apiKey: string,
  ) => Promise<ReadonlyArray<ListedTeamTemplate>>;
  readonly buildBase: (
    apiKey: string,
    name: string,
  ) => Promise<{ readonly templateId: string; readonly buildId: string }>;
  readonly buildProfile: (
    apiKey: string,
    name: string,
    base: { readonly name: string; readonly buildId: string },
    profile: E2BOrbProfile,
  ) => Promise<{ readonly templateId: string; readonly buildId: string }>;
  readonly buildStatus: (
    apiKey: string,
    build: { readonly templateId: string; readonly buildId: string },
  ) => Promise<TeamTemplateBuildStatus>;
}

export class E2BKeyRejected extends Error {
  constructor() {
    super("E2B rejected this API key.");
  }
}

const api = (apiKey: string) =>
  new ApiClient(new ConnectionConfig({ apiKey })).api;

const buildStatusOf = (status: string): TeamTemplateBuildStatus =>
  status === "ready" ? "ready" : status === "error" ? "error" : "building";

export const liveE2BTeamApi: E2BTeamApi = {
  listTemplates: async (apiKey) => {
    const response = await api(apiKey).GET("/templates");
    if (response.response.status === 401 || response.response.status === 403)
      throw new E2BKeyRejected();
    if (response.data === undefined)
      throw new Error(
        `E2B template list failed (${response.response.status}).`,
      );
    return response.data.map((template) => ({
      templateID: template.templateID,
      buildID: template.buildID,
      buildStatus: template.buildStatus,
      names: template.names ?? [],
      aliases: template.aliases ?? [],
    }));
  },
  buildBase: async (apiKey, name) => {
    const template = Template({ fileContextPath: "." })
      .fromDockerfile(inlineOrbDockerfile())
      .setStartCmd(START_COMMAND, waitForFile(READY_FILE));
    const build = await Template.buildInBackground(template, name, {
      apiKey,
      ...BASE_RESOURCES,
    });
    return { templateId: build.templateId, buildId: build.buildId };
  },
  buildProfile: async (apiKey, name, base, profile) => {
    const template = Template({ fileContextPath: "." }).fromTemplate(
      `${base.name}:${base.buildId}`,
    );
    const build = await Template.buildInBackground(template, name, {
      apiKey,
      cpuCount: profile.resources.cpuCores,
      memoryMB: profile.resources.memoryMb,
    });
    return { templateId: build.templateId, buildId: build.buildId };
  },
  buildStatus: async (apiKey, build) => {
    const response = await api(apiKey).GET(
      "/templates/{templateID}/builds/{buildID}/status",
      {
        params: {
          path: { templateID: build.templateId, buildID: build.buildId },
          query: { limit: 0 },
        },
      },
    );
    if (response.response.status === 401 || response.response.status === 403)
      throw new E2BKeyRejected();
    if (response.data === undefined)
      throw new Error(`E2B build status failed (${response.response.status}).`);
    return buildStatusOf(response.data.status);
  },
};

/** E2B names a team's template `<team>/<name>`; the team is the account. */
const findListed = (
  templates: ReadonlyArray<ListedTeamTemplate>,
  name: string,
) =>
  templates.find(
    (template) =>
      template.aliases.includes(name) ||
      template.names.some((full) => full === name || full.endsWith(`/${name}`)),
  );

export const teamOf = (
  templates: ReadonlyArray<ListedTeamTemplate>,
): string | null => {
  for (const template of templates)
    for (const full of template.names) {
      const slash = full.indexOf("/");
      if (slash > 0) return full.slice(0, slash);
    }
  return null;
};

const failed = (
  current: Omit<TeamTemplateState, "state" | "error">,
  error: string,
): TeamTemplateState => ({ ...current, state: "failed", error });

/**
 * Starts (or verifies) the Orb templates in the key's team. Listing first
 * validates the key, names the team, and reuses templates an earlier save
 * already built, so re-saving or rotating a key within the same team is
 * ready at once.
 */
export const startTeamTemplates = async (
  teamApi: E2BTeamApi,
  apiKey: string,
  recipe: string,
  profiles: ReadonlyArray<E2BOrbProfile> = E2B_ORB_PROFILES,
): Promise<TeamTemplateState> => {
  let templates = await teamApi.listTemplates(apiKey);
  const builds: Array<TeamTemplateBuild> = [];
  for (const profile of [undefined, ...profiles]) {
    const name = teamTemplateName(recipe, profile);
    const listed = findListed(templates, name);
    if (listed === undefined || listed.buildStatus === "error") continue;
    builds.push({
      profileId: profile?.id ?? null,
      name,
      templateId: listed.templateID,
      buildId: listed.buildID,
      status: buildStatusOf(listed.buildStatus),
    });
  }
  const state = await advanceTeamTemplates(
    teamApi,
    apiKey,
    recipe,
    { state: "building", account: teamOf(templates), builds, error: null },
    profiles,
  );
  if (state.account !== null || state.builds.length === 0) return state;
  // A team without templates names itself once the first build exists.
  templates = await teamApi.listTemplates(apiKey);
  return { ...state, account: teamOf(templates) };
};

/**
 * One step of the build: reads the status of builds in progress and starts
 * the next template when its predecessor is ready (the base, then each
 * size in catalog order, one at a time, as the deployment builds them).
 */
export const advanceTeamTemplates = async (
  teamApi: E2BTeamApi,
  apiKey: string,
  recipe: string,
  current: TeamTemplateState,
  profiles: ReadonlyArray<E2BOrbProfile> = E2B_ORB_PROFILES,
): Promise<TeamTemplateState> => {
  if (current.state !== "building") return current;
  const builds: Array<TeamTemplateBuild> = [];
  for (const build of current.builds)
    builds.push(
      build.status === "building"
        ? { ...build, status: await teamApi.buildStatus(apiKey, build) }
        : build,
    );
  const progress = { account: current.account, builds };
  const broken = builds.find(({ status }) => status === "error");
  if (broken !== undefined)
    return failed(progress, `E2B could not build ${broken.name}.`);
  if (builds.some(({ status }) => status === "building"))
    return { ...progress, state: "building", error: null };
  const base = builds.find(({ profileId }) => profileId === null);
  if (base === undefined) {
    const name = teamTemplateName(recipe);
    const started = await teamApi.buildBase(apiKey, name);
    return {
      ...progress,
      state: "building",
      error: null,
      builds: [
        ...builds,
        { profileId: null, name, ...started, status: "building" },
      ],
    };
  }
  const next = profiles.find(
    (profile) => !builds.some(({ profileId }) => profileId === profile.id),
  );
  if (next === undefined) return { ...progress, state: "ready", error: null };
  const name = teamTemplateName(recipe, next);
  const started = await teamApi.buildProfile(apiKey, name, base, next);
  return {
    ...progress,
    state: "building",
    error: null,
    builds: [
      ...builds,
      { profileId: next.id, name, ...started, status: "building" },
    ],
  };
};

/** The template each size creates from, once every build is ready. */
export const readyProfileTemplates = (
  state: Pick<TeamTemplateState, "state" | "builds">,
): ReadonlyMap<string, string> | undefined =>
  state.state !== "ready"
    ? undefined
    : new Map(
        state.builds.flatMap(({ profileId, name }) =>
          profileId === null ? [] : [[profileId, name] as const],
        ),
      );
