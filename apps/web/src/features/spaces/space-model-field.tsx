import type { ServedModelChoiceData } from "@dx/api";
import { isClaudeCodeModel, type ThinkingLevel } from "@dx/domain";
import {
  PICKER_EFFORTS,
  pickerModelValue,
  pickerOrder,
  pickerValueModel,
  servedPickerModel,
} from "../../shared/model-picker-models.js";
import {
  ModelPicker,
  type ModelPickerDefault,
} from "../../shared/ui/model-picker.js";

/** A model a Space or its threads run on, picked for this Space. */
export interface SpaceModelPick {
  readonly model: string;
  readonly thinking: ThinkingLevel;
}

const DEFAULT = "default";

/**
 * One of a Space's two model rows, in dx's one picker: the coordinator's
 * model, or the model the threads it starts run on. Undefined is the
 * default row, such as the Space model from Settings or "Same as
 * coordinator".
 */
export function SpaceModelField({
  id,
  label,
  servedModels,
  claudeCode,
  value,
  defaultRow,
  disabled,
  loading,
  defaultEffort = true,
  onChange,
}: {
  /**
   * Whether the effort row shows on the default row; picking an effort
   * there pins the default's model.
   */
  readonly defaultEffort?: boolean;
  readonly id: string;
  readonly label: string;
  readonly servedModels: ReadonlyArray<ServedModelChoiceData>;
  /** Whether Claude Code models are offered. */
  readonly claudeCode: boolean;
  readonly value: SpaceModelPick | undefined;
  readonly defaultRow: Omit<ModelPickerDefault, "value"> & {
    /** The model and effort the default runs on now, when known. */
    readonly runs?: SpaceModelPick;
  };
  readonly disabled: boolean;
  readonly loading: boolean;
  readonly onChange: (next: SpaceModelPick | undefined) => void;
}) {
  const models = pickerOrder(servedModels).flatMap((model) =>
    claudeCode || !isClaudeCodeModel(model.canonical)
      ? [servedPickerModel(model)]
      : [],
  );
  const { runs, ...row } = defaultRow;
  const effort =
    value?.thinking ?? (defaultEffort ? runs?.thinking : undefined);
  return (
    <ModelPicker
      id={id}
      label={label}
      appearance="field"
      models={models}
      value={value === undefined ? DEFAULT : pickerModelValue(value.model)}
      disabled={disabled}
      loading={loading}
      defaultOption={{
        ...row,
        value: DEFAULT,
        ...(runs === undefined
          ? {}
          : { resolves: pickerModelValue(runs.model) }),
      }}
      {...(effort === undefined
        ? {}
        : {
            effort,
            onEffortChange: (thinking: ThinkingLevel) => {
              const model = value?.model ?? runs?.model;
              if (model !== undefined) onChange({ model, thinking });
            },
          })}
      onValueChange={(next) => {
        const model = pickerValueModel(next);
        if (model === undefined) {
          onChange(undefined);
          return;
        }
        const served = servedModels.find(
          ({ canonical }) => canonical === model,
        );
        onChange({
          model,
          thinking:
            served !== undefined &&
            !served.reasoning &&
            !isClaudeCodeModel(model)
              ? "off"
              : (value?.thinking ??
                runs?.thinking ??
                (PICKER_EFFORTS[1] as ThinkingLevel)),
        });
      }}
    />
  );
}
