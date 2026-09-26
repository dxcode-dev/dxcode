import {
  MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH,
  WORKSPACE_USAGE_AUDIT_RETENTION_DAYS,
} from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  AlertTriangle,
  Download,
  FileSearch,
  Info,
  RotateCw,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import {
  formatCost,
  formatDuration,
  formatTokens,
  type UsageMode,
} from "./usage-format.js";
import {
  combineWorkspaceAuditPages,
  combineWorkspaceUsagePages,
  privateInspectionMutationOptions,
  type WorkspacePrivateThreadInspectionData,
  type WorkspaceUsageAuditFilters,
  type WorkspaceUsageAuditPageData,
  type WorkspaceUsageData,
  type WorkspaceUsageFilters,
  workspaceAuditExportMutationOptions,
  workspaceUsageAuditQueryOptions,
  workspaceUsageExportMutationOptions,
  workspaceUsageQueryOptions,
} from "./usage-queries.js";
import {
  DailyTrend,
  RunnerTable,
  UsageSummaryCards,
} from "./usage-settings.js";

type WorkspaceUsageView = "overview" | "rankings" | "access";
type Ranking = WorkspaceUsageFilters["ranking"];

const isoDate = (date: Date) => date.toISOString().slice(0, 10);
const initialRange = () => {
  const now = new Date();
  const to = new Date(now.getTime() - now.getTimezoneOffset() * 60_000);
  const from = new Date(to);
  from.setUTCDate(from.getUTCDate() - 29);
  return { from: isoDate(from), to: isoDate(to) };
};
const instant = (value: DateTime.Utc) => DateTime.formatIso(value);
const resultLabel = (result: string) => result.replaceAll("_", " ");
const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

const downloadCsv = (exported: {
  readonly content: string;
  readonly contentType: string;
  readonly filename: string;
}) => {
  const url = URL.createObjectURL(
    new Blob([exported.content], { type: exported.contentType }),
  );
  const anchor = document.createElement("a");
  anchor.href = url;
  anchor.download = exported.filename;
  anchor.click();
  URL.revokeObjectURL(url);
};

const aggregateUsage = (item: {
  readonly totalTokens: number;
  readonly unknownTokenEvents: number;
  readonly estimatedCostMicros: number;
  readonly unknownCostEvents: number;
  readonly averageLatencyMs: number | null;
  readonly runnerDurationMs: number;
}) => (
  <>
    <strong>
      {formatTokens(item.totalTokens)} tokens
      {item.unknownTokenEvents > 0
        ? ` + ${item.unknownTokenEvents} unknown`
        : ""}
    </strong>
    <small>
      {item.unknownCostEvents > 0 && item.estimatedCostMicros === 0
        ? "Cost unknown"
        : `${formatCost(item.estimatedCostMicros)} estimated`}
    </small>
  </>
);

export function WorkspaceRankingTable({
  ranking,
}: {
  readonly ranking: WorkspaceUsageData["ranking"];
}) {
  return (
    <div className="usage-table-scroll">
      <table className="usage-table workspace-ranking-table">
        <thead>
          <tr>
            <th>{ranking.kind === "users" ? "User" : "Project"}</th>
            <th>Usage</th>
            <th>Latency</th>
            <th>Runner</th>
            <th>Errors</th>
          </tr>
        </thead>
        <tbody>
          {ranking.items.map((item) => (
            <tr key={"userId" in item ? item.userId : item.projectId}>
              <td>
                {"userId" in item ? item.userName : item.projectName}
                <small>
                  {"userId" in item
                    ? item.userId
                    : `${item.ownerName} · ${item.projectId}`}
                </small>
              </td>
              <td>{aggregateUsage(item)}</td>
              <td>{formatDuration(item.averageLatencyMs)}</td>
              <td>{formatDuration(item.runnerDurationMs)}</td>
              <td>{item.errorEvents.toLocaleString()}</td>
            </tr>
          ))}
        </tbody>
      </table>
      {ranking.items.length === 0 ? (
        <p className="usage-empty">No matching aggregate activity.</p>
      ) : null}
    </div>
  );
}

