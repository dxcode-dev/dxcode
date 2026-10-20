// Render-scope regression for the signed-in identity: a session refetch on
// window focus returns new objects (Better Auth revives timestamps as Dates),
// and must not re-render every identity reader unless the identity changed.

import { QueryClientProvider } from "@tanstack/react-query";
import * as React from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, expect, it, vi } from "vitest";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { createQueryClient } from "../../shared/query/query-client.js";
import { AuthGate } from "./auth-gate.js";
import { sessionQueryOptions } from "./sign-in-queries.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const server = vi.hoisted(() => ({ name: "Ada Lovelace" }));
vi.mock("../../shared/auth/auth-client.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../shared/auth/auth-client.js")
  >()),
  // Each response is a fresh object graph, as Better Auth's client returns.
  getBrowserSession: async () => ({
    user: {
      id: "usr_render_scope",
      name: server.name,
      email: "ada@dx.test",
      createdAt: new Date("2026-01-01T00:00:00Z"),
      updatedAt: new Date("2026-10-01T00:00:00Z"),
    },
  }),
}));

let renders = 0;
const IdentityReader = React.memo(function IdentityReader() {
  const { identity } = useAuthenticatedIdentity();
  renders += 1;
  return <p data-testid="identity">{identity.name}</p>;
});

let root: Root | undefined;

const mount = async () => {
  const queryClient = createQueryClient();
  const container = document.body.appendChild(document.createElement("div"));
  root = createRoot(container);
  await React.act(async () => {
    root?.render(
      <QueryClientProvider client={queryClient}>
        <AuthGate>
          <IdentityReader />
        </AuthGate>
      </QueryClientProvider>,
    );
    await queryClient.fetchQuery(sessionQueryOptions);
  });
  renders = 0;
  // Query notifies observers on the next macrotask; wait for it inside act.
  const refetchSession = () =>
    React.act(async () => {
      await queryClient.refetchQueries({
        queryKey: sessionQueryOptions.queryKey,
      });
      await new Promise((resolve) => setTimeout(resolve, 0));
    });
  return { container, refetchSession };
};

afterEach(async () => {
  await React.act(() => root?.unmount());
  root = undefined;
  document.body.replaceChildren();
  server.name = "Ada Lovelace";
});

it("re-renders no identity reader when a session refetch returns the same person", async () => {
  const { container, refetchSession } = await mount();

  for (let i = 0; i < 3; i++) await refetchSession();

  expect(container.textContent).toBe("Ada Lovelace");
  expect(renders).toBe(0);
});

it("updates identity readers when the person's name changes", async () => {
  const { container, refetchSession } = await mount();

  server.name = "Ada King";
  await refetchSession();

  expect(container.textContent).toBe("Ada King");
  expect(renders).toBe(1);
});
