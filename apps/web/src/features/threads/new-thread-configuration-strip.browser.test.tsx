import type { ProjectData } from "@dx/api";
import type { ProjectId, RunnerProfileId, ThinkingLevel } from "@dx/domain";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { NewThreadConfigurationStrip } from "./new-thread-configuration-strip.js";

const projectId = "prj_00000000-0000-4000-8000-000000000001" as ProjectId;
const projects = [
  { id: projectId, name: "dx" },
] as unknown as ReadonlyArray<ProjectData>;
const istanbulProject = {
  id: "prj_00000000-0000-4000-8000-000000000002" as ProjectId,
  name: "Istanbul",
} as ProjectData;
const longProject = {
  id: "prj_00000000-0000-4000-8000-000000000003" as ProjectId,
  name: "Asymmetric project title that must remain readable before its repository metadata",
  repository: {
    fullName: "dxcode-dev/metadata-that-may-truncate",
    provider: "github",
    bindingRevision: 1,
    webUrl: "https://github.com/dxcode-dev/metadata-that-may-truncate",
  },
} as ProjectData;

const choices = {
  sourceScope: "personal",
  modes: ["low", "medium", "high", "ultra"].map((mode) => ({
    mode,
    config: { model: "dx-byok/gpt-5.6-luna", thinking: "medium" },
    modelName: "GPT 5.6 Luna",
    source: "default",
    served: true,
    servingConnectionName: "LiteLLM2",
  })),
  revision: 1,
  tiers: [
    {
      id: "low",
      label: "Low",
      available: true,
      model: "dx-byok/gpt-5.6-luna",
      modelId: "gpt-5.6-luna",
      connectionName: "LiteLLM2",
    },
    {
      id: "medium",
      label: "Medium",
      available: true,
      model: "dx-byok/gpt-5.6-luna",
      modelId: "gpt-5.6-luna",
      connectionName: "LiteLLM2",
    },
    {
      id: "high",
      label: "High",
      available: true,
      model: "dx-byok/gpt-5.6-luna",
      modelId: "gpt-5.6-luna",
      connectionName: "LiteLLM2",
    },
    {
      id: "ultra",
      label: "Ultra",
      available: false,
      model: null,
      modelId: null,
      connectionName: null,
    },
  ],
  models: [
    {
      canonical: "dx-byok/gpt-5.6-luna",
      id: "gpt-5.6-luna",
      name: "GPT 5.6 Luna",
      providerId: "dx-byok",
      connectionId: "conn_1",
      connectionName: "LiteLLM2",
      contextWindow: 128_000,
      maxOutputTokens: 16_384,
      reasoning: true,
      vision: false,
    },
  ],
} as unknown as NonNullable<
  Parameters<typeof NewThreadConfigurationStrip>[0]["choices"]
>;

const runnerProfiles = [
  {
    id: "a1.tiny" as RunnerProfileId,
    label: "a1.tiny",
    availability: "available",
    resources: { cpuCores: 1, memoryMb: 2048, diskGb: 20 },
  },
  {
    id: "a1.small" as RunnerProfileId,
    label: "a1.small",
    availability: "available",
    resources: { cpuCores: 2, memoryMb: 4096, diskGb: 20 },
  },
  {
    id: "a1.medium" as RunnerProfileId,
    label: "a1.medium",
    availability: "available",
    resources: { cpuCores: 4, memoryMb: 8192, diskGb: 20 },
  },
] as unknown as NonNullable<
  Parameters<typeof NewThreadConfigurationStrip>[0]["runnerProfiles"]
>;

