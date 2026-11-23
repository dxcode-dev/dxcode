import { ArchiveRestore } from "lucide-react";
import { Button } from "./button.js";

/**
 * In the composer's place while a Thread or Space is archived. Without
 * `onUnarchive` (the person is not its owner) it shows disabled.
 */
export function UnarchiveToContinue({
  pending,
  onUnarchive,
}: {
  readonly pending: boolean;
  readonly onUnarchive?: () => void;
}) {
  return (
    <Button
      variant="outline"
      className="unarchive-to-continue"
      disabled={onUnarchive === undefined || pending}
      aria-busy={pending || undefined}
      onClick={onUnarchive}
    >
      <ArchiveRestore aria-hidden="true" />
      Unarchive to Continue
    </Button>
  );
}
