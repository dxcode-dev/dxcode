import type * as React from "react";
import { Badge } from "./badge.js";
import "./choice-cards.css";

export interface ChoiceCardOption<Value extends string> {
  readonly value: Value;
  readonly title: string;
  /** One line under the title saying what the choice gives. */
  readonly description?: React.ReactNode;
  /** A small picture of the choice, drawn above the title. */
  readonly preview?: React.ReactNode;
  /** A short tag after the title, such as Recommended. */
  readonly badge?: string;
}

/**
 * One choice among a few, each drawn as a card with an optional picture of
 * what it looks like, such as Detailed or Simple for the thread view. The
 * cards are native radio buttons: arrow keys move between them, and a
 * screen reader announces them as one group.
 */
export function ChoiceCards<Value extends string>({
  label,
  name,
  value,
  options,
  onValueChange,
  size = "md",
}: {
  /** The group's accessible name. */
  readonly label: string;
  /** The radio group's form name; unique on the page. */
  readonly name: string;
  readonly value: Value;
  readonly options: ReadonlyArray<ChoiceCardOption<Value>>;
  readonly onValueChange: (value: Value) => void;
  /** md for a settings page; lg for a full-page step such as onboarding. */
  readonly size?: "md" | "lg";
}) {
  return (
    <div
      className="dx-choice-cards"
      role="radiogroup"
      aria-label={label}
      data-size={size}
    >
      {options.map((option) => (
        <label
          key={option.value}
          className="dx-choice-card"
          data-selected={option.value === value ? "" : undefined}
        >
          <input
            className="dx-choice-card-input"
            type="radio"
            name={name}
            value={option.value}
            checked={option.value === value}
            onChange={() => onValueChange(option.value)}
          />
          {option.preview === undefined ? null : (
            <span className="dx-choice-card-preview" aria-hidden="true">
              {option.preview}
            </span>
          )}
          <span className="dx-choice-card-text">
            <span className="dx-choice-card-title">
              {option.title}
              {option.badge === undefined ? null : (
                <Badge tone="info">{option.badge}</Badge>
              )}
            </span>
            {option.description === undefined ? null : (
              <span className="dx-choice-card-description">
                {option.description}
              </span>
            )}
          </span>
        </label>
      ))}
    </div>
  );
}
