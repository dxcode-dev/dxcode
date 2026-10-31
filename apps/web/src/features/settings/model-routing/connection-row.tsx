import { Menu } from "@base-ui/react/menu";
import type { ConnectionData } from "@dx/api";
import { CLAUDE_CODE_PROVIDER_ID, customModelEndpoint } from "@dx/domain";
import {
  ChevronRight,
  Ellipsis,
  GripVertical,
  KeyRound,
  Route,
} from "lucide-react";
import type { PointerEventHandler, ReactNode } from "react";
import { Button } from "../../../shared/ui/button.js";
import { ClaudeIcon } from "../../../shared/ui/claude-icon.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { providerKeyPresentation } from "./provider-key-presentation.js";
import { hasProviderMark } from "./provider-mark-ids.js";
import { ProviderMark } from "./provider-marks.js";

const healthLabel = (health: ConnectionData["health"]): string => {
  switch (health.state) {
    case "healthy":
      return "Healthy";
    case "unhealthy":
      return health.code;
    case "untested":
      return "Not checked";
  }
};

export const ConnectionRow = ({
  connection,
  canMutate,
  canReorderUp,
  canReorderDown,
  expanded,
  onExpand,
  onPointerDown,
  onPointerMove,
  onPointerUp,
  onPointerCancel,
  onToggle,
  onMove,
  onCheckAccess,
  onEdit,
  onDelete,
  onDisconnect,
  checkingAccess,
  children,
}: {
  readonly connection: ConnectionData;
  readonly canMutate: boolean;
  readonly canReorderUp: boolean;
  readonly canReorderDown: boolean;
  readonly expanded: boolean;
  readonly onExpand: () => void;
  readonly onPointerDown: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerMove: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerUp: PointerEventHandler<HTMLButtonElement>;
  readonly onPointerCancel: PointerEventHandler<HTMLButtonElement>;
  readonly onToggle: (enabled: boolean) => void;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onCheckAccess: () => void;
  readonly onEdit: () => void;
  readonly onDelete: () => void;
  readonly onDisconnect: () => void;
  readonly checkingAccess: boolean;
  /** Always-visible content under the row's head, such as a plan's usage. */
  readonly children?: ReactNode;
}) => {
  const managed =
    connection.kind === "subscription" || connection.kind === "deployment";
  const claude = connection.providerId === CLAUDE_CODE_PROVIDER_ID;
  const keyProvider =
    !claude &&
    connection.kind === "provider" &&
    hasProviderMark(connection.providerId);
  const Icon = claude
    ? ClaudeIcon
    : connection.kind === "subscription"
      ? GitHubIcon
      : connection.kind === "custom"
        ? Route
        : KeyRound;
  const label = claude
    ? "Used in Claude Code mode only"
    : connection.kind === "subscription"
      ? "GitHub Copilot"
      : connection.kind === "custom"
        ? "Custom URL"
        : `${providerKeyPresentation(connection.providerId, connection.providerId).name} API Key`;
  return (
    <div
      className="model-routing-connection-row"
      data-disabled={!connection.enabled || undefined}
    >
      <div className="model-routing-connection-head">
        {/* Claude plans are tabs: they reorder from the row's menu. */}
        {claude ? null : (
          <button
            type="button"
            className="model-routing-drag-handle"
            disabled={!canMutate}
            aria-label={`Drag ${connection.name} to change priority`}
            title="Drag to change priority. Use arrow keys to reorder."
            onPointerDown={onPointerDown}
            onPointerMove={onPointerMove}
            onPointerUp={onPointerUp}
            onPointerCancel={onPointerCancel}
            onKeyDown={(event) => {
              if (event.key === "ArrowUp" && canReorderUp) {
                event.preventDefault();
                onMove(-1);
              }
              if (event.key === "ArrowDown" && canReorderDown) {
                event.preventDefault();
                onMove(1);
              }
            }}
          >
            <GripVertical aria-hidden="true" />
          </button>
        )}
        <button
          type="button"
          className="model-routing-connection-disclosure"
          aria-expanded={expanded}
          aria-controls={`connection-detail-${connection.id}`}
          onClick={onExpand}
        >
          {keyProvider ? (
            <ProviderMark
              providerId={connection.providerId}
              className="routing-connection-icon"
            />
          ) : (
            <Icon className="routing-connection-icon" aria-hidden="true" />
          )}
          <span className="model-routing-connection-summary">
            <span className="model-routing-connection-name">
              {connection.name}
            </span>
            <span className="model-routing-connection-subtitle">{label}</span>
          </span>
          {!connection.enabled ? (
            <span className="model-routing-health-badge">Inactive</span>
          ) : connection.health.state === "unhealthy" ? (
            <span
              className="model-routing-health-badge"
              data-health="unhealthy"
            >
              Warning
            </span>
          ) : null}
          <ChevronRight
            className="model-routing-connection-chevron"
            aria-hidden="true"
          />
        </button>
      </div>
      {children}
      {expanded ? (
        <div
          className="model-routing-connection-detail"
          id={`connection-detail-${connection.id}`}
        >
          <dl>
            <div>
              <dt>{managed ? "Account" : claude ? "Token" : "API key"}</dt>
              <dd>
                {connection.credential?.present
                  ? `Stored ···${connection.credential.tail ?? ""}`
                  : managed
                    ? label
                    : "Not configured"}
              </dd>
            </div>
            {connection.baseUrl ? (
              connection.kind === "custom" && connection.format ? (
                <div>
                  <dt>Endpoint</dt>
                  <dd className="model-routing-connection-mono">
                    {customModelEndpoint(connection.format, connection.baseUrl)}
                  </dd>
                </div>
              ) : (
                <div>
                  <dt>Base URL</dt>
                  <dd>{connection.baseUrl}</dd>
                </div>
              )
            ) : null}
            <div>
              <dt>Models</dt>
              <dd>
                {claude
                  ? "Claude Code models on your plan"
                  : connection.serves === "catalog"
                    ? "Provider catalog"
                    : connection.models.length
                      ? connection.models.map((m) => (
                          <span
                            key={m.canonical}
                            className="model-routing-connection-mono"
                          >
                            {m.canonical}
                            {m.upstream ? ` → ${m.upstream}` : ""}
                          </span>
                        ))
                      : "No models configured"}
              </dd>
            </div>
            <div>
              <dt>Status</dt>
              <dd>{healthLabel(connection.health)}</dd>
            </div>
          </dl>
          <div className="model-routing-connection-actions">
            <Button
              type="button"
              size="xs"
              variant="outline"
              disabled={checkingAccess || !canMutate}
              onClick={onCheckAccess}
            >
              {checkingAccess ? "Checking…" : "Check Access"}
            </Button>
            {canMutate ? (
              <>
                <Button
                  type="button"
                  size="xs"
                  variant="outline"
                  onClick={() => onToggle(!connection.enabled)}
                >
                  {connection.enabled ? "Deactivate" : "Activate"}
                </Button>
                {!managed ? (
                  <Button
                    type="button"
                    size="xs"
                    variant="outline"
                    onClick={onEdit}
                  >
                    {claude ? "Replace Token" : "Edit"}
                  </Button>
                ) : null}
                <ConnectionMenu
                  connection={connection}
                  canReorderUp={canReorderUp}
                  canReorderDown={canReorderDown}
                  onMove={onMove}
                  onRemove={
                    connection.kind === "subscription" ? onDisconnect : onDelete
                  }
                />
              </>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
};

/** Reordering without dragging, and removal, behind the row's overflow. */
const ConnectionMenu = ({
  connection,
  canReorderUp,
  canReorderDown,
  onMove,
  onRemove,
}: {
  readonly connection: ConnectionData;
  readonly canReorderUp: boolean;
  readonly canReorderDown: boolean;
  readonly onMove: (direction: -1 | 1) => void;
  readonly onRemove: () => void;
}) => {
  const claudeTab = connection.providerId === CLAUDE_CODE_PROVIDER_ID;
  return (
    <Menu.Root>
      <Menu.Trigger
        render={
          <Button
            size="icon-xs"
            variant="ghost"
            aria-label={`More actions for ${connection.name}`}
          />
        }
      >
        <Ellipsis />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="routing-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup">
            {canReorderUp ? (
              <Menu.Item
                className="thread-menu-item"
                onClick={() => onMove(-1)}
              >
                {claudeTab ? "Move Left" : "Move Up"}
              </Menu.Item>
            ) : null}
            {canReorderDown ? (
              <Menu.Item className="thread-menu-item" onClick={() => onMove(1)}>
                {claudeTab ? "Move Right" : "Move Down"}
              </Menu.Item>
            ) : null}
            <Menu.Item
              className="thread-menu-item routing-menu-danger"
              onClick={onRemove}
            >
              {connection.kind === "subscription" ? "Disconnect" : "Delete"}
            </Menu.Item>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
};
