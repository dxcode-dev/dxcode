import { Menu } from "@base-ui/react/menu";
import type {
  CatalogProviderData,
  ConnectionData,
  CustomApiFormatData,
  PendingPersonalModelSubscriptionAuthorizationDataSchema,
} from "@dx/api";
import { customModelEndpoint } from "@dx/domain";
import {
  ArrowDown,
  ArrowUp,
  ChevronRight,
  GitBranch,
  GripVertical,
  Plus,
} from "lucide-react";
import type { FormEvent, PointerEventHandler } from "react";
import { useRef, useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";

import { parseCustomModelsText } from "./custom-models.js";
import {
  beginCopilotAuthorization,
  pollCopilotAuthorization,
} from "./model-routing-mutations.js";

type CustomApiFormat = CustomApiFormatData;

const CUSTOM_API_FORMATS: ReadonlyArray<readonly [string, string]> = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
];

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

export const AddConnectionMenu = ({
  showCopilot,
  onPick,
}: {
  readonly showCopilot: boolean;
  readonly onPick: (pick: "copilot" | "custom") => void;
}) => (
  <Menu.Root>
    <Menu.Trigger className="routing-add-button">
      <Plus aria-hidden="true" /> Add
    </Menu.Trigger>
    <Menu.Portal>
      <Menu.Positioner
        side="bottom"
        align="end"
        sideOffset={6}
        className="routing-menu-positioner"
      >
        <Menu.Popup className="routing-add-menu">
          {showCopilot ? (
            <Menu.Item onClick={() => onPick("copilot")}>
              <GitHubIcon aria-hidden="true" />
              GitHub Copilot
            </Menu.Item>
          ) : null}
          <Menu.Item onClick={() => onPick("custom")}>
            <GitBranch aria-hidden="true" />
            Custom URL
          </Menu.Item>
        </Menu.Popup>
      </Menu.Positioner>
    </Menu.Portal>
  </Menu.Root>
);

