// @vitest-environment happy-dom

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import type { ProjectData } from "@dx/api";
import type { ModeId, ProjectId, RunnerProfileId } from "@dx/domain";
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
const source = readFileSync(
  resolve(
    process.cwd(),
    "apps/web/src/features/threads/new-thread-configuration-strip.tsx",
  ),
  "utf8",
);
const styles = readFileSync(
  resolve(process.cwd(), "apps/web/src/styles.css"),
  "utf8",
);

const choices = {
  sourceScope: "personal",
  modes: ["low", "medium", "high", "ultra"].map((mode) => ({
    mode,
    config: { model: "dx-byok/gpt-5.6-luna", thinking: "medium" },
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
} as unknown as Parameters<typeof NewThreadConfigurationStrip>[0]["choices"];

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
    readonly retrying?: boolean;
    readonly runnerProfileId?: RunnerProfileId;
    readonly runnerProfileLoading?: boolean;
    readonly allowedRunnerProfileIds?: ReadonlyArray<RunnerProfileId> | null;
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
      profile="high"
      choices={choices}
      locked={overrides.locked ?? false}
      submitting={false}
      ready
      retrying={overrides.retrying ?? false}
      onProjectChange={() => undefined}
      runnerProfiles={overrides.runnerProfiles ?? runnerProfiles}
      runnerProviders={overrides.runnerProviders}
      runnerOrbs={overrides.runnerOrbs}
      runnerProfileId={
        overrides.runnerProfileId ??
        overrides.runnerProfiles?.[0]?.id ??
        runnerProfiles[0]?.id
      }
      runnerProfileLoading={overrides.runnerProfileLoading}
      allowedRunnerProfileIds={overrides.allowedRunnerProfileIds}
      onRunnerProfileChange={() => undefined}
      onRunnerProfileRetry={overrides.onRunnerProfileRetry}
      onModelChange={() => undefined}
      onProfileChange={() => undefined}
      dictationControls={
        <button
          type="button"
          aria-label="Press to dictate. Hold to dictate and send."
        />
      }
    />,
  );

describe("new thread configuration strip accessibility", () => {
  it("keeps the Orb affordance stable while its profile catalog loads", () => {
    const markup = renderStrip({
      runnerProfiles: [],
      runnerProfileLoading: true,
    });

    expect(markup).toContain('aria-label="Orb"');
    expect(markup).toContain("Loading Orb options");
    expect(markup).not.toContain('aria-label="Orb: a1.tiny"');
  });

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

  it("falls back to the provider's display name from a Core without short names", () => {
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
    });
    expect(markup).toContain(
      'aria-label="Orb: Cloudflare Containers standard-2"',
    );
    expect(markup).toContain(">Cloudflare Containers · standard-2<");
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
          },
        ],
      }),
    ).toContain('aria-label="Orb: E2B a1.tiny, your key"');
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
          },
        ],
      }),
    ).toContain('aria-label="Orb: E2B a1.tiny"');
    // A key whose template still builds cannot start a Thread yet.
    expect(source).toContain('group.orb.status !== "ready"');
  });

  it("uses the configured runner-profile catalog rather than a hard-coded Orb size", () => {
    expect(renderStrip()).toContain('aria-label="Orb: a1.tiny"');
    expect(renderStrip({ runnerProfileId: runnerProfiles[1]?.id })).toContain(
      'aria-label="Orb: a1.small"',
    );
    expect(renderStrip({ runnerProfileId: runnerProfiles[2]?.id })).toContain(
      'aria-label="Orb: a1.medium"',
    );
    expect(source).not.toContain("a1.medium");
    expect(source).not.toContain("a1.large");
    expect(source).not.toContain("MoreVertical");
  });

  it("disables profiles excluded by a workspace restriction", () => {
    expect(source).toContain("new Set(allowedRunnerProfileIds)");
    expect(source).toContain("allowedRunnerProfileIdSet.has(runnerProfile.id)");
    expect(source).toContain('runnerProfile.availability !== "available" ||');
  });

  it("keeps truthful full names and renders the supplied dictation control", () => {
    const markup = renderStrip();

    expect(markup).not.toContain("Executor: ");
    expect(markup).toContain(">a1.tiny</span>");
    expect(markup).toContain('aria-label="Project: dx"');
    expect(source).toContain("Choose a project…");
    expect(markup).toContain('aria-label="Reasoning mode: high"');
    expect(source).toContain("Choose a mode");
    expect(source).toContain("<ModeDialPlate");
    expect(source).toContain("Raw Models");
    expect(source).toContain("Choose a Model…");
    expect(source).toContain('pickerTab === "modes" ? (');
    expect(source).toContain("dx Modes");
    expect(source).not.toContain("<Zap");
    expect(source).not.toContain("CHATGPT SUBSCRIPTION CONNECTED");
    expect(source).toContain("<OrbIcon");
    expect(markup).toContain(
      'aria-label="Press to dictate. Hold to dictate and send."',
    );
  });

  it("uses compact project rows with a trailing selection check", () => {
    expect(source).toContain('className="project-picker-check"');
    expect(source).toContain('className="project-picker-repository"');
    expect(styles).toContain(".project-picker-option[data-selected]");
  });

  it("orders compact controls as Orb, Project, then Mode", () => {
    const markup = renderStrip();
    const orb = markup.indexOf('aria-label="Orb: a1.tiny"');
    const project = markup.indexOf('aria-label="Project: dx"');
    const mode = markup.indexOf('aria-label="Reasoning mode: high"');

    expect(orb).toBeGreaterThanOrEqual(0);
    expect(project).toBeGreaterThan(orb);
    expect(mode).toBeGreaterThan(project);
  });

  it("preserves the retry submit accessible name", () => {
    expect(renderStrip({ retrying: true })).toContain(
      'aria-label="Retry sending message"',
    );
  });

  it("keeps a valid mode when switching to the raw-model tab", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const changed = vi.fn();
    function Harness() {
      const [profile, setProfile] = React.useState<ModeId>("medium");
      return (
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          profile={profile}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onProfileChange={(next) => {
            changed(next);
            setProfile(next);
          }}
        />
      );
    }
    try {
      await React.act(() => root.render(<Harness />));
      await React.act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Reasoning mode: medium"]',
          )
          ?.click(),
      );
      const rawTab = Array.from(
        document.querySelectorAll<HTMLButtonElement>('[role="tab"]'),
      ).find((tab) => tab.textContent === "Raw Models");
      expect(rawTab).toBeDefined();
      await React.act(() => rawTab?.click());
      expect(
        document.querySelector('[aria-label="Search models"]'),
      ).not.toBeNull();
      expect(
        container.querySelector('[aria-label="Reasoning mode: medium"]'),
      ).not.toBeNull();
      expect(changed).not.toHaveBeenCalled();
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("clears a pinned raw model when selecting a mode", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    const modelChanged = vi.fn();
    const profileChanged = vi.fn();

    function Harness() {
      const [profile, setProfile] = React.useState<ModeId>("medium");
      const [model, setModel] = React.useState<string | undefined>(
        "dx-byok/gpt-5.6-luna",
      );
      return (
        <NewThreadConfigurationStrip
          choices={{
            ...choices!,
            modes: choices!.modes.map((mode) => ({
              ...mode,
              servingConnectionName: "Different mode provider",
            })),
          }}
          projects={projects}
          projectId={projectId}
          profile={profile}
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
          onProfileChange={(next) => {
            profileChanged(next);
            setProfile(next);
          }}
        />
      );
    }

    try {
      await React.act(() => root.render(<Harness />));
      expect(
        container.querySelector('[aria-label="Model: dx-byok/gpt-5.6-luna"]'),
      ).not.toBeNull();

      await React.act(() =>
        container
          .querySelector<HTMLButtonElement>(
            '[aria-label="Model: dx-byok/gpt-5.6-luna"]',
          )
          ?.click(),
      );
      expect(document.body.textContent).toContain("SERVED BY LiteLLM2");
      expect(document.body.textContent).not.toContain(
        "SERVED BY Different mode provider",
      );
      const highMode = Array.from(
        document.querySelectorAll<HTMLElement>('[role="option"]'),
      ).find((option) => option.textContent?.includes("high"));
      expect(highMode).toBeDefined();
      await React.act(() => highMode?.click());

      expect(modelChanged).toHaveBeenCalledWith(undefined);
      expect(profileChanged).toHaveBeenCalledWith("high");
      expect(
        container.querySelector('[aria-label="Reasoning mode: high"]'),
      ).not.toBeNull();
      expect(container.textContent).toContain("Mode: high");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("opens with Control+S and exposes working dial without Fast Mode controls", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);

    function Harness() {
      const [profile, setProfile] = React.useState<ModeId>("medium");
      return (
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          profile={profile}
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onProfileChange={setProfile}
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

    const dial = document.querySelector<HTMLElement>('[role="slider"]');
    const fastMode = document.querySelector<HTMLButtonElement>(
      '[role="switch"][aria-label="Fast Mode"]',
    );
    expect(dial?.getAttribute("aria-valuetext")).toBe("Medium");
    expect(dial?.getAttribute("aria-keyshortcuts")).toBe(
      "ArrowLeft ArrowRight ArrowUp ArrowDown",
    );
    expect(document.activeElement).toBe(dial);
    expect(fastMode).toBeNull();
    expect(
      document.querySelector(".mode-dial-position.active .mode-plate-label")
        ?.textContent,
    ).toBe("MED");

    await React.act(() =>
      dial?.dispatchEvent(
        new KeyboardEvent("keydown", { key: "ArrowUp", bubbles: true }),
      ),
    );
    expect(dial?.getAttribute("aria-valuetext")).toBe("High");
    expect(
      document.querySelector(".mode-dial-position.active .mode-plate-label")
        ?.textContent,
    ).toBe("HIGH");
    expect(
      document.querySelector<SVGGElement>(".mode-dial-rotor")?.style.transform,
    ).toBe("rotate(15deg)");

    if (dial !== null) {
      Object.defineProperties(dial, {
        getBoundingClientRect: {
          value: () => ({
            x: 100,
            y: 100,
            top: 100,
            right: 200,
            bottom: 200,
            left: 100,
            width: 100,
            height: 100,
            toJSON: () => undefined,
          }),
        },
        setPointerCapture: { value: vi.fn() },
      });
      await React.act(() =>
        dial.dispatchEvent(
          new PointerEvent("pointerdown", {
            clientX: 113,
            clientY: 166,
            pointerId: 1,
            bubbles: true,
          }),
        ),
      );
      expect(dial.getAttribute("aria-valuetext")).toBe("Low");

      await React.act(() =>
        dial.dispatchEvent(
          new PointerEvent("pointerdown", {
            clientX: 187,
            clientY: 166,
            pointerId: 2,
            bubbles: true,
          }),
        ),
      );
      expect(dial.getAttribute("aria-valuetext")).toBe("Ultra");
      expect(
        document.querySelector(".mode-dial-position.active .mode-plate-label")
          ?.textContent,
      ).toBe("ULTRA");
      await React.act(() =>
        dial.dispatchEvent(
          new PointerEvent("pointerup", {
            pointerId: 2,
            bubbles: true,
          }),
        ),
      );
      expect(document.querySelector('[role="slider"]')).toBe(dial);
    }

    await React.act(() => root.unmount());
    container.remove();
  });

  it("does not open the mode picker from Control+S while locked", async () => {
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    await React.act(() =>
      root.render(
        <NewThreadConfigurationStrip
          projects={projects}
          projectId={projectId}
          profile="medium"
          locked
          submitting
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onProfileChange={() => undefined}
        />,
      ),
    );
    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "s", ctrlKey: true }),
      ),
    );
    expect(document.querySelector('[role="slider"]')).toBeNull();
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
          profile="medium"
          locked={false}
          submitting={false}
          ready
          retrying={false}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onProfileChange={() => undefined}
        />,
      ),
    );
    await React.act(() =>
      window.dispatchEvent(
        new KeyboardEvent("keydown", { key: "j", ctrlKey: true }),
      ),
    );
    expect(
      document.querySelector<HTMLInputElement>(
        '[aria-label="Filter projects"]',
      ),
    ).toBe(document.activeElement);

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
          profile="medium"
          locked={false}
          submitting={false}
          ready
          retrying={false}
          hasMoreProjects
          onLoadMoreProjects={loadMore}
          onProjectChange={() => undefined}
          onModelChange={() => undefined}
          onProfileChange={() => undefined}
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

  it("gives a long project title its row width before truncating metadata", async () => {
    const markup = renderToStaticMarkup(
      <NewThreadConfigurationStrip
        projects={[longProject]}
        projectId={longProject.id}
        profile="medium"
        locked={false}
        submitting={false}
        ready
        retrying={false}
        onProjectChange={() => undefined}
        onModelChange={() => undefined}
        onProfileChange={() => undefined}
      />,
    );

    expect(markup).toContain(longProject.name);
    expect(source).toContain("project-picker-name");
    expect(source).toContain("project.repository?.fullName");
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
            profile="medium"
            locked={false}
            submitting={false}
            ready
            retrying={false}
            onProjectChange={changed}
            onModelChange={() => undefined}
            onProfileChange={() => undefined}
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
          profile="medium"
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
          onProfileChange={() => undefined}
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

  it("shows the provider's short name and the size on a compact trigger", async () => {
    const picker = await mountPicker(undefined);
    try {
      expect(picker.trigger?.textContent).toBe("Cloudflare · standard-1");
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
      },
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      const rows = document.querySelectorAll(
        '[role="menuitem"][aria-haspopup="menu"]',
      );
      expect(Array.from(rows, (row) => row.textContent)).toEqual([
        "E2BYour key",
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
    const picker = await mountPicker(undefined);
    try {
      await React.act(() => picker.trigger?.click());
      await React.act(() => picker.providerRow("Cloudflare")?.click());
      const sizes = Array.from(
        document.querySelectorAll<HTMLElement>('[role="menuitemradio"]'),
      );
      expect(sizes.map((size) => size.textContent)).toEqual([
        "standard-10.5 CPU · 4 GB",
        "standard-21 CPU · 6 GB",
      ]);
      expect(sizes.map((size) => size.getAttribute("aria-checked"))).toEqual([
        "true",
        "false",
      ]);
      expect(sizes[0]?.querySelector(".orb-picker-dot")).not.toBeNull();
      expect(sizes[1]?.querySelector(".orb-picker-dot")).toBeNull();

      await React.act(() => sizes[1]?.click());
      expect(picker.onRunnerProfileChange).toHaveBeenCalledWith(
        "cf.standard-2",
      );
    } finally {
      await picker.unmount();
    }
  });

  it("opens a provider's sizes with the keyboard", async () => {
    const picker = await mountPicker(undefined);
    try {
      await React.act(() => picker.trigger?.click());
      const row = picker.providerRow("E2B");
      await React.act(() => {
        row?.focus();
        row?.dispatchEvent(
          new KeyboardEvent("keydown", { key: "ArrowRight", bubbles: true }),
        );
      });
      expect(row?.getAttribute("aria-expanded")).toBe("true");
      expect(
        Array.from(
          document.querySelectorAll('[role="menuitemradio"]'),
          (size) => size.firstElementChild?.firstElementChild?.textContent,
        ),
      ).toEqual(["a1.tiny", "a1.small", "a1.medium"]);
    } finally {
      await picker.unmount();
    }
  });

  it("disables a provider's sizes while its key's template builds", async () => {
    const picker = await mountPicker([
      {
        providerId: "e2b",
        scope: "personal",
        account: "team-a",
        status: "building",
      },
      {
        providerId: "cloudflare",
        scope: "deployment",
        account: null,
        status: "ready",
      },
    ]);
    try {
      await React.act(() => picker.trigger?.click());
      const row = picker.providerRow("E2B");
      expect(row?.textContent).toBe("E2BBuilding template…");
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
