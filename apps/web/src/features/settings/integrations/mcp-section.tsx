import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Plus, Settings } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import {
  type McpServersMutationAction,
  mcpServersMutationOptions,
} from "./mcp-mutations.js";
import {
  type McpServerData,
  type McpServersTarget,
  type McpToolData,
  mcpServersQueryOptions,
} from "./mcp-queries.js";
import {
  type McpAuthMode,
  type McpServerFields,
  mcpCreateInput,
  mcpFieldsComplete,
  mcpFieldsFor,
  mcpServerHint,
  mcpUpdateInput,
} from "./mcp-server-fields.js";

type Run = (
  action: McpServersMutationAction,
  message: string,
) => Promise<boolean>;
type FinalFocus = React.RefObject<HTMLElement | null>;

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

function ServerFields({
  id,
  value,
  server,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly value: McpServerFields;
  readonly server?: McpServerData;
  readonly disabled: boolean;
  readonly onChange: (value: McpServerFields) => void;
}) {
  const legacySecret = server?.authReference !== undefined;
  return (
    <>
      <SettingsRow
        title="Name"
        control={
          <Input
            id={`${id}-name`}
            aria-label="Name"
            value={value.name}
            maxLength={80}
            required
            disabled={disabled}
            placeholder="Docs"
            onChange={(event) =>
              onChange({ ...value, name: event.target.value })
            }
          />
        }
      />
      <SettingsRow
        title="URL"
        control={
          <Input
            id={`${id}-url`}
            aria-label="URL"
            type="url"
            value={value.endpoint}
            maxLength={2048}
            required
            disabled={disabled}
            placeholder="https://mcp.example.com/mcp"
            onChange={(event) =>
              onChange({ ...value, endpoint: event.target.value })
            }
          />
        }
      />
      <SettingsRow
        title="Auth"
        description={
          value.auth === "secret"
            ? "Uses a secret that is also visible in Thread sandboxes. Switch to a bearer token stored on this server."
            : undefined
        }
        control={
          <SettingsSelect
            id={`${id}-auth`}
            label="Auth"
            value={value.auth}
            disabled={disabled}
            options={[
              ["none", "No token"],
              ["token", "Bearer token"],
              ...(legacySecret
                ? ([["secret", "Secret reference"]] as const)
                : []),
            ]}
            onValueChange={(auth) =>
              onChange({ ...value, auth: auth as McpAuthMode, token: "" })
            }
          />
        }
      />
      {value.auth === "token" ? (
        <SettingsRow
          title="Token"
          control={
            <Input
              id={`${id}-token`}
              aria-label="Token"
              type="password"
              autoComplete="off"
              spellCheck={false}
              value={value.token}
              disabled={disabled}
              placeholder={
                server?.hasStoredToken
                  ? "Saved. Enter a new token to replace it."
                  : "Paste the bearer token"
              }
              onChange={(event) =>
                onChange({ ...value, token: event.target.value })
              }
            />
          }
        />
      ) : null}
    </>
  );
}

