import { Menu } from "@base-ui/react/menu";
import {
  Check,
  ChevronRight,
  ClipboardPaste,
  Copy,
  Info,
  Lock,
  Plus,
  X,
} from "lucide-react";
import * as React from "react";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import type { McpTemplate } from "./mcp-catalog.js";
import type { McpServerData } from "./mcp-queries.js";
import {
  emptyMcpHeader,
  looksSecret,
  type McpAuthMode,
  type McpFieldErrors,
  type McpHeaderField,
  type McpServerFields,
  mcpModuleIdFor,
  mcpOAuthCallbackUrl,
  parsePastedHeaders,
  withMcpName,
} from "./mcp-server-fields.js";

const AUTH_COPY: Readonly<
  Record<McpAuthMode, { readonly title: string; readonly detail: string }>
> = {
  auto: {
    title: "Automatic Detection",
    detail: "dx checks the server when you connect.",
  },
  oauth: { title: "OAuth", detail: "Sign in on the provider's website." },
  token: {
    title: "Bearer Token",
    detail: "Send an API token with every request.",
  },
  none: { title: "No Authentication", detail: "Connect without credentials." },
  secret: {
    title: "Secret Reference",
    detail:
      "Uses a secret that is also visible in Thread sandboxes. Choose Bearer Token to store a token on this server instead.",
  },
};

/** Links, inline code, and bold in a template's setup note. */
function SetupText({ text }: { readonly text: string }) {
  const tokens = [
    ...text.matchAll(
      /\[([^\]]+)\]\(([^)]+)\)|`([^`]+)`|\*\*([^*]+)\*\*|[^[`*]+|./g,
    ),
  ];
  return (
    <>
      {tokens.map((token) => {
        const key = `${token.index}`;
        if (token[1] !== undefined)
          return (
            <a key={key} href={token[2]} target="_blank" rel="noreferrer">
              {token[1]}
            </a>
          );
        if (token[3] !== undefined) return <code key={key}>{token[3]}</code>;
        if (token[4] !== undefined)
          return <strong key={key}>{token[4]}</strong>;
        return <React.Fragment key={key}>{token[0]}</React.Fragment>;
      })}
    </>
  );
}

function FieldError({
  id,
  children,
}: {
  readonly id: string;
  readonly children?: string;
}) {
  return children === undefined ? null : (
    <p id={id} className="mcp-field-error">
      {children}
    </p>
  );
}

function Field({
  id,
  label,
  error,
  help,
  children,
}: {
  readonly id: string;
  readonly label: string;
  readonly error?: string;
  readonly help?: React.ReactNode;
  readonly children: React.ReactNode;
}) {
  return (
    <div className="mcp-form-field">
      <label htmlFor={id}>{label}</label>
      {children}
      {help === undefined ? null : <p className="mcp-form-help">{help}</p>}
      <FieldError id={`${id}-error`}>{error}</FieldError>
    </div>
  );
}

function AuthenticationCard({
  value,
  creating,
  legacySecret,
  disabled,
  onChange,
}: {
  readonly value: McpAuthMode;
  readonly creating: boolean;
  readonly legacySecret: boolean;
  readonly disabled: boolean;
  readonly onChange: (mode: McpAuthMode) => void;
}) {
  const choices: ReadonlyArray<McpAuthMode> = [
    "oauth",
    "token",
    "none",
    ...(legacySecret ? (["secret"] as const) : []),
  ];
  return (
    <div className="mcp-auth-card">
      <div>
        <strong>{AUTH_COPY[value].title}</strong>
        {value === "auto" ? null : <span>{AUTH_COPY[value].detail}</span>}
      </div>
      <Menu.Root>
        <Menu.Trigger
          disabled={disabled}
          render={<Button size="xs" variant="ghost" type="button" />}
        >
          Change
        </Menu.Trigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            align="end"
            sideOffset={4}
          >
            <Menu.Popup className="thread-menu-popup mcp-menu-popup">
              {creating ? (
                <Menu.Item
                  className="thread-menu-item mcp-menu-heading"
                  onClick={() => onChange("auto")}
                >
                  Detect Authentication
                </Menu.Item>
              ) : null}
              <Menu.RadioGroup
                value={value}
                onValueChange={(next) => onChange(next as McpAuthMode)}
              >
                {choices.map((mode) => (
                  <Menu.RadioItem
                    key={mode}
                    value={mode}
                    className="thread-menu-item mcp-menu-radio"
                  >
                    <Menu.RadioItemIndicator className="mcp-menu-indicator">
                      <Check />
                    </Menu.RadioItemIndicator>
                    {AUTH_COPY[mode].title}
                  </Menu.RadioItem>
                ))}
              </Menu.RadioGroup>
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.Root>
    </div>
  );
}

