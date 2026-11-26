import { type DataViewPart, readStatePath } from "@dx/domain";
import { Badge } from "../../../shared/ui/badge.js";
import { Card } from "../../../shared/ui/card.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { LogView } from "../../../shared/ui/log-view.js";
import { RecordList } from "../../../shared/ui/record-list.js";
import { StatGrid } from "../../../shared/ui/stat-tile.js";
import { Tab, Tabs, TabsList, TabsPanel } from "../../../shared/ui/tabs.js";
import { TimeSeriesChart } from "../../../shared/ui/time-series-chart.js";
import { FormPart } from "./data-view-form.js";
import { formatViewValue, numberOf } from "./data-view-format.js";
import { ButtonPart, StatPart } from "./data-view-stat.js";
import { TablePart } from "./data-view-table.js";
import {
  keyOf,
  listOf,
  type PartContext,
  recordOf,
  shows,
  text,
  toneOf,
} from "./data-view-values.js";

export type { PartContext };

/**
 * Draws a view's parts with dx's shared parts. Every value from state is
 * drawn as text. Consecutive stats share one grid, and consecutive buttons
 * one row.
 */

interface Placed<P> {
  readonly part: P;
  /** The part's place among its siblings: its key and control id. */
  readonly id: string;
}

type StatPartData = DataViewPart & { readonly type: "stat" };
type ButtonPartData = DataViewPart & { readonly type: "button" };

type Group =
  | {
      readonly kind: "stats";
      readonly id: string;
      readonly parts: ReadonlyArray<Placed<StatPartData>>;
    }
  | {
      readonly kind: "buttons";
      readonly id: string;
      readonly parts: ReadonlyArray<Placed<ButtonPartData>>;
    }
  | { readonly kind: "one"; readonly id: string; readonly part: DataViewPart };

const groupParts = (
  parts: ReadonlyArray<Placed<DataViewPart>>,
): ReadonlyArray<Group> => {
  const groups: Array<Group> = [];
  for (const placed of parts) {
    const { part, id } = placed;
    const last = groups.at(-1);
    if (part.type === "stat")
      if (last?.kind === "stats")
        groups[groups.length - 1] = {
          ...last,
          parts: [...last.parts, { part, id }],
        };
      else groups.push({ kind: "stats", id, parts: [{ part, id }] });
    else if (part.type === "button")
      if (last?.kind === "buttons")
        groups[groups.length - 1] = {
          ...last,
          parts: [...last.parts, { part, id }],
        };
      else groups.push({ kind: "buttons", id, parts: [{ part, id }] });
    else groups.push({ kind: "one", id, part });
  }
  return groups;
};

export function DataViewParts({
  parts,
  context,
  path,
}: {
  readonly parts: ReadonlyArray<DataViewPart>;
  readonly context: PartContext;
  /** Where these parts sit, for keys and control ids. */
  readonly path: string;
}) {
  const visible = parts.flatMap((part, index) =>
    shows(part, context.state) ? [{ part, id: `${path}.${index}` }] : [],
  );
  return groupParts(visible).map((group) => {
    if (group.kind === "stats")
      return (
        <StatGrid key={group.id} label="Figures" className="data-view-stats">
          {group.parts.map(({ part, id }) => (
            <StatPart key={id} part={part} state={context.state} />
          ))}
        </StatGrid>
      );
    if (group.kind === "buttons")
      return (
        <div key={group.id} className="data-view-buttons">
          {group.parts.map(({ part, id }) => (
            <ButtonPart key={id} id={id} part={part} context={context} />
          ))}
        </div>
      );
    return (
      <OnePart
        key={group.id}
        id={group.id}
        part={group.part}
        context={context}
      />
    );
  });
}

