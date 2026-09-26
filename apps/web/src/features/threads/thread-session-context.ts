import * as React from "react";
import type {
  RetainedThread,
  ThreadSessionRegistry,
} from "./thread-session-registry.js";

export const ThreadSessionRegistryContext = React.createContext<
  ThreadSessionRegistry | undefined
>(undefined);

export const ThreadPresentationContext = React.createContext<
  RetainedThread | undefined
>(undefined);
