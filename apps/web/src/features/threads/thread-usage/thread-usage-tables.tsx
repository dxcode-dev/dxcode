import type {
  ThreadDetailData,
  ThreadUsageModel,
  ThreadUsageOrb,
  ThreadUsageRequest,
} from "@dx/api";
import { useInfiniteQuery } from "@tanstack/react-query";
import { ChevronRight } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { modelDisplayName } from "../../../shared/model-display-name.js";
import { SettingsCard } from "../../../shared/ui/settings.js";
import {
  formatCount,
  formatDuration,
  formatInstant,
  formatOrbSize,
  formatUsd,
  formatUsdMills,
} from "./thread-usage-format.js";
import {
  threadOrbSessionsQueryOptions,
  threadUsageRequestsQueryOptions,
} from "./thread-usage-queries.js";

type ThreadId = ThreadDetailData["id"];

const PURPOSE_LABELS: Record<ThreadUsageRequest["purpose"], string> = {
  agent: "Agent",
  compaction: "Compaction",
  compaction_prefix: "Compaction",
};
const OUTCOME_LABELS: Partial<Record<ThreadUsageRequest["outcome"], string>> = {
  error: "Failed",
  cancelled: "Cancelled",
};

/** "88 (+34,652 cached)", or "88" with nothing cached. */
function InputTokens({
  uncached,
  cached,
}: {
  readonly uncached: number;
  readonly cached: number;
}) {
  return (
    <>
      {formatCount(uncached)}
      {cached === 0 ? null : (
        <span className="thread-usage-cached">{` (+${formatCount(cached)} cached)`}</span>
      )}
    </>
  );
}

/** The chevron that opens a row's details, as Usage settings draws it. */
function ToggleCell({
  name,
  open,
  onToggle,
}: {
  readonly name: string;
  readonly open: boolean;
  readonly onToggle: () => void;
}) {
  return (
    <td className="usage-list-toggle">
      <button
        type="button"
        aria-label={`${open ? "Collapse" : "Expand"} ${name}`}
        aria-expanded={open}
        onClick={onToggle}
      >
        <ChevronRight aria-hidden="true" />
      </button>
    </td>
  );
}

/** A loading, error, or "Show more" row under an open row. */
function PageRow({
  columns,
  query,
  noun,
}: {
  readonly columns: number;
  readonly query: {
    readonly isPending: boolean;
    readonly isError: boolean;
    readonly hasNextPage: boolean;
    readonly isFetchingNextPage: boolean;
    readonly isFetchNextPageError: boolean;
    readonly fetchNextPage: () => unknown;
    readonly refetch: () => unknown;
  };
  readonly noun: string;
}) {
  const content = query.isPending ? (
    `Loading ${noun}…`
  ) : query.isError && !query.isFetchNextPageError ? (
    <>
      {`${noun.charAt(0).toUpperCase()}${noun.slice(1)} could not load.`}{" "}
      <button
        type="button"
        className="thread-usage-more"
        onClick={() => void query.refetch()}
      >
        Retry
      </button>
    </>
  ) : query.hasNextPage ? (
    <button
      type="button"
      className="thread-usage-more"
      disabled={query.isFetchingNextPage}
      onClick={() => void query.fetchNextPage()}
    >
      {query.isFetchingNextPage
        ? "Loading…"
        : query.isFetchNextPageError
          ? "Show more (the last try failed)"
          : "Show more"}
    </button>
  ) : undefined;
  return content === undefined ? null : (
    <tr className="usage-list-detail thread-usage-page-row">
      <td />
      <td colSpan={columns - 1}>{content}</td>
    </tr>
  );
}

export function ModelsCard({
  models,
  threadId,
}: {
  readonly models: ReadonlyArray<ThreadUsageModel>;
  readonly threadId: ThreadId;
}) {
  return (
    <SettingsCard title="By Model" className="thread-usage-card">
      <div className="thread-usage-table-scroll">
        <table
          className="usage-list thread-usage-table thread-usage-models"
          aria-label="By Model"
        >
          <thead>
            <tr>
              <th className="usage-list-toggle">
                <span className="sr-only">Details</span>
              </th>
              <th>Model</th>
              <th className="usage-list-number">Input</th>
              <th className="usage-list-number">Output</th>
              <th className="usage-list-number">dx Cost</th>
              <th>Est. List Price</th>
            </tr>
          </thead>
          <tbody>
            {models.map((model) => (
              <ModelRows
                key={`${model.providerId}/${model.modelId}`}
                model={model}
                threadId={threadId}
              />
            ))}
          </tbody>
        </table>
      </div>
    </SettingsCard>
  );
}