export const ConnectionRow = ({
  connection,
  priority,
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
}: {
  readonly connection: ConnectionData;
  readonly priority: number;
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
}) => {
  const managed =
    connection.kind === "subscription" || connection.kind === "deployment";
  const Icon = connection.kind === "subscription" ? GitHubIcon : GitBranch;
  const label =
    connection.kind === "subscription"
      ? "GitHub Copilot"
      : connection.kind === "custom"
        ? "Custom URL"
        : connection.providerId;
  return (
    <div
      className="model-routing-connection-row"
      data-disabled={!connection.enabled || undefined}
    >
      <div className="model-routing-connection-head">
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
        <button
          type="button"
          className="model-routing-connection-disclosure"
          aria-expanded={expanded}
          aria-controls={`connection-detail-${connection.id}`}
          onClick={onExpand}
        >
          <Icon className="routing-connection-icon" aria-hidden="true" />
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
      {expanded ? (
        <div
          className="model-routing-connection-detail"
          id={`connection-detail-${connection.id}`}
        >
          <dl>
            <div>
              <dt>{managed ? "Account" : "API key"}</dt>
              <dd>
                {connection.credential?.present
                  ? `Stored ···${connection.credential.tail ?? ""}`
                  : managed
                    ? label
                    : "Not configured"}
                <button
                  type="button"
                  className="model-routing-connection-check"
                  disabled={checkingAccess || !canMutate}
                  onClick={onCheckAccess}
                >
                  {checkingAccess ? "Checking…" : "Check access"}
                </button>
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
                {connection.serves === "catalog"
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
          <div className="model-routing-connection-footer">
            <span className="model-routing-connection-meta">
              Priority {priority}
            </span>
            <div className="model-routing-connection-actions">
              <button
                type="button"
                className="model-routing-connection-action"
                disabled={!canReorderUp}
                aria-label="Move connection up"
                onClick={() => onMove(-1)}
              >
                <ArrowUp />
              </button>
              <button
                type="button"
                className="model-routing-connection-action"
                disabled={!canReorderDown}
                aria-label="Move connection down"
                onClick={() => onMove(1)}
              >
                <ArrowDown />
              </button>
              {canMutate ? (
                <>
                  <button
                    type="button"
                    className="model-routing-connection-action"
                    onClick={() => onToggle(!connection.enabled)}
                  >
                    {connection.enabled ? "Deactivate" : "Activate"}
                  </button>
                  {!managed ? (
                    <button
                      type="button"
                      className="model-routing-connection-action"
                      onClick={onEdit}
                    >
                      Edit
                    </button>
                  ) : null}
                  <button
                    type="button"
                    className="model-routing-connection-action"
                    data-variant="danger"
                    onClick={
                      connection.kind === "subscription"
                        ? onDisconnect
                        : onDelete
                    }
                  >
                    {connection.kind === "subscription"
                      ? "Disconnect"
                      : "Delete"}
                  </button>
                </>
              ) : null}
            </div>
          </div>
        </div>
      ) : null}
    </div>
  );
};

const parseHeaders = (
  input: string,
): {
  headers: ReadonlyArray<{ name: string; value: string }>;
  error?: string;
} => {
  const headers: Array<{ name: string; value: string }> = [];
  const lines = input.split("\n");
  for (const [index, raw] of lines.entries()) {
    const text = raw.trim();
    if (text === "") continue;
    const colon = text.indexOf(":");
    if (colon <= 0) {
      return { headers, error: `Line ${index + 1}: expected \`Name: value\`.` };
    }
    headers.push({
      name: text.slice(0, colon).trim(),
      value: text.slice(colon + 1).trim(),
    });
  }
  return { headers };
};

export interface ConnectionDialogSubmit {
  readonly name: string;
  readonly apiKey?: string;
  readonly baseUrl?: string | null;
  readonly format?: CustomApiFormat;
  readonly fields: Readonly<Record<string, string>>;
  /** Omitted while editing to preserve stored values; an empty array clears. */
  readonly headers?: ReadonlyArray<{ name: string; value: string }>;
  readonly models?: ReadonlyArray<{ canonical: string; upstream?: string }>;
  readonly enabled: boolean;
}

type HeaderAction = "keep" | "replace" | "clear";

const CustomHeaderEditor = ({
  stored,
  action,
  onAction,
  text,
  onText,
  error,
}: {
  readonly stored: ConnectionData["headers"];
  readonly action: HeaderAction;
  readonly onAction: (action: HeaderAction) => void;
  readonly text: string;
  readonly onText: (text: string) => void;
  readonly error?: string;
}) => (
  <label htmlFor="mr-headers">
    Custom headers
    {stored.length > 0 ? (
      <>
        <span className="text-sm text-muted-foreground">
          Stored:{" "}
          {stored
            .map((header) => `${header.name}: ${header.masked}`)
            .join(", ")}
        </span>
        <select
          aria-label="Custom header action"
          value={action}
          onChange={(event) => onAction(event.target.value as HeaderAction)}
        >
          <option value="keep">Keep stored headers</option>
          <option value="replace">Replace stored headers</option>
          <option value="clear">Clear stored headers</option>
        </select>
      </>
    ) : null}
    {action === "replace" ? (
      <Textarea
        id="mr-headers"
        rows={3}
        placeholder="X-Tenant: my-tenant"
        value={text}
        onChange={(event) => onText(event.target.value)}
      />
    ) : null}
    {error === undefined ? null : (
      <span className="model-routing-field-error">{error}</span>
    )}
  </label>
);

/**
 * Add/edit dialog for catalog providers and Custom URL connections. Mount
 * with a `key` of provider id or `custom` so a different target resets the
 * form.
 */
const ConnectionFieldError = ({
  message,
}: {
  readonly message: string | undefined;
}) =>
  message === undefined ? null : (
    <span className="model-routing-field-error">{message}</span>
  );

/** A custom connection's models, one canonical model per line. */
const CustomModelsField = ({
  value,
  onChange,
  lineErrors,
  error,
}: {
  readonly value: string;
  readonly onChange: (value: string) => void;
  readonly lineErrors: ReadonlyArray<{ line: number; message: string }>;
  readonly error: string | undefined;
}) => (
  <label htmlFor="mr-models">
    Models
    <Textarea
      id="mr-models"
      rows={3}
      placeholder={
        "openai/gpt-6-astra -> astra-litellm\nanthropic/claude-fable-5-1"
      }
      value={value}
      onChange={(event) => onChange(event.target.value)}
    />
    <span className="routing-model-hint">
      One canonical model per line. Add -&gt; upstream-id to map a different
      provider name.
    </span>
    {lineErrors.map((lineError) => (
      <span key={lineError.line} className="model-routing-field-error">
        Line {lineError.line}: {lineError.message}
      </span>
    ))}
    <ConnectionFieldError message={error} />
  </label>
);

export const ConnectionDialog = ({
  open,
  provider,
  existing,
  busy,
  fieldErrors,
  submitError,
  onClose,
  onSubmit,
}: {
  readonly open: boolean;
  readonly provider?: CatalogProviderData;
  readonly existing?: ConnectionData;
  readonly busy: boolean;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly submitError?: string;
  readonly onClose: () => void;
  readonly onSubmit: (input: ConnectionDialogSubmit) => void;
}) => {
  const custom = provider === undefined;
  const [name, setName] = useState(
    () => existing?.name ?? provider?.name ?? "",
  );
  const [apiKey, setApiKey] = useState("");
  const [fields, setFields] = useState<Readonly<Record<string, string>>>(
    () => ({
      ...Object.fromEntries(
        (provider?.fields ?? []).map((field) => [field.key, ""]),
      ),
      ...(existing?.fields ?? {}),
    }),
  );
  const [baseUrl, setBaseUrl] = useState(() => existing?.baseUrl ?? "");
  const [format, setFormat] = useState<CustomApiFormat>(
    () => existing?.format ?? "openai-completions",
  );
  const [modelsText, setModelsText] = useState(() =>
    (existing?.models ?? [])
      .map(
        (model) =>
          `${model.canonical}${model.upstream === undefined ? "" : ` -> ${model.upstream}`}`,
      )
      .join("\n"),
  );
  const [headersText, setHeadersText] = useState("");
  const hasStoredHeaders = (existing?.headers.length ?? 0) > 0;
  const [headerAction, setHeaderAction] = useState<HeaderAction>(() =>
    hasStoredHeaders ? "keep" : "replace",
  );
  const [advanced, setAdvanced] = useState(false);
  const [headerError, setHeaderError] = useState<string>();
  const [modelErrors, setModelErrors] = useState<
    ReadonlyArray<{ line: number; message: string }>
  >([]);

  const endpointPreview =
    custom && baseUrl.trim() !== ""
      ? customModelEndpoint(format, baseUrl)
      : undefined;
  const requiredFields =
    provider?.fields.filter((field) => field.required) ?? [];
  const advancedFields =
    provider?.fields.filter((field) => !field.required) ?? [];

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const { headers, error } =
      headerAction === "replace"
        ? parseHeaders(headersText)
        : { headers: [], error: undefined };
    if (error !== undefined) {
      setHeaderError(error);
      return;
    }
    setHeaderError(undefined);
    const parsed = custom ? parseCustomModelsText(modelsText) : undefined;
    if (parsed !== undefined && parsed.errors.length > 0) {
      setModelErrors(parsed.errors);
      return;
    }
    setModelErrors([]);
    onSubmit({
      name,
      ...(apiKey === "" ? {} : { apiKey }),
      ...(baseUrl === ""
        ? existing !== undefined && !custom && existing.baseUrl !== undefined
          ? { baseUrl: null }
          : {}
        : { baseUrl }),
      ...(custom ? { format } : {}),
      fields: Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== ""),
      ),
      ...(headerAction === "keep"
        ? {}
        : { headers: headerAction === "clear" ? [] : headers }),
      ...(parsed !== undefined ? { models: parsed.models } : {}),
      enabled: true,
    });
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && onClose()}>
      <DialogContent className="model-routing-dialog">
        <DialogTitle>
          {existing === undefined
            ? custom
              ? "Add Custom URL"
              : `Add ${provider.name}`
            : `Edit ${existing.name}`}
        </DialogTitle>
        <DialogDescription>
          {custom
            ? "Connect your models through an API endpoint."
            : provider.description}
        </DialogDescription>
        <form
          onSubmit={submit}
          className="model-routing-dialog-form"
          autoComplete="off"
        >
          <label htmlFor="mr-base-url">
            {custom ? "Base URL" : "Base URL override"}
            <Input
              id="mr-base-url"
              autoFocus
              placeholder={custom ? "https://api.example.com/v1" : "https://"}
              value={baseUrl}
              aria-describedby={
                endpointPreview === undefined ? undefined : "mr-endpoint"
              }
              onChange={(event) => setBaseUrl(event.target.value)}
            />
            <ConnectionFieldError message={fieldErrors.baseUrl} />
          </label>
          {custom ? (
            <fieldset className="routing-format-options">
              <legend>API format</legend>
              {CUSTOM_API_FORMATS.map(([value, label]) => (
                <label key={value} className="routing-format-option">
                  <input
                    type="radio"
                    name="api-format"
                    value={value}
                    checked={format === value}
                    onChange={() => setFormat(value as CustomApiFormat)}
                  />
                  {label}
                </label>
              ))}
            </fieldset>
          ) : null}
          {endpointPreview === undefined ? null : (
            <p
              id="mr-endpoint"
              className="routing-endpoint-preview"
              aria-live="polite"
            >
              <span>Requests go to</span>
              <code className="model-routing-connection-mono">
                {endpointPreview}
              </code>
            </p>
          )}
          <label htmlFor="mr-name">
            Name
            <Input
              id="mr-name"
              value={name}
              autoComplete="off"
              onChange={(event) => setName(event.target.value)}
            />
            <ConnectionFieldError message={fieldErrors.name} />
          </label>
          <label htmlFor="mr-key">
            API key
            <Input
              id="mr-key"
              type="password"
              autoComplete="new-password"
              placeholder={
                existing?.credential?.present === true
                  ? `Stored ···${existing.credential.tail ?? ""} — leave blank to keep`
                  : "Required"
              }
              value={apiKey}
              onChange={(event) => setApiKey(event.target.value)}
            />
            <ConnectionFieldError message={fieldErrors.apiKey} />
          </label>
          {requiredFields.map((field) => (
            <label key={field.key} htmlFor={`mr-field-${field.key}`}>
              {field.label}
              <Input
                id={`mr-field-${field.key}`}
                type={field.secret ? "password" : "text"}
                placeholder={field.placeholder}
                value={fields[field.key] ?? ""}
                onChange={(event) =>
                  setFields((current) => ({
                    ...current,
                    [field.key]: event.target.value,
                  }))
                }
              />
              <ConnectionFieldError
                message={fieldErrors[`fields.${field.key}`]}
              />
            </label>
          ))}
          {custom ? (
            <CustomModelsField
              value={modelsText}
              onChange={setModelsText}
              lineErrors={modelErrors}
              error={fieldErrors.models}
            />
          ) : null}
          <button
            type="button"
            className="model-routing-advanced-toggle"
            onClick={() => setAdvanced((current) => !current)}
          >
            {advanced ? "Hide advanced" : "Advanced"}
          </button>
          {advanced ? (
            <div className="model-routing-advanced">
              {advancedFields.map((field) => (
                <label key={field.key} htmlFor={`mr-adv-${field.key}`}>
                  {field.label}
                  <Input
                    id={`mr-adv-${field.key}`}
                    placeholder={field.placeholder}
                    value={fields[field.key] ?? ""}
                    onChange={(event) =>
                      setFields((current) => ({
                        ...current,
                        [field.key]: event.target.value,
                      }))
                    }
                  />
                </label>
              ))}
              <CustomHeaderEditor
                stored={existing?.headers ?? []}
                action={headerAction}
                onAction={setHeaderAction}
                text={headersText}
                onText={setHeadersText}
                error={headerError}
              />
            </div>
          ) : null}
          {submitError === undefined ? null : (
            <p className="model-routing-field-error">{submitError}</p>
          )}
          <div className="model-routing-dialog-actions">
            <Button type="button" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button type="submit" disabled={busy}>
              {busy ? "Saving…" : existing === undefined ? "Add" : "Save"}
            </Button>
          </div>
        </form>
      </DialogContent>
    </DialogRoot>
  );
};

