// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import { ModeDialSettings } from "./mode-dial-settings.js";

const router = vi.hoisted(() => ({
  search: { mode: "high" } as { mode?: string },
  navigate: vi.fn(),
  data: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", () => ({
  useBlocker: () => ({ status: "idle" }),
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: router.data[queryKey[2]!],
    isError: false,
    isPending: router.data[queryKey[2]!] === undefined,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("../../../shared/auth/auth-context.js", () => ({
  useAuthenticatedIdentity: () => ({ identity: { id: "usr_test" } }),
}));

describe("mode dial settings", () => {
  it("opens Medium and reports edits and discard to the settings shell", async () => {
    router.search = {};
    router.data = {
      profile: {
        modes: Object.fromEntries(
          ["low", "medium", "high", "ultra"].map((mode) => [
            mode,
            {
              source: "default",
              config: { agent: { model: "openai/a", thinking: "medium" } },
            },
          ]),
        ),
      },
      choices: {
        models: [
          {
            canonical: "openai/a",
            name: "A",
            reasoning: true,
            connectionName: "Provider",
          },
          {
            canonical: "openai/b",
            name: "B",
            reasoning: true,
            connectionName: "Provider",
          },
        ],
      },
    };
    const onDirtyChange = vi.fn();
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(<ModeDialSettings onDirtyChange={onDirtyChange} />),
      );
      expect(
        container
          .querySelector(".mode-tuning-workbench")
          ?.getAttribute("data-mode"),
      ).toBe("medium");
      const select =
        container.querySelector<HTMLSelectElement>("#mode-dial-model")!;
      await React.act(() => {
        select.value = "openai/b";
        select.dispatchEvent(new Event("change", { bubbles: true }));
      });
      expect(onDirtyChange).toHaveBeenLastCalledWith(true);
      await React.act(() =>
        Array.from(container.querySelectorAll("button"))
          .find((button) => button.textContent === "Discard")
          ?.click(),
      );
      expect(onDirtyChange).toHaveBeenLastCalledWith(false);
      expect(select.value).toBe("openai/a");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
      router.data = {};
    }
  });
});
