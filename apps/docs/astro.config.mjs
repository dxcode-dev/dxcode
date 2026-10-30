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
      description: "Deploy, operate, and contribute to dx.",
      favicon: "/favicon.svg",
      customCss: ["./src/styles/custom.css"],
      social: [
        {
          icon: "github",
          label: "dxcode on GitHub",
          href: "https://github.com/dxcode-dev/dxcode",
        },
      ],
      sidebar: [
        {
          label: "Use dx",
          items: [
            { label: "Getting started", slug: "use/getting-started" },
            { label: "Connecting a model", slug: "use/connect-a-model" },
            {
              label: "Connecting an Orb provider",
              slug: "use/connect-an-orb-provider",
            },
          ],
        },
        {
          label: "Guides",
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
          ],
        },
        {
          label: "Get started",
          items: [
            { label: "Overview", slug: "get-started/overview" },
            { label: "Install and deploy", slug: "get-started/install" },
            {
              label: "First project and thread",
              slug: "get-started/first-project",
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
          label: "Deploy and operate",
          items: [
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
            {
              label: "GitHub source access",
              slug: "deployment/github-source",
            },
            {
              label: "Bitbucket source access",
              slug: "deployment/bitbucket-source",
            },
            {
              label: "GitHub Copilot",
              slug: "deployment/github-copilot",
            },
            {
              label: "Claude Pro/Max",
              slug: "deployment/claude-code",
            },
            { label: "Deploy from a fork", slug: "deployment/fork" },
            {
              label: "Upgrade and recovery",
              slug: "operations/upgrade-recovery",
            },
            { label: "Troubleshooting", slug: "operations/troubleshooting" },
          ],
        },
        {
          label: "Contribute",
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
