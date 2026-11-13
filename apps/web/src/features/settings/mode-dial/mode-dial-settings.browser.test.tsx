import { WorkspaceShortName } from "@dx/domain";
import { Schema } from "effect";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { assert, describe, expect, it, vi } from "vitest";
import { ModeDialSettings } from "./mode-dial-settings.js";

const router = vi.hoisted(() => ({
  search: { mode: "high" } as { mode?: string },
  navigate: vi.fn(),
  data: {} as Record<string, unknown>,
}));

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  useBlocker: () => ({ status: "idle" }),
  useSearch: () => router.search,
  useNavigate: () => router.navigate,
  Link: ({ children }: { children: React.ReactNode }) => (
    <a href="/">{children}</a>
  ),
}));
vi.mock("@tanstack/react-query", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-query")>()),
  useQueryClient: () => ({}),
  useQuery: ({ queryKey }: { queryKey: string[] }) => ({
    data: router.data[queryKey.at(-2) ?? ""],
    isError: false,
    isPending: router.data[queryKey.at(-2) ?? ""] === undefined,
  }),
  useMutation: () => ({ mutate: vi.fn(), isPending: false, isError: false }),
}));
vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({ identity: { id: "usr_test" } }),
}));

describe("models settings", () => {
  it.each([
    undefined,
    Schema.decodeUnknownSync(WorkspaceShortName)("qa-workspace"),
  ])(
    "shows sync state and resets an unsaved Recommended draft in scope %s",
    async (workspaceSlug) => {
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
          root.render(
            <ModeDialSettings
              onDirtyChange={onDirtyChange}
              workspaceSlug={workspaceSlug}
            />,
          ),
        );
        const select =
          container.querySelector<HTMLSelectElement>("#models-medium");
        assert.exists(select);
        const button = (text: string) =>
          Array.from(container.querySelectorAll("button")).find(
            (element) => element.textContent?.trim() === text,
          );
        const status = () =>
          container.querySelector(".settings-form-actions > span")?.textContent;
        expect(status()).toBe("In sync");
        expect(button("Save")?.disabled).toBe(true);
        const choose = async (value: string) => {
          await React.act(() => {
            select.value = value;
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
        };
        await choose("openai/b");
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
        expect(status()).toBe("Unsaved changes");
        expect(button("Save")?.disabled).toBe(false);
        // Auto is the reset: back on Auto there is nothing to save.
        await choose("auto");
        expect(select.value).toBe("auto");
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        expect(status()).toBe("In sync");
        await choose("openai/b");
        await React.act(() => button("Discard")?.click());
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        // An unpicked slot shows Auto, not the model Auto resolves to.
        expect(select.value).toBe("auto");
      } finally {
        await React.act(() => root.unmount());
        container.remove();
        router.data = {};
      }
    },
  );

  it("names Auto's model as the catalog does when no connection serves it", async () => {
    router.search = {};
    const model = "cloudflare/@cf/zai-org/glm-5.3-flash";
    router.data = {
      profile: {
        modes: Object.fromEntries(
          ["low", "medium", "high", "ultra"].map((mode) => [
            mode,
            {
              source: "default",
              config: { agent: { model, thinking: "high" } },
            },
          ]),
        ),
      },
      choices: {
        modes: ["low", "medium", "high", "ultra"].map((mode) => ({
          mode,
          config: { model, thinking: "high" },
          modelName: "GLM 5.3 Flash",
          source: "default",
          served: false,
          servingConnectionName: null,
        })),
        models: [],
      },
    };
    const container = document.createElement("div");
    document.body.append(container);
    const root = createRoot(container);
    try {
      await React.act(() =>
        root.render(<ModeDialSettings onDirtyChange={vi.fn()} />),
      );
      // Older mode Threads' models stay hidden until asked for.
      expect(container.querySelector("#models-low")).toBeNull();
      const show = Array.from(container.querySelectorAll("button")).find(
        (element) => element.textContent?.trim() === "Show",
      );
      await React.act(() => show?.click());
      for (const slot of ["medium", "low", "high", "ultra"]) {
        const auto = container.querySelector<HTMLOptionElement>(
          `#models-${slot} option[value="auto"]`,
        );
        expect(auto?.textContent, slot).toBe("Auto · GLM 5.3 Flash");
      }
      expect(container.textContent).not.toContain("cloudflare/");
      expect(container.textContent).not.toContain("glm-5.3-flash");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
      router.data = {};
    }
  });
});
