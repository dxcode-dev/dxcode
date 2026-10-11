// @vitest-environment happy-dom

import {
  PluginUsageDataSchema,
  WorkspacePluginUsageUserDataSchema,
} from "@dx/api";
import { Schema } from "effect";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { PluginUsageMemberTable, PluginUsageTable } from "./plugin-usage.js";

const search = {
  pluginId: "search",
  pluginName: "Web search",
  providerId: "exa",
  providerName: "Exa",
  capability: "web.search",
  unit: "request",
};
const plugins = Schema.decodeUnknownSync(Schema.Array(PluginUsageDataSchema))([
  {
    ...search,
    credentialScope: "personal",
    units: 2,
    events: 2,
    outcomes: { success: 1, error: 1 },
  },
  {
    ...search,
    credentialScope: "deployment",
    units: 1,
    events: 1,
    outcomes: { success: 1, error: 0 },
  },
  {
    pluginId: "speech",
    pluginName: "Dictation",
    providerId: "sarvam",
    providerName: "Sarvam",
    capability: "speech.transcribe",
    credentialScope: "workspace",
    unit: "audio_second",
    units: 42,
    events: 3,
    outcomes: { success: 3, error: 0 },
  },
]);
const pluginUsers = Schema.decodeUnknownSync(
  Schema.Array(WorkspacePluginUsageUserDataSchema),
)([
  {
    userId: "usr_avery",
    userName: "Avery Engineer",
    ...plugins[0],
  },
  {
    userId: "usr_blake",
    userName: "Blake Reviewer",
    ...plugins[1],
  },
]);

const rowsOf = (container: ParentNode) =>
  [...container.querySelectorAll("tbody")].map((group) =>
    [...group.querySelectorAll("tr")].map((row) =>
      [...row.querySelectorAll("th, td")]
        .map((cell) =>
          [...cell.childNodes].map((node) => node.textContent).join(" "),
        )
        .join(" | "),
    ),
  );

const render = (markup: string) => {
  const container = document.createElement("div");
  container.innerHTML = markup;
  return container;
};

describe("plugin usage", () => {
  it("groups by plugin and provider, names the paying key, and keeps units apart", () => {
    const container = render(
      renderToStaticMarkup(
        <PluginUsageTable rows={plugins} viewer="personal" />,
      ),
    );
    expect(rowsOf(container)).toEqual([
      [
        "Web search Exa",
        "web.search | Your key | 2 requests | 2 1 failed",
        "web.search | Deployment key | 1 request | 1",
      ],
      [
        "Dictation Sarvam",
        "speech.transcribe | Workspace key | 42 audio seconds | 3",
      ],
    ]);
    expect(container.textContent).not.toMatch(/\$|cost|price/i);
  });

  it("names a member's own key as a personal key for workspace readers", () => {
    const container = render(
      renderToStaticMarkup(<PluginUsageMemberTable rows={pluginUsers} />),
    );
    expect(rowsOf(container)).toEqual([
      [
        "Avery Engineer usr_avery",
        "Web search · Exa web.search | Personal key | 2 requests | 2 1 failed",
      ],
      [
        "Blake Reviewer usr_blake",
        "Web search · Exa web.search | Deployment key | 1 request | 1",
      ],
    ]);
  });
});
