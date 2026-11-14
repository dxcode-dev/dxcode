import type { PluginIconSetData, PluginJobData, PluginJobsData } from "@dx/api";
import type { PluginId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
// Clock already ships with the first load; a new icon would add to it.
import { Clock } from "lucide-react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { Button } from "../../../shared/ui/button.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import { errorMessage } from "./plugin-bundle-presentation.js";
import {
  pluginJobActionMutationOptions,
  pluginJobsQueryOptions,
} from "./plugin-jobs-queries.js";

/**
 * A plugin's background jobs and live connections, run by its Durable
 * Object host: each job with its schedule, its next run, and Stop or Start.
 * Shown only for a plugin whose manifest declares jobs.
 */
export function PluginJobs({
  target,
  pluginId,
  plugin,
  declaredJobs,
}: {
  readonly target: PluginsTarget;
  readonly pluginId: PluginId;
  /** The plugin, for each row's icon. */
  readonly plugin: {
    readonly name: string;
    readonly icon: PluginIconSetData | undefined;
    readonly legacySrc: string | undefined;
  };
  /** The jobs the manifest declares. */
  readonly declaredJobs: ReadonlyArray<{
    readonly id: string;
    readonly title: string;
    readonly schedule: { readonly at?: string } | object;
  }>;
}) {
  const query = useQuery(pluginJobsQueryOptions(target, pluginId));
  if (query.isPending)
    return (
      <section
        className="plugin-bundle-group plugin-bundle-settings plugin-jobs"
        aria-label="Background jobs"
        aria-busy="true"
      >
        {header()}
        <p className="plugin-bundle-help">Loading jobs…</p>
      </section>
    );
  if (query.isError)
    return (
      <p className="plugin-bundle-error" role="alert">
        {errorMessage(query.error)}
      </p>
    );
  // On-demand jobs a Thread's object lists but never ran say nothing a
  // person acts on; each shows once, from the manifest, as "On demand".
  const listed = new Set(
    query.data.jobs.flatMap((job) =>
      job.threadId === undefined ? [job.id] : [],
    ),
  );
  const onDemand = declaredJobs.filter(
    (job) => "at" in job.schedule && !listed.has(job.id),
  );
  const data = {
    ...query.data,
    jobs: query.data.jobs.filter(
      (job) =>
        !(
          job.status === "done" &&
          job.lastRunAt === undefined &&
          job.threadId !== undefined
        ),
    ),
  };
  const active = data.jobs.filter(
    ({ status }) => status === "scheduled" || status === "running",
  ).length;
  return (
    <section
      className="plugin-bundle-group plugin-bundle-settings plugin-jobs"
      aria-label="Background jobs"
    >
      {header(
        data.available
          ? `${active} of ${data.jobLimit} running`
          : plural(declaredJobs.length, "job"),
      )}
      {data.available ? null : (
        <p className="plugin-bundle-help plugin-jobs-blocked">
          {data.reason === "blocked-tier"
            ? "Needs workspace trust. This install runs sandboxed, so its jobs, storage, and watches are off."
            : "This deployment does not run plugin jobs."}
        </p>
      )}
      <JobList
        target={target}
        pluginId={pluginId}
        plugin={plugin}
        data={data}
      />
      {onDemand.length === 0 ? null : (
        <ul aria-label="On-demand jobs">
          {onDemand.map((job) => (
            <li key={job.id} className="plugin-job">
              <PluginIcon
                name={plugin.name}
                icon={plugin.icon}
                legacySrc={plugin.legacySrc}
                size={20}
                className="plugin-job-icon"
              />
              <div className="plugin-job-main">
                <strong>{job.title}</strong>
                <span>On demand: runs when the plugin starts it</span>
              </div>
            </li>
          ))}
        </ul>
      )}
      {data.watches.length === 0 ? null : (
        <ul className="plugin-jobs-watches" aria-label="Live connections">
          {data.watches.map((watch) => (
            <li key={`${watch.target}:${watch.connectedAt}`}>
              <span aria-hidden="true" className="plugin-jobs-live" />
              {watch.target === "" ? (
                <code>Live connection</code>
              ) : (
                <code title={watch.target}>{hostOf(watch.target)}</code>
              )}
              <span>
                {plural(watch.messages, "message")}
                {watch.dropped > 0 ? `, ${watch.dropped} dropped` : ""}
              </span>
            </li>
          ))}
        </ul>
      )}
      {data.available ? (
        <p className="plugin-bundle-help plugin-jobs-storage">
          Storage: {bytes(data.storage.sqlBytes)} SQL,{" "}
          {bytes(data.storage.blobBytes)} files
        </p>
      ) : null}
    </section>
  );
}

const header = (count?: string) => (
  <h3>
    <Clock aria-hidden="true" />
    <span>Background jobs</span>
    {count === undefined ? null : (
      <span className="plugin-bundle-count">{count}</span>
    )}
  </h3>
);

function JobList({
  target,
  pluginId,
  plugin,
  data,
}: {
  readonly target: PluginsTarget;
  readonly pluginId: PluginId;
  readonly plugin: Parameters<typeof PluginJobs>[0]["plugin"];
  readonly data: PluginJobsData;
}) {
  const queryClient = useQueryClient();
  const action = useMutation(
    pluginJobActionMutationOptions(queryClient, target, pluginId),
  );
  const pendingKey =
    action.isPending && action.variables !== undefined
      ? `${action.variables.threadId ?? ""}/${action.variables.jobId}`
      : undefined;
  return (
    <>
      <ul>
        {data.jobs.map((job) => {
          const key = `${job.threadId ?? ""}/${job.id}`;
          const running =
            job.status === "scheduled" || job.status === "running";
          const startable =
            job.status === "stopped" && job.schedule.at === undefined;
          return (
            <li key={key} className="plugin-job" data-status={job.status}>
              <PluginIcon
                name={plugin.name}
                icon={plugin.icon}
                legacySrc={plugin.legacySrc}
                size={20}
                className="plugin-job-icon"
              />
              <div className="plugin-job-main">
                <strong>{job.title}</strong>
                <span>
                  {scheduleText(job)}
                  {job.threadId === undefined
                    ? ""
                    : ` · ${job.threadTitle ?? "a member's Thread"}`}
                </span>
              </div>
              <em className="plugin-bundle-status-pill" data-tone={tone(job)}>
                {statusText(job)}
              </em>
              {data.available && data.canMutate && (running || startable) ? (
                <Button
                  size="xs"
                  variant={running ? "outline" : "ghost"}
                  disabled={pendingKey === key}
                  aria-label={`${running ? "Stop" : "Start"} ${job.title}`}
                  onClick={() =>
                    action.mutate({
                      action: running ? "stop" : "start",
                      jobId: job.id,
                      ...(job.threadId === undefined
                        ? {}
                        : { threadId: job.threadId }),
                    })
                  }
                >
                  {pendingKey === key
                    ? running
                      ? "Stopping…"
                      : "Starting…"
                    : running
                      ? "Stop"
                      : "Start"}
                </Button>
              ) : null}
            </li>
          );
        })}
      </ul>
      {action.isError ? (
        <p className="plugin-bundle-error" role="alert">
          {errorMessage(action.error)}
        </p>
      ) : null}
    </>
  );
}

const plural = (count: number, word: string) =>
  `${count.toLocaleString()} ${word}${count === 1 ? "" : "s"}`;

const timeFormat = new Intl.DateTimeFormat(undefined, {
  month: "short",
  day: "numeric",
  hour: "numeric",
  minute: "2-digit",
});

const scheduleText = (job: PluginJobData) =>
  job.schedule.every !== undefined
    ? `Every ${job.schedule.every}`
    : job.schedule.cron !== undefined
      ? `Cron ${job.schedule.cron} UTC`
      : typeof job.schedule.at === "number"
        ? "Once"
        : "On demand";

/** The job's state in words; a failed last run leads, so color is not the only sign. */
const statusText = (job: PluginJobData) => {
  const state = stateText(job);
  // A run in progress says more than how the last one ended.
  if (job.lastOutcome !== "failed" || job.status === "running") return state;
  return job.status === "scheduled" && job.nextRunAt !== undefined
    ? `Failed · next ${timeFormat.format(job.nextRunAt)}`
    : `Failed · ${state.charAt(0).toLowerCase()}${state.slice(1)}`;
};

const stateText = (job: PluginJobData) =>
  job.status === "running"
    ? "Running"
    : job.status === "scheduled"
      ? job.nextRunAt === undefined
        ? "Scheduled"
        : `Next ${timeFormat.format(job.nextRunAt)}`
      : job.status === "paused"
        ? "Paused: Thread archived"
        : job.status === "stopped"
          ? "Stopped"
          : job.lastRunAt === undefined
            ? "Not scheduled"
            : `Last ran ${timeFormat.format(job.lastRunAt)}`;

const tone = (job: PluginJobData) =>
  job.lastOutcome === "failed" && job.status !== "running"
    ? "removed"
    : job.status === "scheduled" || job.status === "running"
      ? "added"
      : undefined;

const hostOf = (target: string) => {
  try {
    return new URL(target).host;
  } catch {
    return target;
  }
};

const bytes = (count: number) =>
  count < 1_024
    ? `${count} B`
    : count < 1_048_576
      ? `${(count / 1_024).toFixed(1)} KB`
      : count < 1_073_741_824
        ? `${(count / 1_048_576).toFixed(1)} MB`
        : `${(count / 1_073_741_824).toFixed(2)} GB`;
