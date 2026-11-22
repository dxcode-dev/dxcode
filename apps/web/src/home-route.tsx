import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { HomeScreen } from "./features/home/home-screen.js";
import { MobilePullActions } from "./features/home/mobile-pull-actions.js";
import { SetupChecklist } from "./features/home/setup-checklist.js";
import {
  CHECKLIST,
  type ChecklistKey,
} from "./features/home/setup-checklist-items.js";
import {
  markOnboardingMutationOptions,
  onboardingQueryOptions,
} from "./features/onboarding/onboarding-queries.js";
import { projectsQueryOptions } from "./features/projects/project-queries.js";
import { modelRoutingChoicesQueryOptions } from "./features/settings/model-routing/model-routing-queries.js";
import { InlineNewThreadFrame } from "./features/threads/inline-new-thread-frame.js";
import { threadsQueryOptions } from "./features/threads/thread-queries.js";
import { useAuthenticatedIdentity } from "./shared/auth/auth-context.js";
import { useNewThreadSurface } from "./shared/new-thread-surface.js";
import { lazyComponent } from "./shared/stale-chunk.js";
import { useTheme } from "./shared/theme/theme-provider.js";
import { useMobile } from "./shared/use-mobile.js";

// The composer's chunk is the New Thread dialog's; a phone never loads it
// here.
const InlineNewThread = lazyComponent(() =>
  import("./features/threads/inline-new-thread.js").then((module) => ({
    default: module.InlineNewThread,
  })),
);

/**
 * The signed-in home page, `/`. A wide screen shows the New Thread composer
 * in the page, which the New Thread button and its shortcut focus. A phone
 * shows the dx mark and a Start new thread button; pulling the page down
 * opens the palette or a new Thread.
 */
/**
 * A new account's setup checklist (model, code, a thread, the tour) until
 * every item is done or it is hidden; accounts from before onboarding have
 * it hidden.
 */
function useSetupChecklist() {
  const { identity } = useAuthenticatedIdentity();
  const userId = identity.id;
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { openNewThread } = useNewThreadSurface();
  const progress = useQuery(onboardingQueryOptions(userId));
  const shown = progress.data?.checklistHiddenAt === null;
  const choices = useQuery({
    ...modelRoutingChoicesQueryOptions(userId),
    enabled: shown,
  });
  const projects = useInfiniteQuery({
    ...projectsQueryOptions(userId),
    enabled: shown,
  });
  // The sidebar already reads this list, so it costs no request here.
  const threads = useInfiniteQuery({
    ...threadsQueryOptions(userId, undefined, "active", "roots"),
    enabled: shown,
  });
  const hide = useMutation(markOnboardingMutationOptions(queryClient, userId));
  const done: ReadonlyArray<ChecklistKey> = [
    ...((choices.data?.models.length ?? 0) > 0 ? (["model"] as const) : []),
    ...(projects.data?.pages.some((page) => page.items.length > 0)
      ? (["code"] as const)
      : []),
    ...(threads.data?.pages.some((page) => page.items.length > 0)
      ? (["thread"] as const)
      : []),
    ...(progress.data?.tourFinishedAt ? (["tour"] as const) : []),
  ];
  if (!shown || done.length === CHECKLIST.length) return undefined;
  return (
    <SetupChecklist
      done={done}
      onAction={(key) => {
        if (key === "thread") openNewThread();
        else if (key === "tour") void navigate({ to: "/welcome/tour" });
        else void navigate({ to: "/welcome", search: { step: key } });
      }}
      onHide={() => hide.mutate("checklist")}
    />
  );
}

export function HomeRoute() {
  const { logoAnimation } = useTheme();
  const { openNewThread } = useNewThreadSurface();
  const checklist = useSetupChecklist();
  if (useMobile())
    return (
      <MobilePullActions>
        <HomeScreen
          layout="phone"
          still={!logoAnimation}
          onStartNewThread={() => openNewThread()}
          checklist={checklist}
        />
      </MobilePullActions>
    );
  return (
    <HomeScreen
      layout="wide"
      checklist={checklist}
      composer={
        <React.Suspense fallback={<InlineNewThreadFrame loading />}>
          <InlineNewThread />
        </React.Suspense>
      }
    />
  );
}
