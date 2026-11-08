/**
 * Every setting a self-hosted dx deployment takes, in one registry. Each
 * release adds its new settings here; `pnpm dx:configure` walks the registry,
 * prompting with the deployment's current values as defaults, and a plain
 * `pnpm dx:deploy` names the settings this deployment has never been asked
 * about (`configuredSettings` in deploy.selfhost.json).
 *
 * A setting is either a value in deploy.selfhost.json (`get`/`set`) or a
 * secret supplied through its environment variable (`env`). Secrets are never
 * written to the config or printed: the deployment holds them from the first
 * deploy that supplies them, so the command only reports whether one is set.
 *
 * `flow` settings are changed by one of the installer's own steps (sign-in,
 * sender, Portals); the command shows them and names the step's flag.
 *
 * Private deployments extend this list from internal/; nothing here imports
 * it.
 */

const toggle = (list, value, on) =>
  on
    ? [...new Set([...(list ?? []), value])].sort()
    : (list ?? []).filter((item) => item !== value);

const integration = (id) => ({
  get: (config) => config.integrations.includes(id),
  set: (config, on) => ({
    ...config,
    integrations: toggle(config.integrations, id, on),
  }),
});

const orbProvider = (id) => ({
  get: (config) => config.orbProviders.includes(id),
  set: (config, on) => ({
    ...config,
    orbProviders: toggle(config.orbProviders, id, on),
  }),
});

// Turning a plugin off also drops its provider key's integration, which
// requires the plugin.
const plugin = (id, providerIntegration) => ({
  get: (config) => (config.plugins ?? []).includes(id),
  set: (config, on) => ({
    ...config,
    plugins: toggle(config.plugins, id, on),
    offeredPlugins: toggle(config.offeredPlugins, id, true),
    integrations: on
      ? config.integrations
      : toggle(config.integrations, providerIntegration, false),
  }),
});

const field = (key) => ({
  get: (config) => config[key],
  set: (config, value) => {
    const { [key]: _previous, ...rest } = config;
    return value === undefined ||
      value === "" ||
      (Array.isArray(value) && value.length === 0)
      ? rest
      : { ...rest, [key]: value };
  },
});

export const SETTING_GROUPS = Object.freeze([
  "Sign-in",
  "Model routing",
  "Orb providers",
  "Source control",
  "Plugins",
  "Bug reports",
  "Observability",
  "Network",
]);

/**
 * kind: boolean | text | list | secret | flow. `when` limits a setting to
 * deployments it applies to; `required` settings must have a value there.
 * `binding` names the Worker binding the setting becomes, so the command can
 * read the live deployment and the registry check can prove coverage.
 */
