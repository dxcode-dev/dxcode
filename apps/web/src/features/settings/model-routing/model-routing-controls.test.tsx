// @vitest-environment happy-dom

import type { CatalogProviderData, ConnectionData } from "@dx/api";
import * as React from "react";
import { createRoot } from "react-dom/client";
import { describe, expect, it, vi } from "vitest";
import {
  ConnectionDialog,
  type ConnectionDialogSubmit,
} from "./model-routing-controls.js";

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
        fieldErrors={{}}
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