export function WorkspaceUsageOverview({
  data,
  mode,
  onModeChange,
}: {
  readonly data: WorkspaceUsageData;
  readonly mode: UsageMode;
  readonly onModeChange: (mode: UsageMode) => void;
}) {
  return (
    <>
      <UsageSummaryCards data={data} />
      <SettingsCard>
        <div className="usage-card-header">
          <div>
            <h2>Daily workspace activity</h2>
            <p>
              Content-free totals in {data.range.timezone}; unknown tokens and
              unpriced turns stay explicit.
            </p>
          </div>
          <div className="usage-tabs" role="tablist" aria-label="Usage metric">
            {(["tokens", "cost", "latency", "runners"] as const).map((item) => (
              <button
                key={item}
                type="button"
                role="tab"
                aria-selected={mode === item}
                onClick={() => onModeChange(item)}
              >
                {item === "runners" ? "E2B" : item}
              </button>
            ))}
          </div>
        </div>
        <DailyTrend data={data} mode={mode} />
      </SettingsCard>
      <SettingsCard>
        <div className="usage-card-header">
          <div>
            <h2>E2B runners</h2>
            <p>Observed create/connect duration and resource attribution.</p>
          </div>
        </div>
        <RunnerTable data={data} />
      </SettingsCard>
      <div className="usage-disclosure">
        <Info aria-hidden="true" />
        <span>
          Aggregates contain attribution, counts, categorical outcomes, and
          timings only. They never read prompts, responses, messages, or tool
          payloads. Costs are estimates; absent or stale prices remain unknown.
        </span>
      </div>
    </>
  );
}

