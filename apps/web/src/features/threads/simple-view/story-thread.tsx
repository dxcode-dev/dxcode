import { deriveTranscriptViewModel } from "@dx/client";
import {
  createMemoryHistory,
  createRootRoute,
  createRoute,
  createRouter,
  RouterProvider,
} from "@tanstack/react-router";
import * as React from "react";
import type { ThreadView } from "../../../shared/theme/theme-store.js";
import { StoryQueryProvider } from "../../../testing/story-query-provider.js";
import { ThreadTranscript } from "../thread-transcript.js";
import type { SimpleViewScenario } from "./simple-view-fixtures.js";

export const STORY_THREAD = "thr_00000000-0000-4000-8000-00000000c0de";

const Page = React.createContext<React.ReactNode>(null);

/** A Thread route around the story, as artifact cards read its ID. */
function ThreadRoute({ children }: { readonly children: React.ReactNode }) {
  const [router] = React.useState(() => {
    const root = createRootRoute();
    const thread = createRoute({
      getParentRoute: () => root,
      path: "/threads/$threadId",
      component: () => React.use(Page),
    });
    return createRouter({
      routeTree: root.addChildren([thread]),
      history: createMemoryHistory({
        initialEntries: [`/threads/${STORY_THREAD}`],
      }),
    });
  });
  return (
    <Page value={children}>
      <RouterProvider router={router} />
    </Page>
  );
}

const frame = (layout: "web" | "phone"): React.CSSProperties => ({
  position: "relative",
  width: layout === "phone" ? "390px" : "min(1440px, 100vw)",
  height: layout === "phone" ? "844px" : "min(900px, 100vh)",
  display: "flex",
  flexDirection: "column",
  background: "var(--surface)",
});

/**
 * A Thread's chat pane on fixture turns, drawn by the real transcript in
 * the given view. Stories and the design comparisons share it.
 */
export function StoryThread({
  scenario,
  view,
  layout = "web",
  label = "Agent chat",
  fill = false,
  footer,
}: {
  readonly scenario: SimpleViewScenario;
  readonly view: ThreadView;
  readonly layout?: "web" | "phone";
  readonly label?: string;
  /** Fill the parent instead of a 1440×900 or 390×844 page. */
  readonly fill?: boolean;
  /**
   * Below the turns, as the page shows the Orb's preparation status; while
   * it shows, the running turn's own line waits, as on the page.
   */
  readonly footer?: React.ReactNode;
}) {
  const model = deriveTranscriptViewModel({
    messages: scenario.messages,
    settlements: scenario.settlements,
    finalOutputs: scenario.finalOutputs,
  });
  return (
    <StoryQueryProvider>
      <ThreadRoute>
        <div
          style={
            fill
              ? { ...frame(layout), width: "100%", height: "100%" }
              : frame(layout)
          }
        >
          <div
            className={layout === "phone" ? "mobile-pane-content" : undefined}
            style={{ flex: 1, minHeight: 0 }}
          >
            <div className="agent-panel-stack">
              <section className="workspace-pane agent-pane" aria-label={label}>
                <ThreadTranscript
                  model={model}
                  threadView={view}
                  footer={footer}
                  showProcessingIndicator={footer === undefined}
                />
              </section>
            </div>
          </div>
        </div>
      </ThreadRoute>
    </StoryQueryProvider>
  );
}
