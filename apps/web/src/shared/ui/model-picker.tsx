import type { ThinkingLevel } from "@dx/domain";
import { Cpu, Layers } from "lucide-react";
import * as React from "react";
import { effortLabel } from "../model-effort-label.js";
import { cn } from "../utils.js";
import { chipVariants } from "./chip-variants.js";
import {
  ChoiceSelectEmpty,
  ChoiceSelectItem,
  ChoiceSelectItemText,
  ChoiceSelectLabel,
  ChoiceSelectList,
  ChoiceSelectPopup,
  ChoiceSelectRoot,
  ChoiceSelectSearch,
  ChoiceSelectTrigger,
} from "./choice-select.js";
import { ProviderMark } from "./provider-marks.js";
import { SegmentedControl } from "./segmented-control.js";
import "./model-picker.css";

/** One model a person can pick. */
export interface ModelPickerModel {
  /** What `onValueChange` reports for this model. */
  readonly value: string;
  /** "Claude Opus 5.5". */
  readonly name: string;
  /** The maker's mark id in `ProviderMark`, such as `anthropic`. */
  readonly provider: string;
  /** The maker's name: "Anthropic". */
  readonly providerName: string;
  /** Who pays for it: "Included with dx", "Your Claude Pro/Max plan". */
  readonly route: string;
  readonly contextWindow?: number;
  /** One line on what it is good for. */
  readonly description?: string;
  /** The efforts it takes, lowest first; none means no effort setting. */
  readonly efforts?: ReadonlyArray<ThinkingLevel>;
  /** Drawn instead of the maker's mark, such as a plugin agent's icon. */
  readonly icon?: React.ReactNode;
}

/**
 * A row above the models that follows a default instead of naming a model,
 * such as Recommended or "Same as coordinator".
 */
export interface ModelPickerDefault {
  readonly value: string;
  readonly label: string;
  /** The line under it, such as what the default is now. */
  readonly detail: string;
  /** The model it runs on now, for the trigger's mark and the panel. */
  readonly resolves?: string;
  /** The trigger's short tag for it; defaults to `label`. */
  readonly tag?: string;
  /** What `resolves` names, when the list does not hold it. */
  readonly resolvedModel?: ModelPickerModel;
}

const contextLabel = (tokens: number) =>
  tokens >= 1_000_000
    ? `${Math.round(tokens / 100_000) / 10}M`
    : `${Math.round(tokens / 1000)}k`;

/** A model maker's mark, or a chip icon for a maker without one. */
export function ModelMark({
  provider,
  icon,
  className,
}: {
  readonly provider: string;
  /** Drawn instead of the maker's mark. */
  readonly icon?: React.ReactNode;
  readonly className?: string;
}) {
  return (
    <span className={cn("dx-model-mark", className)} aria-hidden="true">
      {icon ?? <ProviderMark providerId={provider} fallback={<Cpu />} />}
    </span>
  );
}

type Grouping = "provider" | "route";

const groupModels = (
  models: ReadonlyArray<ModelPickerModel>,
  grouping: Grouping,
) => {
  const groups = new Map<
    string,
    {
      key: string;
      label: string;
      provider?: string;
      models: ModelPickerModel[];
    }
  >();
  for (const model of models) {
    const key = grouping === "provider" ? model.provider : model.route;
    const group = groups.get(key) ?? {
      key,
      label: grouping === "provider" ? model.providerName : model.route,
      ...(grouping === "provider" ? { provider: model.provider } : {}),
      models: [],
    };
    group.models.push(model);
    groups.set(key, group);
  }
  return [...groups.values()];
};

const matches = (model: ModelPickerModel, query: string) =>
  [model.name, model.providerName, model.route, model.value].some((text) =>
    text.toLowerCase().includes(query),
  );

/**
 * dx's one model picker, for every place that picks a model: the composer,
 * an open Thread, Settings, and Space creation. Search on top, the default
 * row, then models under their maker's mark (or under who pays, from the
 * grouping toggle). The panel beside the list describes the highlighted
 * model and sets its effort; on a phone it sits under the list.
 */
