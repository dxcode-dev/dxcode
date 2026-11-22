// A deployment registers its own pages, account menu items, and notices
// here. Public dx registers none.
import type { UserId } from "@dx/domain";
import type { QueryClient } from "@tanstack/react-query";
import type { AnyRootRoute } from "@tanstack/react-router";
import type { ComponentType } from "react";

export const registeredDeploymentRoutes = (_rootRoute: AnyRootRoute) =>
  [] as const;

export const DeploymentAccountMenuItems:
  | ComponentType<{
      readonly userId: UserId;
      readonly onNavigate: () => void;
    }>
  | undefined = undefined;

export const DeploymentNotices: ComponentType | undefined = undefined;

export const prefetchDeploymentShell:
  | ((queryClient: QueryClient) => Promise<void>)
  | undefined = undefined;
