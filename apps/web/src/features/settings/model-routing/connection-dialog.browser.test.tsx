import type { CatalogProviderData, ConnectionData } from "@dx/api";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionDialog,
  type ConnectionDialogSubmit,
} from "./connection-dialog.js";

const existing = {
  id: "mcon_1",
  name: "Existing provider",
  kind: "custom",
  providerId: "dx-custom",
  enabled: true,
  fields: {},
  headers: [{ name: "X-Tenant", masked: "••••nant" }],
  models: [],
  health: { state: "untested" },
} as unknown as ConnectionData;

const setValue = (
  element: HTMLInputElement | HTMLTextAreaElement,
  value: string,
) => {
  const prototype =
    element instanceof HTMLTextAreaElement
      ? HTMLTextAreaElement.prototype
      : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(prototype, "value")?.set?.call(
    element,
    value,
  );
  element.dispatchEvent(new Event("input", { bubbles: true }));
};

const renderDialog = async (
  onSubmit: (input: ConnectionDialogSubmit) => void,
  options: {
    existing?: ConnectionData;
    provider?: CatalogProviderData;
    fieldErrors?: Readonly<Record<string, string>>;
    submitError?: string;
  } = { existing },
) => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await React.act(() =>
    root.render(
      <ConnectionDialog
        open
        existing={options.existing}
        provider={options.provider}
        busy={false}
        fieldErrors={options.fieldErrors ?? {}}
        submitError={options.submitError}
        onClose={() => undefined}
        onSubmit={onSubmit}
      />,
    ),
  );
  return { container, root };
};

describe("connection dialog headers", () => {
  it("preserves masked headers during an unrelated edit", async () => {
    const onSubmit = vi.fn();
    const { container, root } = await renderDialog(onSubmit);
    try {
      const name = document.querySelector<HTMLInputElement>("#mr-name");
      expect(name).not.toBeNull();
      if (name !== null) setValue(name, "Renamed provider");
      await React.act(() =>
        document
          .querySelector<HTMLFormElement>(".model-routing-dialog-form")
          ?.requestSubmit(),
      );
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ name: "Renamed provider" }),
      );
      expect(onSubmit.mock.calls[0]?.[0]).not.toHaveProperty("headers");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it.each([
    [
      "replace",
      "X-New: replacement",
      [{ name: "X-New", value: "replacement" }],
    ],
    ["clear", undefined, []],
  ] as const)("supports an explicit %s", async (action, text, expected) => {
    const onSubmit = vi.fn();
    const { container, root } = await renderDialog(onSubmit);
    try {
      await React.act(() =>
        document
          .querySelector<HTMLButtonElement>(".model-routing-advanced-toggle")
          ?.click(),
      );
      const actionSelect = document.querySelector<HTMLSelectElement>(
        '[aria-label="Custom header action"]',
      );
      expect(document.body.textContent).toContain("X-Tenant: ••••nant");
      await React.act(() => {
        if (actionSelect === null) return;
        actionSelect.value = action;
        actionSelect.dispatchEvent(new Event("change", { bubbles: true }));
      });
      if (text !== undefined) {
        const headers =
          document.querySelector<HTMLTextAreaElement>("#mr-headers");
        expect(headers).not.toBeNull();
        if (headers !== null) setValue(headers, text);
      }
      await React.act(() =>
        document
          .querySelector<HTMLFormElement>(".model-routing-dialog-form")
          ?.requestSubmit(),
      );
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ headers: expected }),
      );
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });
});

describe("connection dialog base URL override", () => {
  it("sends null when an existing provider override is cleared", async () => {
    const onSubmit = vi.fn();
    const providerConnection = {
      ...existing,
      kind: "provider",
      providerId: "openai",
      baseUrl: "https://provider.example.com/v1",
      headers: [],
    } as ConnectionData;
    const provider = {
      id: "openai",
      name: "OpenAI",
      description: "OpenAI",
      connectionKind: "provider",
      transport: "proxy",
      fields: [],
      models: [],
    } as CatalogProviderData;
    const { container, root } = await renderDialog(onSubmit, {
      existing: providerConnection,
      provider,
    });
    try {
      const baseUrl = document.querySelector<HTMLInputElement>("#mr-base-url");
      expect(baseUrl).not.toBeNull();
      if (baseUrl !== null) setValue(baseUrl, "");
      await React.act(() =>
        document
          .querySelector<HTMLFormElement>(".model-routing-dialog-form")
          ?.requestSubmit(),
      );
      expect(onSubmit).toHaveBeenCalledWith(
        expect.objectContaining({ baseUrl: null }),
      );
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });
});

describe("connection dialog endpoint preview", () => {
  const preview = () =>
    document.querySelector("#mr-endpoint code")?.textContent ?? null;
  const chooseFormat = (value: string) =>
    React.act(() =>
      document
        .querySelector<HTMLInputElement>(
          `input[name="api-format"][value="${value}"]`,
        )
        ?.click(),
    );

  it("marks each field the server rejected with its message", async () => {
    const { container, root } = await renderDialog(vi.fn(), {
      fieldErrors: {
        name: "Name is required.",
        baseUrl: "Use a public HTTPS endpoint.",
        apiKey: "API key is required.",
        models: "Declare at least one model.",
        format: "Pick the API format this endpoint speaks.",
      },
      submitError: "Model routing validation failed.",
    });
    try {
      const errorOf = (id: string) => {
        const input = document.querySelector(`#${id}`);
        expect(input?.getAttribute("aria-invalid")).toBe("true");
        const describedBy = input?.getAttribute("aria-describedby") ?? "";
        return describedBy
          .split(" ")
          .map((ref) => document.getElementById(ref)?.textContent)
          .join(" ");
      };
      expect(errorOf("mr-name")).toContain("Name is required.");
      expect(errorOf("mr-base-url")).toContain("Use a public HTTPS endpoint.");
      expect(errorOf("mr-key")).toContain("API key is required.");
      expect(errorOf("mr-models")).toContain("Declare at least one model.");
      expect(
        document.querySelector(".routing-format-options")?.textContent,
      ).toContain("Pick the API format this endpoint speaks.");
      // Field errors replace the generic form message.
      expect(document.body.textContent).not.toContain(
        "Model routing validation failed.",
      );
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("shows no endpoint preview for a URL that is not HTTPS", async () => {
    const { container, root } = await renderDialog(vi.fn(), {});
    try {
      const baseUrl = document.querySelector<HTMLInputElement>("#mr-base-url");
      await React.act(() => {
        if (baseUrl !== null) setValue(baseUrl, "ftp://bad");
      });
      expect(preview()).toBeNull();
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });

  it("shows the exact endpoint for each format as the user types", async () => {
    const { container, root } = await renderDialog(vi.fn(), {});
    try {
      const baseUrl = document.querySelector<HTMLInputElement>("#mr-base-url");
      expect(preview()).toBeNull();
      await React.act(() => {
        if (baseUrl !== null) setValue(baseUrl, "https://ai.example.com/v1/");
      });
      expect(preview()).toBe("https://ai.example.com/v1/chat/completions");
      expect(baseUrl?.getAttribute("aria-describedby")).toBe("mr-endpoint");

      await chooseFormat("openai-responses");
      expect(preview()).toBe("https://ai.example.com/v1/responses");

      await chooseFormat("anthropic-messages");
      expect(preview()).toBe("https://ai.example.com/v1/messages");
      // The typed value is left as entered; only the derived endpoint changes.
      expect(baseUrl?.value).toBe("https://ai.example.com/v1/");
    } finally {
      await React.act(() => root.unmount());
      container.remove();
    }
  });
});
