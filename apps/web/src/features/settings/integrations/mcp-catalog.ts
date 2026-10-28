/**
 * Ready-to-connect MCP servers shown under Available on the Integrations &
 * MCP page. Add or remove a server by editing this list; nothing else needs
 * to change. A template's logo is `mcp-logos/<id>.svg` or `.png` beside this
 * file.
 *
 * `auth` is what Connect preselects: `oauth` signs in on the provider's
 * site, `bearer` asks for a token, `none` connects without credentials.
 * `setup` is Markdown shown in the connect dialog when a server needs more
 * than a click. `clientName` prefills the client name for servers that admit
 * only clients they know by name. Configured servers are matched to a
 * template by URL, including `alternateUrls` (regions, read-only variants).
 */
export interface McpTemplate {
  readonly id: string;
  readonly name: string;
  readonly url: string;
  readonly alternateUrls?: ReadonlyArray<string>;
  readonly description: string;
  readonly auth: "oauth" | "bearer" | "none";
  readonly setup?: string;
  readonly clientName?: string;
}

const LOGOS = import.meta.glob<string>("./mcp-logos/*.{svg,png}", {
  eager: true,
  query: "?url",
  import: "default",
});

/** The bundled logo URL for a template, when one exists. */
export const mcpTemplateLogo = (id: string): string | undefined =>
  LOGOS[`./mcp-logos/${id}.svg`] ?? LOGOS[`./mcp-logos/${id}.png`];

