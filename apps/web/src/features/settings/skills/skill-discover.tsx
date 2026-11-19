import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ArrowLeft, Check, Download, Search, ShieldCheck } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { Card } from "../../../shared/ui/card.js";
import { CatalogRow } from "../../../shared/ui/catalog-row.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { FileTree } from "../../../shared/ui/file-tree.js";
import { FileView } from "../../../shared/ui/file-view.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { Input } from "../../../shared/ui/input.js";
import { Select } from "../../../shared/ui/select.js";
import {
  fileCount,
  installCount,
  lineCount,
  skillMarkdown,
  skillTreePaths,
} from "./skill-files.js";
import {
  skillErrorMessage,
  skillInstallMutationOptions,
} from "./skills-mutations.js";
import {
  cachedDirectoryInstalls,
  discoverQueryOptions,
  type SkillData,
  type SkillInstallSource,
  type SkillsTarget,
  sourcePreviewQueryOptions,
} from "./skills-queries.js";

/** A value that settles 300 ms after the last change, for a search box. */
const useSettledValue = () => {
  const [settled, setSettled] = React.useState("");
  const timer = React.useRef<ReturnType<typeof setTimeout>>(undefined);
  const update = (next: string) => {
    clearTimeout(timer.current);
    timer.current = setTimeout(() => setSettled(next), 300);
  };
  return [settled, update] as const;
};

export interface InstallTarget {
  readonly target: SkillsTarget;
  readonly label: string;
}

/**
 * One skill from skills.sh or GitHub before install: where to install it,
 * every file it carries, and what it can do.
 */
