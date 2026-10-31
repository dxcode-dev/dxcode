import { DialogContent, DialogRoot } from "../../../shared/ui/dialog.js";
import { ImportPluginForm } from "./import-plugin-form.js";
import type { BundlePreview, BundleRun } from "./plugin-bundle-presentation.js";

export function ImportPluginDialog({
  open,
  busy,
  preview,
  run,
  onClose,
}: {
  readonly open: boolean;
  readonly busy: boolean;
  readonly preview: BundlePreview;
  readonly run: BundleRun;
  readonly onClose: () => void;
}) {
  return (
    <DialogRoot
      open={open}
      onOpenChange={(next) => {
        if (!next) onClose();
      }}
    >
      {open ? (
        <DialogContent className="plugin-bundle-dialog">
          <ImportPluginForm
            busy={busy}
            preview={preview}
            run={run}
            onCancel={onClose}
          />
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}
