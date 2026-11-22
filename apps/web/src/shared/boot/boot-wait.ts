import {
  type EnsureQueryDataOptions,
  hashKey,
  type QueryClient,
  type QueryKey,
  type UseQueryOptions,
  type UseQueryResult,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import type { AnyRouter } from "@tanstack/react-router";
import { use } from "react";

/**
 * Promises the boot suspends on, one per query or router, so every render
 * that waits for the same thing hands React the same promise. Each settles
 * without rejecting: the component that waited reads the query's error from
 * its own state, as it did before it suspended.
 */
const queryWaits = new Map<string, Promise<void>>();
const routerLoads = new WeakMap<AnyRouter, Promise<void>>();
let routers = new WeakMap<QueryClient, Map<string, AnyRouter>>();
const settle = () => undefined;

/**
 * Records a step of the launch as a User Timing mark (`dx-boot:…`), so a
 * trace or `pnpm --filter @dx/web test:boot-flicker` shows where a launch
 * spent its time, or which wait never settled.
 */
const markBoot = (step: string) => {
  performance.mark(`dx-boot:${step}`);
};

/**
 * Settles when `options`' query has an answer or has failed. Pass it to
 * `React.use` while the query is pending, so the nearest Suspense boundary
 * (the boot screen during launch) shows instead of a loading screen of the
 * component's own.
 */
export const waitForQuery = <
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  queryClient: QueryClient,
  options: EnsureQueryDataOptions<TQueryFnData, TError, TData, TQueryKey>,
): Promise<void> => {
  const key = hashKey(options.queryKey);
  const pending = queryWaits.get(key);
  if (pending !== undefined) return pending;
  markBoot(`wait ${key}`);
  const wait = queryClient
    .ensureQueryData(options)
    .then(settle, settle)
    .finally(() => {
      markBoot(`settled ${key}`);
      queryWaits.delete(key);
    });
  queryWaits.set(key, wait);
  return wait;
};

/**
 * The boot screen fades in after `.boot-screen`'s 1 s animation delay in
 * styles.css. Once it shows, it stays at least half a second, so a launch
 * that ends just after the delay doesn't flash the mark (TanStack Router's
 * `pendingMinMs` for the same reason). The router's load is the last wait
 * of every launch, so only it holds.
 */
const BOOT_SCREEN_DELAY_MS = 1_000;
const BOOT_SCREEN_MIN_MS = 500;
let bootScreenSince: number | undefined;

/** `BootScreen`'s ref: when its fade-in began counting. */
export const trackBootScreen = (node: HTMLElement | null) => {
  bootScreenSince = node === null ? undefined : performance.now();
  markBoot(node === null ? "boot screen removed" : "boot screen mounted");
};

const holdShownBootScreen = () => {
  if (bootScreenSince === undefined) return;
  const shown = bootScreenSince + BOOT_SCREEN_DELAY_MS;
  const now = performance.now();
  const left = shown + BOOT_SCREEN_MIN_MS - now;
  if (now < shown || left <= 0) return;
  return new Promise<void>((resolve) => {
    setTimeout(resolve, left);
  });
};

/**
 * The router `create` makes for `key`, made once per query client and kept
 * until `forgetRouters`. Routers are made outside render because the boot
 * suspends while they load, and React keeps nothing a suspended first render
 * made: a router made in render would be replaced, and load again, every
 * time the boot resumed.
 */
export const keptRouter = <TRouter extends AnyRouter>(
  queryClient: QueryClient,
  key: string,
  create: () => TRouter,
): TRouter => {
  let kept = routers.get(queryClient);
  if (kept === undefined) {
    kept = new Map();
    routers.set(queryClient, kept);
  }
  const router = kept.get(key) ?? create();
  kept.set(key, router);
  return router as TRouter;
};

/** Sign-out calls this, so the next account or visit starts fresh routers. */
export const forgetRouters = () => {
  routers = new WeakMap();
};

/**
 * Settles once `router` has resolved its first location: its redirects,
 * `beforeLoad`s, loaders, and lazy route components. Rendering the router
 * after this paints the destination page in its first frame, instead of an
 * empty frame while its matches load.
 */
export const routerLoaded = (router: AnyRouter): Promise<void> => {
  const loaded = routerLoads.get(router);
  if (loaded !== undefined) return loaded;
  markBoot("router load");
  const load = router
    .load()
    .then(settle, settle)
    .then(() => markBoot("router loaded"))
    .then(holdShownBootScreen)
    .then(() => markBoot("router ready"));
  routerLoads.set(router, load);
  return load;
};

/**
 * `useQuery` for an answer the boot waits for: while the query has neither
 * data nor an error it suspends (see `waitForQuery`). A failure renders the
 * caller's error state and stays until the caller retries: the component
 * that suspended mounts fresh, and a fresh observer would otherwise fetch
 * again on mount, suspend again, and never show the failure.
 */
export const useBootQuery = <
  TQueryFnData,
  TError,
  TData,
  TQueryKey extends QueryKey,
>(
  options: UseQueryOptions<TQueryFnData, TError, TData, TQueryKey>,
): UseQueryResult<TData, TError> => {
  const queryClient = useQueryClient();
  const result = useQuery({ ...options, retryOnMount: false });
  if (result.isPending) use(waitForQuery(queryClient, options));
  return result;
};
