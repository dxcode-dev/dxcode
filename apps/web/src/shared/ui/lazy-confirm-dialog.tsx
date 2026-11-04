import * as React from "react";
import type { ConfirmDialog } from "./confirm-dialog.js";

const LoadedConfirmDialog = React.lazy(() =>
  import("./confirm-dialog.js").then((module) => ({
    default: module.ConfirmDialog,
  })),
);

/**
 * `ConfirmDialog`, loaded the first time one opens. Use it where the dialog
 * mounts only on demand from a module on the Thread page's first load, so
 * the dialog stays out of that load's budget.
 */
export function LazyConfirmDialog(
  props: React.ComponentProps<typeof ConfirmDialog>,
) {
  return (
    <React.Suspense fallback={null}>
      <LoadedConfirmDialog {...props} />
    </React.Suspense>
  );
}