export function ModelPicker({
  models,
  value,
  onValueChange,
  effort,
  onEffortChange,
  defaultOption,
  appearance = "field",
  label = "Model",
  open,
  defaultOpen,
  onOpenChange,
  disabled = false,
  loading = false,
  shortcut,
  actions,
  note,
  id,
  className,
  unlisted,
  triggerText,
}: {
  /** The picked model when `models` does not list it, such as one no connection serves now. */
  readonly unlisted?: ModelPickerModel;
  /** Words for the trigger instead of the model, such as an older Thread's mode. */
  readonly triggerText?: { readonly text: string; readonly label: string };
  readonly models: ReadonlyArray<ModelPickerModel>;
  /** The picked model's or default row's value. */
  readonly value: string;
  readonly onValueChange: (value: string) => void;
  /** The picked effort; undefined hides the effort setting. */
  readonly effort?: ThinkingLevel;
  readonly onEffortChange?: (effort: ThinkingLevel) => void;
  readonly defaultOption?: ModelPickerDefault;
  /**
   * `pill` is the New Thread composer's; `chip` is an open Thread's quiet
   * chip; `field` sits in a settings row or a form like a Select.
   */
  readonly appearance?: "pill" | "chip" | "field";
  /** The trigger's accessible name. */
  readonly label?: string;
  readonly open?: boolean;
  readonly defaultOpen?: boolean;
  readonly onOpenChange?: (open: boolean) => void;
  readonly disabled?: boolean;
  /** The models are still loading. */
  readonly loading?: boolean;
  /** Keycaps at the search row's end, such as Ctrl+S. */
  readonly shortcut?: React.ReactNode;
  /** Links under the list, such as "Manage models". */
  readonly actions?: React.ReactNode;
  /** A line above the panel's effort, such as when a change applies. */
  readonly note?: string;
  /** The trigger's id, for a label's `htmlFor`. */
  readonly id?: string;
  readonly className?: string;
}) {
  const [query, setQuery] = React.useState("");
  const [grouping, setGrouping] = React.useState<Grouping>("provider");
  const [highlighted, setHighlighted] = React.useState<string | undefined>();
  const normalized = query.trim().toLowerCase();
  const byValue = new Map(models.map((model) => [model.value, model]));
  const isDefault =
    defaultOption !== undefined && value === defaultOption.value;
  const picked = isDefault
    ? (byValue.get(defaultOption.resolves ?? "") ?? defaultOption.resolvedModel)
    : (byValue.get(value) ?? unlisted);
  const shown = models.filter(
    (model) => normalized === "" || matches(model, normalized),
  );
  const groups = groupModels(shown, grouping);
  const showDefault =
    defaultOption !== undefined &&
    (normalized === "" ||
      `${defaultOption.label} ${defaultOption.detail}`
        .toLowerCase()
        .includes(normalized));
  const focusValue = highlighted ?? value;
  const focusDefault =
    defaultOption !== undefined && focusValue === defaultOption.value;
  const focus = focusDefault
    ? (byValue.get(defaultOption.resolves ?? "") ?? defaultOption.resolvedModel)
    : (byValue.get(focusValue) ??
      (focusValue === value ? unlisted : undefined));
  const pickedEfforts = picked?.efforts ?? [];
  const effortName = effort === undefined ? undefined : effortLabel(effort);
  const triggerLabel =
    triggerText !== undefined
      ? triggerText.label
      : loading
        ? `${label}: loading`
        : `${label}: ${isDefault ? `${defaultOption.label}, ` : ""}${picked?.name ?? "none"}${picked?.efforts?.length && effortName ? `, ${effortName} effort` : ""}`;
  return (
    <ChoiceSelectRoot
      value={value}
      disabled={disabled || loading}
      {...(open === undefined ? {} : { open })}
      {...(defaultOpen === undefined ? {} : { defaultOpen })}
      onOpenChange={(next) => {
        if (!next) {
          setQuery("");
          setHighlighted(undefined);
        }
        onOpenChange?.(next);
      }}
      onValueChange={(next) => {
        // Filtering unmounts items and can emit a cleared value.
        if (next !== null) onValueChange(next);
      }}
    >
      <ChoiceSelectTrigger
        variant={appearance === "field" ? "field" : "bare"}
        size="md"
        className={cn(
          "dx-model-picker-trigger",
          appearance === "pill" &&
            chipVariants({ variant: "soft", size: "lg" }),
          appearance === "chip" &&
            chipVariants({ variant: "outline", size: "md" }),
          className,
        )}
        data-appearance={appearance}
        {...(id === undefined ? {} : { id })}
        aria-label={triggerLabel}
        title={triggerLabel}
      >
        <span className="dx-model-picker-value">
          <TriggerWords
            loading={loading}
            placeholder={appearance === "field" ? undefined : label}
            picked={picked}
            triggerText={triggerText}
            effortName={effortName}
            tag={
              isDefault && appearance === "field"
                ? (defaultOption.tag ?? defaultOption.label)
                : undefined
            }
          />
        </span>
      </ChoiceSelectTrigger>
      <ChoiceSelectPopup
        className="dx-model-picker"
        positionerClassName="dx-model-picker-positioner"
        aria-label={`Choose ${label.toLowerCase()}`}
        sideOffset={6}
        collisionPadding={8}
      >
        <div className="dx-model-picker-search">
          <ChoiceSelectSearch
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            trailing={shortcut}
          />
          <button
            type="button"
            className="dx-model-picker-grouping"
            aria-label={
              grouping === "provider"
                ? "Grouped by provider. Group by who pays"
                : "Grouped by who pays. Group by provider"
            }
            onClick={() =>
              setGrouping((current) =>
                current === "provider" ? "route" : "provider",
              )
            }
          >
            <Layers aria-hidden="true" />
            {grouping === "provider" ? "By provider" : "By who pays"}
          </button>
        </div>
        <div className="dx-model-picker-body">
          <ChoiceSelectList className="dx-model-picker-list">
            <PickerRows
              defaultOption={showDefault ? defaultOption : undefined}
              groups={groups}
              grouping={grouping}
              query={query}
              onHighlight={setHighlighted}
            />
          </ChoiceSelectList>
          {focus === undefined ? null : (
            <DetailsPanel
              model={focus}
              followsDefault={focusDefault ? defaultOption?.label : undefined}
              note={note}
            />
          )}
        </div>
        {actions === undefined || normalized !== "" ? null : (
          <div className="dx-model-picker-actions">{actions}</div>
        )}
        {effort === undefined ||
        onEffortChange === undefined ||
        picked === undefined ||
        pickedEfforts.length === 0 ? null : (
          <EffortRow
            model={picked}
            efforts={pickedEfforts}
            effort={effort}
            onEffortChange={onEffortChange}
          />
        )}
      </ChoiceSelectPopup>
    </ChoiceSelectRoot>
  );
}

