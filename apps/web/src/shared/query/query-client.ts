import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.js";
import { shareEqualData } from "./structural-sharing.js";

declare module "@tanstack/react-query" {
  interface Register {
    defaultError: unknown;
  }
}

const retry = (failureCount: number, error: unknown) => {
  if (error instanceof DOMException && error.name === "AbortError")
    return false;
  if (error instanceof ApiError && error.status < 500) return false;
  return failureCount < 1;
};

export const createQueryClient = () =>
  new QueryClient({
    defaultOptions: {
      queries: {
        staleTime: 30_000,
        gcTime: 5 * 60_000,
        retry,
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
