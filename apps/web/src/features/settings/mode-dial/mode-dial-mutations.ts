import type { PutModeRequestSchema } from "@dx/api";
import type { ModeId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import {
  putProfileMode,
  resetProfileMode,
} from "../../../shared/api/client.js";
import { modelRoutingKey } from "../model-routing/model-routing-queries.js";

const invalidate = (queryClient: QueryClient) => {
  void queryClient.invalidateQueries({
    queryKey: modelRoutingKey({ scope: "personal" }),
  });
};

export const modeDialMutationOptions = (queryClient: QueryClient) => ({
  save: {
    mutationFn: (input: {
      mode: ModeId;
      config: typeof PutModeRequestSchema.Encoded;
    }) => putProfileMode(input.mode, input.config),
    onSettled: invalidate.bind(undefined, queryClient),
  },
  reset: {
    mutationFn: (mode: ModeId) => resetProfileMode(mode),
    onSettled: invalidate.bind(undefined, queryClient),
  },
});