function CopyValue({ value }: { readonly value: string }) {
  const [copied, setCopied] = React.useState(false);
  return (
    <div className="mcp-copy-value">
      <code>{value}</code>
      <Button
        size="icon-xs"
        variant="ghost"
        type="button"
        aria-label="Copy callback URL"
        onClick={() =>
          void navigator.clipboard.writeText(value).then(() => setCopied(true))
        }
      >
        {copied ? <Check /> : <Copy />}
      </Button>
    </div>
  );
}

function HeadersEditor({
  id,
  headers,
  error,
  disabled,
  onChange,
}: {
  readonly id: string;
  readonly headers: ReadonlyArray<McpHeaderField>;
  readonly error?: string;
  readonly disabled: boolean;
  readonly onChange: (headers: ReadonlyArray<McpHeaderField>) => void;
}) {
  const [pasting, setPasting] = React.useState<string>();
  const [placeholder] = React.useState(emptyMcpHeader);
  const rows: ReadonlyArray<McpHeaderField> =
    headers.length === 0 ? [placeholder] : headers;
  const update = (index: number, header: McpHeaderField) =>
    onChange(rows.map((row, at) => (at === index ? header : row)));
  return (
    <div className="mcp-form-field">
      <span className="mcp-form-label">Headers</span>
      {rows.map((header, index) => (
        <div className="mcp-header-row" key={header.key}>
          <Input
            aria-label={`Header ${index + 1} name`}
            value={header.name}
            disabled={disabled}
            placeholder="x-custom-header"
            spellCheck={false}
            onChange={(event) => {
              const name = event.target.value;
              update(index, {
                ...header,
                name,
                // Suggest Secret for credential-looking names; a stored
                // secret stays secret.
                secret:
                  header.stored ||
                  header.secret ||
                  looksSecret(name, header.value),
              });
            }}
          />
          <Input
            aria-label={`Header ${index + 1} value`}
            value={header.value}
            disabled={disabled}
            type={header.secret ? "password" : "text"}
            autoComplete="off"
            spellCheck={false}
            placeholder={header.stored ? "Saved" : "value"}
            onChange={(event) => {
              const value = event.target.value;
              update(index, {
                ...header,
                value,
                secret:
                  header.stored ||
                  header.secret ||
                  looksSecret(header.name, value),
              });
            }}
          />
          <label
            className="mcp-header-secret"
            title={
              header.stored
                ? "A saved secret stays secret. Remove it and add it again to make it visible."
                : undefined
            }
          >
            <input
              type="checkbox"
              checked={header.secret}
              disabled={disabled || header.stored}
              onChange={(event) =>
                update(index, { ...header, secret: event.target.checked })
              }
            />
            Secret
          </label>
          <Button
            size="icon-xs"
            variant="ghost"
            type="button"
            aria-label={`Remove header ${index + 1}`}
            disabled={disabled}
            onClick={() => onChange(rows.filter((_, at) => at !== index))}
          >
            <X />
          </Button>
        </div>
      ))}
      {pasting === undefined ? null : (
        <div className="mcp-header-paste">
          <Textarea
            aria-label="Paste headers"
            value={pasting}
            rows={3}
            placeholder={"X-Org-Id: acme\nX-Api-Key: …"}
            onChange={(event) => setPasting(event.target.value)}
          />
          <div>
            <Button
              size="xs"
              variant="ghost"
              type="button"
              onClick={() => setPasting(undefined)}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              type="button"
              disabled={parsePastedHeaders(pasting).length === 0}
              onClick={() => {
                onChange([
                  ...headers.filter((header) => header.name.trim() !== ""),
                  ...parsePastedHeaders(pasting),
                ]);
                setPasting(undefined);
              }}
            >
              Add headers
            </Button>
          </div>
        </div>
      )}
      <div className="mcp-header-actions">
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => onChange([...rows, emptyMcpHeader()])}
        >
          <Plus /> Add Header
        </Button>
        <Button
          size="xs"
          variant="outline"
          type="button"
          disabled={disabled}
          onClick={() => setPasting("")}
        >
          <ClipboardPaste /> Paste Headers
        </Button>
      </div>
      <p className="mcp-form-help">
        Sent with every request, for servers that need values such as an
        organization ID.
      </p>
      <FieldError id={`${id}-headers-error`}>{error}</FieldError>
    </div>
  );
}

