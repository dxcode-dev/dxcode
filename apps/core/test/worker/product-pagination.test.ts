import { ProjectRepository, ThreadRepository } from "@dx/domain";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";
import { project, thread } from "./fixtures.js";
import {
  bindings,
  createProductApp,
  createProjectViaApi,
  owner,
} from "./product-route-fixture.js";
import { runRepositories } from "./runtime.js";

describe("Product pagination in workerd with real D1", () => {
  it("keeps seek pagination deterministic and scoped with equal timestamps", async () => {
    const projectA = project(
      "prj_00000000-0000-4000-8000-0000000000a1",
      owner,
      "A",
    );
    const projectB = project(
      "prj_00000000-0000-4000-8000-0000000000a2",
      owner,
      "B",
    );
    await runRepositories(
      Effect.gen(function* () {
        const projects = yield* ProjectRepository;
        const threads = yield* ThreadRepository;
        yield* projects.insert(projectA);
        yield* projects.insert(projectB);
        for (const [id, projectId] of [
          ["thr_00000000-0000-4000-8000-0000000000b1", projectA.id],
          ["thr_00000000-0000-4000-8000-0000000000b2", projectA.id],
          ["thr_00000000-0000-4000-8000-0000000000b3", projectB.id],
        ] as const) {
          yield* threads.insert(thread(id, projectId, owner));
        }
      }),
    );

    const first = await createProductApp().request(
      `/threads?projectId=${projectA.id}&limit=1`,
      {},
      bindings,
    );
    const firstBody = await first.json<{
      data: { items: Array<{ id: string }>; nextCursor: string };
    }>();
    const second = await createProductApp().request(
      `/threads?projectId=${projectA.id}&limit=1&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
      {},
      bindings,
    );
    const secondBody = await second.json<{
      data: { items: Array<{ id: string }> };
    }>();
    expect([firstBody.data.items[0]?.id, secondBody.data.items[0]?.id]).toEqual(
      [
        "thr_00000000-0000-4000-8000-0000000000b2",
        "thr_00000000-0000-4000-8000-0000000000b1",
      ],
    );

    const crossScope = await createProductApp().request(
      `/threads?projectId=${projectB.id}&cursor=${encodeURIComponent(firstBody.data.nextCursor)}`,
      {},
      bindings,
    );
    const crossScopeBody = JSON.stringify(await crossScope.json());
    expect(crossScopeBody).not.toContain(projectA.id);
  });

  it("defaults to 20 and returns a next cursor", async () => {
    await Promise.all(
      Array.from({ length: 21 }, (_, index) =>
        createProjectViaApi(`project-${index}`),
      ),
    );
    const list = await createProductApp().request("/projects", {}, bindings);
    const body = await list.json<{
      data: { items: Array<unknown>; nextCursor?: string };
    }>();
    expect(body.data.items).toHaveLength(20);
    expect(body.data.nextCursor).toBeDefined();
  });
});
