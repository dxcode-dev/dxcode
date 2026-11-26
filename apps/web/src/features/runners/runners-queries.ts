import {
  CreateRunnerPairingEndpoint,
  ListRunnersEndpoint,
  type RunnerListData,
  type RunnerMachine,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { queryOptions, useQuery } from "@tanstack/react-query";
import { dxClient } from "../../shared/api/client.js";
import { retryQuery } from "../../shared/query/query-retry.js";

export type { RunnerListData, RunnerMachine };

// Runners: the person's own machines that Threads can run on. The requests
// live here, not in the shared client, so the Thread page's first load
// carries none of them.
const listRunners = async (signal?: AbortSignal) =>
  (await dxClient.call(ListRunnersEndpoint, {}, { signal })).data;

const createRunnerPairing = async () =>
  (await dxClient.call(CreateRunnerPairingEndpoint)).data;

export const runnerKeys = {
  all: (userId: UserId) => ["runners", userId] as const,
  list: (userId: UserId) => [...runnerKeys.all(userId), "list"] as const,
  pairing: (userId: UserId, session: number) =>
    [...runnerKeys.all(userId), "pairing", session] as const,
};

/**
 * The person's paired machines. `poll` refreshes every 3 s, while the Add
 * runner dialog waits for a new machine to connect; otherwise every 30 s,
 * so a machine going offline or coming back shows up.
 */
export const runnersQueryOptions = (
  userId: UserId,
  options: { readonly enabled?: boolean; readonly poll?: boolean } = {},
) =>
  queryOptions({
    queryKey: runnerKeys.list(userId),
    queryFn: ({ signal }) => listRunners(signal),
    enabled: options.enabled ?? true,
    retry: retryQuery,
    staleTime: 10_000,
    refetchOnWindowFocus: true,
    refetchInterval: options.poll === true ? 3_000 : 30_000,
  });

/**
 * One pairing code per opening of the Add runner dialog: `session` is the
 * opening, so reopening asks for a new code and a re-render never does.
 */
export const runnerPairingQueryOptions = (userId: UserId, session: number) =>
  queryOptions({
    queryKey: runnerKeys.pairing(userId, session),
    queryFn: () => createRunnerPairing(),
    staleTime: Number.POSITIVE_INFINITY,
    gcTime: 0,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });

/**
 * One opening of the Add runner dialog: `session` names its pairing code,
 * and `knownIds` are the machines already paired, so the first new one is
 * the machine that just connected.
 */
export interface AddRunnerSession {
  readonly session: number;
  readonly knownIds: ReadonlySet<string>;
}

/** Opens the dialog from a click handler, where reading the clock is fine. */
export const startAddRunnerSession = (
  runners: ReadonlyArray<RunnerMachine> | undefined,
): AddRunnerSession => ({
  session: Date.now(),
  knownIds: new Set((runners ?? []).map(({ id }) => id)),
});

/**
 * The paired machines, and while an Add runner session is open its pairing
 * code and the machine that connected since it opened (the list polls).
 */
export const useRunners = (
  userId: UserId,
  options: {
    readonly enabled?: boolean;
    readonly session: AddRunnerSession | undefined;
  },
) => {
  const session = options.session;
  const list = useQuery(
    runnersQueryOptions(userId, {
      enabled: (options.enabled ?? true) || session !== undefined,
      poll: session !== undefined,
    }),
  );
  const pairing = useQuery({
    ...runnerPairingQueryOptions(userId, session?.session ?? 0),
    enabled: session !== undefined,
  });
  const connected =
    session === undefined
      ? undefined
      : list.data?.runners.find(({ id }) => !session.knownIds.has(id));
  return { list, pairing, connected };
};

/**
 * The machine a new Thread starts on: the chosen one while it is still
 * paired, else the first online machine, else the first.
 */
export const effectiveRunner = (
  runners: ReadonlyArray<RunnerMachine> | undefined,
  chosen: string | undefined,
) =>
  runners?.find(({ id }) => id === chosen) ??
  runners?.find(({ online }) => online) ??
  runners?.[0];
