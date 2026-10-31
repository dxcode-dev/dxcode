import { Dialog } from "@base-ui/react/dialog";
import { Menu } from "@base-ui/react/menu";
import { Check, ChevronDown, ChevronRight, RefreshCw, X } from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { SettingsToggle } from "../settings-primitives.js";
import { McpLogo } from "./integration-card.js";
import type { McpServersMutationAction } from "./mcp-mutations.js";
import type { McpServerData, McpToolData } from "./mcp-queries.js";
import {
  type McpFieldErrors,
  type McpServerFields,
  mcpAuthLabel,
  mcpFieldErrorsAfterEdit,
  mcpFieldErrorsShown,
  mcpFieldsComplete,
  mcpFieldsFor,
  mcpServerStatus,
  mcpTemplateForEndpoint,
  mcpUpdateInput,
} from "./mcp-server-fields.js";
import { McpServerForm } from "./mcp-server-form.js";
import { McpServerProjects } from "./mcp-server-projects.js";

export type McpRun = (
  action: McpServersMutationAction,
  message: string,
  /** Receives server field errors instead of the page status. */
  onFieldErrors?: (errors: McpFieldErrors) => void,
) => Promise<boolean>;

/** A panel that slides in from the right, or up from the bottom on a phone. */
function Sheet({
  open,
  label,
  onClose,
  children,
}: {
  readonly open: boolean;
  readonly label: string;
  readonly onClose: () => void;
  readonly children: React.ReactNode;
}) {
  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      <Dialog.Portal>
        <Dialog.Backdrop className="mcp-sheet-backdrop" />
        <Dialog.Viewport className="mcp-sheet-viewport">
          <Dialog.Popup className="mcp-sheet" aria-label={label}>
            <span className="mcp-sheet-handle" aria-hidden="true" />
            {children}
            <Dialog.Close className="mcp-sheet-close" aria-label="Close">
              <X />
            </Dialog.Close>
          </Dialog.Popup>
        </Dialog.Viewport>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

const POLICY_COPY = {
  allow: {
    label: "Allow",
    detail: "Agents can call this tool.",
  },
  disabled: {
    label: "Disabled",
    detail: "Agents cannot call this tool.",
  },
  review: {
    label: "Review",
    detail: "New or changed. Agents cannot call it until you allow it.",
  },
} as const;

function ToolPolicyMenu({
  tool,
  disabled,
  onChoose,
}: {
  readonly tool: McpToolData;
  readonly disabled: boolean;
  readonly onChoose: (policy: "allow" | "disabled") => void;
}) {
  return (
    <Menu.Root>
      <Menu.Trigger
        disabled={disabled}
        render={
          <Button
            size="xs"
            variant="ghost"
            type="button"
            className="mcp-tool-policy"
            data-policy={tool.policy}
            aria-label={`${tool.name}: ${POLICY_COPY[tool.policy].label}`}
          />
        }
      >
        {POLICY_COPY[tool.policy].label}
        <ChevronDown />
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup mcp-menu-popup">
            <Menu.RadioGroup
              value={tool.policy}
              onValueChange={(value) => onChoose(value as "allow" | "disabled")}
            >
              {(["allow", "disabled"] as const).map((policy) => (
                <Menu.RadioItem
                  key={policy}
                  value={policy}
                  className="thread-menu-item mcp-menu-radio mcp-menu-detailed"
                >
                  <Menu.RadioItemIndicator className="mcp-menu-indicator">
                    <Check />
                  </Menu.RadioItemIndicator>
                  <span>
                    <strong>{POLICY_COPY[policy].label}</strong>
                    <span>{POLICY_COPY[policy].detail}</span>
                  </span>
                </Menu.RadioItem>
              ))}
            </Menu.RadioGroup>
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}

/** Allowing a new or changed tool shows exactly what is being allowed. */
function ReviewToolDialog({
  server,
  tool,
  busy,
  run,
  onClose,
}: {
  readonly server: McpServerData;
  readonly tool?: McpToolData;
  readonly busy: boolean;
  readonly run: McpRun;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={tool !== undefined}
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
    >
      {tool ? (
        <DialogContent className="mcp-review-dialog">
          <DialogTitle>Allow {tool.name}?</DialogTitle>
          <DialogDescription>
            Allowing covers this exact name, description, and input schema. If
            the server changes the tool, it needs review again.
          </DialogDescription>
          {tool.description === "" ? null : (
            <p className="mcp-review-description">{tool.description}</p>
          )}
          <dl className="mcp-review-contract">
            <div>
              <dt>Server</dt>
              <dd>{server.name}</dd>
            </div>
            <div>
              <dt>SHA-256 contract</dt>
              <dd>
                <code>{tool.schemaHash}</code>
              </dd>
            </div>
          </dl>
          <pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre>
          <footer className="mcp-dialog-actions">
            <Button size="xs" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button
              size="xs"
              disabled={busy}
              onClick={async () => {
                const done = await run(
                  {
                    type: "reviewTool",
                    serverId: server.id,
                    toolName: tool.name,
                    schemaHash: tool.schemaHash,
                    approved: true,
                  },
                  `${tool.name} allowed.`,
                );
                if (done) onClose();
              }}
            >
              Allow tool
            </Button>
          </footer>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function DeleteServerDialog({
  server,
  open,
  busy,
  run,
  onCancel,
  onDeleted,
}: {
  readonly server: McpServerData;
  readonly open: boolean;
  readonly busy: boolean;
  readonly run: McpRun;
  readonly onCancel: () => void;
  readonly onDeleted: () => void;
}) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel();
      }}
    >
      {open ? (
        <DialogContent>
          <DialogTitle>Delete {server.name}?</DialogTitle>
          <DialogDescription>
            Saved sign-ins, tokens, and connections to this server will be
            removed. New calls are blocked immediately; Thread history is
            unchanged.
          </DialogDescription>
          <footer className="mcp-dialog-actions">
            <Button size="xs" variant="ghost" onClick={onCancel}>
              Cancel
            </Button>
            <Button
              size="xs"
              variant="destructive"
              disabled={busy}
              onClick={async () => {
                const done = await run(
                  { type: "delete", serverId: server.id },
                  `${server.name} deleted.`,
                );
                if (done) onDeleted();
              }}
            >
              Delete
            </Button>
          </footer>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function ToolsPanel({
  server,
  disabled,
  run,
  onReview,
}: {
  readonly server: McpServerData;
  readonly disabled: boolean;
  readonly run: McpRun;
  readonly onReview: (tool: McpToolData) => void;
}) {
  const [open, setOpen] = React.useState(() =>
    server.tools.some((tool) => tool.policy === "review"),
  );
  const count = `${server.tools.length} ${server.tools.length === 1 ? "tool" : "tools"}`;
  const refresh = (
    <Button
      size="icon-xs"
      variant="ghost"
      type="button"
      aria-label="Refresh tools"
      disabled={disabled}
      onClick={() =>
        void run({ type: "discover", serverId: server.id }, "Tools refreshed.")
      }
    >
      <RefreshCw />
    </Button>
  );
  if (server.tools.length === 0)
    return (
      <div className="mcp-tools mcp-tools-empty">
        <span>No tools discovered yet.</span>
        {refresh}
      </div>
    );
  return (
    <div className="mcp-tools" data-open={open || undefined}>
      <div className="mcp-tools-header">
        <button
          type="button"
          aria-expanded={open}
          onClick={() => setOpen(!open)}
        >
          <strong>{count}</strong>
          {open ? null : (
            <span>{server.tools.map((tool) => tool.name).join(", ")}</span>
          )}
        </button>
        {open ? refresh : null}
        <Button
          size="icon-xs"
          variant="ghost"
          type="button"
          aria-label={open ? "Collapse tools" : "Expand tools"}
          onClick={() => setOpen(!open)}
        >
          {open ? <ChevronDown /> : <ChevronRight />}
        </Button>
      </div>
      {open ? (
        <ul>
          {server.tools.map((tool) => (
            <li key={tool.name}>
              <code>{tool.name}</code>
              <span title={tool.description}>{tool.description}</span>
              <ToolPolicyMenu
                tool={tool}
                disabled={disabled}
                onChoose={(policy) => {
                  if (policy === "allow" && tool.policy === "review") {
                    onReview(tool);
                    return;
                  }
                  if (policy === tool.policy) return;
                  void run(
                    {
                      type: "reviewTool",
                      serverId: server.id,
                      toolName: tool.name,
                      schemaHash: tool.schemaHash,
                      approved: policy === "allow",
                    },
                    `${tool.name} ${policy === "allow" ? "allowed" : "disabled"}.`,
                  );
                }}
              />
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

function EditServer({
  server,
  busy,
  run,
  onDirtyChange,
  onDone,
}: {
  readonly server: McpServerData;
  readonly busy: boolean;
  readonly run: McpRun;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onDone: () => void;
}) {
  const id = React.useId();
  const [fields, setFields] = React.useState<McpServerFields>(() =>
    mcpFieldsFor(server),
  );
  const [errors, setErrors] = React.useState<McpFieldErrors>({});
  return (
    <form
      className="mcp-sheet-body"
      onSubmit={async (event) => {
        event.preventDefault();
        const saved = await run(
          {
            type: "update",
            serverId: server.id,
            input: mcpUpdateInput(fields, server),
          },
          `${fields.name.trim()} saved.`,
          setErrors,
        );
        if (saved) onDone();
      }}
    >
      <McpServerForm
        id={id}
        fields={fields}
        errors={errors}
        disabled={busy}
        server={server}
        template={mcpTemplateForEndpoint(fields.endpoint)}
        onChange={(next) => {
          setErrors(mcpFieldErrorsAfterEdit(errors, fields, next));
          setFields(next);
          onDirtyChange(true);
        }}
      />
      <p className="mcp-form-help">
        Changing the URL or authentication clears discovered tools and sign-ins.
      </p>
      <footer className="mcp-dialog-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onDone}>
          Cancel
        </Button>
        <Button
          size="xs"
          type="submit"
          disabled={
            busy ||
            !mcpFieldsComplete(fields, server) ||
            mcpFieldErrorsShown(errors)
          }
        >
          Save
        </Button>
      </footer>
    </form>
  );
}

/**
 * One server's settings: status, its tools and their policy, sign-in, and
 * deletion. Edit swaps in the same form used to connect it.
 */
export function McpServerSheet({
  server,
  canMutate,
  busy,
  run,
  onSignIn,
  onDirtyChange,
  onClose,
}: {
  readonly server?: McpServerData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: McpRun;
  readonly onSignIn: (server: McpServerData) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onClose: () => void;
}) {
  const [editing, setEditing] = React.useState(false);
  const [reviewing, setReviewing] = React.useState<McpToolData>();
  const [deleting, setDeleting] = React.useState(false);
  const close = () => {
    setEditing(false);
    onDirtyChange(false);
    onClose();
  };
  if (server === undefined) return null;
  const template = mcpTemplateForEndpoint(server.endpoint);
  const status = mcpServerStatus(server);
  const disabled = !canMutate || busy;
  return (
    <Sheet open label={`${server.name} settings`} onClose={close}>
      <header className="mcp-sheet-header">
        <span className="integration-tile-icon" aria-hidden="true">
          <McpLogo template={template} />
        </span>
        <div>
          <h2>{server.name}</h2>
          <p className="mcp-sheet-meta">
            <span>{server.endpoint}</span>
            <span aria-hidden="true">·</span>
            <span>
              ID: <code>{server.moduleId}</code>
            </span>
            <span aria-hidden="true">·</span>
            <span>{mcpAuthLabel(server)}</span>
          </p>
          <p className="integration-tile-status" data-tone={status.tone}>
            <span aria-hidden="true" />
            {server.authType === "oauth" && server.signedIn
              ? `Signed in · ${status.text}`
              : status.text}
          </p>
        </div>
        <div className="mcp-sheet-actions">
          {editing || !canMutate ? null : (
            <Button size="xs" variant="ghost" onClick={() => setEditing(true)}>
              Edit
            </Button>
          )}
          {editing ? null : (
            <SettingsToggle
              checked={server.enabled}
              disabled={disabled}
              label={`${server.name} ${server.enabled ? "on" : "off"}`}
              onCheckedChange={(enabled) =>
                void run(
                  {
                    type: "update",
                    serverId: server.id,
                    input: { enabled },
                  },
                  `${server.name} turned ${enabled ? "on" : "off"}.`,
                )
              }
            />
          )}
        </div>
      </header>
      {editing ? (
        <EditServer
          key={server.id}
          server={server}
          busy={busy}
          run={run}
          onDirtyChange={onDirtyChange}
          onDone={() => {
            setEditing(false);
            onDirtyChange(false);
          }}
        />
      ) : (
        <div className="mcp-sheet-body">
          {server.authType === "oauth" ? (
            <section className="mcp-sheet-card" aria-label="Sign-in">
              <div>
                <strong>
                  {server.signedIn ? "Signed in" : "Sign in required"}
                </strong>
                <p>
                  {server.signedIn
                    ? "Your Threads call this server as you."
                    : server.scope === "workspace"
                      ? "Each member signs in with their own account. Threads use the sign-in of the person who started them."
                      : "Sign in on the provider's website so your Threads can call this server."}
                </p>
              </div>
              {server.signedIn ? (
                <Button
                  size="xs"
                  variant="outline"
                  disabled={busy}
                  onClick={() =>
                    void run(
                      { type: "signOut", serverId: server.id },
                      `Signed out of ${server.name}.`,
                    )
                  }
                >
                  Sign out
                </Button>
              ) : (
                <Button
                  size="xs"
                  disabled={busy}
                  onClick={() => onSignIn(server)}
                >
                  Sign in
                </Button>
              )}
            </section>
          ) : null}
          <McpServerProjects
            server={server}
            canMutate={canMutate}
            busy={busy}
            run={run}
          />
          <ToolsPanel
            server={server}
            disabled={disabled}
            run={run}
            onReview={setReviewing}
          />
          {canMutate ? (
            <section className="mcp-sheet-card" aria-label="Delete MCP server">
              <div>
                <strong>Delete MCP Server</strong>
                <p>Removes this server and its saved sign-ins and tokens.</p>
              </div>
              <Button
                size="xs"
                variant="ghost"
                className="mcp-danger"
                disabled={busy}
                onClick={() => setDeleting(true)}
              >
                Delete
              </Button>
            </section>
          ) : null}
        </div>
      )}
      <ReviewToolDialog
        server={server}
        tool={reviewing}
        busy={busy}
        run={run}
        onClose={() => setReviewing(undefined)}
      />
      <DeleteServerDialog
        server={server}
        open={deleting}
        busy={busy}
        run={run}
        onCancel={() => setDeleting(false)}
        onDeleted={() => {
          setDeleting(false);
          close();
        }}
      />
    </Sheet>
  );
}
