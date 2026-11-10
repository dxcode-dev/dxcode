import type { SpaceAgentRoute } from "@dx/api";

const EFFORT_NAMES: Record<string, string> = {
  off: "No thinking",
  minimal: "Minimal",
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/** Where a new Space runs, in one line (Mode Dial, Create Space). */
export const spaceRouteText = (route: SpaceAgentRoute) => {
  const effort = EFFORT_NAMES[route.thinking] ?? route.thinking;
  switch (route.kind) {
    case "claude-code":
      return `Claude Code · ${route.modelName} · ${effort}, on ${route.connectionName}`;
    case "model-routing":
      return `dx agent · ${route.modelName} · ${effort}, through ${route.connectionName}`;
    case "unavailable":
      return route.message;
  }
};
