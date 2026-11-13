import type {
  ChoicesData,
  ConnectionData,
  DictationProviderData,
  GraphData,
  SpaceAgentRoute,
} from "@dx/api";
import { isClaudeCodeModel } from "@dx/domain";

export interface RoutingSource {
  readonly id: string;
  readonly label?: string;
  readonly model?: string;
  readonly name: string;
  readonly destination: string;
}
export interface RoutingGroup {
  readonly id: string;
  readonly name?: string;
  readonly rows: ReadonlyArray<RoutingSource>;
}
export interface RoutingDestination {
  readonly id: string;
  readonly name: string;
  readonly detail?: string;
  readonly kind: string;
  /** A workspace connection, which serves after the user's own. */
  readonly workspace?: boolean;
}
export const NOT_SERVED = "not-served";
export const TRANSCRIPTION_SOURCE = "speech:transcription";
/** Who pays for transcription: the credential scope Speech resolved. */
const TRANSCRIPTION = {
  deployment: { id: "dx-transcription", name: "dx", kind: "dx" },
  workspace: {
    id: "workspace-transcription",
    name: "Workspace key",
    kind: "dx",
  },
  personal: { id: "personal-transcription", name: "Your key", kind: "dx" },
} as const;
const MODE_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

/**
 * The routing graph's rows and destinations. Model names come from the
 * server, which takes them from the model catalog, so this page and the Mode
 * Dial name a model the same way.
 */
export function routingPresentation({
  graph,
  choices,
  connections = [],
  dictation,
  space,
}: {
  readonly graph: GraphData;
  readonly choices?: ChoicesData;
  readonly connections?: ReadonlyArray<ConnectionData>;
  /** The Speech provider dictation resolves to; absent hides the row. */
  readonly dictation?: DictationProviderData;
  /** Where a new Space would run; absent hides the Space row. */
  readonly space?: SpaceAgentRoute;
}) {
  const edgeByMode = new Map(graph.edges.map((e) => [e.mode, e]));
  const groups: RoutingGroup[] = graph.modes.map((mode) => ({
    id: mode.mode,
    name: MODE_NAMES[mode.mode] ?? mode.mode,
    rows: [
      {
        id: `${mode.mode}:agent`,
        label: "Main Agent",
        model: mode.config.model,
        name: mode.modelName,
        destination: edgeByMode.get(mode.mode)?.connectionId ?? NOT_SERVED,
      },
    ],
  }));
  // Claude Code models run as Claude Code mode, not as routed models.
  const served = new Map(
    choices?.models.flatMap((m) =>
      isClaudeCodeModel(m.canonical) ? [] : [[m.canonical, m] as const],
    ) ?? [],
  );
  // Choices is the server's resolved personal catalog. Do not infer winners
  // from connection order or reproduce its routing algorithm in the browser.
  if (choices !== undefined) {
    const rows: RoutingSource[] = Array.from(served.values(), (model) => ({
      id: `model:${model.canonical}`,
      model: model.canonical,
      name: model.name,
      destination: model.connectionId,
    }));
    if (rows.length) groups.push({ id: "other", rows });
  }
  const transcription =
    dictation === undefined ? undefined : TRANSCRIPTION[dictation.scope];
  if (dictation !== undefined && transcription !== undefined) {
    const row = {
      id: TRANSCRIPTION_SOURCE,
      name: dictation.displayName,
      label: "Transcription",
      destination: transcription.id,
    };
    const other = groups.find((g) => g.id === "other");
    if (other)
      groups[groups.indexOf(other)] = { ...other, rows: [...other.rows, row] };
    else groups.push({ id: "other", rows: [row] });
  }
  // A Space has its own model (Models → Space) and route, picked once
  // when each Space is created: Claude Code on a plan, or Model Routing.
  const spaceDestination =
    space === undefined || space.kind === "unavailable"
      ? undefined
      : {
          id: `space:${space.kind}`,
          name: space.connectionName,
          kind: space.kind === "claude-code" ? "claude-code" : "provider",
          detail: space.kind === "claude-code" ? "Claude Code" : "dx agent",
        };
  if (space !== undefined)
    groups.push({
      id: "space",
      name: "Space",
      rows: [
        {
          id: "space:agent",
          label: "Space agent",
          model: space.model,
          name: space.modelName,
          destination: spaceDestination?.id ?? NOT_SERVED,
        },
      ],
    });
  const used = new Set(groups.flatMap((g) => g.rows.map((r) => r.destination)));
  const connectionsById = new Map(
    connections.map((row) => [String(row.id), row]),
  );
  const destinations: RoutingDestination[] = [];
  for (const connection of graph.connections) {
    if (!used.has(connection.connectionId)) continue;
    const row = connectionsById.get(connection.connectionId);
    destinations.push({
      id: connection.connectionId,
      name: connection.name,
      kind: connection.kind,
      detail:
        connection.kind === "subscription"
          ? "GitHub Copilot"
          : connection.kind === "custom"
            ? "Custom URL"
            : connection.kind === "deployment"
              ? "Deployment"
              : row?.providerId,
      // The deployment's own connection is stored under a workspace target.
      ...(connection.scope === "workspace" && connection.kind !== "deployment"
        ? { workspace: true }
        : {}),
    });
  }
  for (const model of served.values()) {
    if (
      used.has(model.connectionId) &&
      !destinations.some((d) => d.id === model.connectionId)
    )
      destinations.push({
        id: model.connectionId,
        name: model.connectionName,
        kind: "provider",
      });
  }
  if (transcription !== undefined)
    destinations.push({ ...transcription, detail: "Transcription" });
  if (spaceDestination !== undefined) destinations.push(spaceDestination);
  if (used.has(NOT_SERVED))
    destinations.push({
      id: NOT_SERVED,
      name: "Not served",
      kind: "unavailable",
    });
  return { groups, destinations };
}

export type RoutingHighlight =
  | { readonly kind: "group" | "source" | "destination"; readonly id: string }
  | undefined;
export function highlightedSources(
  groups: ReadonlyArray<RoutingGroup>,
  target: RoutingHighlight,
): ReadonlySet<string> {
  const active = new Set<string>();
  for (const group of groups) {
    for (const row of group.rows) {
      const matches =
        target?.kind === "group"
          ? target.id === group.id
          : target?.kind === "source"
            ? target.id === row.id
            : target?.kind === "destination" && target.id === row.destination;
      if (matches) active.add(row.id);
    }
  }
  return active;
}
