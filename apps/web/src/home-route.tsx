import * as React from "react";
import { HomeScreen } from "./features/home/home-screen.js";
import { MobilePullActions } from "./features/home/mobile-pull-actions.js";
import { InlineNewThreadFrame } from "./features/threads/inline-new-thread-frame.js";
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
export function HomeRoute() {
  const { logoAnimation } = useTheme();
  const { openNewThread } = useNewThreadSurface();
  if (useMobile())
    return (
      <MobilePullActions>
        <HomeScreen
          layout="phone"
          still={!logoAnimation}
          onStartNewThread={() => openNewThread()}
        />
      </MobilePullActions>
    );
  return (
    <HomeScreen
      layout="wide"
      composer={
        <React.Suspense fallback={<InlineNewThreadFrame loading />}>
          <InlineNewThread />
        </React.Suspense>
      }
    />
  );
}
