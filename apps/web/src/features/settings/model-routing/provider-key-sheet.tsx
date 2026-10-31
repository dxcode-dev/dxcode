import { Dialog } from "@base-ui/react/dialog";
import type { CatalogProviderData, ConnectionData } from "@dx/api";
import { modelMappingText, parseModelMappingText } from "@dx/domain";
import { KeyRound, LockKeyhole, X } from "lucide-react";
import { type FormEvent, useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import type { ConnectionDialogSubmit } from "./connection-dialog.js";
import {
  type HeaderRow,
  ProviderHeadersField,
} from "./provider-headers-field.js";
import {
  openAiRegionBaseUrl,
  openAiRegionOf,
  providerKeyPresentation,
  providerSheetTitle,
} from "./provider-key-presentation.js";
import { hasProviderMark } from "./provider-mark-ids.js";
import { ProviderMark } from "./provider-marks.js";
import { ProviderModelsSection } from "./provider-models-section.js";
import { ProviderSettingsFields } from "./provider-settings-fields.js";

/** The provider's mark in a 44px tile, or a key for unmarked providers. */
const ProviderTile = ({ providerId }: { readonly providerId: string }) => (
  <span className="routing-sheet-mark" aria-hidden="true">
    {hasProviderMark(providerId) ? (
      <ProviderMark providerId={providerId} />
    ) : (
      <KeyRound />
    )}
  </span>
);

export const ProviderKeySheet = ({
  provider,
  existing,
  defaultName,
  busy,
  fieldErrors,
  submitError,
  onClose,
  onSubmit,
}: {
  readonly provider: CatalogProviderData;
  readonly existing?: ConnectionData;
  /** Name used when Display Name is left empty. */
  readonly defaultName: string;
  readonly busy: boolean;
  readonly fieldErrors: Readonly<Record<string, string>>;
  readonly submitError?: string;
  readonly onClose: () => void;
  readonly onSubmit: (input: ConnectionDialogSubmit) => void;
}) => {
  const presentation = providerKeyPresentation(provider.id, provider.name);
  const [apiKey, setApiKey] = useState("");
  const [fields, setFields] = useState<Readonly<Record<string, string>>>(
    () => ({
      ...Object.fromEntries(provider.fields.map((field) => [field.key, ""])),
      ...(existing?.fields ?? {}),
    }),
  );
  const initialRegion = openAiRegionOf(existing?.baseUrl);
  const [region, setRegion] = useState(initialRegion);
  const [mappingText, setMappingText] = useState(() =>
    modelMappingText(existing?.models ?? []),
  );
  const [showName, setShowName] = useState(existing !== undefined);
  const [name, setName] = useState(existing?.name ?? "");
  const [showHeaders, setShowHeaders] = useState(false);
  const [headers, setHeaders] = useState<ReadonlyArray<HeaderRow>>([]);
  const [clearHeaders, setClearHeaders] = useState(false);
  const [mappingErrors, setMappingErrors] = useState<ReadonlyArray<string>>([]);

  const parsed = parseModelMappingText(mappingText);
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed.errors.length > 0) {
      setMappingErrors(
        parsed.errors.map((error) => `Line ${error.line}: ${error.message}`),
      );
      return;
    }
    setMappingErrors([]);
    const headerRows = headers.filter(
      (row) => row.name.trim() !== "" || row.value.trim() !== "",
    );
    onSubmit({
      name: name.trim() === "" ? (existing?.name ?? defaultName) : name.trim(),
      ...(apiKey === "" ? {} : { apiKey }),
      ...(presentation.region === "openai" &&
      (existing === undefined ? region !== "" : region !== initialRegion)
        ? { baseUrl: region === "" ? null : openAiRegionBaseUrl(region) }
        : {}),
      fields: Object.fromEntries(
        Object.entries(fields).filter(([, value]) => value !== ""),
      ),
      ...(clearHeaders
        ? { headers: [] }
        : headerRows.length > 0 || existing === undefined
          ? {
              headers: headerRows.map((row) => ({
                name: row.name.trim(),
                value: row.value,
              })),
            }
          : {}),
      models: parsed.lines,
      enabled: true,
    });
  };

  const description =
    presentation.sheet === "api-key"
      ? `Configure the API key dx should use for inference on ${presentation.name}.`
      : undefined;
  const requiredFields = provider.fields.filter((field) => field.required);

  return (
    <Dialog.Root open onOpenChange={(open) => !open && onClose()}>
      <Dialog.Portal>
        <Dialog.Backdrop className="dialog-backdrop" />
        <Dialog.Popup className="routing-sheet">
          <header className="routing-sheet-header">
            <ProviderTile providerId={provider.id} />
            <div className="routing-sheet-heading">
              <Dialog.Title className="routing-sheet-title">
                {existing === undefined
                  ? providerSheetTitle(presentation)
                  : `Edit ${existing.name}`}
              </Dialog.Title>
              {description === undefined ? null : (
                <Dialog.Description className="routing-sheet-description">
                  {description}
                </Dialog.Description>
              )}
            </div>
          </header>
          <div className="routing-sheet-body">
            <form
              className="routing-sheet-form"
              autoComplete="off"
              onSubmit={submit}
            >
              <div className="routing-sheet-field">
                <label htmlFor="model-provider-api-key">
                  {presentation.keyLabel}
                </label>
                <div className="routing-sheet-secret">
                  <Input
                    className="routing-sheet-control"
                    id="model-provider-api-key"
                    type="password"
                    autoComplete="new-password"
                    spellCheck={false}
                    required={existing === undefined}
                    placeholder={
                      existing?.credential?.present === true
                        ? `Stored ···${existing.credential.tail ?? ""}, leave blank to keep`
                        : presentation.placeholder
                    }
                    value={apiKey}
                    onChange={(event) => setApiKey(event.target.value)}
                  />
                  <span
                    role="img"
                    aria-label="Encrypted at rest on dx's servers"
                    title="Encrypted at rest on dx's servers"
                  >
                    <LockKeyhole />
                  </span>
                </div>
                {presentation.help === undefined ? null : (
                  <p className="routing-sheet-help">{presentation.help}</p>
                )}
                {fieldErrors.apiKey === undefined ? null : (
                  <p className="model-routing-field-error">
                    {fieldErrors.apiKey}
                  </p>
                )}
              </div>
              <ProviderSettingsFields
                presentation={presentation}
                fields={requiredFields}
                values={fields}
                onValues={setFields}
                region={region}
                onRegion={setRegion}
                fieldErrors={fieldErrors}
              />
              <ProviderModelsSection
                providerId={provider.id}
                providerName={presentation.name}
                models={provider.models}
                mappingText={mappingText}
                onMappingText={setMappingText}
                errors={[
                  ...mappingErrors,
                  ...(fieldErrors.models === undefined
                    ? []
                    : [fieldErrors.models]),
                ]}
              />
              {showName ? (
                <div className="routing-sheet-field">
                  <label htmlFor="model-provider-key-name">
                    Display Name (Optional)
                  </label>
                  <Input
                    className="routing-sheet-control"
                    id="model-provider-key-name"
                    placeholder={defaultName}
                    value={name}
                    onChange={(event) => setName(event.target.value)}
                  />
                  {fieldErrors.name === undefined ? null : (
                    <p className="model-routing-field-error">
                      {fieldErrors.name}
                    </p>
                  )}
                </div>
              ) : null}
              {presentation.headers && showHeaders ? (
                <ProviderHeadersField
                  stored={existing?.headers ?? []}
                  cleared={clearHeaders}
                  onClear={() => setClearHeaders(true)}
                  rows={headers}
                  onRows={setHeaders}
                  {...(fieldErrors.headers === undefined
                    ? {}
                    : { error: fieldErrors.headers })}
                />
              ) : null}
              {showName && (!presentation.headers || showHeaders) ? null : (
                <div className="routing-sheet-inline-actions">
                  {showName ? null : (
                    <Button
                      type="button"
                      size="xs"
                      className="routing-sheet-button"
                      variant="outline"
                      onClick={() => setShowName(true)}
                    >
                      Display Name
                    </Button>
                  )}
                  {presentation.headers && !showHeaders ? (
                    <Button
                      type="button"
                      size="xs"
                      className="routing-sheet-button"
                      variant="outline"
                      onClick={() => {
                        setShowHeaders(true);
                        if (headers.length === 0)
                          setHeaders([
                            { key: Date.now(), name: "", value: "" },
                          ]);
                      }}
                    >
                      Headers
                    </Button>
                  ) : null}
                </div>
              )}
              {submitError === undefined ? null : (
                <p className="model-routing-field-error">{submitError}</p>
              )}
              <div className="routing-sheet-footer">
                <Button
                  type="button"
                  size="xs"
                  className="routing-sheet-button"
                  variant="outline"
                  onClick={onClose}
                >
                  Cancel
                </Button>
                <Button
                  type="submit"
                  size="xs"
                  className="routing-sheet-button"
                  disabled={busy}
                >
                  {busy
                    ? "Saving…"
                    : existing === undefined
                      ? "Create"
                      : "Save"}
                </Button>
              </div>
            </form>
          </div>
          <Dialog.Close className="routing-sheet-close" aria-label="Close">
            <X />
          </Dialog.Close>
        </Dialog.Popup>
      </Dialog.Portal>
    </Dialog.Root>
  );
};
