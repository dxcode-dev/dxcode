import { X } from "lucide-react";
import * as React from "react";
import { cn } from "../utils.js";
import "./token-field.css";

const SEPARATOR = /[\s,;]+/;

/**
 * A text field that turns each entry into a removable token, such as an
 * email's recipients. Enter, Tab, a comma, a semicolon, a space, a paste, or
 * leaving the field adds what was typed; Backspace in the empty field
 * removes the last token. A token `isValid` refuses is marked invalid and
 * kept, so it can be fixed. `max` stops adding once that many are in.
 * A key it handles (Enter or Tab adding a token) is default-prevented, so a
 * surrounding form can tell that press was the field's.
 */
export function TokenField({
  id,
  values,
  onValuesChange,
  isValid,
  max,
  placeholder,
  disabled = false,
  autoFocus = false,
  className,
  "aria-label": ariaLabel,
  "aria-describedby": describedBy,
}: {
  readonly id?: string;
  readonly values: ReadonlyArray<string>;
  readonly onValuesChange: (values: ReadonlyArray<string>) => void;
  /** Whether a token is acceptable; an invalid one is marked red. */
  readonly isValid?: (value: string) => boolean;
  /** The most tokens it takes. */
  readonly max?: number;
  readonly placeholder?: string;
  readonly disabled?: boolean;
  /** Focus the field when it mounts, as a form opened to fill it does. */
  readonly autoFocus?: boolean;
  readonly className?: string;
  readonly "aria-label"?: string;
  readonly "aria-describedby"?: string;
}) {
  const [draft, setDraft] = React.useState("");
  const full = max !== undefined && values.length >= max;
  const add = (text: string) => {
    const taken = new Set(values);
    const entries = [
      ...new Set(
        text
          .split(SEPARATOR)
          .map((entry) => entry.trim())
          .filter((entry) => entry !== "" && !taken.has(entry)),
      ),
    ];
    const room = max === undefined ? entries.length : max - values.length;
    if (entries.length > 0 && room > 0)
      onValuesChange([...values, ...entries.slice(0, room)]);
    setDraft("");
  };
  const remove = (index: number) =>
    onValuesChange(values.filter((_, at) => at !== index));
  const invalidCount = values.filter(
    (value) => isValid !== undefined && !isValid(value),
  ).length;
  return (
    <div
      className={cn("dx-token-field", className)}
      data-disabled={disabled || undefined}
      data-invalid={invalidCount > 0 || undefined}
    >
      {values.map((value, index) => {
        const valid = isValid === undefined || isValid(value);
        return (
          <span
            key={value}
            className="dx-token"
            data-invalid={valid ? undefined : ""}
            title={valid ? value : `${value} is not valid`}
          >
            <span className="dx-token-text">{value}</span>
            <button
              type="button"
              className="dx-token-remove"
              aria-label={`Remove ${value}`}
              disabled={disabled}
              onClick={() => remove(index)}
            >
              <X aria-hidden="true" />
            </button>
          </span>
        );
      })}
      <input
        id={id}
        className="dx-token-input"
        value={draft}
        disabled={disabled || full}
        // biome-ignore lint/a11y/noAutofocus: only when the person opened a form to fill this field
        autoFocus={autoFocus}
        placeholder={values.length === 0 ? placeholder : undefined}
        aria-label={ariaLabel}
        aria-describedby={describedBy}
        aria-invalid={invalidCount > 0 || undefined}
        autoComplete="off"
        spellCheck={false}
        onChange={(event) => {
          const text = event.target.value;
          if (SEPARATOR.test(text.slice(-1))) add(text);
          else setDraft(text);
        }}
        onKeyDown={(event) => {
          if (
            (event.key === "Enter" || event.key === "Tab") &&
            draft.trim() !== ""
          ) {
            event.preventDefault();
            add(draft);
          } else if (event.key === "Backspace" && draft === "") {
            if (values.length > 0) remove(values.length - 1);
          }
        }}
        onPaste={(event) => {
          const text = event.clipboardData.getData("text");
          if (!SEPARATOR.test(text)) return;
          event.preventDefault();
          add(`${draft}${text}`);
        }}
        onBlur={() => {
          if (draft.trim() !== "") add(draft);
        }}
      />
    </div>
  );
}
