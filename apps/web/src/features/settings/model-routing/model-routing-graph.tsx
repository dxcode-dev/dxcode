import type {
  CatalogData,
  ChoicesData,
  ConnectionData,
  DictationProviderData,
  GraphData,
} from "@dx/api";
import { GitBranch, Mic, Unplug } from "lucide-react";
import { useCallback, useState } from "react";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import {
  highlightedSources,
  type RoutingGroup,
  type RoutingHighlight,
  routingPresentation,
  TRANSCRIPTION_SOURCE,
} from "./model-routing-presentation.js";

interface MeasuredEdge {
  readonly id: string;
  readonly group: string;
  readonly destination: string;
  readonly x: number;
  readonly y: number;
  readonly path: string;
}

function observeGraphSize(node: HTMLElement, measure: () => void) {
  const observer = new ResizeObserver(measure);
  for (const element of [
    node,
    ...node.querySelectorAll("[data-routing-column]"),
  ])
    observer.observe(element);
  return () => observer.disconnect();
}

function RoutingCard({
  group,
  active,
  onHighlight,
}: {
  readonly group: RoutingGroup;
  readonly active: ReadonlySet<string>;
  readonly onHighlight: (target: RoutingHighlight) => void;
}) {
  const full = group.rows.every((r) => active.has(r.id));
  return (
    <div
      className="routing-card"
      data-mode={group.id}
      data-active={full || undefined}
    >
      {group.name ? (
        <button
          type="button"
          className="routing-card-title"
          onMouseEnter={() => onHighlight({ kind: "group", id: group.id })}
          onFocus={() => onHighlight({ kind: "group", id: group.id })}
          onMouseLeave={() => onHighlight(undefined)}
          onBlur={() => onHighlight(undefined)}
        >
          {group.name}
        </button>
      ) : null}
      {group.rows.map((row) => (
        <button
          type="button"
          key={row.id}
          className="routing-slot"
          data-routing-source={row.id}
          data-destination={row.destination}
          data-active={(!full && active.has(row.id)) || undefined}
          title={
            row.model ??
            (row.id === TRANSCRIPTION_SOURCE
              ? "Composer dictation"
              : "Oracle is unavailable")
          }
          aria-label={`${group.name ?? "Model"}${row.label ? ` ${row.label}` : ""}: ${row.name}`}
          onMouseEnter={() => onHighlight({ kind: "source", id: row.id })}
          onFocus={() => onHighlight({ kind: "source", id: row.id })}
          onMouseLeave={() => onHighlight(undefined)}
          onBlur={() => onHighlight(undefined)}
        >
          {row.label ? (
            <span className="routing-slot-label">{row.label}</span>
          ) : null}
          <span className="routing-slot-name">{row.name}</span>
        </button>
      ))}
    </div>
  );
}

