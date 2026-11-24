import type { ConnectionData } from "@dx/api";
import { type HeaderRow, HeaderRows } from "../../../shared/ui/header-rows.js";

export type { HeaderRow } from "../../../shared/ui/header-rows.js";

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
    <HeaderRows rows={rows} onRows={onRows} />
    {error === undefined ? null : (
      <p className="model-routing-field-error">{error}</p>
    )}
  </div>
);
