import type {
  NeedsYouAsk,
  NeedsYouItem,
  NeedsYouLink,
  NeedsYouRankedItem,
  NeedsYouRankingData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import { Check, ExternalLink, FileText, ListOrdered, X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { PageShell } from "../../shared/layout/page-shell.js";
import { Button } from "../../shared/ui/button.js";
import { issueIcon, pullIcon } from "../../shared/ui/github-status.js";
import { SettingsSelect } from "../../shared/ui/settings.js";
import { TimeText } from "../../shared/ui/time-text.js";
import {
  needsYouAsksQueryOptions,
  tickNeedsYouAskMutationOptions,
} from "../notifications/needs-you-asks-queries.js";
import {
  dismissNeedsYouMutationOptions,
  needsYouQueryOptions,
  needsYouRankingQueryOptions,
  rankNeedsYouMutationOptions,
} from "../notifications/needs-you-queries.js";
import { personalExperimentalFeaturesQueryOptions } from "../settings/experimental-features/experimental-features-queries.js";
// The page list and empty state are Your Reports' (bug-reports-*).
import "../threads/bug-reports/bug-reports.css";
import { age, exactTime } from "./inbox-time.js";
import { NEEDS_YOU_KIND } from "./needs-you-kind.js";
import "./needs-you-inbox.css";
import "./needs-you-page.css";

/** Where the ask's own link points, such as `github.com`. */
const linkHost = (url: string) => {
  const parsed = URL.parse(url);
  return parsed === null ? url : parsed.host;
};

/**
 * Whether a URL is the linked issue or PR: GitHub serves one number at both
 * `/issues/<n>` and `/pull/<n>`, so the repository and number decide.
 */
const sameGitHubItem = (
  link: { readonly repository: string; readonly number: number },
  url: string,
) => {
  const parsed = URL.parse(url);
  const path = parsed?.pathname.match(
    /^\/([^/]+\/[^/]+)\/(?:issues|pull)\/(\d+)/,
  );
  return (
    parsed?.host === "github.com" &&
    path?.[1]?.toLowerCase() === link.repository.toLowerCase() &&
    Number(path?.[2]) === link.number
  );
};

/** A linked issue or pull request, with its state icon. */
function GitHubLink({ link }: { readonly link: NeedsYouLink }) {
  return (
    <a
      className="needs-you-page-link"
      href={link.url}
      target="_blank"
      rel="noreferrer"
      title={
        link.title === undefined
          ? `${link.repository}#${link.number} (${link.state})`
          : `${link.title} (${link.state})`
      }
    >
      {link.kind === "pull"
        ? pullIcon(link.state)
        : issueIcon(link.state === "open" ? "open" : "closed")}
      {link.repository}#{link.number}
    </a>
  );
}

/** One ranked ask: its place, the Thread, why it matters, and its links. */
function RankedRow({
  item,
  rank,
  waiting,
  related,
}: {
  readonly item: NeedsYouRankedItem;
  readonly rank: number;
  readonly waiting: boolean;
  /** Other ranked asks that share its group's issue or pull request. */
  readonly related: number;
}) {
  return (
    <li
      className="needs-you-page-row"
      data-kind={item.kind}
      data-settled={waiting ? undefined : ""}
    >
      <span className="needs-you-kind needs-you-rank" aria-hidden>
        {rank}
      </span>
      <div className="needs-you-page-body">
        <div className="needs-you-page-heading">
          <Link
            to="/threads/$threadId"
            params={{ threadId: item.threadId }}
            className="needs-you-page-title"
          >
            {item.threadTitle}
          </Link>
        </div>
        {item.why === undefined ? null : (
          <p className="needs-you-page-ask">{item.why}</p>
        )}
        <div className="needs-you-page-meta">
          <span>{NEEDS_YOU_KIND[item.kind].label}</span>
          {item.projectName === "" ? null : <span>{item.projectName}</span>}
          {waiting ? null : <span>No longer waiting</span>}
          {item.links.map((link) => (
            <GitHubLink key={`${link.repository}#${link.number}`} link={link} />
          ))}
          {related === 0 ? null : (
            <span title={item.group}>
              Related to {related} other {related === 1 ? "ask" : "asks"}
            </span>
          )}
        </div>
      </div>
    </li>
  );
}

/**
 * Prioritize's result: the last saved ranking with when and what ranked it,
 * the model picker, and any failure in words.
 */
function PrioritySection({
  data,
  waiting,
  model,
  onModelChange,
  pending,
  error,
}: {
  readonly data: NeedsYouRankingData | undefined;
  readonly waiting: ReadonlySet<string>;
  readonly model: string | undefined;
  readonly onModelChange: (model: string) => void;
  readonly pending: boolean;
  readonly error: string | undefined;
}) {
  const ranking = data?.ranking;
  const models = data?.models ?? [];
  return (
    <section className="needs-you-page-section" aria-label="Priority">
      <header className="needs-you-page-section-header">
        <h2>Priority</h2>
        <span className="needs-you-page-section-meta">
          {pending ? (
            "Ranking…"
          ) : ranking === undefined ? (
            "Prioritize ranks what to unblock first."
          ) : (
            <>
              Ranked{" "}
              <time
                dateTime={ranking.rankedAt}
                title={exactTime.format(new Date(ranking.rankedAt))}
              >
                <TimeText text={(now) => age(ranking.rankedAt, now)} />
              </time>{" "}
              with {ranking.modelName}
            </>
          )}
        </span>
        {models.length > 1 && model !== undefined ? (
          <SettingsSelect
            label="Model to rank with"
            value={model}
            disabled={pending}
            onValueChange={onModelChange}
            options={models.map(({ model: value, name, connectionName }) => [
              value,
              `${name} · ${connectionName}`,
            ])}
          />
        ) : null}
      </header>
      {error === undefined ? null : (
        <p className="needs-you-page-error" role="alert">
          {error}
        </p>
      )}
      {ranking === undefined ? null : (
        <ol className="bug-reports-list" aria-label="Ranked asks">
          {ranking.items.map((item, index) => (
            <RankedRow
              key={item.threadId}
              item={item}
              rank={index + 1}
              waiting={waiting.has(item.threadId)}
              related={
                item.group === undefined
                  ? 0
                  : ranking.items.filter(({ group }) => group === item.group)
                      .length - 1
              }
            />
          ))}
        </ol>
      )}
    </section>
  );
}

const featureEnabled = (
  flags: ReadonlyArray<{
    readonly registration: { readonly id: string };
    readonly effectiveEnabled: boolean;
  }>,
  id: "needs-you-prioritize" | "artifact-asks",
) =>
  flags.some(
    ({ registration, effectiveEnabled }) =>
      registration.id === id && effectiveEnabled,
  );

/** Prioritize's state: the flag, the saved ranking, and Re-rank. */
function usePrioritize(userId: UserId) {
  const queryClient = useQueryClient();
  const features = useQuery(personalExperimentalFeaturesQueryOptions(userId));
  const enabled =
    features.data !== undefined &&
    featureEnabled(features.data.flags, "needs-you-prioritize");
  const ranking = useQuery(needsYouRankingQueryOptions(userId, enabled));
  const rank = useMutation(rankNeedsYouMutationOptions(queryClient, userId));
  const [picked, setPicked] = React.useState<string | undefined>(undefined);
  const models = ranking.data?.models ?? [];
  const model = models.some(({ model: value }) => value === picked)
    ? picked
    : ranking.data?.defaultModel;
  return {
    enabled,
    data: ranking.data,
    model,
    setModel: setPicked,
    pending: rank.isPending,
    error:
      rank.error instanceof Error
        ? rank.error.message
        : ranking.error instanceof Error
          ? ranking.error.message
          : undefined,
    run: () => rank.mutate(model),
  };
}

/** Asks in artifacts: the flag, the person's open asks, and Tick. */
function useArtifactAsks(userId: UserId) {
  const queryClient = useQueryClient();
  const features = useQuery(personalExperimentalFeaturesQueryOptions(userId));
  const enabled =
    features.data !== undefined &&
    featureEnabled(features.data.flags, "artifact-asks");
  const asks = useQuery(needsYouAsksQueryOptions(userId, enabled));
  const tick = useMutation(tickNeedsYouAskMutationOptions(queryClient, userId));
  return {
    enabled,
    asks: asks.data ?? [],
    tick: (ask: NeedsYouAsk) => tick.mutate(ask),
    error: tick.error instanceof Error ? tick.error.message : undefined,
  };
}

/** An ask's text with each mention chip read as `@Name`. */
const askText = (text: string) =>
  text.replace(/@\[([^\]\n]+)\]\((?:user:[A-Za-z0-9_-]+|agent)\)/g, "@$1");

/** One ask in an artifact: its item, Thread and artifact, age, and Tick. */
function ArtifactAskRow({
  ask,
  onTick,
}: {
  readonly ask: NeedsYouAsk;
  readonly onTick: (ask: NeedsYouAsk) => void;
}) {
  const since = new Date(ask.waitingSince).toISOString();
  return (
    <li className="needs-you-page-row" data-kind="ask">
      <span className="needs-you-kind" title="Ask in an artifact">
        <FileText aria-hidden />
      </span>
      <div className="needs-you-page-body">
        <div className="needs-you-page-heading">
          <Link
            to="/threads/$threadId"
            params={{ threadId: ask.threadId }}
            search={{ artifact: ask.artifactId }}
            className="needs-you-page-title"
          >
            {ask.artifactTitle}
          </Link>
          <time
            dateTime={since}
            title={`Waiting since ${exactTime.format(new Date(since))}`}
          >
            <TimeText text={(now) => age(since, now)} />
          </time>
        </div>
        <p className="needs-you-page-ask">{askText(ask.text)}</p>
        <div className="needs-you-page-meta">
          <span>{ask.threadTitle}</span>
        </div>
      </div>
      {ask.canTick ? (
        <button
          type="button"
          className="needs-you-action"
          aria-label={`Tick ${askText(ask.text)}`}
          title="Tick"
          onClick={() => onTick(ask)}
        >
          <Check />
        </button>
      ) : null}
    </li>
  );
}

/** One waiting ask: the Thread, its ask, and what it links to. */
function NeedsYouPageRow({
  item,
  onDismiss,
}: {
  readonly item: NeedsYouItem;
  readonly onDismiss: (item: NeedsYouItem) => void;
}) {
  const kind = NEEDS_YOU_KIND[item.kind];
  const Icon = kind.icon;
  const links = item.links ?? [];
  // The ask's own link, unless it is one of the linked issues or PRs.
  const askLink =
    item.url === undefined ||
    links.some((link) => sameGitHubItem(link, item.url ?? ""))
      ? undefined
      : item.url;
  return (
    <li className="needs-you-page-row" data-kind={item.kind}>
      <span className="needs-you-kind" title={kind.label}>
        <Icon aria-hidden />
      </span>
      <div className="needs-you-page-body">
        <div className="needs-you-page-heading">
          <Link
            to="/threads/$threadId"
            params={{ threadId: item.threadId }}
            className="needs-you-page-title"
          >
            {item.threadTitle}
          </Link>
          <time
            dateTime={item.requestedAt}
            title={`Waiting since ${exactTime.format(new Date(item.requestedAt))}`}
          >
            <TimeText text={(now) => age(item.requestedAt, now)} />
          </time>
        </div>
        <p className="needs-you-page-ask">
          {item.summary ?? "The last turn failed."}
        </p>
        <div className="needs-you-page-meta">
          <span>{kind.label}</span>
          {item.projectName === "" ? null : <span>{item.projectName}</span>}
          {links.map((link) => (
            <GitHubLink key={`${link.repository}#${link.number}`} link={link} />
          ))}
          {askLink === undefined ? null : (
            <a
              className="needs-you-page-link"
              href={askLink}
              target="_blank"
              rel="noreferrer"
              title={askLink}
            >
              <ExternalLink aria-hidden />
              {linkHost(askLink)}
            </a>
          )}
        </div>
      </div>
      <button
        type="button"
        className="needs-you-action"
        aria-label={`Dismiss ${item.threadTitle}`}
        title="Dismiss"
        onClick={() => onDismiss(item)}
      >
        <X />
      </button>
    </li>
  );
}

/**
 * `/needs-you`: every Thread that waits on the person, newest ask first,
 * with its project, kind, linked issues and pull requests, and how long it
 * has waited. A Thread leaves when its next turn starts or on Dismiss.
 */
export function NeedsYouPage() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const list = useQuery(needsYouQueryOptions(identity.id));
  const dismiss = useMutation(
    dismissNeedsYouMutationOptions(queryClient, identity.id),
  );
  const items = list.data?.items ?? [];
  const prioritize = usePrioritize(identity.id);
  const asks = useArtifactAsks(identity.id);
  const ranked = prioritize.data?.ranking !== undefined;
  const asksSection =
    asks.enabled && asks.asks.length > 0 ? (
      <>
        <h2 className="needs-you-page-all">Asks in artifacts</h2>
        {asks.error === undefined ? null : (
          <p className="needs-you-page-error" role="alert">
            {asks.error}
          </p>
        )}
        <ul className="bug-reports-list" aria-label="Asks in artifacts">
          {asks.asks.map((ask) => (
            <ArtifactAskRow
              key={`${ask.artifactId}:${ask.itemKey}`}
              ask={ask}
              onTick={asks.tick}
            />
          ))}
        </ul>
      </>
    ) : null;
  return (
    <PageShell
      actions={
        prioritize.enabled ? (
          <Button
            type="button"
            size="xs"
            disabled={prioritize.pending || items.length === 0}
            onClick={prioritize.run}
          >
            <ListOrdered aria-hidden />
            {prioritize.pending
              ? "Ranking…"
              : ranked
                ? "Re-rank"
                : "Prioritize"}
          </Button>
        ) : undefined
      }
      title={
        <strong className="needs-you-page-heading-title">
          Needs you
          {list.isSuccess ? (
            <span className="notification-count">
              {items.length + (asks.enabled ? asks.asks.length : 0)}
            </span>
          ) : null}
        </strong>
      }
      contentClassName="bug-reports-content"
    >
      {list.isPending ? (
        <DxLoading label="Loading what waits on you…" />
      ) : list.isError && items.length === 0 ? (
        <div className="empty-state bug-reports-empty" role="alert">
          <strong>Needs you could not be loaded.</strong>
        </div>
      ) : items.length === 0 && asksSection !== null ? (
        asksSection
      ) : items.length === 0 ? (
        <div className="empty-state bug-reports-empty">
          <strong>Nothing waits on you</strong>
          <span>
            Threads that wait on your answer, approval, or a failed turn show up
            here.
          </span>
        </div>
      ) : (
        <>
          {asksSection}
          {prioritize.enabled ? (
            <PrioritySection
              data={prioritize.data}
              waiting={new Set(items.map(({ threadId }) => threadId))}
              model={prioritize.model}
              onModelChange={prioritize.setModel}
              pending={prioritize.pending}
              error={prioritize.error}
            />
          ) : null}
          {prioritize.enabled || asksSection !== null ? (
            <h2 className="needs-you-page-all">All asks</h2>
          ) : null}
          <ul className="bug-reports-list" aria-label="Needs you">
            {items.map((item) => (
              <NeedsYouPageRow
                key={item.threadId}
                item={item}
                onDismiss={(dismissed) => dismiss.mutate(dismissed.threadId)}
              />
            ))}
          </ul>
        </>
      )}
    </PageShell>
  );
}