export function ModelRoutingGraph({
  graph,
  catalog,
  choices,
  connections,
  dictation,
  onConnectionClick,
}: {
  readonly graph: GraphData;
  readonly catalog?: CatalogData;
  readonly choices?: ChoicesData;
  readonly connections?: ReadonlyArray<ConnectionData>;
  readonly dictation?: DictationProviderData;
  readonly onConnectionClick?: (id: string) => void;
}) {
  const { groups, destinations } = routingPresentation({
    graph,
    catalog,
    choices,
    connections,
    dictation,
  });
  const [highlight, setHighlight] = useState<RoutingHighlight>();
  const [edges, setEdges] = useState<ReadonlyArray<MeasuredEdge>>([]);
  const active = highlightedSources(groups, highlight);
  const geometryKey =
    JSON.stringify(
      groups.map((g) => [
        g.id,
        g.rows.map((r) => [r.id, r.destination, r.name]),
      ]),
    ) + JSON.stringify(destinations);
  const measureRef = useCallback(
    (node: HTMLElement | null) => {
      if (!node || !geometryKey) return;
      let disposed = false;
      const measure = () => {
        if (disposed) return;
        const bounds = node.getBoundingClientRect();
        const providers = new Map(
          Array.from(
            node.querySelectorAll<HTMLElement>("[data-routing-destination]"),
            (e) => [e.dataset.routingDestination, e.getBoundingClientRect()],
          ),
        );
        const measured: MeasuredEdge[] = [];
        for (const source of node.querySelectorAll<HTMLElement>(
          "[data-routing-source]",
        )) {
          const target = providers.get(source.dataset.destination);
          if (!target) continue;
          const r = source.getBoundingClientRect(),
            x = r.right - bounds.left,
            y = r.top + r.height / 2 - bounds.top,
            tx = target.left - bounds.left,
            ty = target.top + target.height / 2 - bounds.top;
          const bend = Math.min(96, Math.max(24, (tx - x) / 2));
          measured.push({
            id: source.dataset.routingSource ?? "",
            group:
              source.closest<HTMLElement>("[data-mode]")?.dataset.mode ??
              "other",
            destination: source.dataset.destination ?? "",
            x,
            y,
            path: `M ${x} ${y} C ${x + bend} ${y}, ${tx - bend} ${ty}, ${tx} ${ty}`,
          });
        }
        setEdges((previous) =>
          JSON.stringify(previous) === JSON.stringify(measured)
            ? previous
            : measured,
        );
      };
      measure();
      const disconnect = observeGraphSize(node, measure);
      void document.fonts?.ready.then(measure);
      return () => {
        disposed = true;
        disconnect();
      };
      // Reattach measurement when the rendered source/destination geometry changes.
    },
    [geometryKey],
  );
  return (
    <section
      className="routing-graph"
      ref={measureRef}
      aria-label="Model routing"
      data-highlighted={highlight !== undefined || undefined}
    >
      <svg className="routing-edges" aria-hidden="true">
        {edges.map((edge) => (
          <g
            key={edge.id}
            data-mode={edge.group}
            data-active={active.has(edge.id) || undefined}
          >
            <path className="routing-edge" d={edge.path} />
            <circle
              className="routing-port"
              cx={edge.x}
              cy={edge.y}
              r={active.has(edge.id) ? 2.5 : 2}
            />
            <path
              className="routing-edge-hit"
              d={edge.path}
              onPointerEnter={() =>
                setHighlight({ kind: "source", id: edge.id })
              }
              onPointerLeave={() => setHighlight(undefined)}
            />
          </g>
        ))}
      </svg>
      <div className="routing-sources" data-routing-column>
        {groups.map((group) => (
          <RoutingCard
            key={group.id}
            group={group}
            active={active}
            onHighlight={setHighlight}
          />
        ))}
      </div>
      <div className="routing-space" />
      <div className="routing-destinations" data-routing-column>
        {destinations.map((destination) => {
          const lit = groups.some((g) =>
            g.rows.some(
              (r) => r.destination === destination.id && active.has(r.id),
            ),
          );
          const Icon =
            destination.kind === "subscription"
              ? GitHubIcon
              : destination.kind === "dx"
                ? Mic
                : destination.kind === "unavailable"
                  ? Unplug
                  : GitBranch;
          const actionable =
            onConnectionClick !== undefined &&
            connections?.some((connection) => connection.id === destination.id);
          const Destination = actionable ? "button" : "div";
          return (
            <Destination
              type={actionable ? "button" : undefined}
              tabIndex={actionable ? undefined : 0}
              key={destination.id}
              className="routing-destination"
              data-routing-destination={destination.id}
              data-active={lit || undefined}
              data-unavailable={destination.kind === "unavailable" || undefined}
              title={[destination.name, destination.detail]
                .filter(Boolean)
                .join(" · ")}
              onMouseEnter={() =>
                setHighlight({ kind: "destination", id: destination.id })
              }
              onMouseLeave={() => setHighlight(undefined)}
              onFocus={() =>
                setHighlight({ kind: "destination", id: destination.id })
              }
              onBlur={() => setHighlight(undefined)}
              onClick={() => {
                if (actionable) onConnectionClick?.(destination.id);
              }}
            >
              <Icon aria-hidden="true" />
              <span>{destination.name}</span>
              {destination.detail ? <small>{destination.detail}</small> : null}
            </Destination>
          );
        })}
      </div>
    </section>
  );
}
