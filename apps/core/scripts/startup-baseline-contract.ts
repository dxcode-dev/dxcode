export const startupBaselineMetrics = [
  "thread_create",
  "submission_admission",
  "scheduling",
  "source_backed_model_request",
  "source_backed_first_token",
] as const;

export type StartupBaselineMetric = (typeof startupBaselineMetrics)[number];
export type StartupClassification = "cold" | "warm";

export interface StartupEventRow {
  readonly journey: string;
  readonly request_id: string;
  readonly thread_id: string;
  readonly submission_id: string;
  readonly phase: string;
  readonly occurred_at: string;
  readonly outcome: "reached" | "failed" | "cancelled";
  readonly duration_ms: number;
}

export interface StartupBaselineSample {
  readonly requestId: string;
  readonly threadId: string;
  readonly submissionId?: string;
  readonly outcome: "reached" | "failed" | "cancelled";
  readonly durationMs: number;
  readonly completedAt: string;
}

export interface StartupMetricReport {
  readonly classification: StartupClassification;
  readonly rawSamples: ReadonlyArray<StartupBaselineSample>;
  readonly sampleCount: number;
  readonly reached: number;
  readonly successRate: number;
  readonly p50Ms?: number;
  readonly p95Ms?: number;
}

export const startupBaselineQuery = (
  since: string,
  classification: StartupClassification,
  limit: number,
) => {
  const priorSubmission = `${classification === "cold" ? "NOT " : ""}EXISTS (
                  SELECT 1
                    FROM startup_phase_event AS prior
                   WHERE prior.journey = 'submission'
                     AND prior.phase = 'request_admitted'
                     AND prior.thread_id = opening.thread_id
                     AND prior.occurred_at < opening.occurred_at
                )`;
  return `WITH eligible_submissions AS (
              SELECT journey, request_id, thread_id, submission_id, occurred_at
                FROM startup_phase_event AS opening
               WHERE journey = 'submission'
                 AND phase = 'request_admitted'
                 AND occurred_at >= '${since}'
                 AND ${priorSubmission}
               ORDER BY occurred_at DESC
               LIMIT ${limit}
            ), eligible_threads AS (
              SELECT journey, request_id, thread_id, submission_id
                FROM startup_phase_event
               WHERE journey = 'thread_create'
                 AND phase = 'request_admitted'
                 AND occurred_at >= '${since}'
                 AND '${classification}' = 'cold'
               ORDER BY occurred_at DESC
               LIMIT ${limit}
            ), selected AS (
              SELECT journey, request_id, thread_id, submission_id
                FROM eligible_submissions
              UNION ALL
              SELECT journey, request_id, thread_id, submission_id
                FROM eligible_threads
            ), selected_events AS (
              SELECT event.journey, event.request_id, event.thread_id,
                     event.submission_id, event.phase, event.occurred_at,
                     event.outcome, event.duration_ms
                FROM startup_phase_event AS event
                JOIN selected
                  ON selected.journey = event.journey
                 AND selected.request_id = event.request_id
                 AND selected.thread_id = event.thread_id
                 AND selected.submission_id = event.submission_id
            ), classification_history AS (
              SELECT prior.journey, prior.request_id, prior.thread_id,
                     prior.submission_id, prior.phase, prior.occurred_at,
                     prior.outcome, prior.duration_ms
                FROM startup_phase_event AS prior
               WHERE prior.journey = 'submission'
                 AND prior.phase = 'request_admitted'
                 AND EXISTS (
                   SELECT 1 FROM eligible_submissions AS eligible
                    WHERE eligible.thread_id = prior.thread_id
                      AND prior.occurred_at < eligible.occurred_at
                 )
                 AND prior.occurred_at = (
                   SELECT MIN(first.occurred_at)
                     FROM startup_phase_event AS first
                    WHERE first.journey = 'submission'
                      AND first.phase = 'request_admitted'
                      AND first.thread_id = prior.thread_id
                 )
            )
            SELECT * FROM selected_events
            UNION ALL
            SELECT * FROM classification_history
            ORDER BY occurred_at DESC`;
};

export const startupBaselineOptions = (rawArgs: ReadonlyArray<string>) => {
  const args = rawArgs[0] === "--" ? rawArgs.slice(1) : rawArgs;
  const options = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const name = args[index];
    const value = args[index + 1];
    if (name === undefined || value === undefined || !name.startsWith("--"))
      throw new Error(
        "Usage: startup-baseline --since <ISO> --classification <cold|warm> [--limit <n>] [--compare <report.json>] [--output <report.json>]",
      );
    options.set(name.slice(2), value);
  }
  return options;
};