export function WorkspaceUsageAuditTable({
  data,
}: {
  readonly data?: WorkspaceUsageAuditPageData;
}) {
  return (
    <div className="usage-table-scroll">
      <table className="usage-table workspace-audit-table">
        <thead>
          <tr>
            <th>Time / actor</th>
            <th>Target Thread</th>
            <th>Reason</th>
            <th>Result</th>
          </tr>
        </thead>
        <tbody>
          {data?.items.map((event) => (
            <tr key={event.id}>
              <td data-label="Time / actor">
                {new Date(instant(event.occurredAt)).toLocaleString()}
                <small>
                  {event.actorName} · {event.actorUserId}
                </small>
              </td>
              <td data-label="Target Thread">{event.targetThreadId}</td>
              <td data-label="Reason">{event.reason}</td>
              <td data-label="Result">
                <Badge>{resultLabel(event.result)}</Badge>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {data?.items.length === 0 ? (
        <p className="usage-empty">No exceptional-access attempts in range.</p>
      ) : null}
    </div>
  );
}

function InspectionResult({
  inspection,
}: {
  readonly inspection: WorkspacePrivateThreadInspectionData;
}) {
  return (
    <div className="workspace-inspection-result" aria-live="polite">
      <div>
        <Badge>Logged access</Badge>
        <span>Audit {inspection.auditId}</span>
      </div>
      <dl>
        <div>
          <dt>Thread</dt>
          <dd>{inspection.thread.threadId}</dd>
        </div>
        <div>
          <dt>Project</dt>
          <dd>{inspection.thread.projectName}</dd>
        </div>
        <div>
          <dt>State</dt>
          <dd>
            {inspection.thread.visibility} · {inspection.thread.lifecycle}
          </dd>
        </div>
        <div>
          <dt>Observed usage</dt>
          <dd>
            {formatTokens(inspection.thread.usage.totalTokens)} tokens ·{" "}
            {inspection.thread.usage.modelTurns} model turns
          </dd>
        </div>
      </dl>
      <div className="usage-disclosure">
        <Info aria-hidden="true" />
        <span>{inspection.contentSummary.reason}</span>
      </div>
    </div>
  );
}

export function PrivateInspection({
  workspaceSlug,
  capability,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
  readonly capability: WorkspaceUsageData["privateInspection"];
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const [threadId, setThreadId] = React.useState("");
  const [reason, setReason] = React.useState("");
  const [open, setOpen] = React.useState(false);
  const [inspectionResult, setInspectionResult] =
    React.useState<WorkspacePrivateThreadInspectionData>();
  const [inspectionError, setInspectionError] = React.useState<string>();
  const inspectionDialogToken = React.useRef(0);
  const inspection = useMutation(
    privateInspectionMutationOptions(
      queryClient,
      identity.id,
      workspaceSlug,
      setInspectionResult,
    ),
  );
  const reasonValid =
    reason.trim().length > 0 &&
    reason.trim().length <= MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH;
  const closeInspectionDialog = () => {
    inspectionDialogToken.current += 1;
    setInspectionError(undefined);
    setOpen(false);
  };
  const inspect = async () => {
    if (
      !capability.permitted ||
      !reasonValid ||
      threadId === "" ||
      inspection.isPending
    )
      return;
    const dialogToken = inspectionDialogToken.current;
    setInspectionError(undefined);
    try {
      await inspection.mutateAsync({ threadId, reason });
      if (dialogToken === inspectionDialogToken.current)
        closeInspectionDialog();
    } catch (cause) {
      if (dialogToken === inspectionDialogToken.current)
        setInspectionError(
          errorMessage(
            cause,
            "Private Thread inspection could not be authorized.",
          ),
        );
    } finally {
      inspection.reset();
    }
  };
  return (
    <SettingsCard>
      <div className="usage-card-header">
        <div>
          <h2>Exceptional private Thread inspection</h2>
          <p>
            This is a narrow Auditor-only path, not general workspace
            administration. Every attempt is retained in the immutable audit
            log.
          </p>
        </div>
        <Badge>
          {capability.permitted ? "Auditor" : "Auditor role required"}
        </Badge>
      </div>
      <div className="workspace-inspection-form">
        <label htmlFor="workspace-inspection-thread">
          Exact Thread ID
          <Input
            id="workspace-inspection-thread"
            value={threadId}
            disabled={!capability.permitted}
            placeholder="thr_…"
            onChange={(event) => setThreadId(event.target.value)}
          />
        </label>
        <label htmlFor="workspace-inspection-reason">
          Operational reason
          <Textarea
            id="workspace-inspection-reason"
            value={reason}
            disabled={!capability.permitted}
            required
            maxLength={MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH}
            placeholder="State the approved incident or support reason"
            onChange={(event) => setReason(event.target.value)}
          />
          <small>
            {reason.trim().length}/{MAX_PRIVATE_THREAD_INSPECTION_REASON_LENGTH}
          </small>
        </label>
        <Button
          size="sm"
          disabled={!capability.permitted || !reasonValid || threadId === ""}
          onClick={() => setOpen(true)}
        >
          <FileSearch aria-hidden="true" /> Review exceptional access
        </Button>
      </div>
      {inspectionResult === undefined ? null : (
        <InspectionResult inspection={inspectionResult} />
      )}
      <DialogRoot
        open={open}
        onOpenChange={(nextOpen) => {
          if (nextOpen) setOpen(true);
          else closeInspectionDialog();
        }}
      >
        {open ? (
          <DialogContent className="workspace-inspection-dialog">
            <DialogTitle>Inspect logged private access</DialogTitle>
            <DialogDescription>
              dx records your identity, reason, exact Thread, time, and result
              before returning metadata. Prompts and responses are never read,
              and no model is called to fabricate a summary.
            </DialogDescription>
            <div className="workspace-inspection-warning">
              <AlertTriangle aria-hidden="true" />
              <span>
                This exceptional access is reviewable by workspace Owners,
                Admins, and Auditors for {WORKSPACE_USAGE_AUDIT_RETENTION_DAYS}{" "}
                days.
              </span>
            </div>
            {inspectionError === undefined ? null : (
              <p role="alert">{inspectionError}</p>
            )}
            <footer>
              <Button variant="ghost" onClick={closeInspectionDialog}>
                Cancel
              </Button>
              <Button
                disabled={inspection.isPending}
                onClick={() => void inspect()}
              >
                {inspection.isPending ? "Inspecting…" : "Inspect"}
              </Button>
            </footer>
          </DialogContent>
        ) : null}
      </DialogRoot>
    </SettingsCard>
  );
}

function WorkspaceUsageFilterForm({
  workspaceSlug,
  filters,
  hasData,
  onApply,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
  readonly filters: WorkspaceUsageFilters;
  readonly hasData: boolean;
  readonly onApply: (filters: WorkspaceUsageFilters) => void;
}) {
  const formId = React.useId();
  const initial = React.useMemo(initialRange, []);
  const [from, setFrom] = React.useState(initial.from);
  const [to, setTo] = React.useState(initial.to);
  const [userId, setUserId] = React.useState("");
  const [projectId, setProjectId] = React.useState("");
  const [providerId, setProviderId] = React.useState("");
  const [modelId, setModelId] = React.useState("");
  const [ranking, setRanking] = React.useState<Ranking>("users");
  const exportUsage = useMutation(
    workspaceUsageExportMutationOptions(workspaceSlug, downloadCsv),
  );
  const additionalFilters = [
    { key: "user", label: "User ID", value: userId, change: setUserId },
    {
      key: "project",
      label: "Project ID",
      value: projectId,
      change: setProjectId,
    },
    {
      key: "provider",
      label: "Provider",
      value: providerId,
      change: setProviderId,
    },
    { key: "model", label: "Model", value: modelId, change: setModelId },
  ];

  return (
    <form
      className="usage-filters"
      onSubmit={(event) => {
        event.preventDefault();
        onApply({
          from,
          to,
          timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
          ranking,
          ...(userId === "" ? {} : { userId }),
          ...(projectId === "" ? {} : { projectId }),
          ...(providerId === "" ? {} : { providerId }),
          ...(modelId === "" ? {} : { modelId }),
          limit: 20,
        });
      }}
    >
      <label htmlFor={`${formId}-from`}>
        From
        <Input
          id={`${formId}-from`}
          type="date"
          value={from}
          onChange={(event) => setFrom(event.target.value)}
        />
      </label>
      <label htmlFor={`${formId}-to`}>
        To
        <Input
          id={`${formId}-to`}
          type="date"
          value={to}
          onChange={(event) => setTo(event.target.value)}
        />
      </label>
      <label htmlFor={`${formId}-ranking`}>
        Rank by
        <select
          id={`${formId}-ranking`}
          className="settings-select"
          value={ranking}
          onChange={(event) => setRanking(event.target.value as Ranking)}
        >
          <option value="users">Users</option>
          <option value="projects">Projects</option>
        </select>
      </label>
      <details>
        <summary>More filters</summary>
        <div>
          {additionalFilters.map((filter) => (
            <label key={filter.key} htmlFor={`${formId}-${filter.key}`}>
              {filter.label}
              <Input
                id={`${formId}-${filter.key}`}
                value={filter.value}
                placeholder={`All ${filter.label.toLowerCase()}s`}
                onChange={(event) => filter.change(event.target.value)}
              />
            </label>
          ))}
        </div>
      </details>
      <Button type="submit" size="sm" variant="outline">
        <RotateCw aria-hidden="true" /> Apply
      </Button>
      <Button
        type="button"
        size="sm"
        variant="outline"
        disabled={exportUsage.isPending || !hasData}
        onClick={() =>
          exportUsage.mutate(filters, {
            onSettled: () => exportUsage.reset(),
          })
        }
      >
        <Download aria-hidden="true" />
        {exportUsage.isPending ? "Exporting…" : "Export usage"}
      </Button>
    </form>
  );
}

export function WorkspaceUsageSettings({
  workspaceSlug,
}: SettingsSectionProps) {
  if (workspaceSlug === undefined) return null;
  return <WorkspaceUsageSettingsForSlug workspaceSlug={workspaceSlug} />;
}

function WorkspaceUsageSettingsForSlug({
  workspaceSlug,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [mode, setMode] = React.useState<UsageMode>("tokens");
  const [view, setView] = React.useState<WorkspaceUsageView>("overview");
  const [filters, setFilters] = React.useState<WorkspaceUsageFilters>(() => ({
    ...initialRange(),
    timezoneOffsetMinutes: -new Date().getTimezoneOffset(),
    ranking: "users",
    limit: 20,
  }));
  const resource = useInfiniteQuery(
    workspaceUsageQueryOptions(identity.id, workspaceSlug, filters),
  );
  const data = combineWorkspaceUsagePages(resource.data?.pages ?? []);
  const auditFilters = React.useMemo<WorkspaceUsageAuditFilters>(
    () => ({ from: filters.from, to: filters.to, limit: 20 }),
    [filters.from, filters.to],
  );
  const audit = useInfiniteQuery(
    workspaceUsageAuditQueryOptions(identity.id, workspaceSlug, auditFilters),
  );
  const auditData = combineWorkspaceAuditPages(audit.data?.pages ?? []);
  const exportAuditLog = useMutation(
    workspaceAuditExportMutationOptions(workspaceSlug, downloadCsv),
  );
  const exportAuditCsv = () =>
    exportAuditLog.mutate(auditFilters, {
      onSettled: () => exportAuditLog.reset(),
    });

  return (
    <div className="personal-usage-settings workspace-usage-settings">
      <SettingsHeading
        title="Workspace usage"
        description="Content-free workspace aggregates, bounded user/project rankings, and exceptional-access audit."
      />
      <WorkspaceUsageFilterForm
        workspaceSlug={workspaceSlug}
        filters={filters}
        hasData={data !== undefined}
        onApply={setFilters}
      />
      <div className="usage-tabs workspace-usage-view-tabs" role="tablist">
        {(["overview", "rankings", "access"] as const).map((item) => (
          <button
            key={item}
            type="button"
            role="tab"
            aria-selected={view === item}
            onClick={() => setView(item)}
          >
            {item === "access" ? "Private access & audit" : item}
          </button>
        ))}
      </div>
      {data !== undefined &&
      resource.error !== null &&
      !resource.isFetchNextPageError ? (
        <SettingsBackgroundError onRetry={() => void resource.refetch()}>
          Workspace usage could not be refreshed. Showing the last loaded data.
        </SettingsBackgroundError>
      ) : null}
      {data === undefined && resource.isPending ? (
        <div className="usage-state" aria-busy="true">
          <span className="tool-spinner" />
          <strong>Loading workspace usage…</strong>
        </div>
      ) : data === undefined &&
        resource.error !== null &&
        !resource.isFetchNextPageError ? (
        <div className="usage-state" role="alert">
          <AlertTriangle aria-hidden="true" />
          <strong>{errorMessage(resource.error, "Request failed.")}</strong>
          <Button
            size="sm"
            variant="outline"
            onClick={() => void resource.refetch()}
          >
            Try again
          </Button>
        </div>
      ) : data === undefined ? null : view === "overview" ? (
        <WorkspaceUsageOverview
          data={data}
          mode={mode}
          onModeChange={setMode}
        />
      ) : view === "rankings" ? (
        <SettingsCard>
          <div className="usage-card-header">
            <div>
              <h2>{data.ranking.kind} by estimated cost</h2>
              <p>Stable keyset order; no private Thread rows are exposed.</p>
            </div>
          </div>
          <WorkspaceRankingTable ranking={data.ranking} />
          {resource.isFetchNextPageError ? (
            <p className="usage-state" role="alert">
              <AlertTriangle aria-hidden="true" /> More workspace rankings could
              not be loaded.
            </p>
          ) : null}
          {!resource.hasNextPage ? null : (
            <div className="usage-pagination">
              <Button
                size="sm"
                variant="outline"
                disabled={resource.isFetchingNextPage}
                onClick={() => void resource.fetchNextPage()}
              >
                {resource.isFetchingNextPage
                  ? "Loading…"
                  : resource.isFetchNextPageError
                    ? "Retry"
                    : "More rankings"}
              </Button>
            </div>
          )}
        </SettingsCard>
      ) : (
        <>
          <PrivateInspection
            workspaceSlug={workspaceSlug}
            capability={data.privateInspection}
          />
          <SettingsCard>
            <div className="usage-card-header">
              <div>
                <h2>Immutable private-access audit</h2>
                <p>
                  Actor, bounded reason, exact target, time, and result. Product
                  APIs cannot edit or delete these events.
                </p>
              </div>
              <Button
                size="sm"
                variant="outline"
                disabled={exportAuditLog.isPending || auditData === undefined}
                onClick={exportAuditCsv}
              >
                <Download aria-hidden="true" />
                {exportAuditLog.isPending ? "Exporting…" : "Export audit"}
              </Button>
            </div>
            {audit.isPending ? (
              <div className="usage-state" aria-busy="true">
                <span className="tool-spinner" /> Loading audit…
              </div>
            ) : audit.error !== null && !audit.isFetchNextPageError ? (
              <div className="usage-state" role="alert">
                <AlertTriangle aria-hidden="true" />{" "}
                {errorMessage(audit.error, "Request failed.")}
              </div>
            ) : (
              <WorkspaceUsageAuditTable data={auditData} />
            )}
            {audit.isFetchNextPageError ? (
              <p className="usage-state" role="alert">
                <AlertTriangle aria-hidden="true" /> More audit records could
                not be loaded.
              </p>
            ) : null}
            {!audit.hasNextPage ? null : (
              <div className="usage-pagination">
                <Button
                  size="sm"
                  variant="outline"
                  disabled={audit.isFetchingNextPage}
                  onClick={() => void audit.fetchNextPage()}
                >
                  {audit.isFetchingNextPage
                    ? "Loading…"
                    : audit.isFetchNextPageError
                      ? "Retry"
                      : "More audit events"}
                </Button>
              </div>
            )}
            <div className="usage-disclosure workspace-retention-note">
              <Info aria-hidden="true" />
              <span>
                Audit events are deterministically retained for{" "}
                {WORKSPACE_USAGE_AUDIT_RETENTION_DAYS} days, then removed only
                by the scheduled retention path. Exports use the same stable
                keyset order and return a continuation cursor when bounded.
              </span>
            </div>
          </SettingsCard>
        </>
      )}
    </div>
  );
}