function AddServerDialog({
  open,
  busy,
  finalFocus,
  run,
  onDirtyChange,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly finalFocus: FinalFocus;
  readonly run: Run;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onClose: () => void;
}) {
  const id = React.useId();
  const [fields, setFields] = React.useState<McpServerFields>({
    name: "",
    endpoint: "",
    auth: "none",
    token: "",
  });
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <DialogContent finalFocus={finalFocus} className="mcp-server-dialog">
          <DialogTitle>Add MCP server</DialogTitle>
          <form
            onSubmit={async (event) => {
              event.preventDefault();
              const saved = await run(
                { type: "create", input: mcpCreateInput(fields) },
                "Server added. Discover and review its tools to use them.",
              );
              if (saved) onClose();
            }}
          >
            <ServerFields
              id={id}
              value={fields}
              disabled={busy}
              onChange={(next) => {
                setFields(next);
                onDirtyChange(true);
              }}
            />
            <footer>
              <Button size="xs" variant="ghost" type="button" onClick={onClose}>
                Cancel
              </Button>
              <Button
                size="xs"
                type="submit"
                disabled={busy || !mcpFieldsComplete(fields)}
              >
                Add server
              </Button>
            </footer>
          </form>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

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
  readonly run: Run;
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
          <DialogTitle>
            {tool.approved ? "Revoke" : "Approve"} {tool.name}?
          </DialogTitle>
          <DialogDescription>
            {tool.approved
              ? "New calls are blocked. Thread history is unchanged."
              : "Approval covers this exact name, description, and input schema. A changed tool needs a new review."}
          </DialogDescription>
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
                    approved: !tool.approved,
                  },
                  tool.approved ? "Tool revoked." : "Tool approved.",
                );
                if (done) onClose();
              }}
            >
              {tool.approved ? "Revoke tool" : "Approve tool"}
            </Button>
          </footer>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function RemoveServerDialog({
  server,
  open,
  busy,
  run,
  onCancel,
  onRemoved,
}: {
  readonly server: McpServerData;
  readonly open: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onCancel: () => void;
  readonly onRemoved: () => void;
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
          <DialogTitle>Remove {server.name}?</DialogTitle>
          <DialogDescription>
            New calls are blocked immediately. Thread history is unchanged.
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
                  "Server removed.",
                );
                if (done) onRemoved();
              }}
            >
              Remove server
            </Button>
          </footer>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function ServerSettingsForm({
  server,
  canMutate,
  busy,
  run,
  onDirtyChange,
  onClose,
}: {
  readonly server: McpServerData;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: Run;
  readonly onDirtyChange: (dirty: boolean) => void;
  readonly onClose: () => void;
}) {
  const id = React.useId();
  const [fields, setFields] = React.useState<McpServerFields>(() =>
    mcpFieldsFor(server),
  );
  const [reviewing, setReviewing] = React.useState<McpToolData>();
  const [removing, setRemoving] = React.useState(false);
  const disabled = !canMutate || busy;
  return (
    <>
      <form
        onSubmit={async (event) => {
          event.preventDefault();
          const saved = await run(
            {
              type: "update",
              serverId: server.id,
              input: mcpUpdateInput(fields, server),
            },
            "Server saved.",
          );
          if (saved) onClose();
        }}
      >
        <ServerFields
          id={id}
          value={fields}
          server={server}
          disabled={disabled}
          onChange={(next) => {
            setFields(next);
            onDirtyChange(true);
          }}
        />
        <p className="mcp-server-dialog-note">
          Changing the URL or auth clears discovered tools and approvals.
        </p>
        <section className="mcp-server-tools" aria-label="Tools">
          <header>
            <strong>Tools</strong>
            <Button
              size="xs"
              variant="outline"
              type="button"
              disabled={disabled}
              onClick={() =>
                void run(
                  { type: "discover", serverId: server.id },
                  "Discovery complete. Review new or changed tools.",
                )
              }
            >
              Discover tools
            </Button>
          </header>
          {server.tools.length === 0 ? (
            <p>No tools discovered yet.</p>
          ) : (
            server.tools.map((tool) => (
              <SettingsRow
                key={tool.name}
                title={<code>{tool.name}</code>}
                control={
                  <SettingsToggle
                    checked={tool.approved}
                    disabled={disabled}
                    label={`${tool.approved ? "Revoke" : "Review"} ${tool.name}`}
                    onCheckedChange={() => setReviewing(tool)}
                  />
                }
              />
            ))
          )}
        </section>
        <footer>
          <Button
            size="xs"
            variant="ghost"
            type="button"
            disabled={disabled}
            onClick={() => setRemoving(true)}
          >
            Remove server
          </Button>
          <Button
            size="xs"
            type="submit"
            disabled={disabled || !mcpFieldsComplete(fields, server)}
          >
            Save
          </Button>
        </footer>
      </form>
      <ReviewToolDialog
        server={server}
        tool={reviewing}
        busy={busy}
        run={run}
        onClose={() => setReviewing(undefined)}
      />
      <RemoveServerDialog
        server={server}
        open={removing}
        busy={busy}
        run={run}
        onCancel={() => setRemoving(false)}
        onRemoved={onClose}
      />
    </>
  );
}

function PolicyRow({
  allowed,
  disabled,
  run,
}: {
  readonly allowed: boolean;
  readonly disabled: boolean;
  readonly run: Run;
}) {
  const [confirming, setConfirming] = React.useState<boolean>();
  return (
    <>
      <SettingsRow
        title="Allow personal MCP servers"
        control={
          <SettingsToggle
            checked={allowed}
            disabled={disabled}
            label="Allow personal MCP servers"
            onCheckedChange={setConfirming}
          />
        }
      />
      <DialogRoot
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
      >
        {confirming === undefined ? null : (
          <DialogContent>
            <DialogTitle>
              {confirming ? "Allow" : "Block"} personal MCP servers?
            </DialogTitle>
            <DialogDescription>
              Members' next calls follow the new policy.
            </DialogDescription>
            <footer className="mcp-dialog-actions">
              <Button
                size="xs"
                variant="ghost"
                onClick={() => setConfirming(undefined)}
              >
                Cancel
              </Button>
              <Button
                size="xs"
                onClick={async () => {
                  const done = await run(
                    { type: "updatePolicy", allowPersonalServers: confirming },
                    "Workspace MCP policy updated.",
                  );
                  if (done) setConfirming(undefined);
                }}
              >
                Confirm
              </Button>
            </footer>
          </DialogContent>
        )}
      </DialogRoot>
    </>
  );
}

