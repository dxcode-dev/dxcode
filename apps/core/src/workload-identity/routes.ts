import type {
  WorkloadIdentityDiscoveryResponse,
  WorkloadIdentityJwksResponse,
} from "@dx/api";
import type { Context } from "hono";
import { Hono } from "hono";
import type { AppEnv } from "../http/types.js";
import { workloadIdentityBroker } from "./broker.js";

interface PublicWorkloadIdentityBroker {
  readonly discovery: (
    bindings: AppEnv["Bindings"],
  ) => WorkloadIdentityDiscoveryResponse;
  readonly jwks: (bindings: AppEnv["Bindings"]) => WorkloadIdentityJwksResponse;
}

const unavailable = (context: Context<AppEnv>) => {
  context.header("cache-control", "no-store");
  context.header("pragma", "no-cache");
  return context.json(
    {
      status: "error" as const,
      data: {
        code: "WORKLOAD_IDENTITY_UNAVAILABLE" as const,
        message: "Workload identity is temporarily unavailable." as const,
        requestId: context.get("requestId"),
      },
    },
    503,
  );
};

export const makeWorkloadIdentityRoutes = (
  broker: PublicWorkloadIdentityBroker,
) => {
  const routes = new Hono<AppEnv>();

  routes.get("/.well-known/openid-configuration", (context) => {
    try {
      context.header("cache-control", "public, max-age=300, must-revalidate");
      return context.json<WorkloadIdentityDiscoveryResponse>(
        broker.discovery(context.env),
      );
    } catch {
      return unavailable(context);
    }
  });

  routes.get("/jwks.json", (context) => {
    try {
      context.header("cache-control", "public, max-age=300, must-revalidate");
      return context.json<WorkloadIdentityJwksResponse>(
        broker.jwks(context.env),
      );
    } catch {
      return unavailable(context);
    }
  });

  return routes;
};

export const workloadIdentityRoutes = makeWorkloadIdentityRoutes(
  workloadIdentityBroker,
);
