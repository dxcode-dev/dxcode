import { Separator } from "react-resizable-panels";

export function ResizableDivider({ label }: { readonly label: string }) {
  return (
    <Separator className="resize-handle" aria-label={label}>
      <span />
    </Separator>
  );
}
