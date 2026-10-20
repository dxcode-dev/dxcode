import {
  ArrowDown,
  ArrowLeft,
  ArrowRight,
  ArrowUp,
  ClipboardPaste,
} from "lucide-react";
import * as React from "react";
import "./terminal-keys.css";

type KeyRef<T> = { readonly current: T };

/** A phone keyboard has no Esc, Tab, Ctrl, or arrows; these send them. */
const KEYS = [
  { label: "Esc", name: "Escape", data: "\u001b" },
  { label: "Tab", name: "Tab", data: "\t" },
  { label: "^C", name: "Control C", data: "\u0003" },
  { label: "|", name: "Pipe", data: "|" },
  { label: "~", name: "Tilde", data: "~" },
  { label: "/", name: "Slash", data: "/" },
  { label: "-", name: "Dash", data: "-" },
] as const;

const ARROWS = [
  { name: "Left", Icon: ArrowLeft, data: "\u001b[D" },
  { name: "Up", Icon: ArrowUp, data: "\u001b[A" },
  { name: "Down", Icon: ArrowDown, data: "\u001b[B" },
  { name: "Right", Icon: ArrowRight, data: "\u001b[C" },
] as const;

/** The control byte for a key typed while Ctrl is held, as a terminal reads it. */
const controlByte = (data: string) => {
  if (data.length !== 1) return data;
  if (data === " ") return "\u0000";
  const code = data.toUpperCase().charCodeAt(0);
  // @ through _ map onto 0x00–0x1f: Ctrl-A is 0x01, Ctrl-[ is Esc.
  return code >= 64 && code <= 95 ? String.fromCharCode(code - 64) : data;
};

// Keeps the terminal focused, so the phone keyboard stays open.
const keepFocus = (event: React.PointerEvent | React.MouseEvent) =>
  event.preventDefault();

export function TerminalKeys({
  disabled,
  sendInput,
  transformInputRef,
}: {
  readonly disabled: boolean;
  readonly sendInput: KeyRef<(data: string) => void>;
  readonly transformInputRef: { current: (data: string) => string };
}) {
  const [control, setControl] = React.useState(false);
  const latchControl = (latched: boolean) => {
    setControl(latched);
    transformInputRef.current = latched
      ? (data) => {
          // The next typed key takes Ctrl, then the latch lets go.
          transformInputRef.current = (next) => next;
          setControl(false);
          return controlByte(data);
        }
      : (data) => data;
  };
  const send = (data: string) => {
    if (control) {
      latchControl(false);
      sendInput.current(controlByte(data));
    } else sendInput.current(data);
  };
  return (
    <div
      className="terminal-keys"
      role="toolbar"
      aria-label="Terminal keys"
      onPointerDown={keepFocus}
      onMouseDown={keepFocus}
    >
      {KEYS.slice(0, 2).map((key) => (
        <button
          key={key.label}
          type="button"
          className="terminal-key"
          disabled={disabled}
          onClick={() => send(key.data)}
        >
          {key.label}
        </button>
      ))}
      <button
        type="button"
        className="terminal-key"
        aria-label="Control"
        aria-pressed={control}
        disabled={disabled}
        onClick={() => latchControl(!control)}
      >
        Ctrl
      </button>
      {KEYS.slice(2).map((key) => (
        <button
          key={key.label}
          type="button"
          className="terminal-key"
          aria-label={key.name}
          disabled={disabled}
          onClick={() => send(key.data)}
        >
          {key.label}
        </button>
      ))}
      {ARROWS.map(({ name, Icon, data }) => (
        <button
          key={name}
          type="button"
          className="terminal-key"
          aria-label={name}
          disabled={disabled}
          onClick={() => sendInput.current(data)}
        >
          <Icon aria-hidden="true" />
        </button>
      ))}
      <button
        type="button"
        className="terminal-key"
        aria-label="Paste"
        disabled={disabled}
        onClick={() =>
          void navigator.clipboard
            ?.readText()
            .then((text) => {
              if (text.length > 0) sendInput.current(text);
            })
            .catch(() => undefined)
        }
      >
        <ClipboardPaste aria-hidden="true" />
      </button>
    </div>
  );
}
