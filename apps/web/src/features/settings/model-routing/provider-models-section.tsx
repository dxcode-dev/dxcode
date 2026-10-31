import { Checkbox } from "@base-ui/react/checkbox";
import { Popover } from "@base-ui/react/popover";
import { Switch } from "@base-ui/react/switch";
import type { CatalogProviderData } from "@dx/api";
import {
  type ModelMappingLine,
  modelMappingServes,
  modelMappingText,
  parseModelMappingText,
} from "@dx/domain";
import { Check, Info, KeyRound } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { hasProviderMark } from "./provider-mark-ids.js";
import { ProviderMark } from "./provider-marks.js";

type CatalogModel = CatalogProviderData["models"][number];

const OTHER_MODEL_SUFFIX = "\u0000other";

const formatTokens = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Number((tokens / 1_000_000).toFixed(1))}M tokens`
    : `${Math.round(tokens / 1000)}K tokens`;

/** Mapping lines for a set of enabled models and the "all other" choice. */
const linesFor = (
  providerId: string,
  models: ReadonlyArray<CatalogModel>,
  enabled: ReadonlySet<string>,
  others: boolean,
  renames: ReadonlyMap<string, string>,
): ModelMappingLine[] => {
  const line = (canonical: string): ModelMappingLine => {
    const upstream = renames.get(canonical);
    return upstream === undefined ? { canonical } : { canonical, upstream };
  };
  if (others) {
    const excluded = models.filter((model) => !enabled.has(model.id));
    const renamed = models.filter(
      (model) => enabled.has(model.id) && renames.has(model.id),
    );
    if (excluded.length === 0 && renamed.length === 0) return [];
    return [
      { canonical: `${providerId}/*` },
      ...excluded.map((model) => ({ canonical: `-${model.id}` })),
      ...renamed.map((model) => line(model.id)),
    ];
  }
  const included = models.filter((model) => enabled.has(model.id));
  return included.length === 0
    ? [{ canonical: `-${providerId}/*` }]
    : included.map((model) => line(model.id));
};

const ModelDetails = ({ model }: { readonly model: CatalogModel }) => {
  const slash = model.id.indexOf("/");
  const supports = [
    "Tools",
    ...(model.reasoning ? ["Reasoning"] : []),
    ...(model.vision ? ["Image input"] : []),
  ].join(", ");
  return (
    <Popover.Root>
      <Popover.Trigger
        className="routing-model-details-trigger"
        aria-label={`Details for ${model.name}`}
      >
        <Info />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner
          side="left"
          sideOffset={6}
          className="routing-menu-positioner"
        >
          <Popover.Popup className="routing-model-details">
            <p className="routing-model-details-id">{model.id}</p>
            <dl>
              <dt>Provider ID</dt>
              <dd>{model.id.slice(slash + 1)}</dd>
              <dt>Context</dt>
              <dd>{formatTokens(model.contextWindow)}</dd>
              <dt>Output</dt>
              <dd>{formatTokens(model.maxOutputTokens)}</dd>
              <dt>Supports</dt>
              <dd>{supports}</dd>
            </dl>
            <Button
              type="button"
              size="xs"
              variant="outline"
              className="routing-sheet-button routing-model-details-copy"
              onClick={() => void navigator.clipboard?.writeText(model.id)}
            >
              Copy to clipboard
            </Button>
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
};

const ModelRow = ({
  id,
  providerId,
  label,
  checked,
  onChange,
  details,
  note,
}: {
  readonly id: string;
  readonly providerId: string;
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly details?: CatalogModel;
  /** Popover text for a row without catalog details. */
  readonly note?: string;
}) => (
  <div className="routing-model-row">
    <label className="routing-model-row-label" htmlFor={id}>
      <Checkbox.Root
        id={id}
        checked={checked}
        onCheckedChange={onChange}
        className="routing-checkbox"
      >
        <Checkbox.Indicator className="routing-checkbox-indicator">
          <Check />
        </Checkbox.Indicator>
      </Checkbox.Root>
      {hasProviderMark(providerId) ? (
        <ProviderMark
          providerId={providerId}
          className="routing-model-row-mark"
        />
      ) : (
        <KeyRound className="routing-model-row-mark" aria-hidden="true" />
      )}
      <span className="routing-model-row-name">{label}</span>
    </label>
    {details !== undefined ? (
      <ModelDetails model={details} />
    ) : note !== undefined ? (
      <RowNote label={label} note={note} />
    ) : null}
  </div>
);

const RowNote = ({
  label,
  note,
}: {
  readonly label: string;
  readonly note: string;
}) => (
  <Popover.Root>
    <Popover.Trigger
      className="routing-model-details-trigger"
      aria-label={`Details for ${label}`}
    >
      <Info />
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner
        side="left"
        sideOffset={6}
        className="routing-menu-positioner"
      >
        <Popover.Popup className="routing-model-details">
          <p>{note}</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
);

const MAPPING_SYNTAX = `*/*
-anthropic/*
anthropic/claude-fable-5-1
openai/gpt-5.6-sol -> gpt-5.6-sol-2026
# every model except Anthropic's, plus Claude Fable 5.1,
# with GPT-5.6 Sol sent to the provider as gpt-5.6-sol-2026`;

