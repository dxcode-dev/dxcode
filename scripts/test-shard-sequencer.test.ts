import type { TestSpecification, Vitest } from "vitest/node";
import { describe, expect, it } from "vitest";
import { WeightedShardSequencer } from "./test-shard-sequencer.js";

const root = "/repo";

const shardsOf = async (
  files: ReadonlyArray<string>,
  count: number,
  weights: Readonly<Record<string, number>>,
) =>
  Promise.all(
    Array.from({ length: count }, async (_, index) => {
      const sequencer = new WeightedShardSequencer(
        { config: { root, shard: { index: index + 1, count } } } as Vitest,
        weights,
      );
      const picked = await sequencer.shard(
        files.map(
          (file) => ({ moduleId: `${root}/${file}` }) as TestSpecification,
        ),
      );
      return picked.map(({ moduleId }) => moduleId.slice(root.length + 1));
    }),
  );

describe("weighted test shards", () => {
  it("runs every file in exactly one shard, including unrecorded files", async () => {
    const files = Array.from({ length: 23 }, (_, i) => `apps/f${i}.test.ts`);
    const shards = await shardsOf(files, 4, {
      "apps/f3.test.ts": 9,
      "apps/f4.test.ts": 9,
    });
    expect(shards.flat().toSorted()).toEqual(files.toSorted());
  });

  it("keeps the slowest file from stacking onto a busy shard", async () => {
    const files = [
      "apps/core/src/slow.test.ts",
      ...Array.from({ length: 12 }, (_, i) => `apps/web/src/w${i}.test.ts`),
    ];
    const shards = await shardsOf(files, 4, {
      "apps/core/src/slow.test.ts": 60,
      ...Object.fromEntries(files.slice(1).map((file) => [file, 5])),
    });
    expect(shards.find((shard) => shard.includes(files[0] ?? ""))).toEqual([
      files[0],
    ]);
  });

  it("leaves extra shards empty when there are fewer files than shards", async () => {
    const shards = await shardsOf(["apps/a.test.ts"], 4, {});
    expect(shards.flat()).toEqual(["apps/a.test.ts"]);
  });
});