/**
 * The fields shared by connecting a server and editing one: URL, name, ID,
 * authentication, an own OAuth app, headers, and the client name.
 */
export function McpServerForm({
  id,
  fields,
  errors,
  disabled,
  server,
  template,
  onChange,
}: {
  readonly id: string;
  readonly fields: McpServerFields;
  readonly errors: McpFieldErrors;
  readonly disabled: boolean;
  /** The server being edited; undefined when connecting a new one. */
  readonly server?: McpServerData;
  readonly template?: McpTemplate;
  readonly onChange: (fields: McpServerFields) => void;
}) {
  const [ownAppOpen, setOwnAppOpen] = React.useState(
    fields.oauthClientId !== "",
  );
  const [headersOpen, setHeadersOpen] = React.useState(
    fields.headers.length > 0,
  );
  const [clientNameOpen, setClientNameOpen] = React.useState(
    fields.clientName !== "",
  );
  const creating = server === undefined;
  return (
    <div className="mcp-server-form">
      <Field id={`${id}-url`} label="Server URL" error={errors.endpoint}>
        <Input
          id={`${id}-url`}
          aria-invalid={errors.endpoint !== undefined}
          value={fields.endpoint}
          maxLength={2048}
          required
          disabled={disabled}
          placeholder="mcp.example.com/mcp"
          spellCheck={false}
          autoComplete="off"
          onChange={(event) =>
            onChange({ ...fields, endpoint: event.target.value })
          }
        />
      </Field>
      <Field id={`${id}-name`} label="Name" error={errors.name}>
        <Input
          id={`${id}-name`}
          aria-invalid={errors.name !== undefined}
          value={fields.name}
          maxLength={80}
          required
          disabled={disabled}
          onChange={(event) =>
            onChange(withMcpName(fields, event.target.value))
          }
        />
      </Field>
      <Field
        id={`${id}-module`}
        label="ID"
        error={errors.moduleId}
        help={`Agents import this server's tools under this ID. IDs must be unique within these settings. When IDs match, workspace servers override personal servers.${creating ? "" : " Renaming does not change this ID."}`}
      >
        <Input
          id={`${id}-module`}
          aria-invalid={errors.moduleId !== undefined}
          value={fields.moduleId}
          maxLength={64}
          disabled={disabled}
          spellCheck={false}
          autoComplete="off"
          placeholder={mcpModuleIdFor(fields.name) || "docs"}
          onChange={(event) =>
            onChange({
              ...fields,
              moduleId: event.target.value,
              moduleIdEdited: event.target.value !== "",
            })
          }
        />
      </Field>
      <div className="mcp-form-field">
        <span className="mcp-form-label">Authentication</span>
        <AuthenticationCard
          value={fields.auth}
          creating={creating}
          legacySecret={server?.authReference !== undefined}
          disabled={disabled}
          onChange={(auth) => onChange({ ...fields, auth, token: "" })}
        />
        <FieldError id={`${id}-auth-error`}>{errors.auth}</FieldError>
      </div>
      {fields.auth === "token" ? (
        <div className="mcp-form-inset">
          <Field
            id={`${id}-token`}
            label="Bearer Token"
            help={
              <>
                dx sends it as <code>Authorization: Bearer …</code>. For another
                scheme, choose No Authentication and add an Authorization
                header.
              </>
            }
          >
            <div className="mcp-secret-input">
              <Input
                id={`${id}-token`}
                type="password"
                autoComplete="off"
                spellCheck={false}
                value={fields.token}
                disabled={disabled}
                placeholder={
                  server?.hasStoredToken
                    ? "Saved. Enter a new token to replace it."
                    : "Paste API token"
                }
                onChange={(event) =>
                  onChange({ ...fields, token: event.target.value })
                }
              />
              <Lock aria-hidden="true" />
            </div>
          </Field>
        </div>
      ) : null}
      {fields.auth === "none" ? (
        <p className="mcp-form-help">
          Use this only when the MCP server accepts requests without
          credentials.
        </p>
      ) : null}
      {fields.auth === "oauth" ? (
        <>
          <button
            type="button"
            className="mcp-disclosure"
            aria-expanded={ownAppOpen}
            onClick={() => setOwnAppOpen(!ownAppOpen)}
          >
            Use Your Own OAuth App
            <ChevronRight data-open={ownAppOpen || undefined} />
          </button>
          {ownAppOpen ? (
            <div className="mcp-form-inset">
              <p className="mcp-form-help">
                Enter these credentials only if you configured your own OAuth
                app. Without them, dx registers itself with the server.
              </p>
              <div className="mcp-form-pair">
                <Field id={`${id}-client-id`} label="OAuth Client ID">
                  <Input
                    id={`${id}-client-id`}
                    value={fields.oauthClientId}
                    disabled={disabled}
                    placeholder="Optional"
                    spellCheck={false}
                    autoComplete="off"
                    onChange={(event) =>
                      onChange({ ...fields, oauthClientId: event.target.value })
                    }
                  />
                </Field>
                <Field id={`${id}-client-secret`} label="OAuth Client Secret">
                  <div className="mcp-secret-input">
                    <Input
                      id={`${id}-client-secret`}
                      type="password"
                      value={fields.oauthClientSecret}
                      disabled={disabled}
                      autoComplete="off"
                      placeholder={
                        server?.hasOAuthClientSecret ? "Saved" : "Optional"
                      }
                      onChange={(event) =>
                        onChange({
                          ...fields,
                          oauthClientSecret: event.target.value,
                        })
                      }
                    />
                    <Lock aria-hidden="true" />
                  </div>
                </Field>
              </div>
              <p className="mcp-form-help">
                If the provider asks for an allowed callback URL, use this
                value.
              </p>
              <CopyValue value={mcpOAuthCallbackUrl()} />
            </div>
          ) : null}
        </>
      ) : null}
      <div className="mcp-form-chips">
        <Button
          size="xs"
          variant="outline"
          type="button"
          aria-expanded={headersOpen}
          onClick={() => setHeadersOpen(!headersOpen)}
        >
          Headers
        </Button>
        <Button
          size="xs"
          variant="outline"
          type="button"
          aria-expanded={clientNameOpen}
          onClick={() => setClientNameOpen(!clientNameOpen)}
        >
          Client Name
        </Button>
      </div>
      {headersOpen ? (
        <HeadersEditor
          id={id}
          headers={fields.headers}
          error={errors.headers}
          disabled={disabled}
          onChange={(headers) => onChange({ ...fields, headers })}
        />
      ) : (
        <FieldError id={`${id}-headers-error`}>{errors.headers}</FieldError>
      )}
      {clientNameOpen ? (
        <Field
          id={`${id}-client-name`}
          label="Client Name"
          help="Sent as the MCP client name, and as the OAuth client name when dx registers itself. Some servers only accept clients they know by name."
        >
          <Input
            id={`${id}-client-name`}
            value={fields.clientName}
            maxLength={80}
            disabled={disabled}
            placeholder="dx"
            onChange={(event) =>
              onChange({ ...fields, clientName: event.target.value })
            }
          />
        </Field>
      ) : null}
      {template?.setup === undefined ? null : (
        <div className="mcp-setup-note" role="note">
          <Info aria-hidden="true" />
          <div>
            <strong>Client Setup Required</strong>
            <p>
              <SetupText text={template.setup} />
            </p>
          </div>
        </div>
      )}
      <FieldError id={`${id}-form-error`}>{errors.form}</FieldError>
    </div>
  );
}