const MappingSyntax = () => (
  <Popover.Root>
    <Popover.Trigger
      render={
        <Button
          type="button"
          size="xs"
          variant="outline"
          className="routing-sheet-button"
        />
      }
    >
      Model Mapping Syntax
    </Popover.Trigger>
    <Popover.Portal>
      <Popover.Positioner sideOffset={6} className="routing-menu-positioner">
        <Popover.Popup className="routing-model-details routing-mapping-syntax">
          <p>
            One provider/model pattern per line, such as
            anthropic/claude-opus-5-5. Prefix a line with - to exclude, use * at
            the start or end of a pattern, and # for comments. The last matching
            line wins. Add -&gt; provider-model-id after an exact model ID to
            override the model ID sent to the provider.
          </p>
          <pre>{MAPPING_SYNTAX}</pre>
          <p>Leave the field empty to use this provider's default models.</p>
        </Popover.Popup>
      </Popover.Positioner>
    </Popover.Portal>
  </Popover.Root>
);

/**
 * A provider key's Models section: a searchable checklist of the provider's
 * catalog plus "All other" models, or the raw mapping text under Advanced.
 * Both edit the same mapping lines.
 */
export const ProviderModelsSection = ({
  providerId,
  providerName,
  models,
  mappingText,
  onMappingText,
  errors,
}: {
  readonly providerId: string;
  readonly providerName: string;
  readonly models: ReadonlyArray<CatalogModel>;
  readonly mappingText: string;
  readonly onMappingText: (text: string) => void;
  readonly errors: ReadonlyArray<string>;
}) => {
  const [advanced, setAdvanced] = useState(false);
  const [search, setSearch] = useState("");
  const parsed = parseModelMappingText(mappingText);
  const served = (canonical: string) =>
    modelMappingServes(parsed.lines, canonical).served;
  const enabled = new Set<string>();
  for (const model of models) if (served(model.id)) enabled.add(model.id);
  const others = served(`${providerId}/${OTHER_MODEL_SUFFIX}`);
  const renames = new Map(
    parsed.lines.flatMap((line) =>
      line.upstream === undefined ? [] : [[line.canonical, line.upstream]],
    ),
  );
  const setSelection = (next: ReadonlySet<string>, nextOthers: boolean) =>
    onMappingText(
      modelMappingText(linesFor(providerId, models, next, nextOthers, renames)),
    );
  const query = search.trim().toLowerCase();
  const visible = models
    .toSorted((a, b) => a.name.localeCompare(b.name))
    .filter(
      (model) =>
        query === "" ||
        model.name.toLowerCase().includes(query) ||
        model.id.toLowerCase().includes(query),
    );
  const otherLabel = `All other ${providerName} models`;
  const mappingSummary =
    parsed.lines.length === 0
      ? "All models supported by this provider (default)"
      : `${enabled.size} of ${models.length} catalog models${others ? ", plus models added later" : ""}`;
  return (
    <section className="routing-sheet-models" aria-label="Models">
      <div className="routing-sheet-models-head">
        <span className="routing-sheet-models-title">
          <span>Models</span>
          {advanced ? null : (
            <span aria-live="polite">
              {enabled.size} of {models.length} enabled
            </span>
          )}
        </span>
        <div className="routing-sheet-advanced">
          <span aria-hidden="true">Advanced</span>
          <Switch.Root
            checked={advanced}
            onCheckedChange={setAdvanced}
            aria-label="Advanced"
            className="routing-switch"
          >
            <Switch.Thumb className="routing-switch-thumb" />
          </Switch.Root>
        </div>
      </div>
      {advanced ? (
        <div className="routing-sheet-field">
          <label htmlFor="model-provider-mapping">Models</label>
          <Textarea
            className="routing-sheet-control"
            id="model-provider-mapping"
            rows={5}
            spellCheck={false}
            placeholder={`${providerId}/*`}
            value={mappingText}
            onChange={(event) => onMappingText(event.target.value)}
          />
          <p className="routing-sheet-help">{mappingSummary}</p>
          <div className="routing-sheet-inline-actions">
            <MappingSyntax />
          </div>
        </div>
      ) : (
        <>
          <Input
            className="routing-sheet-control"
            aria-label="Search models"
            placeholder="Search models…"
            value={search}
            onChange={(event) => setSearch(event.target.value)}
          />
          <div className="routing-model-list">
            {visible.map((model) => (
              <ModelRow
                key={model.id}
                id={`model-${model.id}`}
                providerId={providerId}
                label={model.name}
                checked={enabled.has(model.id)}
                details={model}
                onChange={(checked) => {
                  const next = new Set(enabled);
                  if (checked) next.add(model.id);
                  else next.delete(model.id);
                  setSelection(next, others);
                }}
              />
            ))}
            {query === "" ? (
              <ModelRow
                id={`pattern-${providerId}/*`}
                providerId={providerId}
                label={otherLabel}
                note={`Models dx adds to the ${providerName} catalog later, and any ${providerName} model this list does not name.`}
                checked={others}
                onChange={(checked) => setSelection(enabled, checked)}
              />
            ) : null}
          </div>
        </>
      )}
      {errors.map((error) => (
        <p key={error} className="model-routing-field-error">
          {error}
        </p>
      ))}
    </section>
  );
};
