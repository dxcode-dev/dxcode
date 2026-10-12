import { readFileSync } from "node:fs";
import { relative } from "node:path";
import {
  BaseSequencer,
  type TestSpecification,
  type Vitest,
} from "vitest/node";

const recordedSeconds: Readonly<Record<string, number>> = JSON.parse(
  readFileSync(new URL("./test-shard-weights.json", import.meta.url), "utf8"),
);

// Import and setup time per file, which recorded test durations leave out.
const fileOverheadSeconds = 0.85;

/**
 * Splits test files across `--shard` runs by recorded duration instead of
 * Vitest's equal-count hash split, so slow files (the dxd capture test builds
 * the daemon) land on the lightest shard. Every shard derives the same split
 * from the same file list, so each file runs exactly once. Refresh the
 * durations with `node scripts/update-test-shard-weights.mjs`.
 */
export class WeightedShardSequencer extends BaseSequencer {
  readonly #seconds: Readonly<Record<string, number>>;

  constructor(ctx: Vitest, seconds = recordedSeconds) {
    super(ctx);
    this.#seconds = seconds;
  }

  override async shard(files: TestSpecification[]) {
    const { index, count } = this.ctx.config.shard ?? { index: 1, count: 1 };
    const weighted = files
      .map((spec) => {
        const key = relative(this.ctx.config.root, spec.moduleId).replaceAll(
          "\\",
          "/",
        );
        return {
          spec,
          key,
          seconds: (this.#seconds[key] ?? 0) + fileOverheadSeconds,
        };
      })
      .toSorted(
        (a, b) =>
          b.seconds - a.seconds || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
      );
    const loads = Array.from({ length: count }, () => 0);
    const picked: TestSpecification[] = [];
    for (const file of weighted) {
      const lightest = loads.indexOf(Math.min(...loads));
      loads[lightest] = (loads[lightest] ?? 0) + file.seconds;
      if (lightest === index - 1) picked.push(file.spec);
    }
    return picked;
  }
}
