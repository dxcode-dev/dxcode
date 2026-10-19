/**
 * Keys for the remote desktop from a phone, which has no Esc, Tab, arrows,
 * or modifiers. Waymote reads `KeyboardEvent.code` from its text input, so a
 * key is sent by dispatching the events a hardware keyboard would.
 */
export type DesktopModifier =
  | "ShiftLeft"
  | "ControlLeft"
  | "AltLeft"
  | "MetaLeft";

const KEY_VALUES: Readonly<Record<string, string>> = {
  Escape: "Escape",
  Tab: "Tab",
  Enter: "Enter",
  Backspace: "Backspace",
  ArrowLeft: "ArrowLeft",
  ArrowUp: "ArrowUp",
  ArrowDown: "ArrowDown",
  ArrowRight: "ArrowRight",
  ShiftLeft: "Shift",
  ControlLeft: "Control",
  AltLeft: "Alt",
  MetaLeft: "Meta",
  F4: "F4",
  Space: " ",
  Minus: "-",
  Period: ".",
  Comma: ",",
  Slash: "/",
};

const keyValue = (code: string) => {
  const known = KEY_VALUES[code];
  if (known !== undefined) return known;
  if (code.startsWith("Key")) return code.slice(3).toLowerCase();
  if (code.startsWith("Digit")) return code.slice(5);
  return code;
};

/** Presses the keys in order and releases them in reverse, as a hand would. */
export const pressChord = (target: HTMLElement, codes: readonly string[]) => {
  const modifiers = {
    shiftKey: codes.includes("ShiftLeft"),
    ctrlKey: codes.includes("ControlLeft"),
    altKey: codes.includes("AltLeft"),
    metaKey: codes.includes("MetaLeft"),
  };
  const event = (type: "keydown" | "keyup", code: string) =>
    new KeyboardEvent(type, {
      code,
      key: keyValue(code),
      bubbles: true,
      cancelable: true,
      ...modifiers,
    });
  for (const code of codes) target.dispatchEvent(event("keydown", code));
  for (const code of [...codes].reverse())
    target.dispatchEvent(event("keyup", code));
};

const PUNCTUATION: Readonly<Record<string, string>> = {
  " ": "Space",
  "-": "Minus",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
};

/**
 * The key a typed character comes from, so a latched modifier can apply to
 * it (Ctrl + c from the phone keyboard). Undefined for anything else.
 */
export const codeForCharacter = (character: string) => {
  if (/^[a-z]$/i.test(character))
    return {
      code: `Key${character.toUpperCase()}`,
      shift: character !== character.toLowerCase(),
    };
  if (/^\d$/.test(character))
    return { code: `Digit${character}`, shift: false };
  const punctuation = PUNCTUATION[character];
  return punctuation === undefined
    ? undefined
    : { code: punctuation, shift: false };
};
