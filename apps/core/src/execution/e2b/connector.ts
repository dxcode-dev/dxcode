import { E2B_ORB_PROFILES, type OrbProviderCredentials } from "@dx/domain";
import {
  failedPreparation,
  type OrbPreparation,
  type OrbProviderConnector,
  OrbProviderCredentialsRejected,
} from "../../plugins/execution/connector.js";
import {
  advanceTeamTemplates,
  currentOrbTemplateRecipe,
  E2BKeyRejected,
  type E2BTeamApi,
  liveE2BTeamApi,
  readyProfileTemplates,
  startTeamTemplates,
  type TeamTemplateBuild,
  type TeamTemplateState,
  unavailableProfiles,
} from "./team-templates.js";

/** How often preparation reads E2B's build status. */
const BUILD_POLL_MS = 10_000;

const apiKeyOf = (credentials: OrbProviderCredentials) => {
  const apiKey = credentials.apiKey;
  if (apiKey === undefined)
    throw new OrbProviderCredentialsRejected("Enter an E2B API key.");
  return apiKey;
};

const buildsOf = (
  state: OrbPreparation["state"],
): ReadonlyArray<TeamTemplateBuild> =>
  Array.isArray(state.builds)
    ? (state.builds as ReadonlyArray<TeamTemplateBuild>)
    : [];

const progressOf = (builds: ReadonlyArray<TeamTemplateBuild>) => {
  const total = E2B_ORB_PROFILES.length + 1;
  const done = builds.filter(
    ({ status }) => status === "ready" || status === "skipped",
  ).length;
  const building = builds.find(({ status }) => status === "building");
  const size =
    building === undefined
      ? undefined
      : building.profileId === null
        ? "the base"
        : building.profileId;
  return {
    step:
      size === undefined
        ? "Starting the next template build"
        : `Building the Orb template (${size}) in your E2B team`,
    done,
    total,
  };
};

const preparationOf = (state: TeamTemplateState): OrbPreparation => {
  const shared = { account: state.account, state: { builds: state.builds } };
  if (state.state === "failed")
    return failedPreparation(shared, state.error ?? "The template failed.");
  if (state.state === "ready")
    return { ...shared, status: "ready", progress: null, error: null };
  return {
    ...shared,
    status: "preparing",
    progress: progressOf(state.builds),
    error: null,
    nextStepInMs: BUILD_POLL_MS,
  };
};

/**
 * E2B in a person's or workspace's own team. Preparing the team builds the
 * standard Orb template and one template per size, from this build's
 * recipe; a team that already has them is ready at once.
 */
export const makeE2BConnector = (
  teamApi: E2BTeamApi = liveE2BTeamApi,
): OrbProviderConnector => ({
  providerId: "e2b",
  description:
    "Runs Orbs in your E2B team. dx builds its Orb templates there first, which takes a few minutes.",
  fields: [
    {
      id: "apiKey",
      label: "E2B API key",
      secret: true,
      placeholder: "e2b_…",
      help: "Create one in the E2B dashboard under API Keys.",
    },
  ],
  recipe: currentOrbTemplateRecipe,
  async start(credentials, recipe) {
    try {
      return preparationOf(
        await startTeamTemplates(teamApi, apiKeyOf(credentials), recipe),
      );
    } catch (cause) {
      if (cause instanceof E2BKeyRejected)
        throw new OrbProviderCredentialsRejected("E2B rejected this API key.");
      throw cause;
    }
  },
  async advance(credentials, recipe, current) {
    try {
      return preparationOf(
        await advanceTeamTemplates(teamApi, apiKeyOf(credentials), recipe, {
          state: "building",
          account: current.account,
          builds: buildsOf(current.state),
          error: null,
        }),
      );
    } catch (cause) {
      if (cause instanceof E2BKeyRejected)
        return failedPreparation(current, "E2B rejected this API key.");
      throw cause;
    }
  },
  targets: (preparation) =>
    readyProfileTemplates({
      state: preparation.status === "ready" ? "ready" : "building",
      builds: buildsOf(preparation.state),
    }),
  unavailable: (preparation) =>
    unavailableProfiles({
      state: preparation.status === "ready" ? "ready" : "building",
      builds: buildsOf(preparation.state),
    }),
});
