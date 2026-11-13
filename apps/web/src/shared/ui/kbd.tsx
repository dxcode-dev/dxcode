import "./kbd.css";

/**
 * A key combination, as a keyboard shortcut shows it: each key in one
 * bordered box, read as "Ctrl plus K". With no keys it shows `emptyLabel`
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
      {keys.map((key) => (
        <kbd key={key}>{key}</kbd>
      ))}
    </span>
  );
}
