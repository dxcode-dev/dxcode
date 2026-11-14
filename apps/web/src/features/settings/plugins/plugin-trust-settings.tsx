import type { PluginBundleListData } from "@dx/api";
import {
  MAX_TRUSTED_PLUGIN_SIGNERS,
  PLUGIN_TIERS,
  type PluginTier,
} from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Checkbox } from "../../../shared/ui/checkbox.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Select } from "../../../shared/ui/select.js";
import { SettingsRow } from "../../../shared/ui/settings.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import type { BundleRun } from "./plugin-bundle-presentation.js";
import { plural } from "./plugin-bundle-presentation.js";
import { tierLabel } from "./plugin-trust-presentation.js";
import { allProjectsQueryOptions } from "./plugin-trust-queries.js";

type Trust = NonNullable<PluginBundleListData["pluginTrust"]>;

const FINGERPRINT = /^SHA256:[A-Za-z0-9+/]{43}$/;

const capDetail = {
  sandboxed: "Every plugin keeps today's limits and runs only on the Worker.",
  "personal-dev": "Members' own plugins get the rich features; installs don't.",
  "workspace-trusted":
    "Installed plugins get the rich features; none is verified.",
  verified: "No cap: signed plugins can be verified.",
} as const satisfies Record<PluginTier, string>;

/** The row's one-line summary of the workspace's plugin trust. */
const summary = (trust: Trust) =>
  [
    `Up to ${tierLabel[trust.tierCap]}`,
    trust.trustedProjectIds.length === 0
      ? undefined
      : plural(
          trust.trustedProjectIds.length,
          "trusted repository",
          "trusted repositories",
        ),
    trust.trustedSigners.length === 0
      ? undefined
      : plural(trust.trustedSigners.length, "trusted key", "trusted keys"),
  ]
    .filter((part) => part !== undefined)
    .join(" · ");

/**
 * The workspace admin's plugin trust: the highest tier any plugin gets,
 * the projects whose repository plugins are trusted, and the signing keys
 * that make a workspace install verified.
 */
export function PluginTrustSettings({
  trust,
  workspaceId,
  canMutate,
  busy,
  run,
  message,
}: {
  readonly trust: Trust;
  readonly workspaceId: string | undefined;
  readonly canMutate: boolean;
  readonly busy: boolean;
  readonly run: BundleRun;
  /** The page's latest outcome: after a failed save, why it failed. */
  readonly message: string | undefined;
}) {
  const [open, setOpen] = React.useState(false);
  const [failed, setFailed] = React.useState(false);
  const changeOpen = (next: boolean) => {
    setOpen(next);
    setFailed(false);
  };
  return (
    <>
      <SettingsRow
        title="Plugin trust"
        description={summary(trust)}
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={!canMutate || busy}
            onClick={() => changeOpen(true)}
          >
            Edit
          </Button>
        }
      />
      <DialogRoot open={open} onOpenChange={changeOpen}>
        {open ? (
          <DialogContent className="plugin-bundle-dialog">
            <PluginTrustForm
              trust={trust}
              workspaceId={workspaceId}
              busy={busy}
              error={
                failed ? (message ?? "Plugin trust was not saved.") : undefined
              }
              onSave={async (next) => {
                setFailed(false);
                const saved = await run(
                  {
                    type: "policy",
                    pluginTierCap: next.tierCap,
                    trustedPluginProjectIds: next.trustedProjectIds,
                    trustedPluginSigners: next.trustedSigners,
                  },
                  "Plugin trust updated.",
                );
                // A refused save keeps the dialog and its edits open.
                if (saved) changeOpen(false);
                else setFailed(true);
              }}
              onCancel={() => changeOpen(false)}
            />
          </DialogContent>
        ) : null}
      </DialogRoot>
    </>
  );
}

