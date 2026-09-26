import {
  normalizeUsageQuery,
  type Principal,
  type UsageQueryType,
  UsageRepository,
} from "@dx/domain";
import { Context, Effect, Layer } from "effect";

export const csvCell = (value: string | number) => {
  const text = String(value);
  return /[",\r\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};

export class PersonalUsageService extends Context.Service<
  PersonalUsageService,
  {
    readonly get: ReturnType<typeof makeGet>;
    readonly exportCsv: ReturnType<typeof makeExportCsv>;
  }
>()("@dx/core/settings/usage/PersonalUsageService") {
  static readonly layer = Layer.effect(
    PersonalUsageService,
    Effect.gen(function* () {
      const repository = yield* UsageRepository;
      return PersonalUsageService.of({
        get: makeGet(repository),
        exportCsv: makeExportCsv(repository),
      });
    }),
  );
}

const makeGet = (repository: UsageRepository["Service"]) =>
  Effect.fn("PersonalUsageService.get")(function* (
    principal: Principal,
    query: UsageQueryType,
  ) {
    const normalized = yield* normalizeUsageQuery(query);
    return yield* repository.dashboard(principal.userId, normalized);
  });

const makeExportCsv = (repository: UsageRepository["Service"]) =>
  Effect.fn("PersonalUsageService.exportCsv")(function* (
    principal: Principal,
    query: UsageQueryType,
  ) {
    const normalized = yield* normalizeUsageQuery({
      ...query,
      cursor: undefined,
      limit: 1,
    });
    const dashboard = yield* repository.dashboard(principal.userId, normalized);
    const header = [
      "day",
      "timezone",
      "total_tokens",
      "unknown_token_events",
      "estimated_cost_usd_micros",
      "unknown_cost_events",
      "average_latency_ms",
      "runner_lifecycle_duration_ms",
      "model_turns",
    ];
    const rows = dashboard.daily.map((day) => [
      day.day,
      dashboard.range.timezone,
      day.totalTokens,
      day.unknownTokenEvents,
      day.estimatedCostMicros,
      day.unknownCostEvents,
      day.averageLatencyMs ?? "unknown",
      day.runnerDurationMs,
      day.modelTurns,
    ]);
    return {
      filename: `dx-personal-usage-${dashboard.range.from}-${dashboard.range.to}.csv`,
      contentType: "text/csv;charset=utf-8" as const,
      content: [header, ...rows]
        .map((row) => row.map(csvCell).join(","))
        .join("\r\n"),
      rows: rows.length,
      timezone: dashboard.range.timezone,
      estimated: true as const,
    };
  });
