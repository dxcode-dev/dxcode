import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createQueryClient } from "../shared/query/query-client.js";

/** A fresh Query cache for one Storybook story, as the app's root gives. */
export function StoryQueryProvider({
  children,
}: {
  readonly children: React.ReactNode;
}) {
  const [client] = React.useState(createQueryClient);
  return <QueryClientProvider client={client}>{children}</QueryClientProvider>;
}
