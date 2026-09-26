import { QueryClient } from "@tanstack/react-query";
import { ApiError } from "../api/client.js";

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
      },
      mutations: {
        retry: false,
      },
    },
  });

export const queryClient = createQueryClient();
