import { QueryClient } from "@tanstack/react-query";
import { retryQuery } from "./query-retry.js";
import { shareEqualData } from "./structural-sharing.js";

declare module "@tanstack/react-query" {
  interface Register {
    defaultError: unknown;
  }
}

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry: retryQuery,
        refetchOnWindowFocus: true,
        // Reuse unchanged decoded data (including Effect DateTime values) so a
        // refetch that returns the same data re-renders nothing.
        structuralSharing: shareEqualData,
      },
      mutations: {
        retry: false,
      },
    },
  });

export const queryClient = createQueryClient();
