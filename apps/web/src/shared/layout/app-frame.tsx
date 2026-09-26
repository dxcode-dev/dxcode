import type { ReactNode } from "react";
import { cn } from "../utils.js";

export function AppFrame({
  children,
  className,
  onBackdropClick,
}: {
  readonly children: ReactNode;
  readonly className?: string;
  readonly onBackdropClick?: () => void;
}) {
  return (
    <div className={cn("dx-app-shell", className)}>
      {onBackdropClick === undefined ? null : (
        <button
          type="button"
          className="dx-app-backdrop"
          aria-label="Close overlay"
          onClick={onBackdropClick}
        />
      )}
      <div className="dx-app-frame">{children}</div>
    </div>
  );
}
