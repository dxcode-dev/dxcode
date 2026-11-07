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
import { AlertTriangle, Download, FileSearch, Info } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
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
import { SettingsCard, SettingsRow } from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { formatTokens, USAGE_LOCALE } from "./usage-format.js";
import {
  combineWorkspaceAuditPages,
  privateInspectionMutationOptions,
  type WorkspacePrivateThreadInspectionData,
  type WorkspaceUsageAuditFilters,
  type WorkspaceUsageAuditPageData,
  type WorkspaceUsageData,
  workspaceAuditExportMutationOptions,
  workspaceUsageAuditQueryOptions,
} from "./usage-queries.js";
import { downloadCsv } from "./usage-values.js";

/**
 * Private Thread access on workspace Usage: an Auditor's logged inspection of
 * one private Thread, and the audit log of every attempt. One row on the
 * page; the form and the log open in a dialog.
 */

const instant = (value: DateTime.Utc) => DateTime.formatIso(value);
const resultLabel = (result: string) => result.replaceAll("_", " ");
const errorMessage = (cause: unknown, fallback: string) =>
  cause instanceof Error ? cause.message : fallback;

function WorkspaceUsageAuditTable({
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
                {new Date(instant(event.occurredAt)).toLocaleString(
                  USAGE_LOCALE,
                )}
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
    const outcome = await settle(async () => {
      await inspection.mutateAsync({ threadId, reason });
      if (dialogToken === inspectionDialogToken.current)
        closeInspectionDialog();
    });
    if (!outcome.ok) {
      if (dialogToken === inspectionDialogToken.current)
        setInspectionError(
          errorMessage(
            outcome.error,
            "Private Thread inspection could not be authorized.",
          ),
        );
    }
    inspection.reset();
  };
  return (
    <SettingsCard>
      <div className="usage-card-header">
        <div>
          <h2>Inspect a private Thread</h2>
          <p>Auditors only. Every attempt goes to the audit log.</p>
        </div>
        {capability.permitted ? null : <Badge>Auditor role required</Badge>}
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

function AuditLog({
  workspaceSlug,
  filters,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
  readonly filters: WorkspaceUsageAuditFilters;
}) {
  const { identity } = useAuthenticatedIdentity();
  const audit = useInfiniteQuery(
    workspaceUsageAuditQueryOptions(identity.id, workspaceSlug, filters),
  );
  const auditData = combineWorkspaceAuditPages(audit.data?.pages ?? []);
  const exportAuditLog = useMutation(
    workspaceAuditExportMutationOptions(workspaceSlug, downloadCsv),
  );
  return (
    <SettingsCard
      title="Audit log"
      description={`Every inspection attempt, kept ${WORKSPACE_USAGE_AUDIT_RETENTION_DAYS} days.`}
      actions={
        <Button
          size="xs"
          variant="outline"
          disabled={exportAuditLog.isPending || auditData === undefined}
          onClick={() =>
            exportAuditLog.mutate(filters, {
              onSettled: () => exportAuditLog.reset(),
            })
          }
        >
          <Download aria-hidden="true" />
          {exportAuditLog.isPending ? "Exporting…" : "Export"}
        </Button>
      }
    >
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
    </SettingsCard>
  );
}

/** One row; the inspection form and the audit log open behind it. */
export function PrivateThreadAccess({
  workspaceSlug,
  capability,
  range,
}: {
  readonly workspaceSlug: NonNullable<SettingsSectionProps["workspaceSlug"]>;
  readonly capability: WorkspaceUsageData["privateInspection"];
  readonly range: { readonly from: string; readonly to: string };
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <SettingsCard>
      <SettingsRow
        title="Private Thread access"
        description="Auditors can inspect one private Thread's usage. Every attempt is logged."
        control={
          <Button
            type="button"
            size="xs"
            variant="outline"
            aria-label="Open Private Thread access"
            onClick={() => setOpen(true)}
          >
            Open
          </Button>
        }
      />
      <DialogRoot open={open} onOpenChange={setOpen}>
        {open ? (
          <DialogContent className="workspace-private-access-dialog">
            <DialogTitle>Private Thread access</DialogTitle>
            <DialogDescription>
              Prompts and responses are never shown; inspection returns usage
              metadata only.
            </DialogDescription>
            <PrivateInspection
              workspaceSlug={workspaceSlug}
              capability={capability}
            />
            <AuditLog
              workspaceSlug={workspaceSlug}
              filters={{ from: range.from, to: range.to, limit: 20 }}
            />
          </DialogContent>
        ) : null}
      </DialogRoot>
    </SettingsCard>
  );
}