/** GitHub Copilot device-flow connect dialog. */
export const CopilotConnectDialog = ({
  open,
  onClose,
  onConnected,
}: {
  readonly open: boolean;
  readonly onClose: () => void;
  readonly onConnected: () => void;
}) => {
  const [authorization, setAuthorization] =
    useState<
      typeof PendingPersonalModelSubscriptionAuthorizationDataSchema.Type
    >();
  const [phase, setPhase] = useState<
    "idle" | "starting" | "pending" | "connected" | "failed"
  >("idle");
  const [error, setError] = useState<string>();
  const cancelled = useRef(false);

  const poll = (authorizationId: string, delayMs: number) => {
    setTimeout(() => {
      if (cancelled.current) return;
      pollCopilotAuthorization(authorizationId)
        .then((result) => {
          if (cancelled.current) return;
          if (result.state === "connected") {
            setPhase("connected");
            onConnected();
            return;
          }
          if (result.state === "pending") {
            setAuthorization(result);
            poll(
              result.id,
              Math.max(0, result.nextPollAt.epochMilliseconds - Date.now()),
            );
            return;
          }
          setPhase("failed");
          setError(`Authorization ${result.state}.`);
        })
        .catch((pollError: unknown) => {
          if (cancelled.current) return;
          setPhase("failed");
          setError(
            pollError instanceof Error ? pollError.message : "Polling failed.",
          );
        });
    }, delayMs);
  };

  const begin = () => {
    cancelled.current = false;
    setPhase("starting");
    setError(undefined);
    beginCopilotAuthorization()
      .then((result) => {
        if (cancelled.current) return;
        setAuthorization(result);
        setPhase("pending");
        poll(
          result.id,
          Math.max(0, result.nextPollAt.epochMilliseconds - Date.now()),
        );
      })
      .catch((beginError: unknown) => {
        if (cancelled.current) return;
        setPhase("failed");
        setError(
          beginError instanceof Error
            ? beginError.message
            : "Could not start authorization.",
        );
      });
  };

  const close = () => {
    cancelled.current = true;
    setAuthorization(undefined);
    setPhase("idle");
    setError(undefined);
    onClose();
  };

  return (
    <DialogRoot open={open} onOpenChange={(next) => !next && close()}>
      <DialogContent className="model-routing-dialog">
        <DialogTitle>Connect GitHub Copilot</DialogTitle>
        {phase === "pending" && authorization !== undefined ? (
          <div className="model-routing-copilot-flow">
            <p>
              Open{" "}
              <a
                href={authorization.verificationUrl}
                target="_blank"
                rel="noreferrer"
              >
                {authorization.verificationUrl}
              </a>{" "}
              and enter this code:
            </p>
            <code className="model-routing-copilot-code">
              {authorization.userCode}
            </code>
            <p>Waiting for GitHub to confirm…</p>
          </div>
        ) : phase === "connected" ? (
          <p>GitHub Copilot connected.</p>
        ) : (
          <p>
            Sign in with your GitHub Copilot subscription to serve its models.
            This is separate from your GitHub source-control connection.
          </p>
        )}
        {error === undefined ? null : (
          <p className="model-routing-field-error">{error}</p>
        )}
        <div className="model-routing-dialog-actions">
          <Button type="button" variant="ghost" onClick={close}>
            {phase === "connected" ? "Close" : "Cancel"}
          </Button>
          {phase === "idle" || phase === "starting" || phase === "failed" ? (
            <Button
              type="button"
              onClick={begin}
              disabled={phase === "starting"}
            >
              {phase === "starting" ? "Starting…" : "Connect"}
            </Button>
          ) : null}
        </div>
      </DialogContent>
    </DialogRoot>
  );
};
