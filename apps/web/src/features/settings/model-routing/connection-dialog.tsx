import type {
  CatalogProviderData,
  ConnectionData,
  CustomApiFormatData,
} from "@dx/api";
import { customModelEndpoint } from "@dx/domain";
import type { FormEvent } from "react";
import { useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";

import { parseCustomModelsText } from "./custom-models.js";

type CustomApiFormat = CustomApiFormatData;

const CUSTOM_API_FORMATS: ReadonlyArray<readonly [string, string]> = [
  ["openai-completions", "OpenAI Chat Completions"],
  ["openai-responses", "OpenAI Responses"],
  ["anthropic-messages", "Anthropic Messages"],
];

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
