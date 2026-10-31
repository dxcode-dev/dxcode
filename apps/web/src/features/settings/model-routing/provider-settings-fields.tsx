import type { CatalogProviderData } from "@dx/api";
import { Input } from "../../../shared/ui/input.js";
import {
  OPENAI_REGIONS,
  type ProviderKeyPresentation,
} from "./provider-key-presentation.js";

/** A provider key's own settings: OpenAI's Region and the catalog's required fields. */
export const ProviderSettingsFields = ({
  presentation,
  fields,
  values,
  onValues,
  region,
  onRegion,
  fieldErrors,
}: {
  readonly presentation: ProviderKeyPresentation;
  readonly fields: CatalogProviderData["fields"];
  readonly values: Readonly<Record<string, string>>;
  readonly onValues: (
    update: (
      current: Readonly<Record<string, string>>,
    ) => Readonly<Record<string, string>>,
  ) => void;
  readonly region: string;
  readonly onRegion: (host: string) => void;
  readonly fieldErrors: Readonly<Record<string, string>>;
}) => (
  <>
    {presentation.region === "openai" ? (
      <div className="routing-sheet-field">
        <div className="routing-sheet-label-row">
          <label htmlFor="model-provider-openai-region">Region</label>
          <span
            className="routing-sheet-badge"
            title="OpenAI serves regional endpoints to Enterprise projects with data residency."
          >
            Enterprise-Only
          </span>
        </div>
        <select
          id="model-provider-openai-region"
          className="routing-sheet-control routing-sheet-select"
          value={region}
          onChange={(event) => onRegion(event.target.value)}
        >
          <option value="">Global (api.openai.com)</option>
          {OPENAI_REGIONS.map((option) => (
            <option key={option.host} value={option.host}>
              {option.label} ({option.host})
            </option>
          ))}
        </select>
        {fieldErrors.baseUrl === undefined ? null : (
          <p className="model-routing-field-error">{fieldErrors.baseUrl}</p>
        )}
      </div>
    ) : null}
    {fields.map((field) => (
      <div key={field.key} className="routing-sheet-field">
        <label htmlFor={`model-provider-field-${field.key}`}>
          {presentation.fieldLabels?.[field.key] ?? field.label}
        </label>
        <Input
          className="routing-sheet-control"
          id={`model-provider-field-${field.key}`}
          type={field.secret ? "password" : "text"}
          placeholder={field.placeholder}
          value={values[field.key] ?? ""}
          onChange={(event) =>
            onValues((current) => ({
              ...current,
              [field.key]: event.target.value,
            }))
          }
        />
        {field.description === undefined ? null : (
          <p className="routing-sheet-help">{field.description}</p>
        )}
        {fieldErrors[`fields.${field.key}`] === undefined ? null : (
          <p className="model-routing-field-error">
            {fieldErrors[`fields.${field.key}`]}
          </p>
        )}
      </div>
    ))}
  </>
);
