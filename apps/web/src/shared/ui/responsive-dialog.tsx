import { Drawer } from "@base-ui/react/drawer";
import type * as React from "react";
import { useMobile } from "../use-mobile.js";
import { cn } from "../utils.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "./dialog.js";
import { DrawerContent, DrawerRoot } from "./drawer.js";
import "./responsive-dialog.css";

/** Below this width the dialog is a bottom sheet a finger swipes down. */
const PHONE_MAX_WIDTH = 639;

/**
 * A short task or a detail over the page: a centered dialog on a desktop,
 * a bottom sheet on a phone. It lays out the title, an optional
 * description, the body, and an optional footer of actions (primary on the
 * right), and the body scrolls when it is taller than the screen.
 */
export function ResponsiveDialog({
  open,
  onOpenChange,
  title,
  description,
  footer,
  size = "md",
  className,
  children,
}: {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: React.ReactNode;
  readonly description?: React.ReactNode;
  /** The actions, such as Cancel and Save; Save goes last. */
  readonly footer?: React.ReactNode;
  /** The desktop width: `sm` 430px, `md` 480px, `lg` 520px, `xl` 720px. */
  readonly size?: "sm" | "md" | "lg" | "xl";
  readonly className?: string;
  readonly children: React.ReactNode;
}) {
  const phone = useMobile(PHONE_MAX_WIDTH);
  const body = (
    <>
      <div className="dx-responsive-dialog-body">{children}</div>
      {footer === undefined ? null : (
        <div className="dx-responsive-dialog-footer">{footer}</div>
      )}
    </>
  );
  if (phone)
    return (
      <DrawerRoot open={open} onOpenChange={onOpenChange} swipeDirection="down">
        <DrawerContent className={cn("dx-responsive-dialog", className)}>
          <div className="dx-responsive-dialog-header">
            <Drawer.Title className="dx-responsive-dialog-title">
              {title}
            </Drawer.Title>
            {description === undefined ? null : (
              <Drawer.Description className="dx-responsive-dialog-description">
                {description}
              </Drawer.Description>
            )}
          </div>
          {body}
        </DrawerContent>
      </DrawerRoot>
    );
  return (
    <DialogRoot open={open} onOpenChange={onOpenChange}>
      <DialogContent
        size={size}
        className={cn("dx-responsive-dialog", className)}
      >
        <div className="dx-responsive-dialog-header">
          <DialogTitle className="dx-responsive-dialog-title">
            {title}
          </DialogTitle>
          {description === undefined ? null : (
            <DialogDescription className="dx-responsive-dialog-description">
              {description}
            </DialogDescription>
          )}
        </div>
        {body}
      </DialogContent>
    </DialogRoot>
  );
}