function ModelRows({
  model,
  threadId,
}: {
  readonly model: ThreadUsageModel;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = React.useState(false);
  const name = modelDisplayName(model.modelName);
  return (
    <>
      <tr data-open={open || undefined}>
        <ToggleCell name={name} open={open} onToggle={() => setOpen(!open)} />
        <td>
          <div className="thread-usage-name">
            <strong>{name}</strong>
            <code>{`${model.providerId}/${model.modelId}`}</code>
            <span>
              {model.requests === 1
                ? "1 request"
                : `${formatCount(model.requests)} requests`}
            </span>
          </div>
        </td>
        <td className="usage-list-number">
          {formatCount(
            model.inputTokens + model.cacheReadTokens + model.cacheWriteTokens,
          )}
        </td>
        <td className="usage-list-number">{formatCount(model.outputTokens)}</td>
        <td className="usage-list-number">{formatUsd(model.dxCostMicros)}</td>
        <td>
          {model.unpricedRequests >= model.requests && model.requests > 0
            ? "—"
            : formatUsd(model.listPriceMicros)}
        </td>
      </tr>
      {open ? <ModelRequests model={model} threadId={threadId} /> : null}
    </>
  );
}

function ModelRequests({
  model,
  threadId,
}: {
  readonly model: ThreadUsageModel;
  readonly threadId: ThreadId;
}) {
  const { identity } = useAuthenticatedIdentity();
  const query = useInfiniteQuery(
    threadUsageRequestsQueryOptions(
      identity.id,
      threadId,
      model.providerId,
      model.modelId,
    ),
  );
  const requests = query.data?.pages.flatMap((page) => page.requests) ?? [];
  return (
    <>
      {requests.map((request) => {
        const outcome = OUTCOME_LABELS[request.outcome];
        return (
          <tr key={request.id} className="usage-list-detail">
            <td />
            <td>
              <div className="thread-usage-name">
                <span>{formatInstant(request.occurredAt)}</span>
                <small>
                  {PURPOSE_LABELS[request.purpose]}
                  {outcome === undefined ? null : ` · ${outcome}`}
                </small>
                <small>Via {request.routeName}</small>
              </div>
            </td>
            <td className="usage-list-number">
              <InputTokens
                uncached={request.inputTokens}
                cached={request.cacheReadTokens + request.cacheWriteTokens}
              />
            </td>
            <td className="usage-list-number">
              {formatCount(request.outputTokens)}
            </td>
            <td className="usage-list-number">
              {formatUsd(request.dxCostMicros)}
            </td>
            <td>
              {request.listPriceMicros === null
                ? "—"
                : formatUsd(request.listPriceMicros)}
            </td>
          </tr>
        );
      })}
      <PageRow columns={6} query={query} noun="requests" />
    </>
  );
}

export function ToolsCard({
  orb,
  threadId,
}: {
  readonly orb: ThreadUsageOrb;
  readonly threadId: ThreadId;
}) {
  const [open, setOpen] = React.useState(false);
  const size = formatOrbSize(orb.cpuCores, orb.memoryMb);
  return (
    <SettingsCard title="By Tool" className="thread-usage-card">
      <table
        className="usage-list thread-usage-table thread-usage-tools"
        aria-label="By Tool"
      >
        <thead>
          <tr>
            <th className="usage-list-toggle">
              <span className="sr-only">Details</span>
            </th>
            <th>Tool</th>
            <th>Cost</th>
          </tr>
        </thead>
        <tbody>
          <tr data-open={open || undefined}>
            <ToggleCell
              name="Orb"
              open={open}
              onToggle={() => setOpen(!open)}
            />
            <td>
              <div className="thread-usage-name">
                <span>
                  <strong>Orb</strong>
                  <span className="thread-usage-muted">
                    {` · ${formatDuration(orb.runtimeMs)} runtime`}
                  </span>
                </span>
                {size === "" ? null : <small>{size}</small>}
              </div>
            </td>
            <td>{formatUsdMills(orb.costMicros)}</td>
          </tr>
          {open ? <OrbSessions threadId={threadId} /> : null}
        </tbody>
      </table>
    </SettingsCard>
  );
}

function OrbSessions({ threadId }: { readonly threadId: ThreadId }) {
  const { identity } = useAuthenticatedIdentity();
  const query = useInfiniteQuery(
    threadOrbSessionsQueryOptions(identity.id, threadId),
  );
  const sessions = query.data?.pages.flatMap((page) => page.sessions) ?? [];
  return (
    <>
      {sessions.map((session) => {
        const size = formatOrbSize(session.cpuCores, session.memoryMb);
        return (
          <tr
            key={`${session.startedAt}-${session.endedAt}`}
            className="usage-list-detail"
          >
            <td />
            <td>
              <div className="thread-usage-name">
                <span>{formatInstant(session.endedAt)}</span>
                <small>{`${formatDuration(session.runtimeMs)} runtime`}</small>
                {size === "" ? null : <small>{size}</small>}
              </div>
            </td>
            <td>{formatUsdMills(session.costMicros)}</td>
          </tr>
        );
      })}
      <PageRow columns={3} query={query} noun="sessions" />
    </>
  );
}
