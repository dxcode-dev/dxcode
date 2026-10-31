import {
  CircleCheckIcon,
  InfoIcon,
  Loader2Icon,
  OctagonXIcon,
  TriangleAlertIcon,
} from "lucide-react";
import type * as React from "react";
import { Toaster as Sonner, type ToasterProps } from "sonner";
import { useTheme } from "../theme/theme-provider.js";

/**
 * shadcn/ui's sonner Toaster on dx's theme: popover surface, border, and
 * radius from the app's variables, lucide icons, and the resolved
 * light or dark appearance. Mounted once with the signed-in app; raise
 * toasts with `toast` from "sonner".
 */
export function Toaster(props: ToasterProps) {
  const { resolvedAppearance } = useTheme();
  return (
    <Sonner
      theme={resolvedAppearance}
      className="toaster group"
      icons={{
        success: <CircleCheckIcon className="size-4" />,
        info: <InfoIcon className="size-4" />,
        warning: <TriangleAlertIcon className="size-4" />,
        error: <OctagonXIcon className="size-4 text-destructive" />,
        loading: <Loader2Icon className="size-4 animate-spin" />,
      }}
      style={
        {
          "--normal-bg": "var(--popover)",
          "--normal-text": "var(--popover-foreground)",
          "--normal-border": "var(--border)",
          "--border-radius": "var(--radius)",
        } as React.CSSProperties
      }
      {...props}
    />
  );
}