const renderStrip = (
  overrides: {
    readonly locked?: boolean;
    readonly runnerProfiles?: Parameters<
      typeof NewThreadConfigurationStrip
    >[0]["runnerProfiles"];
    readonly onRunnerProfileRetry?: () => void;
    readonly runnerProviders?: Parameters<
      typeof NewThreadConfigurationStrip
    >[0]["runnerProviders"];
    readonly runnerOrbs?: Parameters<
      typeof NewThreadConfigurationStrip
    >[0]["runnerOrbs"];
  } = {},
) =>
  renderToStaticMarkup(
    <NewThreadConfigurationStrip
      projects={projects}
      projectId={projectId}
      choices={choices}
      locked={overrides.locked ?? false}
      submitting={false}
      ready
      retrying={false}
      onProjectChange={() => undefined}
      runnerProfiles={overrides.runnerProfiles ?? runnerProfiles}
      runnerProviders={overrides.runnerProviders}
      runnerOrbs={overrides.runnerOrbs}
      runnerProfileId={
        overrides.runnerProfiles?.[0]?.id ?? runnerProfiles[0]?.id
      }
      onRunnerProfileChange={() => undefined}
      onRunnerProfileRetry={overrides.onRunnerProfileRetry}
      onModelChange={() => undefined}
    />,
  );

