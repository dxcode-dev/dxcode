import type { ChoicesData, OrbResolvedProvider, ProjectData } from "@dx/api";
import type {
  ProjectId,
  RunnerProfile,
  RunnerProfileId,
  RunnerProviderPresentation,
  UserId,
} from "@dx/domain";
import type { Meta, StoryObj } from "@storybook/react-vite";
import { useQueryClient } from "@tanstack/react-query";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import { expect, fn, screen, userEvent, waitFor, within } from "storybook/test";
import { HomeScreen } from "./features/home/home-screen.js";
import {
  newThreadOrbProvidersQueryOptions,
  type OrbProviderListData,
} from "./features/settings/orb-providers/orb-providers-queries.js";
import {
  InlineNewThreadFrame,
  useInlineNewThread,
} from "./features/threads/inline-new-thread-frame.js";
import { NewThreadComposer } from "./features/threads/new-thread-composer.js";
import { AuthContext } from "./shared/auth/auth-context.js";
import { CommandProvider } from "./shared/commands/command-provider.js";
import {
  NewThreadSurfaceContext,
  useInlineNewThreadRouting,
  useNewThreadSurface,
} from "./shared/new-thread-surface.js";
import { Button } from "./shared/ui/button.js";
import { useMobile } from "./shared/use-mobile.js";
import { StoryQueryProvider } from "./testing/story-query-provider.js";

const projectId = "prj_00000000-0000-4000-8000-000000002271" as ProjectId;
const PROJECTS = [
  {
    id: projectId,
    name: "dx",
    repository: { provider: "github", owner: "dxcode-dev", name: "dx" },
  },
] as unknown as ReadonlyArray<ProjectData>;
const PROVIDERS: ReadonlyArray<RunnerProviderPresentation> = [
  {
    adapter: "cloudflare",
    displayName: "Cloudflare Containers",
    shortName: "Cloudflare",
    pauseResume: "filesystem",
  },
] as unknown as ReadonlyArray<RunnerProviderPresentation>;
const SIZE = "cf.standard-2" as RunnerProfileId;
const RUNNER_PROFILES = [
  {
    id: SIZE,
    label: "standard-2",
    adapter: "cloudflare",
    availability: "available",
    resources: { cpuCores: 1, memoryMb: 6144, diskGb: 12 },
  },
] as unknown as ReadonlyArray<RunnerProfile>;
const READY_ORBS: ReadonlyArray<OrbResolvedProvider> = [
  {
    providerId: "cloudflare",
    scope: "deployment",
    account: null,
    status: "ready",
    unavailableSizes: [],
  },
] as unknown as ReadonlyArray<OrbResolvedProvider>;
const CHOICES = {
  modes: ["low", "medium", "high", "ultra"].map((mode) => ({
    mode,
    config: { model: "anthropic/claude-opus-5-5", thinking: "high" },
    modelName: "Claude Opus 5.5",
    source: "default",
    served: true,
    servingConnectionName: "Anthropic API key",
  })),
  models: [
    {
      canonical: "anthropic/claude-opus-5-5",
      name: "Claude Opus 5.5",
      connectionId: "conn_anthropic",
      connectionName: "Anthropic API key",
      contextWindow: 200_000,
      reasoning: true,
      vision: true,
    },
  ],
  claudePlans: [],
} as unknown as ChoicesData;

const DRAFT = `Add an inline composer to the home page.

On a wide screen it replaces the dx mark; on a phone a button under the mark opens the composer.`;

type StoryArgs = {
  /** What the composer shows: ready, still loading, or failed to load. */
  readonly state: "ready" | "loading" | "error";
  /** The saved draft the composer opens with. */
  readonly draft: string;
  /** Whether the person has a Project; none starts a No Project Thread. */
  readonly hasProjects: boolean;
  /** Whether an Orb provider is set up; a new workspace has none. */
  readonly orbReady: boolean;
  /** The New Thread dialog opening: everywhere but the wide home page. */
  readonly onOpenDialog: () => void;
};

/** The real composer on fixture data, as the home page frames it. */
function FixtureComposer({
  state,
  draft,
  hasProjects,
  orbReady,
}: Omit<StoryArgs, "onOpenDialog">) {
  const [prompt, setPrompt] = React.useState(draft);
  const [chosenProject, setChosenProject] = React.useState<ProjectId | "">(
    hasProjects ? projectId : "",
  );
  const textareaRef = React.useRef<HTMLTextAreaElement>(null);
  // As the app's InlineNewThread does: "new Thread" focuses this composer.
  useInlineNewThread(() => textareaRef.current?.focus());
  if (state === "loading") return <InlineNewThreadFrame loading />;
  if (state === "error")
    return (
      <InlineNewThreadFrame>
        <div className="notice error-notice" role="alert">
          Settings could not be loaded.
        </div>
      </InlineNewThreadFrame>
    );
  return (
    <InlineNewThreadFrame>
      <NewThreadComposer
        prompt={prompt}
        images={[]}
        textareaRef={textareaRef}
        submitting={false}
        onPromptChange={setPrompt}
        onSubmit={() => setPrompt("")}
        onRemoveImage={() => undefined}
        onFiles={() => undefined}
        onScreenshot={() => undefined}
        projects={hasProjects ? PROJECTS : []}
        projectId={chosenProject}
        onProjectChange={setChosenProject}
        onLoadMoreProjects={() => undefined}
        runnerProfiles={RUNNER_PROFILES}
        runnerProviders={PROVIDERS}
        runnerOrbs={orbReady ? READY_ORBS : []}
        runnerProfileId={SIZE}
        runnerProfileLoading={false}
        onRunnerProfileChange={() => undefined}
        onModelChange={() => undefined}
        choices={CHOICES}
        dictationActive={false}
        dictationHideSubmit={false}
      />
    </InlineNewThreadFrame>
  );
}