export function McpSection({
  target,
  onStatus,
  onDirtyChange,
}: {
  readonly target: McpServersTarget;
  readonly onStatus: (message: string | undefined) => void;
  readonly onDirtyChange: (dirty: boolean) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const resource = useQuery(mcpServersQueryOptions(identity.id, target));
  const mutation = useMutation(
    mcpServersMutationOptions(queryClient, identity.id, target),
  );
  const [busy, setBusy] = React.useState(false);
  const [adding, setAdding] = React.useState(false);
  const [editing, setEditing] = React.useState<string>();
  const finalFocus = React.useRef<HTMLElement | null>(null);
  const run: Run = async (action, message) => {
    setBusy(true);
    onStatus(undefined);
    try {
      await mutation.mutateAsync(action);
      onStatus(message);
      return true;
    } catch (cause) {
      onStatus(errorMessage(cause));
      return false;
    } finally {
      setBusy(false);
    }
  };
  const close = () => {
    setAdding(false);
    setEditing(undefined);
    onDirtyChange(false);
  };
  const canMutate = resource.data?.canMutate ?? false;
  const servers = resource.data?.items ?? [];
  const editingServer = servers.find(({ id }) => id === editing);
  const loadError = resource.error;
  return (
    <section className="mcp-section" aria-labelledby="mcp-section-title">
      <header className="integrations-section-heading">
        <h2 id="mcp-section-title">MCP</h2>
        {canMutate ? (
          <Button
            size="xs"
            variant="outline"
            onClick={(event) => {
              finalFocus.current = event.currentTarget;
              setAdding(true);
            }}
          >
            <Plus /> Add MCP server
          </Button>
        ) : null}
      </header>
      <SettingsCard>
        {resource.isPending ? (
          <p className="settings-card-empty">Loading MCP servers…</p>
        ) : loadError !== null ? (
          <p className="settings-card-empty" role="alert">
            {errorMessage(loadError)}{" "}
            <Button
              size="xs"
              variant="outline"
              onClick={() => void resource.refetch()}
            >
              Retry
            </Button>
          </p>
        ) : servers.length === 0 ? (
          <p className="settings-card-empty">No MCP servers yet.</p>
        ) : (
          servers.map((server) => {
            const hint = mcpServerHint(server);
            return (
              <div className="mcp-server-row" key={server.id}>
                <strong>{server.name}</strong>
                {hint === undefined ? null : <span>{hint}</span>}
                <SettingsToggle
                  checked={server.enabled}
                  disabled={!canMutate || busy}
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
                <Button
                  size="icon-xs"
                  variant="ghost"
                  aria-label={`${server.name} settings`}
                  onClick={(event) => {
                    finalFocus.current = event.currentTarget;
                    setEditing(server.id);
                  }}
                >
                  <Settings />
                </Button>
              </div>
            );
          })
        )}
        {target.scope === "workspace" &&
        resource.data?.allowPersonalServers !== undefined ? (
          <PolicyRow
            allowed={resource.data.allowPersonalServers}
            disabled={!canMutate || busy}
            run={run}
          />
        ) : null}
      </SettingsCard>
      <AddServerDialog
        key={adding ? "adding" : "idle"}
        open={adding}
        busy={busy}
        finalFocus={finalFocus}
        run={run}
        onDirtyChange={onDirtyChange}
        onClose={close}
      />
      <DialogRoot
        open={editingServer !== undefined}
        onOpenChange={(open) => {
          if (!open) close();
        }}
      >
        {editingServer === undefined ? null : (
          <DialogContent finalFocus={finalFocus} className="mcp-server-dialog">
            <DialogTitle>{editingServer.name}</DialogTitle>
            <ServerSettingsForm
              key={editingServer.id}
              server={editingServer}
              canMutate={canMutate}
              busy={busy}
              run={run}
              onDirtyChange={onDirtyChange}
              onClose={close}
            />
          </DialogContent>
        )}
      </DialogRoot>
    </section>
  );
}