export const SELFHOST_SETTINGS = Object.freeze([
  {
    id: "adminEmail",
    group: "Sign-in",
    kind: "text",
    label: "Administrator email",
    description: "The first administrator's sign-in email.",
    example: "me@example.com",
    required: true,
    ...field("adminEmail"),
  },
  {
    id: "signIn",
    group: "Sign-in",
    kind: "flow",
    command: "pnpm dx:deploy -- --sign-in",
    label: "Sign-in methods and admission",
    description:
      "Magic link, email and password, or Google, and who may create an account.",
    example: "magic-link, google; waitlist",
    show: (config) =>
      `${config.signIn.providers.join(", ")}; ${config.signIn.admission}`,
    bindings: [
      "DX_SIGN_IN_PROVIDERS",
      "DX_SIGN_IN_ADMISSION",
      "DX_SIGN_IN_ALLOWED_EMAIL_DOMAINS",
      "DX_GOOGLE_CLIENT_ID",
      "DX_TERMS_URL",
      "DX_PRIVACY_URL",
      "DX_SIGNUP_ENABLED",
    ],
  },
  {
    id: "googleClientSecret",
    group: "Sign-in",
    kind: "secret",
    env: "DX_GOOGLE_CLIENT_SECRET",
    binding: "DX_GOOGLE_CLIENT_SECRET",
    label: "Google OAuth client secret",
    description: "The secret of the Google OAuth client named in sign-in.",
    example: "GOCSPX-…",
    required: true,
    when: (config) => config.signIn.providers.includes("google"),
  },
  {
    id: "authEmailFrom",
    group: "Sign-in",
    kind: "flow",
    command: "pnpm dx:deploy -- --email",
    label: "Sender email",
    description:
      "The address magic links and notification emails come from, on your zone.",
    example: "sign-in@mail.example.com",
    show: (config) => config.authEmailFrom ?? "none",
    bindings: ["DX_AUTH_EMAIL_FROM", "EMAIL"],
  },
  {
    id: "workersAi",
    group: "Model routing",
    kind: "boolean",
    label: "Workers AI",
    description: "Offer Cloudflare Workers AI models on this account.",
    example: "true",
    get: (config) => config.workersAi,
    set: (config, value) => ({ ...config, workersAi: value }),
    binding: "DX_MODEL_WORKERS_AI_ENABLED",
  },
  {
    id: "githubCopilotClientId",
    group: "Model routing",
    kind: "text",
    label: "GitHub Copilot OAuth client ID",
    description: "Lets people connect their GitHub Copilot subscription.",
    example: "Iv23li…",
    binding: "DX_GITHUB_COPILOT_CLIENT_ID",
    ...field("githubCopilotClientId"),
  },
  {
    id: "modelDeploymentProviders",
    group: "Model routing",
    kind: "text",
    label: "API-key model providers people can add",
    description:
      "Comma-separated provider IDs, none, or empty for every catalog provider.",
    example: "anthropic,openai",
    binding: "DX_MODEL_DEPLOYMENT_PROVIDERS",
    ...field("modelDeploymentProviders"),
  },
  {
    id: "modelEndpointAllowlist",
    group: "Model routing",
    kind: "text",
    label: "Custom model endpoint allowlist",
    description: "Comma-separated origins people may point a model at.",
    example: "https://models.example.com",
    binding: "DX_MODEL_ENDPOINT_ALLOWLIST",
    ...field("modelEndpointAllowlist"),
  },
  {
    id: "e2b",
    group: "Orb providers",
    kind: "boolean",
    label: "E2B on this deployment's account",
    description:
      "Threads without their own E2B connection run on, and bill, your E2B key.",
    example: "true",
    ...orbProvider("e2b"),
  },
  {
    id: "e2bApiKey",
    group: "Orb providers",
    kind: "secret",
    env: "E2B_API_KEY",
    binding: "E2B_API_KEY",
    label: "E2B API key",
    description: "The deployment's E2B team key.",
    example: "e2b_…",
    required: true,
    when: (config) => config.orbProviders.includes("e2b"),
  },
  {
    id: "cloudflare",
    group: "Orb providers",
    kind: "boolean",
    label: "Cloudflare Containers on this account",
    description:
      "Containers run and bill in this Cloudflare account (Workers Paid plan, Docker on this machine).",
    example: "false",
    ...orbProvider("cloudflare"),
  },
  {
    id: "boat",
    group: "Orb providers",
    kind: "boolean",
    label: "Boat on this deployment's account",
    description:
      "Threads without their own Boat connection run on, and bill, your Boat key.",
    example: "false",
    ...integration("boat"),
  },
  {
    id: "boatApiKey",
    group: "Orb providers",
    kind: "secret",
    env: "BOAT_API_KEY",
    binding: "BOAT_API_KEY",
    label: "Boat API key",
    description: "The deployment's Boat key (a paid Boat plan).",
    example: "boat_…",
    required: true,
    when: (config) => config.integrations.includes("boat"),
  },
  {
    id: "github",
    group: "Source control",
    kind: "boolean",
    label: "GitHub App",
    description: "Repository access, sign-in, and GitHub event subscriptions.",
    example: "true",
    ...integration("github"),
  },
  {
    id: "githubApp",
    group: "Source control",
    kind: "secret",
    env: "DX_INTEGRATION_GITHUB_APP",
    binding: "DX_INTEGRATION_GITHUB_APP",
    label: "GitHub App JSON",
    description:
      "The App's strict JSON (see the GitHub source access docs); its events and permissions are checked.",
    example: '{"version":1,"appId":"123",…}',
    required: true,
    when: (config) => config.integrations.includes("github"),
  },
  {
    id: "bitbucket",
    group: "Source control",
    kind: "boolean",
    label: "Bitbucket OAuth",
    description: "Bitbucket Cloud repository access.",
    example: "false",
    ...integration("bitbucket"),
  },
  {
    id: "bitbucketOAuth",
    group: "Source control",
    kind: "secret",
    env: "DX_INTEGRATION_BITBUCKET_OAUTH",
    binding: "DX_INTEGRATION_BITBUCKET_OAUTH",
    label: "Bitbucket OAuth JSON",
    description: "The Bitbucket consumer's strict JSON.",
    example: '{"version":1,"key":"…",…}',
    required: true,
    when: (config) => config.integrations.includes("bitbucket"),
  },
  {
    id: "search",
    group: "Plugins",
    kind: "boolean",
    label: "Web search plugin",
    description: "Agent web search and page reading.",
    example: "true",
    binding: "DX_INSTALLED_PLUGINS",
    ...plugin("search", "exa"),
  },
  {
    id: "exa",
    group: "Plugins",
    kind: "boolean",
    label: "Deployment Exa key for Search",
    description: "People and workspaces can also add their own.",
    example: "false",
    when: (config) => (config.plugins ?? []).includes("search"),
    ...integration("exa"),
  },
  {
    id: "exaApiKey",
    group: "Plugins",
    kind: "secret",
    env: "EXA_API_KEY",
    binding: "EXA_API_KEY",
    label: "Exa API key",
    description: "Search's deployment-scope key.",
    example: "exa-…",
    required: true,
    when: (config) => config.integrations.includes("exa"),
  },
  {
    id: "speech",
    group: "Plugins",
    kind: "boolean",
    label: "Speech plugin",
    description: "Composer dictation.",
    example: "true",
    binding: "DX_INSTALLED_PLUGINS",
    ...plugin("speech", "sarvam"),
  },
  {
    id: "sarvam",
    group: "Plugins",
    kind: "boolean",
    label: "Deployment Sarvam key for Speech",
    description: "People and workspaces can also add their own.",
    example: "false",
    when: (config) => (config.plugins ?? []).includes("speech"),
    ...integration("sarvam"),
  },
  {
    id: "sarvamApiKey",
    group: "Plugins",
    kind: "secret",
    env: "SARVAM_API_KEY",
    binding: "SARVAM_API_KEY",
    label: "Sarvam API key",
    description: "Speech's deployment-scope key.",
    example: "sk_…",
    required: true,
    when: (config) => config.integrations.includes("sarvam"),
  },
  {
    id: "bugReportReaders",
    group: "Bug reports",
    kind: "list",
    label: "Bug report readers",
    description:
      "Verified emails that read every in-app bug report, in the app and through their agents.",
    example: "product@example.com",
    binding: "DX_BUG_REPORT_READERS",
    ...field("bugReportReaders"),
  },
  {
    id: "bugReportForwarding",
    group: "Bug reports",
    kind: "boolean",
    label: "Share bug reports with a central dx deployment",
    description:
      "Each report stays here and an anonymous copy (no reporter, emails, or user IDs) goes to that deployment.",
    example: "false",
    ...integration("bugReportForwarding"),
  },
  {
    id: "bugReportDestination",
    group: "Bug reports",
    kind: "text",
    label: "Central dx deployment",
    description: "Its https origin.",
    example: "https://dx.example.com",
    binding: "DX_BUG_REPORT_DESTINATION",
    required: true,
    when: (config) => config.integrations.includes("bugReportForwarding"),
    ...field("bugReportDestination"),
  },
  {
    id: "bugReportDestinationKey",
    group: "Bug reports",
    kind: "secret",
    env: "DX_BUG_REPORT_DESTINATION_KEY",
    binding: "DX_BUG_REPORT_DESTINATION_KEY",
    label: "Bug report intake key",
    description: "The key the central deployment issued this one.",
    example: "dxbr_…",
    required: true,
    when: (config) => config.integrations.includes("bugReportForwarding"),
  },
  {
    id: "bugReportIntake",
    group: "Bug reports",
    kind: "boolean",
    label: "Take bug reports other deployments share",
    description:
      "They appear in All Bug Reports beside this deployment's own, from senders holding a key your secret issues.",
    example: "false",
    ...integration("bugReportIntake"),
  },
  {
    id: "bugReportIntakeSecret",
    group: "Bug reports",
    kind: "secret",
    env: "DX_BUG_REPORT_INTAKE_SECRET",
    binding: "DX_BUG_REPORT_INTAKE_SECRET",
    label: "Bug report intake secret",
    description:
      "Derives each sender's key (docs: Bug report forwarding); rotating it revokes them all.",
    example: "a long random string",
    required: true,
    when: (config) => config.integrations.includes("bugReportIntake"),
  },
  {
    id: "workerTraces",
    group: "Observability",
    kind: "boolean",
    label: "Cloudflare Worker traces",
    description:
      "Records request URLs and Durable Object names; logs are always on.",
    example: "false",
    get: (config) => config.workerTraces === true,
    set: (config, value) => ({ ...config, workerTraces: value }),
  },
  {
    id: "portalDomain",
    group: "Network",
    kind: "flow",
    command: "pnpm dx:deploy -- --portals",
    label: "Portals",
    description:
      "Serve web apps running in a Thread's workspace on a zone of their own.",
    example: "example-portals.dev",
    show: (config) => config.portalDomain ?? "off",
    bindings: ["DX_PORTAL_DOMAIN"],
  },
]);

