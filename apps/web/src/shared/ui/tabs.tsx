import { Tabs as BaseTabs } from "@base-ui/react/tabs";
import type * as React from "react";
import { cn } from "../utils.js";
import "./tabs.css";

/**
 * dx's tabs. `variant="underline"` (default) switches a page's sections;
 * `variant="segmented"` is a compact pill group that switches a view, such
 * as Diff and File, or Chart and List.
 */
export function Tabs({
  variant = "underline",
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.Root> & {
  readonly variant?: "underline" | "segmented";
}) {
  return (
    <BaseTabs.Root
      className={cn("dx-tabs", className)}
      data-variant={variant}
      {...props}
    />
  );
}

export function TabsList({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.List>) {
  return <BaseTabs.List className={cn("dx-tabs-list", className)} {...props} />;
}

export function Tab({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.Tab>) {
  return <BaseTabs.Tab className={cn("dx-tab", className)} {...props} />;
}

export function TabsPanel({
  className,
  ...props
}: React.ComponentProps<typeof BaseTabs.Panel>) {
  return (
    <BaseTabs.Panel className={cn("dx-tabs-panel", className)} {...props} />
  );
}
