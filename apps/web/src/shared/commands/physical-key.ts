/**
 * The key event as a US layout reads it when the pressed letter key types
 * something outside ASCII: a letter of another script (Cyrillic, Greek,
 * Hebrew…), a macOS Option symbol (Option+K types ˚), or a dead key. So Ctrl+K
 * is Ctrl+K on a Russian layout, and Option+Cmd+K records as itself. Latin
 * layouts (AZERTY, QWERTZ, Dvorak) keep their own ASCII letters: their K key
 * is K. Other events are returned as is.
 */
export const physicalKeyEvent = (event: KeyboardEvent): KeyboardEvent => {
  const { key, code } = event;
  if (key !== "Dead" && (key.length !== 1 || /^[\x20-\x7e]$/.test(key)))
    return event;
  const letter = /^Key([A-Z])$/.exec(code)?.[1];
  if (letter === undefined) return event;
  return {
    key: event.shiftKey ? letter : letter.toLowerCase(),
    code,
    ctrlKey: event.ctrlKey,
    altKey: event.altKey,
    shiftKey: event.shiftKey,
    metaKey: event.metaKey,
  } as KeyboardEvent;
};
