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
import { ClaudeIcon } from "./claude-icon.js";
import { GitHubIcon } from "./github-icon.js";
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
  /**
   * What serves and pays for it, the group it is listed under: "Claude
   * Code", "GitHub Copilot", "Anthropic", "Acme OpenRouter · workspace",
   * "Included with dx".
   */
  readonly route: string;
  /**
   * The mark beside the route's group: `claude-code`, `github-copilot`, or
   * a provider mark id such as `openrouter`. None draws a chip icon.
   */
  readonly routeMark?: string;
  /** One more line about the route in the panel, such as which plan. */
  readonly routeDetail?: string;
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

/** Marks for routes that are products rather than model makers. */
const ROUTE_MARKS: Readonly<Record<string, () => React.ReactNode>> = {
  "claude-code": () => <ClaudeIcon />,
  "github-copilot": () => <GitHubIcon />,
};

/** A model maker's or a route's mark, or a chip icon without one. */
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
      {icon ?? ROUTE_MARKS[provider]?.() ?? (
        <ProviderMark providerId={provider} fallback={<Cpu />} />
      )}
    </span>
  );
}

/** Models under what serves them, in the order `models` lists them. */
const groupModels = (models: ReadonlyArray<ModelPickerModel>) => {
  const groups = new Map<
    string,
    { key: string; mark: string; models: ModelPickerModel[] }
  >();
  for (const model of models) {
    const group = groups.get(model.route) ?? {
      key: model.route,
      mark: model.routeMark ?? model.route,
      models: [],
    };
    group.models.push(model);
    groups.set(model.route, group);
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
 * row, then one group per route, such as Claude Code or GitHub Copilot,
 * under the route's mark; each row carries only its maker's mark. The
 * panel beside the list describes the highlighted model, and the row
 * under it sets the picked model's effort.
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
  finalFocus,
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
  /** Where focus goes when the list closes; see ChoiceSelectPopup. */
  readonly finalFocus?: React.ComponentProps<
    typeof ChoiceSelectPopup
  >["finalFocus"];
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
  const [highlighted, setHighlighted] = React.useState<string | undefined>();
  const normalized = query.trim().toLowerCase();
  const byValue = new Map(models.map((model) => [model.value, model]));
  const isDefault =
    defaultOption !== undefined && value === defaultOption.value;
  const picked = isDefault
    ? (byValue.get(defaultOption.resolves ?? "") ?? defaultOption.resolvedModel)
    : (byValue.get(value) ?? unlisted);
  // Filtered rows stay mounted, hidden: unmounting them moves the selected
  // row's index, and the list then takes focus from the search field.
  const shown = new Set<string>();
  for (const model of models)
    if (normalized === "" || matches(model, normalized)) shown.add(model.value);
  const groups = groupModels(models);
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
        finalFocus={finalFocus}
      >
        <div className="dx-model-picker-search">
          <ChoiceSelectSearch
            aria-label="Search models"
            placeholder="Search models"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            trailing={shortcut}
          />
        </div>
        <div className="dx-model-picker-body">
          <ChoiceSelectList className="dx-model-picker-list">
            <PickerRows
              defaultOption={defaultOption}
              showDefault={showDefault}
              shown={shown}
              groups={groups}
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
      {/* A default's tag already says where the pick comes from; the
          panel names the route, and a narrow field keeps the model name. */}
      {triggerText === undefined &&
      tag === undefined &&
      picked?.routeMark !== undefined ? (
        <span className="dx-model-picker-trigger-route" title={picked.route}>
          <ModelMark provider={picked.routeMark} />
        </span>
      ) : null}
      {tag === undefined ? null : (
        <span className="dx-model-picker-tag">{tag}</span>
      )}
    </>
  );
}

/**
 * The default row, then each group of models, or why none show. Rows the
 * search filters out stay mounted and hidden, so the list keeps its indices.
 */
function PickerRows({
  defaultOption,
  showDefault,
  shown,
  groups,
  query,
  onHighlight,
}: {
  readonly defaultOption: ModelPickerDefault | undefined;
  readonly showDefault: boolean;
  /** The values the search keeps. */
  readonly shown: ReadonlySet<string>;
  readonly groups: ReturnType<typeof groupModels>;
  readonly query: string;
  readonly onHighlight: (value: string) => void;
}) {
  return (
    <>
      {defaultOption === undefined ? null : (
        <ChoiceSelectItem
          value={defaultOption.value}
          className="dx-model-picker-item"
          hidden={!showDefault}
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
          <div hidden={!group.models.some((model) => shown.has(model.value))}>
            <ChoiceSelectLabel>
              <span className="dx-model-picker-group">
                <ModelMark provider={group.mark} />
                {group.key}
              </span>
            </ChoiceSelectLabel>
          </div>
          {group.models.map((model) => (
            <ChoiceSelectItem
              key={model.value}
              value={model.value}
              className="dx-model-picker-item"
              data-grouped=""
              hidden={!shown.has(model.value)}
              onPointerEnter={() => onHighlight(model.value)}
              onFocus={() => onHighlight(model.value)}
            >
              <ModelMark provider={model.provider} icon={model.icon} />
              <ChoiceSelectItemText className="dx-model-picker-item-name">
                {model.name}
              </ChoiceSelectItemText>
            </ChoiceSelectItem>
          ))}
        </React.Fragment>
      ))}
      {showDefault || shown.size > 0 ? null : (
        <ChoiceSelectEmpty>No models match “{query.trim()}”.</ChoiceSelectEmpty>
      )}
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
        <dt>Made by</dt>
        <dd>{model.providerName}</dd>
        <dt>Runs on</dt>
        <dd>
          <span className="dx-model-picker-panel-route">
            {model.routeMark === undefined ? null : (
              <ModelMark provider={model.routeMark} />
            )}
            {model.route}
          </span>
          {model.routeDetail === undefined ? null : (
            <span className="dx-model-picker-panel-detail">
              {model.routeDetail}
            </span>
          )}
        </dd>
        {model.contextWindow === undefined ? null : (
          <>
            <dt>Context</dt>
            <dd>{contextLabel(model.contextWindow)} tokens</dd>
          </>
        )}
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
