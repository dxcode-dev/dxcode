import { useQuery } from "@tanstack/react-query";
import { ArrowLeft, Search, Trash2 } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { Card } from "../../../shared/ui/card.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { EmptyState } from "../../../shared/ui/empty-state.js";
import { FileTree } from "../../../shared/ui/file-tree.js";
import { FileView } from "../../../shared/ui/file-view.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsToggle } from "../settings-primitives.js";
import {
  fileCount,
  lineCount,
  skillMarkdown,
  skillOrigin,
  skillTreePaths,
} from "./skill-files.js";
import {
  type SkillData,
  type SkillsTarget,
  skillFileQueryOptions,
} from "./skills-queries.js";

/** Shown after the source line only when the skill is on but cannot load. */
const stateHint = (state: SkillData["effectiveState"]) =>
  state === "replaced-by-personal"
    ? "Replaced by your personal skill"
    : state === "blocked-by-policy"
      ? "Blocked by workspace policy"
      : state === "plugin-disabled"
        ? "Its plugin is off"
        : undefined;

/** Where the skill came from, and its version and size, under its name. */
function SkillMeta({ skill }: { readonly skill: SkillData }) {
  const source = skill.active.source;
  const repository = skillOrigin(source);
  const registry = source.type === "github" ? source.registry?.name : undefined;
  const hint = stateHint(skill.effectiveState);
  return (
    <div className="skill-browser-meta">
      {repository === undefined ? (
        <Badge>{source.label}</Badge>
      ) : (
        <a
          href={`https://github.com/${repository}${source.type === "github" && source.path ? `/tree/${source.commit ?? "HEAD"}/${source.path}` : ""}`}
          target="_blank"
          rel="noreferrer"
        >
          <GitHubIcon />
          {repository}
        </a>
      )}
      {registry === undefined ? null : <Badge>{registry}</Badge>}
      <Badge>Version {skill.activeVersion}</Badge>
      <Badge>{fileCount(skill.active.resources.length + 1)}</Badge>
      {hint === undefined ? null : <Badge tone="warning">{hint}</Badge>}
    </div>
  );
}

/** The open file: SKILL.md from the version, any other file from the API. */
function OpenFile({
  target,
  skill,
  path,
  onSave,
}: {
  readonly target: SkillsTarget;
  readonly skill: SkillData;
  readonly path: string;
  /** Publishes the edited file as the skill's next version. */
  readonly onSave?: (content: string) => Promise<unknown>;
}) {
  const { identity } = useAuthenticatedIdentity();
  const local =
    path === "SKILL.md"
      ? skillMarkdown({
          name: skill.name,
          description: skill.active.manifest.description,
          instructions: skill.active.instructions,
        })
      : undefined;
  const file = useQuery({
    ...skillFileQueryOptions(
      identity.id,
      target,
      skill.id,
      skill.activeVersion,
      path,
    ),
    enabled: local === undefined,
  });
  const content = local ?? file.data?.content;
  if (content === undefined) {
    return (
      <EmptyState
        className="skill-browser-file-state"
        title={file.isError ? "This file could not be loaded." : "Loading…"}
        busy={file.isPending}
        tone={file.isError ? "error" : undefined}
        action={
          file.isError ? (
            <Button size="sm" variant="outline" onClick={() => file.refetch()}>
              Retry
            </Button>
          ) : undefined
        }
      />
    );
  }
  return (
    <FileView
      key={`${skill.id}-${skill.activeVersion}-${path}`}
      path={path}
      content={content}
      detail={lineCount(content)}
      {...(onSave === undefined ? {} : { onSave })}
    />
  );
}

/**
 * Installed skills as a file browser: the skills by name on the left, the
 * chosen one's files below it in the trees library the Files pane uses, and
 * the open file on the right, editable in place. On a phone the list and the
 * skill are one screen each.
 */