/**
 * Picks the layout from the width, as the app's HomeRoute does. "New
 * Thread" goes through the app's routing and the real shortcut handler: it
 * focuses the inline composer when there is one and otherwise opens the
 * dialog. The New thread button stands in for the sidebar's.
 */
function Home(args: StoryArgs) {
  const routing = useInlineNewThreadRouting(args.onOpenDialog);
  return (
    <NewThreadSurfaceContext.Provider value={routing}>
      <CommandProvider onOpenNewThread={routing.openNewThread}>
        <HomeLayout {...args} />
      </CommandProvider>
    </NewThreadSurfaceContext.Provider>
  );
}

function HomeLayout(args: StoryArgs) {
  const phone = useMobile();
  const { openNewThread } = useNewThreadSurface();
  return (
    <div
      style={{ display: "grid", gridTemplateRows: "auto 1fr", height: "100vh" }}
    >
      <div style={{ padding: "var(--space-2)" }}>
        <Button variant="ghost" size="sm" onClick={() => openNewThread()}>
          New thread
        </Button>
      </div>
      {phone ? (
        <HomeScreen
          layout="phone"
          still
          onStartNewThread={() => openNewThread()}
        />
      ) : (
        <HomeScreen layout="wide" composer={<FixtureComposer {...args} />} />
      )}
    </div>
  );
}

const identity = {
  id: "user-ravi" as UserId,
  name: "Ravi",
  email: "ravi@example.com",
};

/**
 * Answers the composer's own Orb provider list from the fixture, so it reads
 * the same providers the story hands it and never calls the API.
 */
function SeededOrbProviders({
  orbReady,
  hasProjects,
  children,
}: {
  readonly orbReady: boolean;
  readonly hasProjects: boolean;
  readonly children: React.ReactNode;
}) {
  const queryClient = useQueryClient();
  const [seeded] = React.useState(() => {
    queryClient.setQueryData(
      newThreadOrbProvidersQueryOptions(
        identity.id,
        hasProjects ? projectId : "",
      ).queryKey,
      {
        providers: [],
        resolved: orbReady ? READY_ORBS : [],
        localRuntime: false,
      } as unknown as OrbProviderListData,
    );
    return true;
  });
  return seeded ? children : null;
}

function HomeStory(args: StoryArgs) {
  const [router] = React.useState(() => {
    const root = createRootRoute({ component: () => <Home {...args} /> });
    const settings = createRoute({
      getParentRoute: () => root,
      path: "/settings/$section",
    });
    return createRouter({
      routeTree: root.addChildren([settings]),
      history: createMemoryHistory({ initialEntries: ["/"] }),
    });
  });
  return (
    <StoryQueryProvider>
      <AuthContext.Provider value={{ identity, logout: () => undefined }}>
        <SeededOrbProviders
          orbReady={args.orbReady}
          hasProjects={args.hasProjects}
        >
          <RouterProvider router={router as never} />
        </SeededOrbProviders>
      </AuthContext.Provider>
    </StoryQueryProvider>
  );
}

/**
 * The signed-in home page, `/`. A wide screen shows the new-Thread
 * composer in the page, where the New Thread button and Alt+Enter focus it
 * instead of opening the dialog. A phone shows the dx mark with a Start new
 * thread button under it. The composer is the real one, on fixture data.
 */
const meta = {
  title: "Features/Home",
  component: HomeStory,
  parameters: { layout: "fullscreen" },
  args: {
    state: "ready",
    draft: "",
    hasProjects: true,
    orbReady: true,
    onOpenDialog: fn(),
  },
  argTypes: {
    state: { control: "inline-radio", options: ["ready", "loading", "error"] },
    draft: { control: "text" },
  },
  render: (args: StoryArgs) => (
    <HomeStory key={JSON.stringify({ ...args, onOpenDialog: 0 })} {...args} />
  ),
} satisfies Meta<StoryArgs>;
export default meta;
type Story = StoryObj<typeof meta>;

const prompt = (canvas: HTMLElement) =>
  within(canvas).findByRole("textbox", { name: "Prompt" });