function SkillSourcePage({
  source,
  targets,
  installed,
  onBack,
}: {
  readonly source: SkillInstallSource;
  /** The scopes the person can install to, this page's scope first. */
  readonly targets: ReadonlyArray<InstallTarget>;
  /** This page's installed skills, to say when this one is one of them. */
  readonly installed: ReadonlyArray<SkillData>;
  readonly onBack: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const [targetIndex, setTargetIndex] = React.useState(0);
  const where = targets[targetIndex] ?? targets[0];
  const preview = useQuery(
    sourcePreviewQueryOptions(
      identity.id,
      where?.target ?? { scope: "personal" },
      source,
    ),
  );
  const [file, setFile] = React.useState("SKILL.md");
  const [done, setDone] = React.useState<InstallTarget>();
  const [failure, setFailure] = React.useState<string>();
  const install = useMutation(
    skillInstallMutationOptions(queryClient, identity.id),
  );
  const data = preview.data;
  // A GitHub install reads the commit the preview showed.
  const sourceToInstall: SkillInstallSource =
    source.kind === "github" && data?.commit !== undefined
      ? { ...source, commit: data.commit }
      : source;
  const back = (
    <Button
      className="skill-discover-back"
      variant="ghost"
      size="sm"
      onClick={onBack}
    >
      <ArrowLeft aria-hidden="true" /> Discover
    </Button>
  );
  if (data === undefined) {
    return (
      <div className="skill-discover-main">
        {back}
        <EmptyState
          title={
            preview.isError
              ? skillErrorMessage(preview.error)
              : "Reading the skill's files…"
          }
          busy={preview.isPending}
          tone={preview.isError ? "error" : undefined}
          action={
            preview.isError ? (
              <Button
                size="sm"
                variant="outline"
                onClick={() => preview.refetch()}
              >
                Retry
              </Button>
            ) : undefined
          }
        />
      </div>
    );
  }
  const repository =
    data.source.type === "github" ? data.source.repository : "";
  // Code the agent may run; schemas and docs under scripts/ do not count.
  const scripts = data.files.filter(({ path }) =>
    /\.(py|sh|bash|zsh|js|mjs|cjs|ts|rb|pl|ps1)$/i.test(path),
  ).length;
  const skillMd = skillMarkdown({
    name: data.manifest.name,
    description: data.manifest.description,
    instructions: data.instructions,
  });
  const open =
    file === "SKILL.md"
      ? { path: "SKILL.md", content: skillMd }
      : (data.files.find(({ path }) => path === file) ?? {
          path: "SKILL.md",
          content: skillMd,
        });
  const alreadyHere =
    data.installed !== undefined && data.installed.integrity === data.integrity;
  const updating = data.installed !== undefined && !alreadyHere;
  const installedHere = installed.some(
    ({ name }) => name === data.manifest.name,
  );
  const directoryInstalls =
    source.kind === "skills.sh"
      ? cachedDirectoryInstalls(queryClient, identity.id, source.id)
      : undefined;
  const runInstall = async () => {
    if (where === undefined) return;
    setFailure(undefined);
    const outcome = await settle(() =>
      install.mutateAsync({
        target: where.target,
        source: sourceToInstall,
        integrity: data.integrity,
      }),
    );
    install.reset();
    if (!outcome.ok) {
      setFailure(skillErrorMessage(outcome.error));
      return;
    }
    setDone(where);
  };
  const facts = (
    <dl className="skill-discover-facts">
      <div>
        <dt>Repository</dt>
        <dd>
          <a
            href={`https://github.com/${repository}${data.source.type === "github" && data.source.path ? `/tree/${data.commit ?? "HEAD"}/${data.source.path}` : ""}`}
            target="_blank"
            rel="noreferrer"
          >
            {repository}
          </a>
        </dd>
      </div>
      <div>
        <dt>Version</dt>
        <dd>
          {data.commit !== undefined ? (
            <code>{data.commit.slice(0, 7)}</code>
          ) : data.source.type === "github" &&
            data.source.registry?.hash !== undefined ? (
            <>
              skills.sh <code>{data.source.registry.hash.slice(0, 7)}</code>
            </>
          ) : (
            "Latest"
          )}
        </dd>
      </div>
      <div>
        <dt>What it can do</dt>
        <dd>
          <ul>
            <li>Instructions the agent follows with your rights</li>
            {scripts > 0 ? (
              <li>
                Carries {scripts} {scripts === 1 ? "script" : "scripts"} that
                run in the Orb
              </li>
            ) : (
              <li>No scripts</li>
            )}
          </ul>
        </dd>
      </div>
      {data.skipped.length === 0 ? null : (
        <div>
          <dt>Not installed</dt>
          <dd>
            <ul>
              {data.skipped.slice(0, 8).map(({ path, reason }) => (
                <li key={path}>
                  <code>{path}</code>: {reason}
                </li>
              ))}
            </ul>
          </dd>
        </div>
      )}
    </dl>
  );
  return (
    <div className="skill-discover-main">
      {back}
      <div className="skill-discover-page">
        <div className="skill-discover-main">
          <div className="skill-discover-title">
            <div>
              <h2>{data.manifest.name}</h2>
              <p className="skill-discover-muted">
                {repository}
                {directoryInstalls === undefined
                  ? ""
                  : ` · ${installCount(directoryInstalls)} installs`}
                {` · ${fileCount(data.files.length + 1)}`}
              </p>
            </div>
          </div>
          <p className="skill-discover-description">
            {data.manifest.description}
          </p>
          <Card variant="subtle" padding="md">
            {done !== undefined || (alreadyHere && installedHere) ? (
              <div className="skill-discover-install">
                <div>
                  <strong>
                    <Check
                      aria-hidden="true"
                      className="skill-discover-check"
                    />
                    Installed in {(done ?? where)?.label}
                  </strong>
                  <span className="skill-discover-muted">
                    New Threads load it in dx and Claude Code mode.
                  </span>
                </div>
              </div>
            ) : (
              <div className="skill-discover-install">
                <div>
                  <strong>{updating ? "Update" : "Install to"}</strong>
                  <span className="skill-discover-muted">
                    {updating
                      ? `Publishes these files as version ${(data.installed?.version ?? 0) + 1}. New Threads load it.`
                      : "Adds the skill and all its files, switched on. New Threads load it."}
                  </span>
                </div>
                {targets.length > 1 ? (
                  <Select
                    size="md"
                    aria-label="Install to"
                    value={String(targetIndex)}
                    onValueChange={(value) => setTargetIndex(Number(value))}
                    options={targets.map(({ label }, index) => [
                      String(index),
                      label,
                    ])}
                  />
                ) : null}
                <Button
                  size="sm"
                  busy={install.isPending}
                  disabled={install.isPending || where === undefined}
                  onClick={() => void runInstall()}
                >
                  {updating ? "Update" : "Install"}
                </Button>
              </div>
            )}
            {failure === undefined ? null : (
              <p className="skill-discover-failure" role="alert">
                {failure}
              </p>
            )}
          </Card>
          <div className="skill-discover-phone-facts">{facts}</div>
          <Card className="skill-discover-files">
            <FileTree
              label={`${data.manifest.name} files`}
              paths={skillTreePaths(data.files)}
              selectedPath={open.path}
              onSelect={setFile}
            />
            <FileView
              key={open.path}
              path={open.path}
              content={open.content}
              detail={lineCount(open.content)}
            />
          </Card>
        </div>
        <div className="skill-discover-side-facts">{facts}</div>
      </div>
    </div>
  );
}

/**
 * skills.sh in Settings → Skills: its most installed skills, or a search,
 * and a skill's page to review and install it.
 */
export function SkillDiscover({
  target,
  installed,
  targets,
  opened,
  onOpen,
  onFromGitHub,
}: {
  readonly target: SkillsTarget;
  readonly installed: ReadonlyArray<SkillData>;
  readonly targets: ReadonlyArray<InstallTarget>;
  readonly opened: SkillInstallSource | undefined;
  readonly onOpen: (source: SkillInstallSource | undefined) => void;
  readonly onFromGitHub: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const [query, setQuery] = useSettledValue();
  const [input, setInput] = React.useState("");
  const results = useQuery(discoverQueryOptions(identity.id, target, query));
  if (opened !== undefined) {
    return (
      <SkillSourcePage
        key={JSON.stringify(opened)}
        source={opened}
        targets={targets}
        installed={installed}
        onBack={() => onOpen(undefined)}
      />
    );
  }
  const items = results.data ?? [];
  const names = new Set(installed.map(({ name }) => name));
  return (
    <div className="skill-discover-main">
      <div className="skill-discover-toolbar">
        <label className="skill-browser-search skill-discover-search">
          <Search aria-hidden="true" />
          <Input
            variant="bare"
            type="search"
            placeholder="Search skills.sh"
            aria-label="Search skills.sh"
            value={input}
            onChange={(event) => {
              setInput(event.target.value);
              setQuery(event.target.value);
            }}
          />
        </label>
        <Button variant="outline" size="sm" onClick={onFromGitHub}>
          <GitHubIcon className="skill-discover-github" /> From GitHub URL
        </Button>
      </div>
      <h3 className="skill-discover-section">
        {query.trim().length < 2
          ? "Most installed on skills.sh"
          : results.isFetching && results.data === undefined
            ? "Searching…"
            : `${items.length} ${items.length === 1 ? "result" : "results"}`}
      </h3>
      {results.isError ? (
        <EmptyState
          tone="error"
          title={skillErrorMessage(results.error)}
          action={
            <Button
              size="sm"
              variant="outline"
              onClick={() => results.refetch()}
            >
              Retry
            </Button>
          }
        />
      ) : results.data === undefined ? (
        <EmptyState busy title="Loading skills.sh…" />
      ) : items.length === 0 ? (
        <EmptyState title={`No skill on skills.sh matches “${query}”.`} />
      ) : (
        <div className="skill-discover-catalog">
          {items.map((entry) => (
            <CatalogRow
              key={entry.id}
              title={entry.name}
              badge={
                names.has(entry.name) ? (
                  <Badge tone="success">Installed</Badge>
                ) : undefined
              }
              description={entry.description}
              stat={
                <>
                  <Download
                    aria-hidden="true"
                    className="skill-discover-stat"
                  />
                  {installCount(entry.installs)}
                </>
              }
              byline={entry.repository}
              onOpen={() => onOpen({ kind: "skills.sh", id: entry.id })}
            />
          ))}
        </div>
      )}
      <p className="skill-discover-note">
        <ShieldCheck aria-hidden="true" />
        Listed by skills.sh. Review a skill's files before you install it: its
        scripts run in your Orb.
      </p>
    </div>
  );
}

/** Asks for a public GitHub URL of a skill, then opens its page. */
export function GitHubSkillDialog({
  onOpen,
  onClose,
}: {
  readonly onOpen: (source: SkillInstallSource) => void;
  readonly onClose: () => void;
}) {
  const [url, setUrl] = React.useState("");
  const valid = /^https:\/\/(www\.)?github\.com\/[^/]+\/[^/]+/.test(url.trim());
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="skill-dialog">
        <DialogTitle>Install from GitHub</DialogTitle>
        <DialogDescription>
          Paste a public repository or folder that holds a <code>SKILL.md</code>
          . You review every file before installing.
        </DialogDescription>
        <form
          className="skill-github-form"
          onSubmit={(event) => {
            event.preventDefault();
            if (valid) onOpen({ kind: "github", url: url.trim() });
          }}
        >
          <Input
            autoFocus
            size="md"
            aria-label="GitHub URL"
            placeholder="https://github.com/anthropics/skills/tree/main/skills/pdf"
            value={url}
            onChange={(event) => setUrl(event.target.value)}
          />
          <footer className="skill-dialog-actions">
            <Button size="sm" variant="ghost" onClick={onClose}>
              Cancel
            </Button>
            <Button size="sm" type="submit" disabled={!valid}>
              Review files
            </Button>
          </footer>
        </form>
      </DialogContent>
    </DialogRoot>
  );
}