function PluginTrustForm({
  trust,
  workspaceId,
  busy,
  error,
  onSave,
  onCancel,
}: {
  readonly trust: Trust;
  readonly workspaceId: string | undefined;
  readonly busy: boolean;
  readonly error: string | undefined;
  readonly onSave: (trust: Trust) => Promise<void>;
  readonly onCancel: () => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  // Every page, so each trusted repository is listed and can be removed.
  const projects = useQuery(allProjectsQueryOptions(identity.id));
  const repositories = (projects.data ?? []).filter(
    (project) =>
      project.workspaceId === workspaceId && project.repository !== undefined,
  );
  // Trusted projects this admin cannot open still show, so they can go.
  const unlisted = projects.isSuccess
    ? trust.trustedProjectIds.filter(
        (projectId) => !repositories.some(({ id }) => id === projectId),
      )
    : [];
  const toggle = (projectId: string, checked: boolean) => {
    const next = new Set(trusted);
    if (checked) next.add(projectId);
    else next.delete(projectId);
    setTrusted(next);
  };
  const [cap, setCap] = React.useState<PluginTier>(trust.tierCap);
  const [trusted, setTrusted] = React.useState(
    () => new Set(trust.trustedProjectIds),
  );
  const [signers, setSigners] = React.useState(() =>
    trust.trustedSigners.join("\n"),
  );
  const keys = signers
    .split(/\s+/)
    .map((key) => key.trim())
    .filter((key) => key !== "");
  const badKey = keys.find((key) => !FINGERPRINT.test(key));
  const uniqueKeys = [...new Set(keys)];
  // The policy holds at most this many; the server refuses more.
  const keyProblem =
    badKey !== undefined
      ? `${badKey.slice(0, 24)}… is not a SHA256 key fingerprint.`
      : uniqueKeys.length > MAX_TRUSTED_PLUGIN_SIGNERS
        ? `At most ${MAX_TRUSTED_PLUGIN_SIGNERS} keys (${uniqueKeys.length} entered).`
        : undefined;
  const id = React.useId();
  return (
    <form
      className="plugin-bundle-form plugin-trust-form"
      onSubmit={(event) => {
        event.preventDefault();
        if (keyProblem !== undefined) return;
        void onSave({
          tierCap: cap,
          trustedProjectIds: [...trusted],
          trustedSigners: uniqueKeys,
        });
      }}
    >
      <header>
        <DialogTitle>Plugin trust</DialogTitle>
        <DialogDescription>
          A plugin gets the lower of the tier it asks for and what its install
          earns. Features above its tier are left out, not refused.
        </DialogDescription>
      </header>
      <div className="plugin-trust-field">
        <label htmlFor={`${id}-cap`}>Highest tier</label>
        <Select
          id={`${id}-cap`}
          value={cap}
          onValueChange={(value) => setCap(value as PluginTier)}
          options={[...PLUGIN_TIERS]
            .reverse()
            .map((tier) => [tier, tierLabel[tier]] as const)}
        />
        <span>{capDetail[cap]}</span>
      </div>
      <fieldset className="plugin-trust-field">
        <legend>Trusted repositories</legend>
        <span>
          Plugins these projects' repositories carry run workspace trusted
          instead of sandboxed.
        </span>
        {projects.isPending ? (
          <span>Loading projects…</span>
        ) : projects.isError ? (
          <span role="alert">Projects could not load.</span>
        ) : repositories.length === 0 && unlisted.length === 0 ? (
          <span>No workspace project has a repository.</span>
        ) : (
          <ul className="plugin-trust-projects">
            {repositories.map((project) => (
              <li key={project.id}>
                <label>
                  <Checkbox
                    checked={trusted.has(project.id)}
                    onChange={(event) =>
                      toggle(project.id, event.target.checked)
                    }
                  />
                  <span>{project.name}</span>
                  <code>{project.repository?.fullName}</code>
                </label>
              </li>
            ))}
            {unlisted.map((projectId) => (
              <li key={projectId}>
                <label>
                  <Checkbox
                    checked={trusted.has(projectId)}
                    onChange={(event) =>
                      toggle(projectId, event.target.checked)
                    }
                  />
                  <span>A project you cannot open</span>
                  <code>{projectId}</code>
                </label>
              </li>
            ))}
          </ul>
        )}
      </fieldset>
      <div className="plugin-trust-field">
        <label htmlFor={`${id}-keys`}>Trusted signing keys</label>
        <Textarea
          id={`${id}-keys`}
          mono
          rows={3}
          spellCheck={false}
          placeholder="SHA256:…"
          value={signers}
          aria-invalid={keyProblem === undefined ? undefined : true}
          onChange={(event) => setSigners(event.target.value)}
        />
        <span role={keyProblem === undefined ? undefined : "alert"}>
          {keyProblem ??
            "One fingerprint per line. Workspace installs signed by one of these keys are verified."}
        </span>
      </div>
      {error === undefined ? null : (
        <p className="plugin-trust-error" role="alert">
          {error}
        </p>
      )}
      <footer className="plugin-bundle-actions">
        <Button size="xs" variant="ghost" type="button" onClick={onCancel}>
          Cancel
        </Button>
        <Button
          size="xs"
          type="submit"
          disabled={busy || keyProblem !== undefined}
        >
          Save
        </Button>
      </footer>
    </form>
  );
}