/** A wide screen: the composer where the dx mark was, empty. */
export const Wide: Story = {
  globals: { viewport: { value: "desktop" } },
  play: async ({ canvasElement }) => {
    await expect(await prompt(canvasElement)).toBeVisible();
    await expect(
      within(canvasElement).queryByRole("img", { name: "dx" }),
    ).toBeNull();
  },
};

/**
 * Focused, as after the New Thread button or Alt+Enter on `/`. The card
 * keeps its border: the caret shows where focus is.
 */
export const WideFocused: Story = {
  globals: { viewport: { value: "desktop" } },
  play: async ({ canvasElement }) => {
    const textbox = await prompt(canvasElement);
    textbox.focus();
    await expect(textbox).toHaveFocus();
    await userEvent.keyboard("Fix the flaky login test");
    await expect(textbox).toHaveValue("Fix the flaky login test");
  },
};

/**
 * Choosing a model with the pointer returns focus to the prompt: no focus
 * ring stays on the chip, and the card's border never turns blue.
 */
export const WideChoosingASetting: Story = {
  globals: { viewport: { value: "desktop" } },
  play: async ({ canvasElement }) => {
    const canvas = within(canvasElement);
    const card = canvasElement.querySelector(".inline-new-thread");
    if (!(card instanceof HTMLElement)) throw new Error("Expected the card.");
    const border = getComputedStyle(card).boxShadow;
    await userEvent.click(
      await canvas.findByRole("combobox", { name: /^Model:/ }),
    );
    const [model] = await screen.findAllByRole("option");
    if (model === undefined) throw new Error("Expected a model to choose.");
    await userEvent.click(model);
    // Focus moves once the list has finished closing.
    const textbox = await prompt(canvasElement);
    await waitFor(() => expect(textbox).toHaveFocus());
    await expect(getComputedStyle(card).boxShadow).toBe(border);
  },
};

/**
 * The New thread button on `/` focuses the composer in the page and opens
 * no dialog.
 */
export const WideNewThreadButtonFocuses: Story = {
  globals: { viewport: { value: "desktop" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    const textbox = await prompt(canvasElement);
    await expect(textbox).not.toHaveFocus();
    await userEvent.click(canvas.getByRole("button", { name: "New thread" }));
    await expect(textbox).toHaveFocus();
    await expect(args.onOpenDialog).not.toHaveBeenCalled();
  },
};

/** Alt+Enter, the new-Thread shortcut, does the same on `/`. */
export const WideShortcutFocuses: Story = {
  globals: { viewport: { value: "desktop" } },
  play: async ({ args, canvasElement }) => {
    const textbox = await prompt(canvasElement);
    await expect(textbox).not.toHaveFocus();
    await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
    await expect(textbox).toHaveFocus();
    await expect(args.onOpenDialog).not.toHaveBeenCalled();
  },
};

/** A draft saved from an earlier visit, or from the dialog elsewhere. */
export const WideWithDraft: Story = {
  args: { draft: DRAFT },
  globals: { viewport: { value: "desktop" } },
  play: async ({ canvasElement }) => {
    await expect(await prompt(canvasElement)).toHaveValue(DRAFT);
  },
};

/** No Projects yet: the Thread starts with No Project. */
export const WideNoProjects: Story = {
  args: { hasProjects: false },
  globals: { viewport: { value: "desktop" } },
};

/**
 * A new workspace with no Orb provider set up: the composer says what is
 * missing and Send stays off.
 */
export const WideSetupNeeded: Story = {
  args: { orbReady: false, hasProjects: false },
  globals: { viewport: { value: "desktop" } },
};

/** While the draft and choices load, the frame holds the composer's place. */
export const WideLoading: Story = {
  args: { state: "loading" },
  globals: { viewport: { value: "desktop" } },
  play: async ({ canvasElement }) => {
    await expect(
      await within(canvasElement).findByRole("status"),
    ).toHaveTextContent("Loading New Thread draft…");
  },
};

/** Settings failed to load. */
export const WideError: Story = {
  args: { state: "error" },
  globals: { viewport: { value: "desktop" } },
};

/** A narrow window, above the phone layout's 768px. */
export const Tablet: Story = {
  args: { draft: DRAFT },
  globals: { viewport: { value: "tablet" } },
};

/** A phone: the dx mark, and under it the button that opens the composer. */
export const Phone: Story = {
  globals: { viewport: { value: "phone" } },
  play: async ({ args, canvasElement }) => {
    const canvas = within(canvasElement);
    await expect(canvas.queryByRole("textbox", { name: "Prompt" })).toBeNull();
    await userEvent.click(
      await canvas.findByRole("button", { name: "Start new thread" }),
    );
    await expect(args.onOpenDialog).toHaveBeenCalledOnce();
    // The shortcut opens the dialog too: a phone has no inline composer.
    await userEvent.keyboard("{Alt>}{Enter}{/Alt}");
    await expect(args.onOpenDialog).toHaveBeenCalledTimes(2);
  },
};

/** The smallest phone dx is checked at. */
export const SmallPhone: Story = {
  globals: { viewport: { value: "smallPhone" } },
};