/**
 * Settings the first-run installer asks itself. A deployment whose config
 * predates `configuredSettings` was asked these, so only later additions
 * count as new for it.
 */
export const INSTALLER_SETTING_IDS = Object.freeze([
  "adminEmail",
  "signIn",
  "googleClientSecret",
  "authEmailFrom",
  "workersAi",
  "githubCopilotClientId",
  "modelDeploymentProviders",
  "e2b",
  "e2bApiKey",
  "cloudflare",
  "github",
  "githubApp",
  "bitbucket",
  "bitbucketOAuth",
  "search",
  "exa",
  "exaApiKey",
  "speech",
  "sarvam",
  "sarvamApiKey",
  "workerTraces",
  "portalDomain",
]);

/**
 * Core Worker bindings the deploy derives itself, never an operator setting.
 * A new binding in apps/core/production-bindings.json must be covered by a
 * setting above or listed here (deploy/selfhost/settings.test.mjs).
 */
export const DERIVED_BINDINGS = Object.freeze([
  "DX_ATTACHMENT_R2_CREDENTIALS",
  "DX_ATTACHMENT_R2_ENDPOINT",
  "DX_AUTH_TRUSTED_ORIGINS",
  "DX_AUTH_URL",
  "DX_DEPLOYMENT_REVISION",
  "DX_DEPLOYMENT_TARGET",
  "DX_DXD_PUBLIC_URL",
  "DX_DXD_RELEASE_SHA256",
  "DX_DXD_RELEASE_URL",
  "DX_E2B_TEMPLATE",
  "DX_E2B_TEMPLATE_BUILD_ID",
  "DX_E2B_TIMEOUT_MS",
  "DX_MANAGED_SSH_SIGNING_ENABLED",
  "DX_MIGRATION_MANIFEST_VERSION",
  "DX_PREVIEW_ORB_IMAGE",
  "DX_PUSH_VAPID_PRIVATE_KEY",
  "DX_PUSH_VAPID_PUBLIC_KEY",
  "DX_SOURCE_CONTROL_SCHEMA_VERSION",
  "DX_SOURCE_SHALLOW_CLONE",
  "DX_TURNSTILE_SECRET_KEY",
  "DX_TURNSTILE_SITE_KEY",
  "DX_WORKER_LOGS",
  "DX_WORKSPACE_INACTIVITY_MS",
  "ORB_CONTAINER",
]);

