import type { ModeId, ThinkingLevel } from "@dx/domain";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

import {
  DIAL_POSITION_BY_MODE,
  angularDistance,
} from "../../../shared/ui/mode-dial-geometry.js";
import { ModeDialPlate } from "../../../shared/ui/mode-dial-plate.js";

import { MODES, MODE_LABELS, THINKING_LEVELS } from "./mode-dial-values.js";
export function ModeDialControl({
  selected,
  onSelect,
  model,
  thinking,
  served,
  disabled,
}: {
  readonly selected: ModeId;
  readonly onSelect: (mode: ModeId) => void;
  readonly model: string;
  readonly thinking: string;
  readonly served: boolean;
  readonly disabled: boolean;
}) {
  const move = (event: KeyboardEvent<HTMLDivElement>) => {
    if (
      ![
        "ArrowLeft",
        "ArrowDown",
        "ArrowRight",
        "ArrowUp",
        "Home",
        "End",
      ].includes(event.key)
    )
      return;
    event.preventDefault();
    const index = MODES.indexOf(selected);
    const next =
      event.key === "Home"
        ? 0
        : event.key === "End"
          ? 3
          : index + (["ArrowLeft", "ArrowDown"].includes(event.key) ? -1 : 1);
    onSelect(MODES[Math.max(0, Math.min(3, next))] ?? selected);
  };
  const selectPointer = (event: PointerEvent<HTMLDivElement>) => {
    if (disabled) return;
    const bounds = event.currentTarget.getBoundingClientRect();
    const angle =
      (Math.atan2(
        event.clientY - bounds.top - bounds.height / 2,
        event.clientX - bounds.left - bounds.width / 2,
      ) *
        180) /
      Math.PI;
    onSelect(
      MODES.reduce((closest, mode) =>
        angularDistance(angle, DIAL_POSITION_BY_MODE[mode].angle) <
        angularDistance(angle, DIAL_POSITION_BY_MODE[closest].angle)
          ? mode
          : closest,
      ),
    );
  };
  return (
    <div className="tuning-device" data-mode={selected}>
      <ModeDialPlate
        profile={selected}
        selectedAngle={DIAL_POSITION_BY_MODE[selected].angle}
        agentEffort={thinking.toUpperCase()}
        displayModel={model}
        agentOnly
        resolutionLabel={served ? "PROVIDER CONNECTED" : "NOT SERVED"}
      />
      {MODES.map((mode) => {
        const position = DIAL_POSITION_BY_MODE[mode];
        return (
          <button
            key={mode}
            type="button"
            className="tuning-label-target"
            aria-label={MODE_LABELS[mode]}
            aria-pressed={selected === mode}
            disabled={disabled}
            onClick={() => onSelect(mode)}
            style={{
              left: `${position.labelX / 4}%`,
              top: `${position.labelY / 1.68}%`,
            }}
          />
        );
      })}
      <div
        className="reasoning-console-dial-target"
        role="slider"
        aria-label="Mode dial"
        aria-valuemin={0}
        aria-valuemax={3}
        aria-valuenow={MODES.indexOf(selected)}
        aria-valuetext={MODE_LABELS[selected]}
        aria-disabled={disabled}
        tabIndex={disabled ? -1 : 0}
        onKeyDown={(event) => {
          if (!disabled) move(event);
        }}
        onPointerDown={(event) => {
          if (disabled) return;
          event.currentTarget.setPointerCapture(event.pointerId);
          selectPointer(event);
        }}
        onPointerMove={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            selectPointer(event);
        }}
        onPointerCancel={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
        onPointerUp={(event) => {
          if (event.currentTarget.hasPointerCapture(event.pointerId))
            event.currentTarget.releasePointerCapture(event.pointerId);
        }}
      />
    </div>
  );
}

export function ReasoningEffort({
  value,
  disabled,
  onChange,
}: {
  readonly value: ThinkingLevel;
  readonly disabled: boolean;
  readonly onChange: (value: ThinkingLevel) => void;
}) {
  const index = THINKING_LEVELS.indexOf(value);
  return (
    <div className="tuning-effort">
      <div
        className="tuning-effort-track"
        style={{ "--effort-fill": `${(index / 6) * 100}%` } as CSSProperties}
      >
        <div className="tuning-effort-dots" aria-hidden="true">
          {THINKING_LEVELS.map((level) => (
            <i key={level} />
          ))}
        </div>
        <input
          type="range"
          aria-label="Main Agent reasoning effort"
          aria-valuetext={value === "xhigh" ? "Extra high" : value}
          min={0}
          max={6}
          step={1}
          value={index}
          disabled={disabled}
          onChange={(e) =>
            onChange(THINKING_LEVELS[Number(e.target.value)] ?? value)
          }
        />
      </div>
      <output>{value === "xhigh" ? "X-High" : value}</output>
    </div>
  );
}
