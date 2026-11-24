import { Plus, X } from "lucide-react";
import { Button } from "./button.js";
import { Input } from "./input.js";
import "./header-rows.css";

/** One header a model connection adds to each request. */
export interface HeaderRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
  /** Shown in an empty value: a stored value the empty field keeps, such as "Saved". */
  readonly valuePlaceholder?: string;
}

/**
 * Name and value rows for the headers sent with each request, an Add
 * Header button, and a remove button per row. Values are typed like
 * passwords: headers often carry a tenant or an auth secret.
 */
export function HeaderRows({
  rows,
  onRows,
  size = "sm",
}: {
  /** Its inputs' height, to match the form around it. */
  readonly size?: "sm" | "md";
  readonly rows: ReadonlyArray<HeaderRow>;
  readonly onRows: (
    update: (current: ReadonlyArray<HeaderRow>) => ReadonlyArray<HeaderRow>,
  ) => void;
}) {
  const edit = (key: number, change: Partial<HeaderRow>) =>
    onRows((current) =>
      current.map((item) => (item.key === key ? { ...item, ...change } : item)),
    );
  return (
    <div className="header-rows">
      {rows.map((row, index) => (
        <div key={row.key} className="header-rows-row">
          <Input
            size={size}
            aria-label={`Header Name ${index + 1}`}
            placeholder="x-custom-header"
            value={row.name}
            onChange={(event) => edit(row.key, { name: event.target.value })}
          />
          <Input
            size={size}
            aria-label={`Header Value ${index + 1}`}
            type="password"
            autoComplete="new-password"
            placeholder={row.valuePlaceholder ?? "value"}
            value={row.value}
            onChange={(event) => edit(row.key, { value: event.target.value })}
          />
          <Button
            type="button"
            size={size === "md" ? "icon" : "icon-sm"}
            variant="ghost"
            aria-label={`Remove header ${index + 1}`}
            onClick={() =>
              onRows((current) =>
                current.filter((item) => item.key !== row.key),
              )
            }
          >
            <X />
          </Button>
        </div>
      ))}
      <div>
        <Button
          type="button"
          size={size === "md" ? "sm" : "xs"}
          variant="outline"
          onClick={() =>
            onRows((current) => [
              ...current,
              {
                key: Math.max(0, ...current.map(({ key }) => key)) + 1,
                name: "",
                value: "",
              },
            ])
          }
        >
          <Plus />
          Add Header
        </Button>
      </div>
    </div>
  );
}