export const settingBindings = (settings = SELFHOST_SETTINGS) =>
  new Set(
    settings.flatMap((setting) => [
      ...(setting.binding === undefined ? [] : [setting.binding]),
      ...(setting.bindings ?? []),
    ]),
  );

export const applies = (setting, config) =>
  setting.when === undefined || setting.when(config);

/** Settings that apply to this deployment and it has never been asked. */
export const unseenSettings = (config, settings = SELFHOST_SETTINGS) => {
  const seen = new Set(config.configuredSettings ?? INSTALLER_SETTING_IDS);
  return settings.filter(
    (setting) => applies(setting, config) && !seen.has(setting.id),
  );
};

/**
 * Whether the live deployment holds a secret. A binding counts only when the
 * setting applied to the config last deployed (`deployed`): with an
 * integration off, the deploy binds a placeholder (GitHub's App is `{}`), not
 * the operator's secret.
 */
export const secretHeld = (setting, { bindings, deployed }) =>
  bindings.has(setting.binding) &&
  (deployed === undefined || applies(setting, deployed));

/**
 * What a secret looks like right now, without its value: supplied in this
 * run's environment, held by the live deployment, or not set.
 */
export const secretState = (setting, { environment, bindings, deployed }) =>
  environment[setting.env]?.trim()
    ? "set in your environment"
    : secretHeld(setting, { bindings, deployed })
      ? "set"
      : "not set";

