import { execFile as execFileCallback } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import { deploymentSelection } from "../../../scripts/alchemy-deployment.mjs";
import { alchemyStage } from "../../../scripts/alchemy-stage.mjs";
import {
  percentageChange,
  type StartupClassification,
  type StartupEventRow,
  type StartupMetricReport,
  startupBaselineMetrics,
  startupBaselineOptions,
  startupBaselineQuery,
  startupMetricReport,
} from "./startup-baseline-contract.js";

const execFile = promisify(execFileCallback);

const options = startupBaselineOptions(process.argv.slice(2));

const since = options.get("since");
if (since === undefined || !Number.isFinite(Date.parse(since)))
  throw new Error("--since must be an ISO timestamp.");
const classification = options.get("classification");
if (classification !== "cold" && classification !== "warm")
  throw new Error("--classification must be cold or warm.");
const limit = Number(options.get("limit") ?? "100");
if (!Number.isInteger(limit) || limit < 1 || limit > 1_000)
  throw new Error("--limit must be an integer from 1 through 1000.");

const git = async (...args: ReadonlyArray<string>) =>
  (await execFile("git", [...args])).stdout.trim();
const branch = await git("branch", "--show-current");
const revision = await git("rev-parse", "HEAD");
const stage = alchemyStage(branch);
const { databaseName } = deploymentSelection({
  branch,
  stage,
  target: "branch",
});
const normalizedSince = new Date(since).toISOString();
const sql = startupBaselineQuery(normalizedSince, classification, limit);
const { stdout } = await execFile(
  "pnpm",
  [
    "--filter",
    "@dx/core",
    "exec",
    "wrangler",
    "d1",
    "execute",
    databaseName,
    "--remote",
    "--json",
    "--command",
    sql,
  ],
  { maxBuffer: 16 * 1_024 * 1_024 },
);
const queryResult: unknown = JSON.parse(stdout);
if (!Array.isArray(queryResult) || !Array.isArray(queryResult[0]?.results))
  throw new Error("Wrangler returned an unexpected D1 result.");
const rows = queryResult[0].results as ReadonlyArray<StartupEventRow>;
const metrics = Object.fromEntries(
  startupBaselineMetrics.map((metric) => [
    metric,
    startupMetricReport(rows, metric, classification, limit),
  ]),
) as Record<(typeof startupBaselineMetrics)[number], StartupMetricReport>;

const comparePath = options.get("compare");
const comparison =
  comparePath === undefined
    ? undefined
    : await readFile(comparePath, "utf8").then((content) => {
        const baseline = JSON.parse(content) as {
          readonly revision: string;
          readonly stage: string;
          readonly metrics: Record<string, StartupMetricReport>;
        };
        return {
          baselineRevision: baseline.revision,
          baselineStage: baseline.stage,
          metrics: Object.fromEntries(
            startupBaselineMetrics.map((metric) => {
              const before = baseline.metrics[metric];
              const current = metrics[metric];
              if (before === undefined)
                throw new Error(`Comparison report has no ${metric} metric.`);
              return [
                metric,
                {
                  p50ChangePercent: percentageChange(
                    before.p50Ms,
                    current.p50Ms,
                  ),
                  p95ChangePercent: percentageChange(
                    before.p95Ms,
                    current.p95Ms,
                  ),
                  successRateChangePercentagePoints:
                    (current.successRate - before.successRate) * 100,
                },
              ];
            }),
          ),
        };
      });

const report = {
  revision,
  stage,
  databaseName,
  classification: classification as StartupClassification,
  since: normalizedSince,
  generatedAt: new Date().toISOString(),
  metrics,
  comparison,
};
const serialized = `${JSON.stringify(report, null, 2)}\n`;
const output = options.get("output");
if (output === undefined) process.stdout.write(serialized);
else {
  await writeFile(output, serialized, { mode: 0o600 });
  process.stdout.write(`Wrote startup baseline report to ${output}\n`);
}