/** The trigger's words: the mark, the model, its effort, a default's tag. */
function TriggerWords({
  loading,
  placeholder,
  picked,
  triggerText,
  effortName,
  tag,
}: {
  readonly loading: boolean;
  /** The words while loading; a chip keeps a short word on a phone. */
  readonly placeholder: string | undefined;
  readonly picked: ModelPickerModel | undefined;
  readonly triggerText: { readonly text: string } | undefined;
  readonly effortName: string | undefined;
  readonly tag: string | undefined;
}) {
  if (loading)
    return (
      <span className="dx-model-picker-placeholder">
        {placeholder ?? "Loading models…"}
      </span>
    );
  return (
    <>
      {picked === undefined ? null : (
        <ModelMark provider={picked.provider} icon={picked.icon} />
      )}
      <span className="dx-model-picker-name">
        {triggerText?.text ?? picked?.name ?? "Choose a model"}
      </span>
      {triggerText === undefined && picked?.efforts?.length && effortName ? (
        <span className="dx-model-picker-effort">{effortName}</span>
      ) : null}
      {tag === undefined ? null : (
        <span className="dx-model-picker-tag">{tag}</span>
      )}
    </>
  );
}

/** The default row, then each group of models, or why none show. */
function PickerRows({
  defaultOption,
  groups,
  grouping,
  query,
  onHighlight,
}: {
  readonly defaultOption: ModelPickerDefault | undefined;
  readonly groups: ReturnType<typeof groupModels>;
  readonly grouping: Grouping;
  readonly query: string;
  readonly onHighlight: (value: string) => void;
}) {
  return (
    <>
      {defaultOption === undefined ? null : (
        <ChoiceSelectItem
          value={defaultOption.value}
          className="dx-model-picker-item"
          onPointerEnter={() => onHighlight(defaultOption.value)}
          onFocus={() => onHighlight(defaultOption.value)}
        >
          <span className="dx-model-picker-default-mark" aria-hidden="true">
            <Layers />
          </span>
          <span className="dx-model-picker-item-lines">
            <ChoiceSelectItemText className="dx-model-picker-item-name">
              {defaultOption.label}
            </ChoiceSelectItemText>
            <span className="dx-model-picker-item-note">
              {defaultOption.detail}
            </span>
          </span>
        </ChoiceSelectItem>
      )}
      {groups.map((group) => (
        <React.Fragment key={group.key}>
          <ChoiceSelectLabel>
            <span className="dx-model-picker-group">
              {group.provider === undefined ? null : (
                <ModelMark provider={group.provider} />
              )}
              {group.label}
            </span>
          </ChoiceSelectLabel>
          {group.models.map((model) => (
            <ChoiceSelectItem
              key={model.value}
              value={model.value}
              className="dx-model-picker-item"
              onPointerEnter={() => onHighlight(model.value)}
              onFocus={() => onHighlight(model.value)}
            >
              <ModelMark provider={model.provider} icon={model.icon} />
              <ChoiceSelectItemText className="dx-model-picker-item-name">
                {model.name}
              </ChoiceSelectItemText>
              <span className="dx-model-picker-item-route">
                {grouping === "provider" ? model.route : model.providerName}
              </span>
            </ChoiceSelectItem>
          ))}
        </React.Fragment>
      ))}
      {defaultOption === undefined && groups.length === 0 ? (
        <ChoiceSelectEmpty>No models match “{query.trim()}”.</ChoiceSelectEmpty>
      ) : null}
    </>
  );
}