export function SkillBrowser({
  target,
  skills,
  canMutate,
  toggling,
  empty,
  onToggle,
  onRemove,
  onSaveFile,
}: {
  readonly target: SkillsTarget;
  readonly skills: ReadonlyArray<SkillData>;
  readonly canMutate: boolean;
  readonly toggling: ReadonlySet<SkillData["id"]>;
  /** What the list shows when the scope has no skills. */
  readonly empty: React.ReactNode;
  readonly onToggle: (skill: SkillData, enabled: boolean) => void;
  readonly onRemove: (skill: SkillData) => Promise<boolean>;
  readonly onSaveFile: (
    skill: SkillData,
    path: string,
    content: string,
  ) => Promise<unknown>;
}) {
  const [filter, setFilter] = React.useState("");
  const [selectedId, setSelectedId] = React.useState<SkillData["id"]>();
  /** On a phone, whether the chosen skill's screen is showing. */
  const [opened, setOpened] = React.useState(false);
  const [files, setFiles] = React.useState<Record<string, string>>({});
  const [removing, setRemoving] = React.useState<SkillData>();
  const [removePending, setRemovePending] = React.useState(false);
  if (skills.length === 0) return <Card padding="md">{empty}</Card>;
  const shown = skills.filter(({ name }) =>
    name.includes(filter.trim().toLowerCase()),
  );
  const skill = skills.find(({ id }) => id === selectedId) ?? skills[0];
  if (skill === undefined) return null;
  const tree = skillTreePaths(skill.active.resources);
  const openPath = files[skill.id] ?? "SKILL.md";
  const choose = (path: string) =>
    setFiles((current) => ({ ...current, [skill.id]: path }));
  const fileTree = (className: string) => (
    <FileTree
      key={`${skill.id}-${skill.activeVersion}`}
      className={className}
      label={`${skill.name} files`}
      paths={tree}
      selectedPath={openPath}
      onSelect={choose}
    />
  );
  return (
    <Card className="skill-browser" data-opened={opened || undefined}>
      <div className="skill-browser-list">
        <label className="skill-browser-search">
          <Search aria-hidden="true" />
          <Input
            variant="bare"
            placeholder="Filter skills"
            aria-label="Filter skills"
            value={filter}
            onChange={(event) => setFilter(event.target.value)}
          />
        </label>
        {shown.map((item) => (
          <div key={item.id}>
            <button
              type="button"
              className="skill-browser-skill"
              aria-current={item.id === skill.id ? "true" : undefined}
              onClick={() => {
                setSelectedId(item.id);
                setOpened(true);
              }}
            >
              {item.name}
            </button>
            {item.id === skill.id ? fileTree("skill-browser-tree") : null}
          </div>
        ))}
        {shown.length === 0 ? (
          <p className="skill-browser-none">No skill matches “{filter}”.</p>
        ) : null}
      </div>
      <section className="skill-browser-detail" aria-label={skill.name}>
        <Button
          className="skill-browser-back"
          variant="ghost"
          size="sm"
          onClick={() => setOpened(false)}
        >
          <ArrowLeft aria-hidden="true" /> Skills
        </Button>
        <header className="skill-browser-header">
          <h2>{skill.name}</h2>
          <div className="skill-browser-actions">
            <span className="skill-browser-state">
              {skill.enabled ? "On" : "Off"}
              <SettingsToggle
                label={`Use ${skill.name}`}
                checked={skill.enabled}
                pending={toggling.has(skill.id)}
                disabled={!canMutate}
                onCheckedChange={(enabled) => onToggle(skill, enabled)}
              />
            </span>
            {canMutate ? (
              <Button
                variant="ghost"
                size="icon-sm"
                aria-label={`Remove ${skill.name}`}
                onClick={() => setRemoving(skill)}
              >
                <Trash2 aria-hidden="true" />
              </Button>
            ) : null}
          </div>
          <p className="skill-browser-description">
            {skill.active.manifest.description}
          </p>
          <SkillMeta skill={skill} />
        </header>
        {fileTree("skill-browser-phone-tree")}
        <OpenFile
          target={target}
          skill={skill}
          path={openPath}
          {...(canMutate
            ? {
                onSave: (content: string) =>
                  onSaveFile(skill, openPath, content),
              }
            : {})}
        />
      </section>
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) setRemoving(undefined);
        }}
        title={`Remove ${removing?.name ?? "this skill"}?`}
        description="New Threads stop loading it. Running Threads keep theirs."
        confirmLabel="Remove"
        destructive
        pending={removePending}
        onConfirm={() => {
          if (removing === undefined) return;
          setRemovePending(true);
          void onRemove(removing).then((done) => {
            setRemovePending(false);
            if (done) {
              setRemoving(undefined);
              setSelectedId(undefined);
              setOpened(false);
            }
          });
        }}
      />
    </Card>
  );
}
