import {
  MAX_PROJECT_ORB_SCRIPT_BYTES,
  type ProjectId,
  type ProjectOrbScriptKind,
  type UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Link } from "@tanstack/react-router";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { SettingsCard } from "../../shared/ui/settings.js";
import { Textarea } from "../../shared/ui/textarea.js";
import { UnsavedChangesGuard } from "../../shared/ui/unsaved-changes-guard.js";
import {
  projectOrbScriptsQueryOptions,
  updateProjectOrbScriptMutationOptions,
} from "./project-orb-scripts-queries.js";

const SCRIPTS: ReadonlyArray<{
  readonly kind: ProjectOrbScriptKind;
  readonly title: string;
  readonly description: React.ReactNode;
}> = [
  {
    kind: "pre-clone",
    title: "Pre-clone Script",
    description: (
      <>
        Runs from <code>/home/user/workspace</code> before dx clones the
        repository. If it fails, the Orb stops before cloning.
      </>
    ),
  },
  {
    kind: "pre-setup",
    title: "Pre-setup Script",
    description: (
      <>
        Runs before <code>.agents/setup</code> and is not committed to the
        repository.
      </>
    ),
  },
  {
    kind: "desktop-resume",
    title: "Desktop Resume Script",
    description: (
      <>
        Runs from the repository root each time the Desktop starts, in place of
        the blank Chromium window, unless the repository contains{" "}
        <code>.agents/desktop/resume</code>. Open a page with{" "}
        <code>/opt/dx/desktop/chromium &lt;url&gt;</code>.
      </>
    ),
  },
];

const scriptBytes = (value: string) => new TextEncoder().encode(value).length;

type Drafts = Partial<Record<ProjectOrbScriptKind, string>>;

/**
 * The Project's Orb scripts, each with its own Save. They run in the Orb of
 * every Thread in the Project, so only people who manage it see this card.
 * Unsaved drafts live here so one guard covers both editors.
 */
export function ProjectOrbScriptsCard({
  projectId,
  userId,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
}) {
  const scripts = useQuery(projectOrbScriptsQueryOptions(userId, projectId));
  const [drafts, setDrafts] = React.useState<Drafts>({});
  const saved = (kind: ProjectOrbScriptKind) =>
    scripts.data?.scripts.find((script) => script.kind === kind)?.body ?? "";
  const dirty = SCRIPTS.some(
    ({ kind }) => drafts[kind] !== undefined && drafts[kind] !== saved(kind),
  );
  return (
    <SettingsCard
      className="project-orb-scripts-card"
      title="Orb Scripts"
      description={
        <>
          dx stores these scripts and runs them in the Orb of every Thread in
          this project. Anyone who can open the project can read them, so keep
          tokens and keys in{" "}
          <Link
            to="/projects/$projectId/settings/$section"
            params={{ projectId, section: "secrets" }}
          >
            Secrets &amp; Env Vars
          </Link>
          .
        </>
      }
      variant="outline"
    >
      {scripts.error ? (
        <p role="alert">Orb scripts could not be loaded.</p>
      ) : scripts.data === undefined ? (
        <p className="project-orb-scripts-state">Loading scripts…</p>
      ) : (
        SCRIPTS.map((script) => (
          <OrbScriptEditor
            key={script.kind}
            projectId={projectId}
            userId={userId}
            kind={script.kind}
            title={script.title}
            description={script.description}
            savedBody={saved(script.kind)}
            draft={drafts[script.kind] ?? saved(script.kind)}
            onDraftChange={(draft) =>
              setDrafts((current) => ({ ...current, [script.kind]: draft }))
            }
            onSaved={() =>
              setDrafts((current) => ({ ...current, [script.kind]: undefined }))
            }
          />
        ))
      )}
      <UnsavedChangesGuard dirty={dirty} onDiscard={() => setDrafts({})} />
    </SettingsCard>
  );
}

function OrbScriptEditor({
  projectId,
  userId,
  kind,
  title,
  description,
  savedBody,
  draft,
  onDraftChange,
  onSaved,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly kind: ProjectOrbScriptKind;
  readonly title: string;
  readonly description: React.ReactNode;
  readonly savedBody: string;
  readonly draft: string;
  readonly onDraftChange: (draft: string) => void;
  readonly onSaved: () => void;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    updateProjectOrbScriptMutationOptions(queryClient, userId, projectId, kind),
  );
  const id = React.useId();
  const tooLarge = scriptBytes(draft) > MAX_PROJECT_ORB_SCRIPT_BYTES;
  const error = tooLarge
    ? `Scripts are limited to ${MAX_PROJECT_ORB_SCRIPT_BYTES / 1024} KB.`
    : mutation.error instanceof Error
      ? mutation.error.message
      : undefined;
  // One row per script: the heading, description, and editor on the left,
  // Save at the bottom right.
  return (
    <form
      className="project-orb-script"
      aria-labelledby={`${id}-title`}
      onSubmit={(event) => {
        event.preventDefault();
        mutation.mutate(draft, { onSuccess: onSaved });
      }}
    >
      <div className="project-orb-script-body">
        <h4 id={`${id}-title`}>{title}</h4>
        <p id={`${id}-description`}>{description}</p>
        <Textarea
          className="project-orb-script-input"
          aria-label={title}
          aria-describedby={`${id}-description`}
          aria-invalid={tooLarge || undefined}
          value={draft}
          spellCheck={false}
          autoCapitalize="off"
          autoCorrect="off"
          placeholder={"#!/usr/bin/env bash\nset -euo pipefail"}
          disabled={mutation.isPending}
          onChange={(event) => onDraftChange(event.target.value)}
        />
        {error === undefined ? null : (
          <p className="project-orb-script-error" role="alert">
            {error}
          </p>
        )}
      </div>
      <div className="project-orb-script-actions">
        <Button
          size="xs"
          type="submit"
          disabled={draft === savedBody || tooLarge || mutation.isPending}
        >
          {mutation.isPending ? "Saving…" : "Save"}
        </Button>
      </div>
    </form>
  );
}