describe("new thread configuration strip accessibility", () => {
  it("offers an accessible retry when the profile catalog is unavailable", () => {
    const markup = renderStrip({
      runnerProfiles: [],
      onRunnerProfileRetry: () => undefined,
    });

    expect(markup).toContain('aria-label="Orb options unavailable. Retry"');
    expect(markup).toContain("Orb options unavailable. Retry");
  });

  it("locks the unavailable-profile retry while submitting", () => {
    const markup = renderStrip({
      locked: true,
      runnerProfiles: [],
      onRunnerProfileRetry: () => undefined,
    });

    expect(markup).toContain('aria-label="Orb options unavailable. Retry"');
    expect(markup).toMatch(
      /aria-label="Orb options unavailable\. Retry"[^>]*disabled/,
    );
  });

  it("names the provider in the label from a Core without short names, and shows its logo on the chip", () => {
    const markup = renderStrip({
      runnerProfiles: [
        {
          id: "cf.standard-2" as RunnerProfileId,
          label: "standard-2",
          adapter: "cloudflare",
          availability: "available",
          resources: { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
        },
      ] as unknown as NonNullable<
        Parameters<typeof NewThreadConfigurationStrip>[0]["runnerProfiles"]
      >,
      runnerProviders: [
        {
          adapter: "cloudflare",
          displayName: "Cloudflare Containers",
          pauseResume: "filesystem",
        },
      ],
      runnerOrbs: [
        {
          providerId: "cloudflare",
          scope: "deployment",
          account: null,
          status: "ready",
          unavailableSizes: [],
        },
      ],
    });
    expect(markup).toContain(
      'aria-label="Orb: Cloudflare Containers standard-2"',
    );
    expect(markup).toContain('data-orb-provider-logo="cloudflare"');
    expect(markup).toContain(">standard-2<");
    expect(markup).not.toContain("Cloudflare Containers ·");
  });

  it("names whose key the Orb runs on when it is not the deployment's", () => {
    const providers = [
      { adapter: "e2b", displayName: "E2B", pauseResume: "processes" },
    ] as const;
    const e2bProfiles = runnerProfiles.map((profile) => ({
      ...profile,
      adapter: "e2b" as const,
    }));
    expect(
      renderStrip({
        runnerProfiles: e2bProfiles,
        runnerProviders: providers,
        runnerOrbs: [
          {
            providerId: "e2b",
            scope: "personal",
            account: "team-a",
            status: "ready",
            unavailableSizes: [],
          },
        ],
      }),
    ).toContain('aria-label="Orb: E2B a1.tiny, your account"');
    expect(
      renderStrip({
        runnerProfiles: e2bProfiles,
        runnerProviders: providers,
        runnerOrbs: [
          {
            providerId: "e2b",
            scope: "deployment",
            account: null,
            status: "ready",
            unavailableSizes: [],
          },
        ],
      }),
    ).toContain('aria-label="Orb: E2B a1.tiny"');
  });

  it("keeps the picked model while the model list is searched", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed = vi.fn();
    try {
      await React.act(() =>
        root.render(
          <NewThreadConfigurationStrip
            choices={choices}
            projects={projects}
            projectId={projectId}
            locked={false}
            submitting={false}
            ready
            retrying={false}
            onProjectChange={() => undefined}
            onModelChange={changed}
          />,
        ),
      );
      const chip = container.querySelector<HTMLButtonElement>(
        '[aria-label="Model: Recommended, GPT 5.6 Luna, Medium effort"]',
      );
      expect(chip).not.toBeNull();
      await React.act(() => chip?.click());
      const search = document.querySelector<HTMLInputElement>(
        'input[aria-label="Search models"]',
      );
      expect(search).not.toBeNull();
      await React.act(() => {
        if (search === null) return;
        const setValue = Object.getOwnPropertyDescriptor(
          HTMLInputElement.prototype,
          "value",
        )?.set;
        setValue?.call(search, "no such model");
        search.dispatchEvent(new Event("input", { bubbles: true }));
      });
      expect(document.body.textContent).toContain(
        "No models match “no such model”.",
      );
      expect(
        container.querySelector(
          '[aria-label="Model: Recommended, GPT 5.6 Luna, Medium effort"]',
        ),
      ).not.toBeNull();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("shows who pays for each model, and Recommended clears a picked model", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelChanged = vi.fn();

    function Harness() {
      const [model, setModel] = React.useState<string | undefined>(
        "dx-byok/gpt-5.6-luna",
      );
      return (
        <NewThreadConfigurationStrip
          choices={{
            ...choices,
            modes: choices.modes.map((mode) => ({
              ...mode,
              servingConnectionName: "Different mode provider",
            })),
          }}
          projects={projects}
          projectId={projectId}
          model={model}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={(next) => {
            modelChanged(next);
            setModel(next);
          }}
        />
      );
    }

    try {
      await React.act(() => root.render(<Harness />));
      const picked = container.querySelector<HTMLButtonElement>(
        '[aria-label="Model: GPT 5.6 Luna, High effort"]',
      );
      expect(picked).not.toBeNull();
      await React.act(() => picked?.click());
      const options = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      );
      // The model's group names the connection that pays for it.
      expect(
        Array.from(document.querySelectorAll(".dx-picker-label")).map(
          (label) => label.textContent,
        ),
      ).toContain("LiteLLM2");
      const recommended = options.find((option) =>
        option.textContent?.startsWith("Recommended"),
      );
      expect(recommended?.textContent).toContain("Different mode provider");
      await React.act(() => recommended?.click());

      expect(modelChanged).toHaveBeenCalledWith(undefined);
      expect(
        container.querySelector(
          '[aria-label="Model: Recommended, GPT 5.6 Luna, Medium effort"]',
        ),
      ).not.toBeNull();
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("opens with Control+S on the search and sets the picked model's effort", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const effortChanged = vi.fn();

    function Harness() {
      const [effort, setEffort] = React.useState<ThinkingLevel>();
      return (
        <NewThreadConfigurationStrip
          choices={choices}
          projects={projects}
          projectId={projectId}
          effort={effort}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onEffortChange={(next) => {
            effortChanged(next);
            setEffort(next);
          }}
        />
      );
    }

    await React.act(() => root.render(<Harness />));
    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "s",
          ctrlKey: true,
          bubbles: true,
        }),
      ),
    );
    const search = document.querySelector<HTMLElement>(
      'input[aria-label="Search models"]',
    );
    await React.act(() =>
      vi.waitFor(() => expect(document.activeElement).toBe(search)),
    );
    // Fast Mode stays out of the picker.
    expect(
      document.querySelector('[role="switch"][aria-label="Fast Mode"]'),
    ).toBeNull();
    const effortButton = (name: string) =>
      Array.from(
        document.querySelectorAll<HTMLButtonElement>(
          'fieldset[aria-label="Effort"] button',
        ),
      ).find((button) => button.textContent === name);
    expect(effortButton("Medium")?.getAttribute("aria-pressed")).toBe("true");
    await React.act(() => effortButton("Max")?.click());
    expect(effortChanged).toHaveBeenCalledWith("max");
    expect(effortButton("Max")?.getAttribute("aria-pressed")).toBe("true");
    expect(
      container.querySelector(
        '[aria-label="Model: Recommended, GPT 5.6 Luna, Max effort"]',
      ),
    ).not.toBeNull();

    await React.act(() => root.unmount());
    container.remove();
  });

  it("does not open the model picker from Control+S while locked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          locked
          submitting
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
        />,
      ),
    );
    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
      ),
    );
    expect(
      document.querySelector('input[aria-label="Search models"]'),
    ).toBeNull();
    await React.act(() => root.unmount());
    container.remove();
  });

  it("opens the project picker with exactly Control+J", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
        />,
      ),
    );
    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true }),
      ),
    );
    // The popup moves focus to its filter once it has opened.
    await React.act(() =>
      vi.waitFor(() =>
        expect(
          document.querySelector<HTMLInputElement>(
            '[aria-label="Filter projects"]',
          ),
        ).toBe(document.activeElement),
      ),
    );

    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          key: "j",
          ctrlKey: true,
          shiftKey: true,
        }),
      ),
    );
    expect(
      document.querySelectorAll('[aria-label="Filter projects"]'),
    ).toHaveLength(1);
    await React.act(() => root.unmount());
    container.remove();
  });

  it("loads additional projects and filters ASCII names independently of locale", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const loadMore = vi.fn();
    await React.act(() =>
      root.render(
        <NewThreadConfigurationStrip
          projects={[...projects, istanbulProject]}
          projectId={projectId}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          hasMoreProjects
          onLoadMoreProjects={loadMore}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      '[aria-label^="Project:"]',
    );
    await React.act(() => trigger?.click());
    const filter = document.querySelector<HTMLInputElement>(
      '[aria-label="Filter projects"]',
    );
    await React.act(() => {
      if (filter === null) return;
      const setValue = Object.getOwnPropertyDescriptor(
        HTMLInputElement.prototype,
        "value",
      )?.set;
      setValue?.call(filter, "istanbul");
      filter.dispatchEvent(new Event("input", { bubbles: true }));
    });
    expect(document.body.textContent).toContain("Istanbul");
    await React.act(() =>
      document
        .querySelector<HTMLButtonElement>(".thread-context-load-more")
        ?.click(),
    );
    expect(loadMore).toHaveBeenCalledOnce();
    await React.act(() => root.unmount());
    container.remove();
  });

  it("shows repository badges, recent selection, and selects No Project", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed = vi.fn();
    try {
      await React.act(() =>
        root.render(
          <NewThreadConfigurationStrip
            projects={[longProject, istanbulProject]}
            projectId={longProject.id}
            locked={false}
            submitting={false}
            ready
            retrying={false}
            onProjectChange={changed}
            onModelChange={() => undefined}
          />,
        ),
      );
      await React.act(() =>
        container
          .querySelector<HTMLButtonElement>(".new-thread-project")
          ?.click(),
      );
      const popup = document.querySelector(".project-picker-popup");
      expect(popup?.textContent).toContain("Recent");
      expect(popup?.textContent).toContain("GitHub");
      expect(popup?.querySelector("[data-selected]")?.textContent).toContain(
        longProject.name,
      );
      const noProject = Array.from(
        popup?.querySelectorAll<HTMLElement>('[role="option"]') ?? [],
      ).find((el) => el.textContent === "No Project");
      await React.act(() => noProject?.click());
      expect(changed).toHaveBeenCalledWith("");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });
});

