import type { ConnectionData } from "@dx/api";
import { Plus, X } from "lucide-react";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";

export interface HeaderRow {
  readonly key: number;
  readonly name: string;
  readonly value: string;
}

/** Header rows a provider key adds to each request; stored values stay masked. */
export const ProviderHeadersField = ({
  stored,
  cleared,
  onClear,
  rows,
  onRows,
  error,
}: {
  readonly stored: ConnectionData["headers"];
  readonly cleared: boolean;
  readonly onClear: () => void;
  readonly rows: ReadonlyArray<HeaderRow>;
  readonly onRows: (
    update: (current: ReadonlyArray<HeaderRow>) => ReadonlyArray<HeaderRow>,
  ) => void;
  readonly error?: string;
}) => (
  <div className="routing-sheet-field">
    <span className="routing-sheet-label">Headers</span>
    {stored.length > 0 && !cleared ? (
      <p className="routing-sheet-help">
        Stored:{" "}
        {stored.map((header) => `${header.name}: ${header.masked}`).join(", ")}.
        Added headers replace them.{" "}
        <button type="button" className="routing-sheet-link" onClick={onClear}>
          Clear stored headers
        </button>
      </p>
    ) : null}
    {rows.map((row, index) => (
      <div key={row.key} className="routing-sheet-header-row">
        <Input
          className="routing-sheet-control"
          aria-label={`Header Name ${index + 1}`}
          placeholder="x-custom-header"
          value={row.name}
          onChange={(event) =>
            onRows((current) =>
              current.map((item) =>
                item.key === row.key
                  ? { ...item, name: event.target.value }
                  : item,
              ),
            )
          }
        />
        <Input
          className="routing-sheet-control"
          aria-label={`Header Value ${index + 1}`}
          type="password"
          autoComplete="new-password"
          placeholder="value"
          value={row.value}
          onChange={(event) =>
            onRows((current) =>
              current.map((item) =>
                item.key === row.key
                  ? { ...item, value: event.target.value }
                  : item,
              ),
            )
          }
        />
        <Button
          type="button"
          size="icon-sm"
          variant="ghost"
          aria-label={`Remove header ${index + 1}`}
          onClick={() =>
            onRows((current) => current.filter((item) => item.key !== row.key))
          }
        >
          <X />
        </Button>
      </div>
    ))}
    <div className="routing-sheet-inline-actions">
      <Button
        type="button"
        size="xs"
        className="routing-sheet-button"
        variant="outline"
        onClick={() =>
          onRows((current) => [
            ...current,
            { key: Date.now(), name: "", value: "" },
          ])
        }
      >
        <Plus />
        Add Header
      </Button>
    </div>
    {error === undefined ? null : (
      <p className="model-routing-field-error">{error}</p>
    )}
  </div>
);
