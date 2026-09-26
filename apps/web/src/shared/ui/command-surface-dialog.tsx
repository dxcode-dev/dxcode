import type * as React from "react";
import { cn } from "../utils.js";
import { DialogDescription, DialogRoot, DialogTitle } from "./dialog.js";
import {
  ModalSurface,
  ModalSurfaceClose,
  ModalSurfaceHeader,
} from "./modal-surface.js";

export function CommandSurfaceDialog({
  open,
  onOpenChange,
  title,
  description,
  leftHeaderAction,
  rightHeaderAction,
  primary,
  children,
  attachments,
  footer,
  pending = false,
  error,
  variant = "command",
  className,
  finalFocus,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: React.ReactNode;
  readonly description: React.ReactNode;
  readonly leftHeaderAction?: React.ReactNode;
  readonly rightHeaderAction?: React.ReactNode;
  readonly primary: React.ReactNode;
  readonly children?: React.ReactNode;
  readonly attachments?: React.ReactNode;
  readonly footer?: React.ReactNode;
  readonly pending?: boolean;
  readonly error?: React.ReactNode;
  readonly variant?: "command" | "keymap";
  readonly className?: string;
  readonly finalFocus?: React.RefObject<HTMLElement | null>;
}) {
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <ModalSurface
        className={cn(
          "command-surface-dialog",
          `command-surface-dialog-${variant}`,
          className,
        )}
        finalFocus={finalFocus}
      >
        <ModalSurfaceHeader className="command-surface-header">
          <ModalSurfaceClose />
          {leftHeaderAction === undefined ? null : (
            <div className="command-surface-header-action">
              {leftHeaderAction}
            </div>
          )}
          <div className="command-surface-heading">
            <DialogTitle>{title}</DialogTitle>
            <DialogDescription>{description}</DialogDescription>
          </div>
          {rightHeaderAction === undefined ? null : (
            <div className="command-surface-header-action command-surface-header-action-right">
              {rightHeaderAction}
            </div>
          )}
        </ModalSurfaceHeader>
        <div className="command-surface-primary">{primary}</div>
        {attachments === undefined ? null : (
          <div className="command-surface-attachments">{attachments}</div>
        )}
        {error === undefined ? null : (
          <div className="command-surface-error" role="alert">
            {error}
          </div>
        )}
        {children === undefined ? null : (
          <div
            className="command-surface-content"
            aria-busy={pending || undefined}
          >
            {children}
          </div>
        )}
        {footer === undefined ? null : (
          <footer className="command-surface-footer">{footer}</footer>
        )}
      </ModalSurface>
    </DialogRoot>
  );
}
