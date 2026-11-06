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

describe("mode dial settings", () => {
  it.each([
    undefined,
    Schema.decodeUnknownSync(WorkspaceShortName)("qa-workspace"),
  ])(
    "shows sync state and resets an unsaved Auto-mode draft in scope %s",
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
        expect(
          container
            .querySelector(".mode-tuning-workbench")
            ?.getAttribute("data-mode"),
        ).toBe("medium");
        const select =
          container.querySelector<HTMLSelectElement>("#mode-dial-model");
        assert.exists(select);
        const button = (text: string) =>
          Array.from(container.querySelectorAll("button")).find(
            (element) => element.textContent?.trim() === text,
          );
        const reset = button("Reset to default");
        assert.exists(reset);
        expect(reset.disabled).toBe(true);
        expect(
          container.querySelector("footer [role='status']")?.textContent,
        ).toBe("In sync");
        const edit = async () => {
          await React.act(() => {
            select.value = "openai/b";
            select.dispatchEvent(new Event("change", { bubbles: true }));
          });
        };
        await edit();
        expect(onDirtyChange).toHaveBeenLastCalledWith(true);
        expect(
          container.querySelector("footer [role='status']")?.textContent,
        ).toBe("Unsaved changes");
        expect(reset.disabled).toBe(false);
        expect(button("Save")?.disabled).toBe(false);
        await React.act(() => reset.click());
        expect(select.value).toBe("auto");
        expect(reset.disabled).toBe(true);
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        expect(
          container.querySelector("footer [role='status']")?.textContent,
        ).toBe("In sync");
        await edit();
        await React.act(() => button("Discard")?.click());
        expect(onDirtyChange).toHaveBeenLastCalledWith(false);
        // An unpinned mode shows Auto, not the model Auto resolves to.
        expect(select.value).toBe("auto");
      } finally {
        await React.act(() => root.unmount());
        container.remove();
        router.data = {};
      }
    },
  );

  it("names Auto's model as the catalog does when no connection serves it", async () => {
    router.search = { mode: "low" };
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
      const auto = container.querySelector<HTMLOptionElement>(
        '#mode-dial-model option[value="auto"]',
      );
      expect(auto?.textContent).toBe("Auto · GLM 5.3 Flash");
      expect(container.textContent).not.toContain("cloudflare/");
      expect(container.textContent).not.toContain("glm-5.3-flash");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
      router.data = {};
    }
  });
});