const nearestRank = (values: ReadonlyArray<number>, percentile: number) => {
  if (values.length === 0) return undefined;
  const ordered = [...values].sort((left, right) => left - right);
  return ordered[Math.ceil(ordered.length * percentile) - 1];
};

const correlationKey = (row: StartupEventRow) =>
  [row.journey, row.request_id, row.thread_id, row.submission_id].join(
    "\u0000",
  );

const targetPhase = (metric: StartupBaselineMetric) => {
  switch (metric) {
    case "thread_create":
      return { journey: "thread_create", phase: "response_ready" };
    case "submission_admission":
      return { journey: "submission", phase: "submission_accepted" };
    case "scheduling":
      return { journey: "submission", phase: "flue_running" };
    case "source_backed_model_request":
      return { journey: "submission", phase: "model_requested" };
    case "source_backed_first_token":
      return { journey: "submission", phase: "model_first_token" };
  }
};

export const startupMetricReport = (
  rows: ReadonlyArray<StartupEventRow>,
  metric: StartupBaselineMetric,
  classification: StartupClassification,
  limit: number,
): StartupMetricReport => {
  const selection = targetPhase(metric);
  const grouped = new Map<string, Array<StartupEventRow>>();
  for (const row of rows) {
    if (row.journey !== selection.journey) continue;
    const key = correlationKey(row);
    const group = grouped.get(key) ?? [];
    group.push(row);
    grouped.set(key, group);
  }
  const firstSubmissionByThread = new Map<string, string>();
  if (selection.journey === "submission") {
    for (const [key, group] of grouped) {
      const opening = group.find(({ phase }) => phase === "request_admitted");
      if (opening === undefined) continue;
      const current = firstSubmissionByThread.get(opening.thread_id);
      if (
        current === undefined ||
        (grouped.get(current)?.find(({ phase }) => phase === "request_admitted")
          ?.occurred_at ?? "") > opening.occurred_at
      )
        firstSubmissionByThread.set(opening.thread_id, key);
    }
  }
  const samples: Array<StartupBaselineSample> = [];
  for (const [key, group] of grouped) {
    const opening = group.find(({ phase }) => phase === "request_admitted");
    if (opening === undefined) continue;
    if (selection.journey === "thread_create" && classification === "warm")
      continue;
    if (
      selection.journey === "submission" &&
      (firstSubmissionByThread.get(opening.thread_id) === key) !==
        (classification === "cold")
    )
      continue;
    const target = group.find(({ phase }) => phase === selection.phase);
    const terminal = group.find(
      ({ outcome }) => outcome === "failed" || outcome === "cancelled",
    );
    const completion = target ?? terminal;
    if (completion === undefined) continue;
    let durationMs = completion.duration_ms;
    if (metric.startsWith("source_backed_")) {
      const source = group.find(({ phase }) => phase === "source_activated");
      if (source?.outcome === "reached")
        durationMs = Math.max(
          0,
          Date.parse(completion.occurred_at) - Date.parse(source.occurred_at),
        );
    }
    samples.push({
      requestId: completion.request_id,
      threadId: completion.thread_id,
      ...(completion.submission_id === ""
        ? {}
        : { submissionId: completion.submission_id }),
      outcome: completion.outcome,
      durationMs,
      completedAt: completion.occurred_at,
    });
  }
  const rawSamples = samples
    .sort((left, right) => right.completedAt.localeCompare(left.completedAt))
    .slice(0, limit);
  const reachedSamples = rawSamples.filter(
    ({ outcome }) => outcome === "reached",
  );
  const durations = reachedSamples.map(({ durationMs }) => durationMs);
  return {
    classification,
    rawSamples,
    sampleCount: rawSamples.length,
    reached: reachedSamples.length,
    successRate:
      rawSamples.length === 0 ? 0 : reachedSamples.length / rawSamples.length,
    p50Ms: nearestRank(durations, 0.5),
    p95Ms: nearestRank(durations, 0.95),
  };
};

export const percentageChange = (
  baseline: number | undefined,
  current: number | undefined,
) =>
  baseline === undefined || current === undefined || baseline === 0
    ? undefined
    : ((current - baseline) / baseline) * 100;
