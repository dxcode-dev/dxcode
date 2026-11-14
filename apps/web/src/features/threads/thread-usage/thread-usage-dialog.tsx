import type {
  ThreadContextWindow,
  ThreadDetailData,
  ThreadUsageData,
  ThreadUsageRoute,
  ThreadUsageRouteKind,
} from "@dx/api";
import { useQuery } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import {
  CircleCheck,
  Info,
  KeyRound,
  Route,
  Server,
  Unplug,
  X,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { modelDisplayName } from "../../../shared/model-display-name.js";
import { Button } from "../../../shared/ui/button.js";
import { buttonVariants } from "../../../shared/ui/button-variants.js";
import { ClaudeIcon } from "../../../shared/ui/claude-icon.js";
import {
  DialogClose,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { ModalSurface } from "../../../shared/ui/modal-surface.js";
import { SettingsCard, SettingsToggle } from "../../../shared/ui/settings.js";
import { settingsContextQueryOptions } from "../../settings/settings-context-queries.js";
import {
  byokSentence,
  formatCount,
  formatInputBreakdown,
  formatPercent,
  formatUsd,
  formatUsdMills,
  routeKindTitle,
  routingSource,
  totalInput,
} from "./thread-usage-format.js";
import { OrbMetricsCard } from "./thread-usage-metrics.js";
import { threadUsageQueryOptions } from "./thread-usage-queries.js";
import { ModelsCard, ToolsCard } from "./thread-usage-tables.js";
import "./thread-usage.css";

const COST_INFO =
  "Model costs are estimates at list prices. A cache write is a cache miss, billed above uncached input; only cache reads count as cached. Orb time is what this deployment charged in credits, or the Orb provider's list price.";
const LIST_PRICE_INFO =
  "What these tokens cost at the model's list price. The connection's provider bills the actual amount.";
const BYOK_LABEL = "Include bring-your-own-key inference at list price";

/**
 * A Thread's Cost & Usage, from the Thread menu's cost row: what it cost
 * and who paid, its tokens, the Model Routing connections and models it
 * used, its Orb time and samples, and its current context.
 */
export function ThreadUsageDialog({
  thread,
  onClose,
}: {
  readonly thread: Pick<ThreadDetailData, "id" | "title">;
  readonly onClose: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const usage = useQuery(threadUsageQueryOptions(identity.id, thread.id));
  // Focus starts on the scrolling body, so the keys scroll it.
  const body = React.useRef<HTMLDivElement>(null);
  return (
    <DialogRoot open onOpenChange={(open) => (open ? undefined : onClose())}>
      <ModalSurface className="thread-usage-dialog" initialFocus={body}>
        <header className="thread-usage-header">
          <DialogTitle className="thread-usage-title">
            <span>Thread Usage:</span> {thread.title}
          </DialogTitle>
          <DialogDescription className="sr-only">
            Cost, model, and tool usage for this thread.
          </DialogDescription>
          <DialogClose
            className={buttonVariants({ variant: "ghost", size: "icon-xs" })}
            aria-label="Close"
          >
            <X aria-hidden="true" />
          </DialogClose>
        </header>
        <div ref={body} className="thread-usage-body" tabIndex={-1}>
          {usage.data !== undefined ? (
            <ThreadUsageSections
              data={usage.data}
              threadId={thread.id}
              onNavigate={onClose}
            />
          ) : usage.isError ? (
            <EmptyState
              tone="error"
              title="Usage could not load."
              action={
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => void usage.refetch()}
                >
                  Retry
                </Button>
              }
            />
          ) : (
            <EmptyState title="Loading usage…" />
          )}
        </div>
      </ModalSurface>
    </DialogRoot>
  );
}

function ThreadUsageSections({
  data,
  threadId,
  onNavigate,
}: {
  readonly data: ThreadUsageData;
  readonly threadId: ThreadDetailData["id"];
  readonly onNavigate: () => void;
}) {
  return (
    <>
      {data.claudeCode ? (
        <aside className="thread-usage-notice">
          <Info aria-hidden="true" />
          <div>
            <strong>dx Does Not Track Model Costs for Claude Code</strong>
            <p>
              This thread runs Claude Code, which calls Anthropic on your Claude
              plan. Your plan pays for its model use, so no cost appears here;
              token counts are what Claude Code reported. This page shows what
              dx bills, such as Orb time.
            </p>
          </div>
        </aside>
      ) : null}
      <CostCard data={data} />
      {data.routes.length === 0 ? null : (
        <RoutingCard routes={data.routes} onNavigate={onNavigate} />
      )}
      {data.models.length === 0 ? null : (
        <ModelsCard models={data.models} threadId={threadId} />
      )}
      {data.orb === null ? null : (
        <ToolsCard orb={data.orb} threadId={threadId} />
      )}
      <OrbMetricsCard threadId={threadId} hasOrb={data.orb !== null} />
      {data.claudeCode ||
      (!data.context.available &&
        data.context.reason === "claude-code") ? null : (
        <ContextCard context={data.context} />
      )}
    </>
  );
}

function CostCard({ data }: { readonly data: ThreadUsageData }) {
  const [includeByok, setIncludeByok] = React.useState(false);
  const sentence = byokSentence(data.routes);
  const total = data.totalMicros + (includeByok ? data.byokListPriceMicros : 0);
  const coverage =
    data.creditsMicros > 0
      ? "Paid with your credits"
      : data.totalMicros > 0
        ? "Covered by this dx deployment"
        : data.byokListPriceMicros > 0
          ? "Billed by your own providers"
          : undefined;
  const credits = [
    data.creditsMicros > 0
      ? `Used ${formatUsdMills(data.creditsMicros)} of credits.`
      : undefined,
    data.claudeCode
      ? "Claude Code's model use is billed by your Claude plan and does not appear here."
      : undefined,
  ]
    .filter((part) => part !== undefined)
    .join(" ");
  const inputParts = {
    uncached: data.tokens.input,
    cacheWrite: data.tokens.cacheWrite,
    cacheRead: data.tokens.cacheRead,
  };
  const input = totalInput(inputParts);
  const breakdown = formatInputBreakdown(inputParts);
  const models = [
    ...new Set(data.models.map((model) => modelDisplayName(model.modelName))),
  ];
  return (
    <SettingsCard
      title="Cost"
      className="thread-usage-card thread-usage-cost"
      actions={
        <span
          className="thread-usage-info"
          role="img"
          aria-label={COST_INFO}
          title={COST_INFO}
        >
          <Info aria-hidden="true" />
        </span>
      }
    >
      <div className="thread-usage-section">
        {sentence === undefined ? null : <p>{sentence}</p>}
        <div className="thread-usage-total-row">
          <strong className="thread-usage-total">{formatUsd(total)}</strong>
          {coverage === undefined ? null : (
            <span className="thread-usage-pill">
              <CircleCheck aria-hidden="true" />
              {coverage}
            </span>
          )}
        </div>
        {data.byokListPriceMicros > 0 ? (
          <div className="thread-usage-toggle">
            <SettingsToggle
              checked={includeByok}
              onCheckedChange={setIncludeByok}
              label={BYOK_LABEL}
            />
            <span aria-hidden="true">{BYOK_LABEL}</span>
          </div>
        ) : null}
        {credits === "" ? null : <p>{credits}</p>}
      </div>
      <dl className="thread-usage-stats">
        <div className="thread-usage-stat">
          <dt>Total Tokens</dt>
          <dd>{formatCount(input + data.tokens.output)}</dd>
          <dd>
            {`${formatCount(input)} input + ${formatCount(data.tokens.output)} output`}
          </dd>
          {breakdown === undefined ? null : (
            <dd>
              {`${breakdown} (${formatPercent(data.tokens.cacheRead, input)}% read from cache)`}
            </dd>
          )}
        </div>
        <div className="thread-usage-stat">
          <dt>Requests</dt>
          <dd>{formatCount(data.requests)}</dd>
        </div>
        <div className="thread-usage-stat">
          <dt>Models</dt>
          <dd>{formatCount(models.length)}</dd>
          {models.length === 0 ? null : <dd>{models.join(", ")}</dd>}
        </div>
      </dl>
    </SettingsCard>
  );
}

const ROUTE_ICONS: Record<
  ThreadUsageRouteKind,
  React.ComponentType<React.SVGProps<SVGSVGElement>>
> = {
  deployment: Server,
  custom: Route,
  provider: KeyRound,
  subscription: GitHubIcon,
  "claude-code": ClaudeIcon,
  unknown: Unplug,
};

function RoutingCard({
  routes,
  onNavigate,
}: {
  readonly routes: ReadonlyArray<ThreadUsageRoute>;
  readonly onNavigate: () => void;
}) {
  const total = routes.reduce((sum, route) => sum + route.listPriceMicros, 0);
  return (
    <SettingsCard title="Model Routing" className="thread-usage-card">
      <div className="thread-usage-section">
        <p>
          This thread used an estimated {formatUsd(total)} of tokens at model
          list prices through {routingSource(routes)}.
        </p>
        <ul className="thread-usage-routes">
          {routes.map((route) => {
            const Icon = ROUTE_ICONS[route.kind];
            return (
              <li key={route.connectionId} className="thread-usage-route">
                <Icon aria-hidden="true" />
                <div className="thread-usage-route-copy">
                  <strong>{route.name}</strong>
                  <span>
                    <RouteSource route={route} onNavigate={onNavigate} />
                  </span>
                </div>
                <div className="thread-usage-route-price">
                  <strong>{formatUsd(route.listPriceMicros)}</strong>
                  <span className="thread-usage-dotted" title={LIST_PRICE_INFO}>
                    Estimated list price
                  </span>
                </div>
              </li>
            );
          })}
        </ul>
      </div>
    </SettingsCard>
  );
}

/** "Custom URL from <Acme workspace settings>", linked to that page. */
function RouteSource({
  route,
  onNavigate,
}: {
  readonly route: ThreadUsageRoute;
  readonly onNavigate: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const settings = useQuery(settingsContextQueryOptions(identity.id));
  if (route.kind === "deployment") return "Provided by this dx deployment";
  const kind = routeKindTitle(route.kind);
  if (route.scope === "personal")
    return (
      <>
        {kind} from{" "}
        <Link
          to="/settings/$section"
          params={{ section: "model-routing" }}
          onClick={onNavigate}
        >
          {route.ownerName === null
            ? "your personal settings"
            : `${route.ownerName}'s personal settings`}
        </Link>
      </>
    );
  if (route.scope === "workspace") {
    const label = `${route.ownerName ?? "your"} workspace settings`;
    const workspaceSlug = settings.data?.workspace?.shortName;
    return (
      <>
        {kind} from{" "}
        {workspaceSlug === undefined ? (
          label
        ) : (
          <Link
            to="/workspaces/$workspaceSlug/$section"
            params={{ workspaceSlug, section: "model-routing" }}
            onClick={onNavigate}
          >
            {label}
          </Link>
        )}
      </>
    );
  }
  return kind;
}

const CONTEXT_PARTS = [
  ["system", "System prompt"],
  ["builtin", "Built-in tools"],
  ["mcp", "MCP tools"],
  ["messages", "Messages"],
] as const;

function ContextCard({ context }: { readonly context: ThreadContextWindow }) {
  return (
    <SettingsCard
      title="Current Context Window"
      description="Estimated input dx would send for this thread's next request."
      className="thread-usage-card"
    >
      <div className="thread-usage-section">
        {context.available ? (
          <ContextWindow context={context} />
        ) : (
          <p className="thread-usage-unavailable">
            Current context is not available for this thread.
          </p>
        )}
      </div>
    </SettingsCard>
  );
}

function ContextWindow({
  context,
}: {
  readonly context: Extract<ThreadContextWindow, { available: true }>;
}) {
  const mcp = context.mcpServers.reduce((sum, entry) => sum + entry.tokens, 0);
  const tokens = {
    system: context.systemPromptTokens,
    builtin: context.builtinToolTokens,
    mcp,
    messages: context.messageTokens,
  };
  const whole = context.maxTokens ?? context.usedTokens;
  const free =
    context.maxTokens === null
      ? undefined
      : Math.max(0, context.maxTokens - context.usedTokens);
  const share = (value: number) => `(${formatPercent(value, whole)}%)`;
  const width = (value: number) =>
    `${whole <= 0 ? 0 : Math.min(100, (value / whole) * 100)}%`;
  return (
    <>
      <div className="thread-usage-context-head">
        <p className="thread-usage-context-used">
          <strong>{formatCount(context.usedTokens)}</strong>
          <span>
            {` / ${context.maxTokens === null ? "—" : formatCount(context.maxTokens)} tokens`}
          </span>
        </p>
        <p className="thread-usage-context-model">
          <span>{modelDisplayName(context.modelName)}</span>
          <span>
            {context.compactions === 1
              ? "1 compaction"
              : `${formatCount(context.compactions)} compactions`}
          </span>
        </p>
      </div>
      <div className="thread-usage-context-bar" aria-hidden="true">
        {CONTEXT_PARTS.map(([part]) => (
          <span
            key={part}
            data-part={part}
            style={{ width: width(tokens[part]) }}
          />
        ))}
      </div>
      <ul className="thread-usage-legend">
        {CONTEXT_PARTS.map(([part, label]) => (
          <li key={part} className="thread-usage-legend-item">
            <span className="thread-usage-swatch" data-part={part} />
            <span className="thread-usage-legend-label">{label}</span>
            <span className="thread-usage-legend-value">
              {formatCount(tokens[part])} <small>{share(tokens[part])}</small>
            </span>
            {part === "mcp" && context.mcpServers.length > 0 ? (
              <ul className="thread-usage-legend-servers">
                {context.mcpServers.map((entry) => (
                  <li key={entry.server}>
                    <code>{entry.server}</code>
                    <span>{formatCount(entry.tokens)}</span>
                  </li>
                ))}
              </ul>
            ) : null}
          </li>
        ))}
        {free === undefined ? null : (
          <li className="thread-usage-legend-item">
            <span className="thread-usage-swatch" data-part="free" />
            <span className="thread-usage-legend-label">Free space</span>
            <span className="thread-usage-legend-value">
              {formatCount(free)} <small>{share(free)}</small>
            </span>
          </li>
        )}
      </ul>
    </>
  );
}
