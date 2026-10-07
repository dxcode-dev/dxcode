import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";

export default defineConfig({
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
          label: "Get started",
          items: [
            { label: "Overview", slug: "get-started/overview" },
            { label: "Install and deploy", slug: "get-started/install" },
            {
              label: "First project and thread",
              slug: "get-started/first-project",
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
