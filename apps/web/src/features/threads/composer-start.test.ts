import type { ProjectId, RunnerProfile, RunnerProfileId } from "@dx/domain";
import { describe, expect, it } from "vitest";
import {
  effectiveRunnerProfileId,
  rememberedProjectToResolve,
  startingMode,
  startingModel,
  startingProjectId,
} from "./composer-start.js";

const dx = "prj_dx" as ProjectId;
const api = "prj_api" as ProjectId;
const small = "small" as RunnerProfileId;
const large = "large" as RunnerProfileId;
const gone = "gone" as RunnerProfileId;
const catalog = [
  { id: small, availability: "available" },
  { id: large, availability: "available" },
  { id: gone, availability: "maintenance" },
] as unknown as ReadonlyArray<RunnerProfile>;

describe("rememberedProjectToResolve", () => {
  it("fetches a remembered Project that is not in the first page", () => {
    expect(
      rememberedProjectToResolve({
        explicit: undefined,
        remembered: api,
        listedProjectIds: [dx],
      }),
    ).toBe(api);
  });

  it("does not fetch when the choice is already decided", () => {
    for (const input of [
      { explicit: dx, remembered: api, listedProjectIds: [dx] },
      { explicit: undefined, remembered: api, listedProjectIds: [dx, api] },
      { explicit: undefined, remembered: "none", listedProjectIds: [dx] },
      { explicit: undefined, remembered: null, listedProjectIds: [dx] },
    ] as const)
      expect(rememberedProjectToResolve(input)).toBeUndefined();
  });

  it("starts on the fetched Project instead of the first listed one", () => {
    expect(
      startingProjectId({
        explicit: undefined,
        remembered: api,
        // The composer lists the fetched remembered Project ahead of page one.
        listedProjectIds: [api, dx],
      }),
    ).toBe(api);
  });
});

describe("startingProjectId", () => {
  it("prefers an explicit Project, including No Project", () => {
    expect(
      startingProjectId({
        explicit: api,
        remembered: dx,
        listedProjectIds: [dx, api],
      }),
    ).toBe(api);
    expect(
      startingProjectId({
        explicit: "",
        remembered: dx,
        listedProjectIds: [dx],
      }),
    ).toBe("");
  });

  it("restores the remembered Project or No Project", () => {
    expect(
      startingProjectId({
        explicit: undefined,
        remembered: api,
        listedProjectIds: [dx, api],
      }),
    ).toBe(api);
    expect(
      startingProjectId({
        explicit: undefined,
        remembered: "none",
        listedProjectIds: [dx],
      }),
    ).toBe("");
  });

  it("falls back to the first Project when the remembered one is not listed", () => {
    expect(
      startingProjectId({
        explicit: undefined,
        remembered: api,
        listedProjectIds: [dx],
      }),
    ).toBe(dx);
    expect(
      startingProjectId({
        explicit: undefined,
        remembered: null,
        listedProjectIds: [],
      }),
    ).toBe("");
  });
});

describe("startingMode and startingModel", () => {
  it("restores the remembered mode, defaulting to medium", () => {
    expect(startingMode("high")).toBe("high");
    expect(startingMode(null)).toBe("medium");
  });

  it("restores a remembered model only while it is offered", () => {
    expect(startingModel("openai/a", ["openai/a"])).toBe("openai/a");
    expect(startingModel("openai/a", ["openai/b"])).toBeUndefined();
    expect(startingModel("openai/a", undefined)).toBe("openai/a");
    expect(startingModel(null, ["openai/a"])).toBeUndefined();
  });
});

describe("effectiveRunnerProfileId", () => {
  const base = {
    override: undefined,
    projectSelected: false,
    projectRunnerProfileId: undefined,
    remembered: null,
    catalog,
    allowed: null,
    fallback: small,
  } as const;

  it("uses the selected Project's size over the remembered size", () => {
    expect(
      effectiveRunnerProfileId({
        ...base,
        projectSelected: true,
        projectRunnerProfileId: small,
        remembered: large,
      }),
    ).toBe(small);
  });

  it("uses the remembered size when no Project is selected", () => {
    expect(effectiveRunnerProfileId({ ...base, remembered: large })).toBe(
      large,
    );
  });

  it("prefers a size picked in this composer", () => {
    expect(
      effectiveRunnerProfileId({
        ...base,
        override: large,
        projectSelected: true,
        projectRunnerProfileId: small,
      }),
    ).toBe(large);
  });

  it("ignores a remembered size that is unavailable or disallowed", () => {
    expect(effectiveRunnerProfileId({ ...base, remembered: gone })).toBe(small);
    expect(
      effectiveRunnerProfileId({
        ...base,
        remembered: large,
        allowed: [small],
      }),
    ).toBe(small);
    expect(
      effectiveRunnerProfileId({
        ...base,
        remembered: large,
        catalog: undefined,
      }),
    ).toBe(small);
  });
});