/** The highlighted model's facts, beside the list. */
function DetailsPanel({
  model,
  followsDefault,
  note,
}: {
  readonly model: ModelPickerModel;
  /** The default row's label, when the default row is highlighted. */
  readonly followsDefault: string | undefined;
  readonly note: string | undefined;
}) {
  return (
    <aside
      className="dx-model-picker-panel"
      aria-label={`${model.name} details`}
    >
      <div className="dx-model-picker-panel-title">
        <ModelMark provider={model.provider} icon={model.icon} />
        <strong>{model.name}</strong>
      </div>
      {model.description === undefined ? null : <p>{model.description}</p>}
      <dl>
        <div>
          <dt>Provider</dt>
          <dd>{model.providerName}</dd>
        </div>
        {model.contextWindow === undefined ? null : (
          <div>
            <dt>Context</dt>
            <dd>{contextLabel(model.contextWindow)}</dd>
          </div>
        )}
        <div>
          <dt>Paid by</dt>
          <dd>{model.route}</dd>
        </div>
      </dl>
      {followsDefault === undefined ? null : (
        <p className="dx-model-picker-panel-note">
          Follows {followsDefault}. It changes when that default changes.
        </p>
      )}
      {note === undefined ? null : (
        <p className="dx-model-picker-panel-note">{note}</p>
      )}
    </aside>
  );
}

/** The picked model's effort, under the list. */
function EffortRow({
  model,
  efforts,
  effort,
  onEffortChange,
}: {
  readonly model: ModelPickerModel;
  readonly efforts: ReadonlyArray<ThinkingLevel>;
  readonly effort: ThinkingLevel;
  readonly onEffortChange: (effort: ThinkingLevel) => void;
}) {
  return (
    // biome-ignore lint/a11y/noStaticElementInteractions: keeps the list's typeahead out of the effort buttons.
    <div
      className="dx-model-picker-effort-row"
      onKeyDown={(event) => {
        if (event.key !== "Escape") event.stopPropagation();
      }}
    >
      <span>
        Effort
        <span className="dx-model-picker-effort-for"> for {model.name}</span>
      </span>
      <SegmentedControl
        label="Effort"
        className="dx-model-picker-effort-control"
        value={efforts.includes(effort) ? effort : (efforts.at(-1) ?? effort)}
        onValueChange={onEffortChange}
        options={efforts.map((level) => [level, effortLabel(level)])}
      />
    </div>
  );
}
