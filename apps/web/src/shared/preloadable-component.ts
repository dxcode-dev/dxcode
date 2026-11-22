import * as React from "react";
import { lazyComponent } from "./stale-chunk.js";

/**
 * `lazyComponent` that can start its download before it renders, such as
 * from a route's loader or when a link is hovered. Once loaded it renders at
 * once, with no Suspense fallback frame; an instance that first rendered
 * while loading stays on the lazy component, which resolves to the same one,
 * so it never remounts.
 */
export const preloadableComponent = <Props extends object>(
  load: () => Promise<{ default: React.ComponentType<Props> }>,
) => {
  let loaded: React.ComponentType<Props> | undefined;
  let loading: Promise<{ default: React.ComponentType<Props> }> | undefined;
  const preload = () => {
    loading ??= load().then(
      (module) => {
        loaded = module.default;
        return module;
      },
      (error: unknown) => {
        loading = undefined;
        throw error;
      },
    );
    return loading;
  };
  const Lazy = lazyComponent(preload) as React.ComponentType<Props>;
  function Preloadable(props: Props) {
    // Picked once per instance, so it never switches component (remounts).
    const [{ Component }] = React.useState(() => ({
      Component: loaded ?? Lazy,
    }));
    return React.createElement(Component, props);
  }
  return Object.assign(Preloadable, { preload });
};
