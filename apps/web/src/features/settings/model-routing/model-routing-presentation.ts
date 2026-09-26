import type {
  CatalogData,
  ChoicesData,
  ConnectionData,
  GraphData,
} from "@dx/api";

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
}
export const NOT_SERVED = "not-served";
const MODE_NAMES: Record<string, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  ultra: "Ultra",
};

export function routingPresentation({
  graph,
  catalog,
  choices,
  connections = [],
  dictationAvailable = false,
}: {
  readonly graph: GraphData;
  readonly catalog?: CatalogData;
  readonly choices?: ChoicesData;
  readonly connections?: ReadonlyArray<ConnectionData>;
  readonly dictationAvailable?: boolean;
}) {
  const catalogModels = catalog?.providers.flatMap((p) => p.models) ?? [];
  const names = new Map(catalogModels.map((m) => [m.id, m.name]));
  const displayName = (id: string) =>
    names.get(id) ??
    choices?.models.find((m) => m.canonical === id)?.name ??
    id;
  const edgeByMode = new Map(graph.edges.map((e) => [e.mode, e]));
  const groups: RoutingGroup[] = graph.modes.map((mode) => ({
    id: mode.mode,
    name: MODE_NAMES[mode.mode] ?? mode.mode,
    rows: [
      {
        id: `${mode.mode}:agent`,
        label: "Main Agent",
        model: mode.config.model,
        name: displayName(mode.config.model),
        destination: edgeByMode.get(mode.mode)?.connectionId ?? NOT_SERVED,
      },
    ],
  }));
  const served = new Map(choices?.models.map((m) => [m.canonical, m]) ?? []);
  // Choices is the server's resolved personal catalog. Do not infer winners
  // from connection order or reproduce its routing algorithm in the browser.
  if (choices !== undefined) {
    const rows: RoutingSource[] = Array.from(served.values(), (model) => ({
      id: `model:${model.canonical}`,
      model: model.canonical,
      name: displayName(model.canonical),
      destination: model.connectionId,
    }));
    if (rows.length) groups.push({ id: "other", rows });
  }
  if (dictationAvailable) {
    const row = {
      id: "sarvam:transcription",
      name: "Sarvam",
      label: "Transcription",
      destination: "dx-transcription",
    };
    const other = groups.find((g) => g.id === "other");
    if (other)
      groups[groups.indexOf(other)] = { ...other, rows: [...other.rows, row] };
    else groups.push({ id: "other", rows: [row] });
  }
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
          : connection.scope === "workspace"
            ? "Workspace"
            : row?.kind === "custom"
              ? "Custom URL"
              : row?.providerId,
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
  if (dictationAvailable)
    destinations.push({
      id: "dx-transcription",
      name: "dx",
      detail: "Transcription",
      kind: "dx",
    });
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
