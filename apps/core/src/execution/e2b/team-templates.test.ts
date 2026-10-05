import { readFileSync } from "node:fs";
import { E2B_ORB_PROFILES } from "@dx/domain";
import { Template } from "e2b";
import { describe, expect, it, vi } from "vitest";
import {
  advanceTeamTemplates,
  E2BKeyRejected,
  type E2BTeamApi,
  inlineOrbDockerfile,
  type ListedTeamTemplate,
  orbTemplateRecipe,
  readyProfileTemplates,
  startTeamTemplates,
  teamOf,
  teamTemplateName,
} from "./team-templates.js";

const repo = new URL("../../../../../", import.meta.url);
const read = (path: string) => readFileSync(new URL(path, repo), "utf8");

describe("Orb template recipe for a person's own E2B team", () => {
  it("inlines exactly the files the Dockerfile copies, byte for byte", () => {
    const dockerfile = read("deploy/orb/Dockerfile");
    const inlined = inlineOrbDockerfile();
    expect(inlined).not.toMatch(/^COPY /m);
    const copies = [...dockerfile.matchAll(/^COPY\s+(\S+)\s+(\S+)$/gm)];
    expect(copies.length).toBeGreaterThan(0);
    for (const [, source, destination] of copies) {
      const encoded = new RegExp(
        `echo (\\S+) \\| base64 -d >${destination?.replaceAll(".", "\\.")}$`,
        "m",
      ).exec(inlined)?.[1];
      expect(
        Buffer.from(encoded ?? "", "base64").toString("utf8"),
        `${source}`,
      ).toBe(read(source ?? ""));
    }
    // Everything else is the same recipe.
    expect(
      inlined.split("\n").filter((line) => !line.startsWith("RUN mkdir -p")),
    ).toEqual(
      dockerfile.split("\n").filter((line) => !line.startsWith("COPY")),
    );
    expect(() =>
      inlineOrbDockerfile("FROM debian\nCOPY unknown /x\n", {}),
    ).toThrow("does not inline unknown");
  });

  it("parses as the same E2B template steps as the deployment's, minus uploads", async () => {
    const template = Template({ fileContextPath: "." }).fromDockerfile(
      inlineOrbDockerfile(),
    );
    const steps = JSON.parse(await Template.toJSON(template, false)) as {
      readonly fromImage?: string;
      readonly steps: ReadonlyArray<{ readonly type: string }>;
    };
    expect(steps.fromImage).toMatch(/^debian:13-slim@sha256:/);
    expect(steps.steps.some(({ type }) => type === "COPY")).toBe(false);
  });

  it("versions template names by recipe", async () => {
    const recipe = await orbTemplateRecipe();
    expect(recipe).toMatch(/^[0-9a-f]{16}$/);
    expect(await orbTemplateRecipe("FROM other")).not.toBe(recipe);
    expect(teamTemplateName(recipe)).toBe(`dx-orb-${recipe}-base`);
    expect(teamTemplateName(recipe, E2B_ORB_PROFILES[0])).toBe(
      `dx-orb-${recipe}-a1-tiny`,
    );
  });
});

const recipe = "0123456789abcdef";

const fakeTeam = (initial: Array<ListedTeamTemplate> = []) => {
  const templates = [...initial];
  const statuses = new Map<string, "building" | "ready" | "error">();
  let next = 0;
  const start = (name: string) => {
    next += 1;
    const build = { templateId: `t${next}`, buildId: `b${next}` };
    statuses.set(build.buildId, "building");
    templates.push({
      templateID: build.templateId,
      buildID: build.buildId,
      buildStatus: "building",
      names: [`team-a/${name}`],
      aliases: [name],
    });
    return build;
  };
  const api: E2BTeamApi = {
    listTemplates: vi.fn(async (apiKey) => {
      if (apiKey === "bad") throw new E2BKeyRejected();
      return templates;
    }),
    buildBase: vi.fn(async (_apiKey, name) => start(name)),
    buildProfile: vi.fn(async (_apiKey, name, base) => {
      expect(base.name).toBe(teamTemplateName(recipe));
      return start(name);
    }),
    buildStatus: vi.fn(
      async (_apiKey, build) => statuses.get(build.buildId) ?? "error",
    ),
  };
  return { api, statuses };
};

describe("building the Orb templates into a key's team", () => {
  it("rejects a key E2B refuses", async () => {
    await expect(
      startTeamTemplates(fakeTeam().api, "bad", recipe),
    ).rejects.toBeInstanceOf(E2BKeyRejected);
  });

  it("builds the base, then each size from it, one at a time, naming the team", async () => {
    const { api, statuses } = fakeTeam();
    let state = await startTeamTemplates(api, "key", recipe);
    expect(state).toMatchObject({ state: "building", account: "team-a" });
    expect(state.builds.map(({ name }) => name)).toEqual([
      teamTemplateName(recipe),
    ]);
    // Nothing more starts while the base builds.
    state = await advanceTeamTemplates(api, "key", recipe, state);
    expect(state.builds).toHaveLength(1);
    for (const profile of E2B_ORB_PROFILES) {
      for (const build of state.builds) statuses.set(build.buildId, "ready");
      state = await advanceTeamTemplates(api, "key", recipe, state);
      expect(state.builds.at(-1)?.profileId).toBe(profile.id);
      expect(state.state).toBe("building");
    }
    for (const build of state.builds) statuses.set(build.buildId, "ready");
    state = await advanceTeamTemplates(api, "key", recipe, state);
    state = await advanceTeamTemplates(api, "key", recipe, state);
    expect(state.state).toBe("ready");
    expect(api.buildBase).toHaveBeenCalledOnce();
    expect(api.buildProfile).toHaveBeenCalledTimes(E2B_ORB_PROFILES.length);
    expect(readyProfileTemplates(state)?.get("a1.medium")).toBe(
      teamTemplateName(recipe, E2B_ORB_PROFILES[2]),
    );
  });

  it("reuses ready templates, so re-saving or rotating a key in the same team is ready at once", async () => {
    const listed = [undefined, ...E2B_ORB_PROFILES].map((profile, index) => ({
      templateID: `t${index}`,
      buildID: `b${index}`,
      buildStatus: "ready",
      names: [`team-a/${teamTemplateName(recipe, profile)}`],
      aliases: [teamTemplateName(recipe, profile)],
    }));
    const { api } = fakeTeam(listed);
    const state = await startTeamTemplates(api, "rotated", recipe);
    expect(state).toMatchObject({ state: "ready", account: "team-a" });
    expect(api.buildBase).not.toHaveBeenCalled();
    expect(teamOf(listed)).toBe("team-a");
  });

  it("fails the key when a build fails, without trying other templates", async () => {
    const { api, statuses } = fakeTeam();
    let state = await startTeamTemplates(api, "key", recipe);
    for (const build of state.builds) statuses.set(build.buildId, "error");
    state = await advanceTeamTemplates(api, "key", recipe, state);
    expect(state).toMatchObject({
      state: "failed",
      error: `E2B could not build ${teamTemplateName(recipe)}.`,
    });
    expect(api.buildProfile).not.toHaveBeenCalled();
  });
});
