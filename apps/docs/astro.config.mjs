import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
  // Canonical URLs and the sitemap point at the hosted docs, including when a
  // self-hosted deployment serves the same pages.
  site: "https://dxcode.dev",
  base: "/docs",
  integrations: [
    starlight({
      title: "dx docs",
      description:
        "Run coding agents in the cloud with dx: Threads, Orbs, and the models you bring.",
      favicon: "/favicon.svg",
      head: [
        {
          tag: "link",
          attrs: {
            rel: "alternate",
            type: "application/rss+xml",
            title: "dx Log",
            href: "/docs/log/rss.xml",
          },
        },
      ],
      components: {
        PageTitle: "./src/components/PageTitle.astro",
      },
      customCss: [
        "@fontsource/dm-sans/400.css",
        "@fontsource/dm-sans/400-italic.css",
        "@fontsource/dm-sans/500.css",
        "@fontsource/dm-sans/600.css",
        "@fontsource/instrument-serif/400.css",
        "@fontsource/dm-mono/400.css",
        "./src/styles/custom.css",
      ],
      social: [
        {
          icon: "github",
          label: "dxcode on GitHub",
          href: "https://github.com/dxcode-dev/dxcode",
        },
      ],
      sidebar: [
        { label: "dx Log", link: "/log/" },
        {
          label: "Get started",
          items: [
            { label: "Getting started", slug: "use/getting-started" },
            { label: "Connecting a model", slug: "use/connect-a-model" },
            {
              label: "Connecting an Orb provider",
              slug: "use/connect-an-orb-provider",
            },
            {
              label: "Terminal, Desktop, and Portal",
              slug: "get-started/workspace-tools",
            },
            {
              label: "Workspace members",
              slug: "get-started/workspace-members",
            },
          ],
        },
        {
          label: "Claude Code",
          items: [
            {
              label: "Run Claude Code in the cloud",
              slug: "guides/run-claude-code-in-the-cloud",
            },
            {
              label: "Your Claude Pro or Max plan",
              slug: "guides/claude-pro-max-plan-in-the-cloud",
            },
            {
              label: "Claude Code usage limits",
              slug: "guides/claude-code-usage-limits",
            },
          ],
        },
        {
          label: "Orb providers",
          items: [
            {
              label: "Sandboxes compared",
              slug: "guides/sandboxes-for-ai-coding-agents",
            },
            { label: "E2B", slug: "guides/e2b" },
            {
              label: "Cloudflare Containers",
              slug: "guides/cloudflare-containers",
            },
            { label: "Freestyle", slug: "guides/freestyle" },
            {
              label: "Docker Cloud Sandboxes",
              slug: "guides/docker-cloud-sandboxes",
            },
            { label: "Boat", slug: "guides/boat" },
          ],
        },
        {
          label: "Self-host",
          collapsed: true,
          items: [
            { label: "Before you deploy", slug: "get-started/overview" },
            { label: "Install and deploy", slug: "get-started/install" },
            {
              label: "First project and thread",
              slug: "get-started/first-project",
            },
            {
              label: "Deployment configuration",
              slug: "deployment/configuration",
            },
            {
              label: "Sign-in and authentication",
              slug: "deployment/authentication",
            },
            { label: "E2B profiles", slug: "deployment/e2b-profiles" },
            {
              label: "Models and providers",
              slug: "deployment/models-providers",
            },
            { label: "GitHub source access", slug: "deployment/github-source" },
            {
              label: "Bitbucket source access",
              slug: "deployment/bitbucket-source",
            },
            { label: "GitHub Copilot", slug: "deployment/github-copilot" },
            { label: "Claude Pro/Max", slug: "deployment/claude-code" },
            { label: "Deploy from a fork", slug: "deployment/fork" },
            {
              label: "Upgrade and recovery",
              slug: "operations/upgrade-recovery",
            },
          ],
        },
        {
          label: "Support",
          items: [
            { label: "Troubleshooting", slug: "operations/troubleshooting" },
          ],
        },
        {
          label: "Contribute",
          collapsed: true,
          items: [
            {
              label: "Local development",
              slug: "contributing/local-development",
            },
            { label: "Contribution guide", slug: "contributing/guide" },
          ],
        },
      ],
    }),
  ],
});