const listValue = (value) =>
  value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);

const shown = (setting, config) => {
  if (setting.kind === "flow") return setting.show(config);
  const value = setting.get(config);
  if (setting.kind === "boolean") return value ? "yes" : "no";
  if (setting.kind === "list") return (value ?? []).join(", ") || "none";
  return value ?? "none";
};

/**
 * Checks a settings file before anything runs: every key names a setting the
 * file may set, and every value has that setting's type, whether or not the
 * setting applies yet. A toggle treats any truthy value as on, so `"false"`
 * would turn an integration on.
 */
export const validateSettingsFile = (values, settings = SELFHOST_SETTINGS) => {
  if (values === null || typeof values !== "object" || Array.isArray(values))
    throw new Error("A settings file holds one JSON object of setting IDs.");
  for (const [id, value] of Object.entries(values)) {
    const setting = settings.find((candidate) => candidate.id === id);
    if (setting === undefined) throw new Error(`Unknown setting: ${id}.`);
    if (setting.kind === "secret")
      throw new Error(
        `${id} is a secret: set ${setting.env} in the environment, not the settings file.`,
      );
    if (setting.kind === "flow")
      throw new Error(
        `${id} is changed with ${setting.command}, not a settings file.`,
      );
    const valid =
      setting.kind === "boolean"
        ? typeof value === "boolean"
        : setting.kind === "list"
          ? Array.isArray(value) &&
            value.every((item) => typeof item === "string")
          : typeof value === "string";
    if (!valid)
      throw new Error(
        `${id} must be ${
          setting.kind === "boolean"
            ? "true or false"
            : setting.kind === "list"
              ? "an array of strings"
              : "a string"
        }, not ${JSON.stringify(value)}.`,
      );
  }
};

/**
 * Walks the settings group by group and returns the updated config. Each
 * prompt defaults to the current value; Enter keeps it. A secret shows only
 * whether it is set. Without `all`, it asks only about settings this
 * deployment has never been asked, and required secrets that are not set.
 *
 * `values` (non-interactive) answers by setting id instead of prompting;
 * secrets then come only from the environment. Returns the config with every applicable
 * setting recorded in `configuredSettings`, and the names of secrets this
 * run supplies.
 */