describe("new thread Orb picker", () => {
  const providers = [
    {
      adapter: "e2b",
      displayName: "E2B",
      shortName: "E2B",
      pauseResume: "processes",
    },
    {
      adapter: "cloudflare",
      displayName: "Cloudflare Containers",
      shortName: "Cloudflare",
      pauseResume: "filesystem",
    },
  ] as const;
  const profiles = [
    ...runnerProfiles.map((profile) => ({
      ...profile,
      adapter: "e2b" as const,
    })),
    {
      id: "cf.standard-1" as RunnerProfileId,
      label: "standard-1",
      adapter: "cloudflare" as const,
      availability: "available",
      resources: { cpuCores: 0.5, memoryMb: 4096, diskGb: 8 },
    },
    {
      id: "cf.standard-2" as RunnerProfileId,
      label: "standard-2",
      adapter: "cloudflare" as const,
      availability: "available",
      resources: { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
    },
  ] as unknown as NonNullable<
    Parameters<typeof NewThreadConfigurationStrip>[0]["runnerProfiles"]
  >;

  const mountPicker = async (
    runnerOrbs: Parameters<typeof NewThreadConfigurationStrip>[0]["runnerOrbs"],
    onRunnerProfileChange = vi.fn(),
  ) => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          runnerProfiles={profiles}
          runnerProviders={providers}
          runnerOrbs={runnerOrbs}
          runnerProfileId={"cf.standard-1" as RunnerProfileId}
          onRunnerProfileChange={onRunnerProfileChange}
          onModelChange={() => undefined}
        />,
      ),
    );
    const trigger = container.querySelector<HTMLButtonElement>(
      ".new-thread-orb-size",
    );
    return {
      trigger,
      onRunnerProfileChange,
      providerRow: (name: string) =>
        Array.from(
          document.querySelectorAll<HTMLElement>(
            '[role="menuitem"][aria-haspopup="menu"]',
          ),
        ).find((row) => row.textContent?.startsWith(name)),
      unmount: async () => {
        await React.act(() => root.unmount());
        container.remove();
      },
    };
  };

  it("shows the provider's logo and the size on a compact trigger", async () => {
    const picker = await mountPicker([
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
        unavailableSizes: [],
      },
    ]);
    try {
      expect(picker.trigger?.textContent).toBe("standard-1");
      expect(
        picker.trigger?.querySelector(
          'img[data-orb-provider-logo="cloudflare"]',
        ),
      ).not.toBeNull();
      expect(picker.trigger?.getAttribute("aria-haspopup")).toBe("menu");
      expect(picker.trigger?.getAttribute("aria-label")).toBe(
        "Orb: Cloudflare standard-1",
      );
    } finally {
      await picker.unmount();
    }
  });

  it("lists one row per resolved provider, naming only a non-deployment key", async () => {
    const picker = await mountPicker([
      {
        providerId: "e2b",
        scope: "personal",
        account: "team-a",
        status: "ready",
        unavailableSizes: [],
      },
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
        unavailableSizes: [],
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      const rows = document.querySelectorAll(
        '[role="menuitem"][aria-haspopup="menu"]',
      );
      expect(Array.from(rows, (row) => row.textContent)).toEqual([
        "E2BYour account",
        "Cloudflare",
      ]);
      expect(picker.providerRow("E2B")?.getAttribute("title")).toBe(
        "Pause keeps running processes",
      );
    } finally {
      await picker.unmount();
    }
  });

  it("offers only providers in the resolved set", async () => {
    const picker = await mountPicker([
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
        unavailableSizes: [],
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      expect(picker.providerRow("E2B")).toBeUndefined();
      expect(picker.providerRow("Cloudflare")).toBeDefined();
    } finally {
      await picker.unmount();
    }
  });

  it("marks the selected size with a dot and selects another from the submenu", async () => {
    const picker = await mountPicker([
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
        unavailableSizes: [],
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      await React.act(() => picker.providerRow("Cloudflare")?.click());
      const sizes = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      );
      expect(sizes.map((size) => size.textContent)).toEqual([
        "standard-10.5 CPU · 4 GiB",
        "standard-21 CPU · 6 GiB",
      ]);
      expect(sizes.map((size) => size.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
      ]);
      expect(
        sizes[0]?.querySelector(".dx-menu-check[data-checked]"),
      ).not.toBeNull();
      expect(
        sizes[1]?.querySelector(".dx-menu-check[data-checked]"),
      ).toBeNull();

      await React.act(() => sizes[1]?.click());
      expect(picker.onRunnerProfileChange).toHaveBeenCalledWith(
        "cf.standard-2",
      );
    } finally {
      await picker.unmount();
    }
  });

  it("disables a provider's sizes while its connection prepares", async () => {
    const picker = await mountPicker([
      {
        providerId: "e2b",
        scope: "personal",
        account: "team-a",
        status: "preparing",
        unavailableSizes: [],
      },
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
        unavailableSizes: [],
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      const row = picker.providerRow("E2B");
      expect(row?.textContent).toBe("E2BPreparing…");
      await React.act(() => row?.click());
      const sizes = document.querySelectorAll('[role="menuitemradio"]');
      expect(sizes).toHaveLength(3);
      for (const size of sizes)
        expect(size.getAttribute("aria-disabled")).toBe("true");
    } finally {
      await picker.unmount();
    }
  });
});
