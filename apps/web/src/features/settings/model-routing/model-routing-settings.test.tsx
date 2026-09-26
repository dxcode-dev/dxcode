// @vitest-environment happy-dom

import type { ChoicesData, GraphData } from "@dx/api";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { settingsManifest } from "../foundation-sections.js";
import { resolveSettingsSection } from "../settings-registration.js";
import { parseCustomModelsText } from "./custom-models.js";
import { ModelRoutingGraph } from "./model-routing-graph.js";
import {
  highlightedSources,
  routingPresentation,
} from "./model-routing-presentation.js";

const graphFixture: GraphData = {
  modes: [
    {
      mode: "low",
      config: { model: "openai/gpt-5.6-terra", thinking: "max" },
      source: "default",
      served: true,
    },
    {
      mode: "high",
      config: { model: "openai/gpt-6-astra", thinking: "medium" },
      source: "override",
      served: false,
    },
  ],
  connections: [
    {
      connectionId:
        "mcon_1" as GraphData["connections"][number]["connectionId"],
      name: "OpenAI",
      kind: "provider",
      scope: "personal",
      priority: 0,
      enabled: true,
    },
  ],
  edges: [
    {
      mode: "low",
      model: "openai/gpt-5.6-terra",
      connectionId: "mcon_1" as GraphData["edges"][number]["connectionId"],
    },
    { mode: "high", model: "openai/gpt-6-astra", connectionId: null },
  ],
};

describe("model routing settings", () => {
  it("registers the model-routing slug for both scopes", () => {
    expect(
      resolveSettingsSection(settingsManifest, "personal", "model-routing"),
    ).toMatchObject({
      found: true,
      registration: { id: "personal-model-routing" },
    });
    expect(
      resolveSettingsSection(settingsManifest, "workspace", "model-routing"),
    ).toMatchObject({
      found: true,
      registration: { id: "workspace-model-routing" },
    });
  });

  it("renders modes to connections with a not-served destination", () => {
    const markup = renderToStaticMarkup(
      <ModelRoutingGraph graph={graphFixture} />,
    );
    expect(markup).toContain("Low");
    expect(markup).toContain("High");
    expect(markup).toContain("openai/gpt-5.6-terra");
    expect(markup).toContain("OpenAI");
    expect(markup).not.toContain("Oracle");
    expect(markup).toContain("Main Agent");
    expect(markup).toContain("Not served");
  });

  it("keeps destinations without a local connection row non-actionable", () => {
    const markup = renderToStaticMarkup(
      <ModelRoutingGraph
        graph={graphFixture}
        connections={[]}
        onConnectionClick={() => undefined}
      />,
    );
    const container = document.createElement("div");
    container.innerHTML = markup;
    const destination = container.querySelector(
      '[data-routing-destination="mcon_1"]',
    );
    expect(destination?.tagName).toBe("DIV");
    expect(destination?.getAttribute("tabindex")).toBe("0");
  });

  it("retains separate source rows when modes share a model", () => {
    const repeatedModel: GraphData = {
      ...graphFixture,
      modes: [
        ...graphFixture.modes,
        {
          mode: "medium",
          config: { model: "openai/gpt-5.6-terra", thinking: "high" },
          source: "default",
          served: true,
        },
      ],
      edges: [
        ...graphFixture.edges,
        {
          mode: "medium",
          model: "openai/gpt-5.6-terra",
          connectionId: "mcon_1" as GraphData["edges"][number]["connectionId"],
        },
      ],
    };
    const markup = renderToStaticMarkup(
      <ModelRoutingGraph graph={repeatedModel} />,
    );

    expect(markup).toContain('data-routing-source="low:agent"');
    expect(markup).toContain('data-routing-source="medium:agent"');
    expect(markup).not.toContain('href="/settings/mode-dial');
  });

  it("parses custom models with line-numbered errors", () => {
    const { models, errors } = parseCustomModelsText(
      [
        "# comment",
        "openai/gpt-6-astra -> astra-litellm",
        "anthropic/claude-fable-5-1",
        "bad line",
        "openai/missing",
        "anthropic/claude-fable-5-1",
        "openai/gpt-6-astra -> astra -> ignored",
      ].join("\n"),
    );
    expect(models).toEqual([
      { canonical: "openai/gpt-6-astra", upstream: "astra-litellm" },
      { canonical: "anthropic/claude-fable-5-1" },
      { canonical: "openai/missing" },
    ]);
    expect(errors).toEqual([
      {
        line: 4,
        message: "Expected a canonical model id like `openai/gpt-6-astra`.",
      },
      { line: 6, message: "Duplicate of line 3." },
      { line: 7, message: "Expected at most one `->` separator." },
    ]);
  });
});

describe("routing presentation preserves dx authority", () => {
  it("keeps the server's winner and never supplies a model fallback", () => {
    const { groups, destinations } = routingPresentation({
      graph: graphFixture,
    });
    expect(groups[0]?.rows.map((r) => r.destination)).toEqual(["mcon_1"]);
    expect(groups[1]?.rows.map((r) => r.destination)).toEqual(["not-served"]);
    expect(destinations.filter((d) => d.id === "not-served")).toHaveLength(1);
    expect(destinations.some((d) => d.kind === "dx")).toBe(false);
  });
  it("shows standalone models only when the direct model picker offers them", () => {
    const choices: ChoicesData = { modes: [], models: [] };
    expect(
      routingPresentation({ graph: graphFixture, choices }).groups.map(
        (g) => g.id,
      ),
    ).toEqual(["low", "high"]);
    const servedChoices: ChoicesData = {
      modes: [],
      models: [
        {
          canonical: "openai/gpt-5.6-terra",
          name: "GPT-5.6 Terra",
          connectionId:
            "mcon_1" as GraphData["connections"][number]["connectionId"],
          connectionName: "OpenAI",
          contextWindow: 100000,
          reasoning: true,
          vision: true,
        },
      ],
    };
    expect(
      routingPresentation({
        graph: graphFixture,
        choices: servedChoices,
      }).groups.find((g) => g.id === "other")?.rows,
    ).toEqual([
      {
        id: "model:openai/gpt-5.6-terra",
        model: "openai/gpt-5.6-terra",
        name: "GPT-5.6 Terra",
        destination: "mcon_1",
      },
    ]);
  });
  it("only adds Sarvam and dx when transcription is available", () => {
    for (const dictationAvailable of [false, true]) {
      const result = routingPresentation({
        graph: graphFixture,
        dictationAvailable,
      });
      expect(
        result.groups
          .flatMap((g) => g.rows)
          .some((r) => r.id === "sarvam:transcription"),
      ).toBe(dictationAvailable);
      expect(result.destinations.some((d) => d.id === "dx-transcription")).toBe(
        dictationAvailable,
      );
    }
  });
  it("highlights main-agent slots, individual routes, and incoming provider routes", () => {
    const { groups } = routingPresentation({ graph: graphFixture });
    expect([
      ...highlightedSources(groups, { kind: "group", id: "low" }),
    ]).toEqual(["low:agent"]);
    expect([
      ...highlightedSources(groups, { kind: "source", id: "low:agent" }),
    ]).toEqual(["low:agent"]);
    expect([
      ...highlightedSources(groups, { kind: "destination", id: "mcon_1" }),
    ]).toEqual(["low:agent"]);
    expect([
      ...highlightedSources(groups, { kind: "destination", id: "not-served" }),
    ]).toEqual(["high:agent"]);
    expect(highlightedSources(groups, undefined).size).toBe(0);
  });
});