export const configureSettings = async ({
  config,
  validate,
  settings = SELFHOST_SETTINGS,
  environment,
  bindings = new Map(),
  all = false,
  values,
  ui,
}) => {
  if (values !== undefined) validateSettingsFile(values, settings);
  const seen = new Set(config.configuredSettings ?? INSTALLER_SETTING_IDS);
  const supplied = [];
  let next = config;
  for (const group of SETTING_GROUPS) {
    const inGroup = settings.filter((setting) => setting.group === group);
    let header = false;
    for (const setting of inGroup) {
      if (!applies(setting, next)) continue;
      const state =
        setting.kind === "secret"
          ? secretState(setting, { environment, bindings, deployed: config })
          : undefined;
      const missingSecret =
        setting.kind === "secret" && setting.required && state === "not set";
      if (values !== undefined) {
        if (setting.kind === "secret") {
          if (missingSecret)
            throw new Error(
              `${setting.label} is required: set ${setting.env} in the environment.`,
            );
          if (state === "set in your environment") supplied.push(setting.env);
        } else if (Object.hasOwn(values, setting.id))
          next = setting.set(next, values[setting.id]);
        continue;
      }
      const isNew = !seen.has(setting.id);
      if (!all && !isNew && !missingSecret) continue;
      if (!header) {
        ui.log(`\n${group}\n`);
        header = true;
      }
      ui.log(
        `  ${setting.label}${isNew ? " (new)" : ""}: ${setting.description}\n`,
      );
      if (setting.kind === "secret") {
        ui.log(`    Currently: ${state}\n`);
        const replace =
          state === "not set"
            ? setting.required || (await ui.yes(`    Set it`, false))
            : await ui.yes(`    Replace it`, false);
        if (replace) {
          const value = (await ui.secret(`    ${setting.label}`)).trim();
          if (value === "" && setting.required && state === "not set")
            throw new Error(`${setting.label} is required.`);
          if (value !== "") {
            environment[setting.env] = value;
            supplied.push(setting.env);
          }
        } else if (state === "set in your environment")
          supplied.push(setting.env);
        continue;
      }
      if (setting.kind === "flow") {
        ui.log(
          `    Currently: ${shown(setting, next)}. Change it with ${setting.command}.\n`,
        );
        continue;
      }
      const live =
        setting.binding !== undefined && bindings.get(setting.binding)?.text;
      if (
        typeof live === "string" &&
        setting.kind !== "boolean" &&
        live !== shown(setting, next).replaceAll(", ", ",")
      )
        ui.log(`    The live deployment has: ${live}\n`);
      if (setting.kind === "boolean") {
        next = setting.set(
          next,
          await ui.yes(`    ${setting.label}`, setting.get(next) === true),
        );
        continue;
      }
      const current = shown(setting, next);
      const answer = (
        await ui.answer(
          `    ${setting.label} (e.g. ${setting.example}; "none" clears)`,
          current,
        )
      ).trim();
      const cleared = answer === "none" || answer === "";
      if (setting.required && cleared)
        throw new Error(`${setting.label} is required.`);
      next = setting.set(
        next,
        setting.kind === "list"
          ? cleared
            ? []
            : listValue(answer)
          : cleared
            ? undefined
            : answer,
      );
    }
  }
  next = validate(next);
  // Required secrets for anything just turned on.
  for (const setting of settings)
    if (
      setting.kind === "secret" &&
      setting.required &&
      applies(setting, next) &&
      secretState(setting, { environment, bindings, deployed: config }) ===
        "not set"
    ) {
      if (values !== undefined || ui === undefined)
        throw new Error(
          `${setting.label} is required: set ${setting.env} in the environment.`,
        );
      const value = (await ui.secret(`${setting.label}`)).trim();
      if (value === "") throw new Error(`${setting.label} is required.`);
      environment[setting.env] = value;
      supplied.push(setting.env);
    }
  return {
    config: validate({
      ...next,
      configuredSettings: [
        ...new Set([
          ...seen,
          ...settings
            .filter((setting) => applies(setting, next))
            .map((setting) => setting.id),
        ]),
      ].sort(),
    }),
    supplied: [...new Set(supplied)].sort(),
  };
};

/**
 * The live dx Worker's bindings: names, types, and plain-text values. The
 * Cloudflare API never returns a secret's value. A deployment that does not
 * exist yet has none.
 */
export const readDeploymentBindings = async ({
  auth,
  workerName,
  fetch: fetchImpl = fetch,
}) => {
  const response = await fetchImpl(
    `https://api.cloudflare.com/client/v4/accounts/${auth.accountId}/workers/scripts/${workerName}/settings`,
    { headers: auth.headers },
  );
  if (response.status === 404) return new Map();
  if (!response.ok)
    throw new Error(
      `Could not read the deployment's Worker settings (HTTP ${response.status}).`,
    );
  const body = await response.json();
  return new Map(
    (body.result?.bindings ?? []).map((binding) => [
      binding.name,
      {
        type: binding.type,
        ...(binding.type === "plain_text" ? { text: binding.text } : {}),
      },
    ]),
  );
};