export const MCP_TEMPLATES: ReadonlyArray<McpTemplate> = [
  {
    id: "linear",
    name: "Linear",
    url: "https://mcp.linear.app/mcp",
    alternateUrls: ["https://mcp.linear.app/mcp/readonly"],
    description:
      "Find, create, and update Linear issues, projects, and comments.",
    auth: "oauth",
  },
  {
    id: "github",
    name: "GitHub",
    url: "https://api.githubcopilot.com/mcp/",
    alternateUrls: ["https://api.githubcopilot.com/mcp/readonly"],
    description:
      "Read and update repositories, issues, pull requests, and Actions.",
    auth: "bearer",
    setup:
      "GitHub's MCP server has no automatic client registration. Connect with a [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) as the bearer token.",
  },
  {
    id: "posthog",
    name: "PostHog",
    url: "https://mcp.posthog.com/mcp",
    description:
      "Query product analytics, feature flags, experiments, and errors.",
    auth: "oauth",
  },
  {
    id: "vercel",
    name: "Vercel",
    url: "https://mcp.vercel.com/",
    description:
      "Check deployments, read build logs, and manage Vercel projects.",
    auth: "oauth",
    setup:
      "Vercel accepts sign-in only from MCP clients it has reviewed ([docs](https://vercel.com/docs/agent-resources/vercel-mcp)).",
  },
  {
    id: "figma",
    name: "Figma",
    url: "https://mcp.figma.com/mcp",
    description:
      "Read Figma designs, components, and variables to build matching UI.",
    auth: "oauth",
    // Figma admits only clients it has approved, matched by client name.
    clientName: "Claude Code",
  },
  {
    id: "atlassian",
    name: "Atlassian",
    url: "https://mcp.atlassian.com/v2/mcp",
    description: "Search and update Jira issues and Confluence pages.",
    auth: "oauth",
    setup:
      "Atlassian accepts sign-in only from domains an organization admin allows. If sign-in fails, ask an admin to add this dx deployment's domain under Atlassian Administration → Rovo → Rovo MCP server ([guide](https://support.atlassian.com/security-and-access-policies/docs/control-atlassian-rovo-mcp-server-settings)).",
  },
  {
    id: "buildkite",
    name: "Buildkite",
    url: "https://mcp.buildkite.com/mcp",
    alternateUrls: ["https://mcp.buildkite.com/mcp/readonly"],
    description: "Check builds, read job logs, and retry failed pipelines.",
    auth: "oauth",
    setup:
      "Sign in to Buildkite and pick your organization. If it requires SSO, choose “Log in with SSO” first, then authorize. The connection can read and write.",
  },
  {
    id: "fastmail",
    name: "Fastmail",
    url: "https://api.fastmail.com/mcp",
    description: "Search, read, and send email from your Fastmail account.",
    auth: "oauth",
    setup:
      "Fastmail accepts sign-in only from callback hosts it allows. If sign-in fails, this deployment's domain is not on its list yet.",
  },
  {
    id: "axiom",
    name: "Axiom",
    url: "https://mcp.axiom.co/mcp",
    description: "Query logs, traces, and events in your Axiom datasets.",
    auth: "oauth",
  },
  {
    id: "sourcegraph",
    name: "Sourcegraph",
    url: "https://sourcegraph.example.com/.api/mcp",
    description: "Search and read code across your Sourcegraph repositories.",
    auth: "oauth",
    setup:
      "Replace `sourcegraph.example.com` with your Sourcegraph instance's hostname ([docs](https://sourcegraph.com/docs/api/mcp)).",
  },
  {
    id: "notion",
    name: "Notion",
    url: "https://mcp.notion.com/mcp",
    description: "Search, read, and update Notion pages and databases.",
    auth: "oauth",
  },
  {
    id: "sentry",
    name: "Sentry",
    url: "https://mcp.sentry.dev/mcp",
    description:
      "Look up Sentry issues, errors, and traces to fix production problems.",
    auth: "oauth",
  },
  {
    id: "cloudflare",
    name: "Cloudflare",
    url: "https://mcp.cloudflare.com/mcp",
    description: "Manage DNS, Workers, R2, and other Cloudflare products.",
    auth: "oauth",
  },
  {
    id: "mobbin",
    name: "Mobbin",
    url: "https://api.mobbin.com/mcp",
    description:
      "Search screens and flows from shipped apps for design references.",
    auth: "oauth",
  },
  {
    id: "supabase",
    name: "Supabase",
    url: "https://mcp.supabase.com/mcp",
    description: "Manage Supabase projects, run SQL, and apply migrations.",
    auth: "oauth",
  },
  {
    id: "context7",
    name: "Context7",
    url: "https://mcp.context7.com/mcp",
    description:
      "Fetch up-to-date documentation and code examples for libraries and frameworks.",
    auth: "none",
  },
  {
    id: "planetscale",
    name: "PlanetScale",
    url: "https://mcp.pscale.dev/mcp/planetscale",
    description:
      "Browse PlanetScale databases and branches, and run SQL queries.",
    auth: "oauth",
  },
  {
    id: "railway",
    name: "Railway",
    url: "https://mcp.railway.com",
    description: "Create projects, manage services, and redeploy on Railway.",
    auth: "oauth",
  },
  {
    id: "exa",
    name: "Exa",
    url: "https://mcp.exa.ai/mcp",
    description: "Search the web and code, and fetch clean page content.",
    auth: "none",
  },
  {
    id: "stripe",
    name: "Stripe",
    url: "https://mcp.stripe.com",
    description:
      "Read and write Stripe customers, payments, and subscriptions.",
    auth: "oauth",
  },
  {
    id: "clickhouse-cloud",
    name: "ClickHouse Cloud",
    url: "https://mcp.clickhouse.cloud/mcp",
    description: "Explore tables and run read-only SQL in ClickHouse Cloud.",
    auth: "oauth",
  },
  {
    id: "laravel-nightwatch",
    name: "Laravel Nightwatch",
    url: "https://nightwatch.laravel.com/mcp",
    description:
      "Browse exceptions and performance issues in Laravel Nightwatch.",
    auth: "oauth",
  },
  {
    id: "firecrawl",
    name: "Firecrawl",
    url: "https://mcp.firecrawl.dev/v2/mcp-oauth",
    description:
      "Search, scrape, and crawl the web into clean Markdown or JSON.",
    auth: "oauth",
  },
  {
    id: "workos",
    name: "WorkOS",
    url: "https://mcp.workos.com/mcp",
    description: "Manage WorkOS organizations, SSO connections, and users.",
    auth: "oauth",
  },
  {
    id: "cloudflare-docs",
    name: "Cloudflare Docs",
    url: "https://docs.mcp.cloudflare.com/mcp",
    description: "Search Cloudflare's product documentation.",
    auth: "none",
  },
  {
    id: "honeycomb",
    name: "Honeycomb",
    url: "https://mcp.honeycomb.io/mcp",
    alternateUrls: ["https://mcp.eu1.honeycomb.io/mcp"],
    description:
      "Query telemetry and analyze traces to investigate production issues.",
    auth: "oauth",
  },
  {
    id: "cloudflare-observability",
    name: "Cloudflare Observability",
    url: "https://observability.mcp.cloudflare.com/mcp",
    description: "Query logs and metrics from your Cloudflare Workers.",
    auth: "oauth",
  },
  {
    id: "neon",
    name: "Neon",
    url: "https://mcp.neon.tech/mcp",
    description: "Manage Neon projects, branches, and databases, and run SQL.",
    auth: "oauth",
  },
  {
    id: "better-stack",
    name: "Better Stack",
    url: "https://mcp.betterstack.com",
    description:
      "Query logs, metrics, and errors, and manage monitors and incidents.",
    auth: "oauth",
  },
  {
    id: "parallel-search",
    name: "Parallel Search",
    url: "https://search.parallel.ai/mcp-oauth",
    description:
      "Search the web and fetch clean, token-efficient content from URLs.",
    auth: "oauth",
  },
  {
    id: "elevenlabs",
    name: "ElevenLabs",
    url: "https://api.us.elevenlabs.io/v1/mcp",
    alternateUrls: [
      "https://api.elevenlabs.io/v1/mcp",
      "https://api.eu.residency.elevenlabs.io/v1/mcp",
      "https://api.in.residency.elevenlabs.io/v1/mcp",
      "https://api.sg.residency.elevenlabs.io/v1/mcp",
    ],
    description: "Build and test ElevenLabs voice agents and generate speech.",
    auth: "oauth",
  },
  {
    id: "clickup",
    name: "ClickUp",
    url: "https://mcp.clickup.com/mcp",
    description:
      "Search, create, and update ClickUp tasks, docs, and comments.",
    auth: "oauth",
  },
  {
    id: "asana",
    name: "Asana",
    url: "https://mcp.asana.com/v2/mcp",
    description:
      "Search, create, and update Asana tasks, projects, and comments.",
    auth: "oauth",
    setup:
      "Asana needs its own OAuth app. [Create an MCP app in Asana](https://developers.asana.com/docs/using-asanas-mcp-server), then enter its client ID and secret under Use your own OAuth app.",
  },
  {
    id: "grafana-cloud",
    name: "Grafana Cloud",
    url: "https://mcp.grafana.com/mcp",
    description:
      "Search dashboards and query metrics, logs, and traces in Grafana Cloud.",
    auth: "oauth",
  },
  {
    id: "incident-io",
    name: "incident.io",
    url: "https://mcp.incident.io/mcp",
    description:
      "Manage incidents, alerts, and follow-ups, and check who's on call.",
    auth: "oauth",
  },
  {
    id: "resend",
    name: "Resend",
    url: "https://mcp.resend.com/mcp",
    description:
      "Send emails and manage domains, contacts, and broadcasts in your Resend account.",
    auth: "oauth",
  },
  {
    id: "render",
    name: "Render",
    url: "https://mcp.render.com/mcp",
    description: "Deploy services, query databases, and read logs on Render.",
    auth: "bearer",
    setup:
      "Render's OAuth sign-in accepts only clients Render lists. [Create an API key](https://dashboard.render.com/u/settings?add-api-key) and connect with it as the bearer token ([docs](https://render.com/docs/mcp-server)).",
  },
  {
    id: "braintrust",
    name: "Braintrust",
    url: "https://api.braintrust.dev/mcp",
    alternateUrls: ["https://api-eu.braintrust.dev/mcp"],
    description: "Query experiments and production logs in Braintrust.",
    auth: "oauth",
  },
  {
    id: "plain",
    name: "Plain",
    url: "https://mcp.plain.com/mcp",
    description: "Read, reply to, and assign Plain support threads.",
    auth: "oauth",
  },
  {
    id: "amplitude",
    name: "Amplitude",
    url: "https://mcp.amplitude.com/mcp",
    alternateUrls: ["https://mcp.eu.amplitude.com/mcp"],
    description:
      "Query product analytics, charts, dashboards, and experiments.",
    auth: "oauth",
  },
  {
    id: "launchdarkly",
    name: "LaunchDarkly",
    url: "https://mcp.launchdarkly.com/mcp/launchdarkly",
    description: "Manage LaunchDarkly feature flags and AI configs.",
    auth: "oauth",
  },
  {
    id: "miro",
    name: "Miro",
    url: "https://mcp.miro.com",
    description:
      "Summarize and search boards, build boards and diagrams, and act on comments.",
    auth: "oauth",
  },
  {
    id: "new-relic",
    name: "New Relic",
    url: "https://mcp.newrelic.com/mcp/",
    alternateUrls: [
      "https://mcp.eu.newrelic.com/mcp/",
      "https://mcp.jp.newrelic.com/mcp/",
    ],
    description: "Query New Relic entities, NRQL data, alerts, and logs.",
    auth: "none",
    setup:
      "New Relic's OAuth sign-in accepts only loopback callbacks. Create a [User API key](https://docs.newrelic.com/docs/apis/intro-apis/new-relic-api-keys/#user-key) (it starts with `NRAK-`) and add it as a secret header named `api-key`.",
  },
  {
    id: "ahrefs",
    name: "Ahrefs",
    url: "https://api.ahrefs.com/mcp/mcp",
    description:
      "Pull backlink, keyword, rank tracking, and site audit data from Ahrefs.",
    auth: "oauth",
  },
  {
    id: "pydantic-logfire",
    name: "Pydantic Logfire",
    url: "https://logfire-us.pydantic.dev/mcp",
    alternateUrls: ["https://logfire-eu.pydantic.dev/mcp"],
    description: "Query traces and metrics in Pydantic Logfire.",
    auth: "oauth",
  },
  {
    id: "tavily",
    name: "Tavily",
    url: "https://mcp.tavily.com/mcp",
    description: "Search the web, extract page content, and crawl sites.",
    auth: "oauth",
  },
  {
    id: "basecamp",
    name: "Basecamp",
    url: "https://mcp.basecamp.com/mcp",
    description: "Manage Basecamp to-dos, cards, messages, and docs.",
    auth: "oauth",
  },
  {
    id: "clerk",
    name: "Clerk",
    url: "https://mcp.clerk.com/mcp",
    description:
      "Manage Clerk applications and users, and get Clerk SDK snippets.",
    auth: "oauth",
  },
  {
    id: "loops",
    name: "Loops",
    url: "https://mcp.loops.so",
    description: "Manage Loops contacts and mailing lists, and send email.",
    auth: "oauth",
  },
  {
    id: "openai-docs",
    name: "OpenAI Docs",
    url: "https://developers.openai.com/mcp",
    description: "Search and read OpenAI developer documentation.",
    auth: "none",
  },
  {
    id: "vanta",
    name: "Vanta",
    url: "https://mcp.vanta.com/mcp",
    alternateUrls: [
      "https://mcp.eu.vanta.com/mcp",
      "https://mcp.aus.vanta.com/mcp",
    ],
    description: "Check Vanta compliance status, failing tests, and evidence.",
    auth: "oauth",
  },
  {
    id: "attio",
    name: "Attio",
    url: "https://mcp.attio.com/mcp",
    description:
      "Search, create, and update CRM records, notes, and tasks in Attio.",
    auth: "oauth",
  },
  {
    id: "netlify",
    name: "Netlify",
    url: "https://netlify-mcp.netlify.app/mcp",
    description: "Create, deploy, and manage Netlify projects.",
    auth: "oauth",
  },
  {
    id: "bugsnag",
    name: "BugSnag",
    url: "https://bugsnag.mcp.smartbear.com/mcp",
    description:
      "Investigate errors, performance traces, and releases in BugSnag.",
    auth: "oauth",
  },
  {
    id: "deepwiki",
    name: "DeepWiki",
    url: "https://mcp.deepwiki.com/mcp",
    description:
      "Read wiki docs for public GitHub repositories and ask about their code.",
    auth: "none",
  },
  {
    id: "excalidraw",
    name: "Excalidraw",
    url: "https://mcp.excalidraw.com",
    description: "Draw hand-drawn diagrams on an editable Excalidraw canvas.",
    auth: "none",
  },
  {
    id: "jam",
    name: "Jam",
    url: "https://mcp.jam.dev/mcp",
    description:
      "Read Jam bug recordings with console logs and network requests.",
    auth: "oauth",
  },
  {
    id: "microsoft-learn",
    name: "Microsoft Learn",
    url: "https://learn.microsoft.com/api/mcp",
    description: "Search Microsoft documentation and code samples.",
    auth: "none",
  },
  {
    id: "mixpanel",
    name: "Mixpanel",
    url: "https://mcp.mixpanel.com/mcp",
    alternateUrls: [
      "https://mcp-eu.mixpanel.com/mcp",
      "https://mcp-in.mixpanel.com/mcp",
    ],
    description:
      "Query events, funnels, and retention, and build Mixpanel dashboards.",
    auth: "oauth",
  },
  {
    id: "pylon",
    name: "Pylon",
    url: "https://mcp.usepylon.com",
    alternateUrls: ["https://mcp.eu.usepylon.com"],
    description:
      "Read and update Pylon support issues, accounts, and contacts.",
    auth: "oauth",
  },
  {
    id: "statsig",
    name: "Statsig",
    url: "https://api.statsig.com/v3/mcp",
    description:
      "Manage Statsig feature gates, experiments, dynamic configs, and metrics.",
    auth: "oauth",
  },
  {
    id: "hex",
    name: "Hex",
    url: "https://app.hex.tech/mcp",
    alternateUrls: ["https://eu.hex.tech/mcp"],
    description: "Search Hex projects and ask questions about your data.",
    auth: "oauth",
  },
  {
    id: "pipedream",
    name: "Pipedream",
    url: "https://mcp.pipedream.net/v2",
    description:
      "Run actions in thousands of apps through your Pipedream accounts.",
    auth: "oauth",
  },
  {
    id: "revenuecat",
    name: "RevenueCat",
    url: "https://mcp.revenuecat.ai/mcp",
    description:
      "Manage RevenueCat apps, products, entitlements, and offerings.",
    auth: "oauth",
  },
  {
    id: "trello",
    name: "Trello",
    url: "https://mcp.trello.com/v1",
    description: "Read and update Trello boards, lists, and cards.",
    auth: "oauth",
  },
  {
    id: "webflow",
    name: "Webflow",
    url: "https://mcp.webflow.com/mcp",
    description: "Build and edit Webflow sites and manage CMS collections.",
    auth: "oauth",
  },
  {
    id: "apify",
    name: "Apify",
    url: "https://mcp.apify.com",
    description:
      "Run Apify Actors for scraping and automation and read their results.",
    auth: "oauth",
  },
  {
    id: "greptile",
    name: "Greptile",
    url: "https://api.greptile.com/mcp",
    description:
      "Read Greptile code review comments and apply suggested fixes.",
    auth: "oauth",
  },
  {
    id: "svelte",
    name: "Svelte",
    url: "https://mcp.svelte.dev/mcp",
    description: "Look up Svelte and SvelteKit docs and check Svelte code.",
    auth: "none",
  },
  {
    id: "higgsfield-ai",
    name: "Higgsfield AI",
    url: "https://mcp.higgsfield.ai/mcp",
    description:
      "Generate images, videos, characters, and audio with Higgsfield.",
    auth: "oauth",
  },
  {
    id: "dash0",
    name: "Dash0",
    url: "https://api.eu-west-1.aws.dash0.com/mcp",
    alternateUrls: [
      "https://api.eu-central-1.aws.dash0.com/mcp",
      "https://api.us-east-1.aws.dash0.com/mcp",
      "https://api.us-west-2.aws.dash0.com/mcp",
      "https://api.europe-west4.gcp.dash0.com/mcp",
    ],
    description:
      "Query logs, metrics, and traces in Dash0 to investigate production issues.",
    auth: "oauth",
    setup:
      "Pick your Dash0 region ([Settings → Endpoints](https://app.dash0.com/goto/settings/endpoints)). Add Dash0 once per region.",
  },
];
