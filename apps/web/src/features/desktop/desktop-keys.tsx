import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  Keyboard,
} from "lucide-react";
import type * as React from "react";
import type { DesktopModifier } from "./desktop-keyboard.js";
import "./desktop-keys.css";

const KEYS = [
  { label: "Esc", name: "Escape", codes: ["Escape"] },
  { label: "Tab", name: "Tab", codes: ["Tab"] },
] as const;

const ARROWS = [
  { name: "Left", Icon: ArrowLeft, codes: ["ArrowLeft"] },
  { name: "Up", Icon: ArrowUp, codes: ["ArrowUp"] },
  { name: "Down", Icon: ArrowDown, codes: ["ArrowDown"] },
  { name: "Right", Icon: ArrowRight, codes: ["ArrowRight"] },
] as const;

/** Latched until the next key, so Ctrl then c sends Ctrl+C. */
const MODIFIERS = [
  { label: "Shift", code: "ShiftLeft" },
  { label: "Ctrl", code: "ControlLeft" },
  { label: "Alt", code: "AltLeft" },
  { label: "Super", code: "MetaLeft" },
] as const satisfies ReadonlyArray<{
  readonly label: string;
  readonly code: DesktopModifier;
}>;

const SHORTCUTS = [
  { label: "Alt+Tab", codes: ["AltLeft", "Tab"] },
  { label: "Alt+F4", codes: ["AltLeft", "F4"] },
  { label: "Ctrl+Alt+T", codes: ["ControlLeft", "AltLeft", "KeyT"] },
] as const;

// Keeps focus where it is, so the phone keyboard and desktop control stay.
const keepFocus = (event: React.PointerEvent | React.MouseEvent) =>
  event.preventDefault();

export function DesktopKeys({
  disabled,
  keyboardOpen,
  modifiers,
  onToggleKeyboard,
  onToggleModifier,
  onPress,
}: {
  readonly disabled: boolean;
  readonly keyboardOpen: boolean;
  readonly modifiers: ReadonlySet<DesktopModifier>;
  readonly onToggleKeyboard: () => void;
  readonly onToggleModifier: (modifier: DesktopModifier) => void;
  readonly onPress: (codes: readonly string[]) => void;
}) {
  return (
    <div
      className="desktop-keys"
      role="toolbar"
      aria-label="Desktop keys"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      <button
        type="button"
        className="desktop-key desktop-key-keyboard"
        aria-label="Keyboard"
        aria-pressed={keyboardOpen}
        disabled={disabled}
        onClick={onToggleKeyboard}
      >
        <Keyboard aria-hidden="true" />
        <span>Keyboard</span>
      </button>
      {KEYS.map((key) => (
        <button
          key={key.name}
          type="button"
          className="desktop-key"
          aria-label={key.name}
          disabled={disabled}
          onClick={() => onPress(key.codes)}
        >
          {key.label}
        </button>
      ))}
      {ARROWS.map(({ name, Icon, codes }) => (
        <button
          key={name}
          type="button"
          className="desktop-key"
          aria-label={name}
          disabled={disabled}
          onClick={() => onPress(codes)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
      {MODIFIERS.map(({ label, code }) => (
        <button
          key={code}
          type="button"
          className="desktop-key"
          aria-pressed={modifiers.has(code)}
          disabled={disabled}
          onClick={() => onToggleModifier(code)}
        >
          {label}
        </button>
      ))}
      {SHORTCUTS.map(({ label, codes }) => (
        <button
          key={label}
          type="button"
          className="desktop-key desktop-key-shortcut"
          disabled={disabled}
          onClick={() => onPress(codes)}
        >
          {label}
        </button>
      ))}
    </div>
  );
}
