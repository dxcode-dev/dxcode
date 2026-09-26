export function ShortcutKeycaps({
  keycaps,
  emptyLabel = "Not set",
}: {
  readonly keycaps: ReadonlyArray<string>;
  readonly emptyLabel?: string;
}) {
  if (keycaps.length === 0) {
    return <span className="shortcut-unassigned">{emptyLabel}</span>;
  }
  return (
    <span
      className="shortcut-keycaps"
      role="img"
      aria-label={keycaps.join(" plus ")}
    >
      {keycaps.map((keycap) => (
        <kbd key={keycap}>{keycap}</kbd>
      ))}
    </span>
  );
}

/**
 * The one renderer for a command's effective bindings. Sequence steps and
 * alternative defaults both arrive as keycap groups; "or" only separates
 * alternatives, never sequence steps. The keymap dialog and the Keyboard
 * Shortcuts settings rows share this so they cannot show different keys.
 */
export function ShortcutBindings({
  bindings,
  sequence,
}: {
  readonly bindings: ReadonlyArray<ReadonlyArray<string>>;
  readonly sequence: boolean;
}) {
  if (bindings.length === 0) {
    return <ShortcutKeycaps keycaps={[]} />;
  }
  const groups = bindings.map((binding, position) => ({
    id: `${position}-${binding.join("-")}`,
    first: position === 0,
    binding,
  }));
  return (
    <span className="keymap-bindings">
      {groups.map((group) => (
        <span className="keymap-binding" key={group.id}>
          {group.first || sequence ? null : <span aria-hidden="true">or</span>}
          <ShortcutKeycaps keycaps={group.binding} />
        </span>
      ))}
    </span>
  );
}