function OnePart({
  id,
  part,
  context,
}: {
  readonly id: string;
  readonly part: DataViewPart;
  readonly context: PartContext;
}) {
  const { state } = context;
  switch (part.type) {
    case "heading": {
      const value = part.text ?? text(readStatePath(state, part.bind ?? ""));
      return part.level === 1 ? (
        <h2 className="data-view-heading" data-level="1">
          {value}
        </h2>
      ) : part.level === 3 ? (
        <h4 className="data-view-heading" data-level="3">
          {value}
        </h4>
      ) : (
        <h3 className="data-view-heading" data-level="2">
          {value}
        </h3>
      );
    }
    case "text":
      return (
        <p className="data-view-text" data-tone={part.tone ?? "default"}>
          {part.bind === undefined
            ? part.text
            : text(readStatePath(state, part.bind))}
        </p>
      );
    case "badge": {
      const value =
        part.bind === undefined
          ? part.text
          : text(readStatePath(state, part.bind));
      return (
        <div>
          <Badge tone={toneOf(value, part.tones, part.tone)}>{value}</Badge>
        </div>
      );
    }
    case "code":
      return (
        <pre className="data-view-code">
          <code>
            {part.bind === undefined
              ? part.text
              : text(readStatePath(state, part.bind))}
          </code>
        </pre>
      );
    case "empty":
      return (
        <EmptyState
          title={part.title}
          {...(part.description === undefined
            ? {}
            : { description: part.description })}
        />
      );
    case "table":
      return <TablePart id={id} part={part} context={context} />;
    case "list": {
      const items = listOf(readStatePath(state, part.bind));
      return (
        <Card padding="none" className="data-view-card">
          <RecordList
            label={part.label ?? "Items"}
            items={items.map((item, index) => {
              const record = recordOf(item);
              const badge =
                part.badge === undefined ? undefined : record[part.badge];
              return {
                key: keyOf(item, part.itemKey, index),
                primary: text(record[part.primary]),
                ...(part.secondary === undefined
                  ? {}
                  : { secondary: text(record[part.secondary]) }),
                ...(part.meta === undefined
                  ? {}
                  : { meta: text(record[part.meta]) }),
                ...(badge === undefined || badge === null
                  ? {}
                  : {
                      badge: {
                        label: text(badge),
                        tone: toneOf(badge, part.tones),
                      },
                    }),
              };
            })}
            {...(part.itemAction === undefined
              ? {}
              : {
                  onSelect: (key: string) => {
                    const index = items.findIndex(
                      (item, at) => keyOf(item, part.itemKey, at) === key,
                    );
                    if (index >= 0 && part.itemAction !== undefined)
                      void context.run(`${id}.${key}`, part.itemAction, {
                        state,
                        row: items[index],
                      });
                  },
                })}
            empty={part.empty ?? "Nothing here yet."}
          />
        </Card>
      );
    }
    case "chart": {
      const points = listOf(readStatePath(state, part.bind)).map(
        (point, index) => {
          const record = recordOf(point);
          return {
            key: String(index),
            label: text(record[part.x]),
            values: Object.fromEntries(
              part.series.map((series) => [
                series.key,
                numberOf(record[series.key]) ?? 0,
              ]),
            ),
          };
        },
      );
      return (
        <Card padding="md" className="data-view-card">
          <TimeSeriesChart
            label={part.label}
            kind={part.kind}
            series={part.series.map((series) => ({
              id: series.key,
              label: series.label,
            }))}
            points={points}
            formatValue={(value) =>
              formatViewValue(value, part.format ?? "number")
            }
            empty="No data yet."
          />
        </Card>
      );
    }
    case "log":
      return (
        <LogView
          label={part.label ?? "Log"}
          lines={listOf(readStatePath(state, part.bind)).map((line, index) => {
            if (typeof line !== "object" || line === null)
              return { key: String(index), text: text(line) };
            const record = recordOf(line);
            const level = record.level;
            return {
              key: String(index),
              text: text(record.text ?? record.message),
              ...(record.time === undefined ? {} : { time: text(record.time) }),
              ...(level === "debug" ||
              level === "info" ||
              level === "warn" ||
              level === "error"
                ? { level }
                : {}),
            };
          })}
          empty={part.empty ?? "No lines yet."}
        />
      );
    case "form":
      return <FormPart id={id} part={part} context={context} />;
    case "tabs":
      return (
        <Tabs defaultValue={0} className="data-view-tabs">
          <TabsList>
            {part.tabs.map((tab, index) => (
              <Tab key={tab.label} value={index}>
                {tab.label}
              </Tab>
            ))}
          </TabsList>
          {part.tabs.map((tab, index) => (
            <TabsPanel
              key={tab.label}
              value={index}
              className="data-view-parts"
            >
              <DataViewParts
                parts={tab.parts}
                context={context}
                path={`${id}.${index}`}
              />
            </TabsPanel>
          ))}
        </Tabs>
      );
    case "stat":
    case "button":
      return null;
  }
}

/** Above this many rows, a table scrolls in place and draws only what shows. */
