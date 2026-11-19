import "./kbd.css";

/**
 * A key combination, as a keyboard shortcut shows it: its keys in one
 * bordered box with a plus between them, read as "Ctrl plus K": Ctrl + K,
 * Ctrl + Shift + U, ⌘ + ⇧ + U. With no keys it shows `emptyLabel`
 * ("Not set"), or nothing when that is empty.
 */
export function Keycaps({
  keys,
  emptyLabel = "Not set",
}: {
  readonly keys: ReadonlyArray<string>;
  readonly emptyLabel?: string;
}) {
  if (keys.length === 0)
    return emptyLabel ? (
      <span className="shortcut-unassigned">{emptyLabel}</span>
    ) : null;
  return (
    <span
      className="shortcut-keycaps"
      role="img"
      aria-label={keys.join(" plus ")}
    >
      {keys.map((key, index) => (
        <span className="shortcut-keycap" key={key}>
          {index > 0 ? (
            <span className="shortcut-keycaps-plus" aria-hidden="true">
              +
            </span>
          ) : null}
          <kbd>{key}</kbd>
        </span>
      ))}
    </span>
  );
}
