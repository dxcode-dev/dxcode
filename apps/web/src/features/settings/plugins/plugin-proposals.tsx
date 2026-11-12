import type { PluginProposalData } from "@dx/api";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Link, useRouterState } from "@tanstack/react-router";
import { KeyRound, Library, PlugZap } from "lucide-react";
import * as React from "react";
import type { PluginsTarget } from "../../../shared/api/client.js";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { SettingsCard } from "../settings-primitives.js";
import { changeItems, permissionItems } from "./plugin-bundle-changes.js";
import { PluginBundleGroup } from "./plugin-bundle-group.js";
import { BundleItems } from "./plugin-bundle-items.js";
import {
  type Decision,
  pluginProposalDecisionMutationOptions,
} from "./plugin-bundle-mutations.js";
import { errorMessage } from "./plugin-bundle-presentation.js";
import { PluginBundleSourceLine } from "./plugin-bundle-source.js";

function PluginProposalDialog({
  proposal,
  pending,
  error,
  onDecide,
  onClose,
}: {
  readonly proposal: PluginProposalData;
  readonly pending?: Decision | undefined;
  readonly error?: string | undefined;
  readonly onDecide: (decision: Decision) => void;
  readonly onClose: () => void;
}) {
  const { manifest } = proposal;
  const widens = proposal.permissions?.widens === true;
  return (
    <DialogRoot open onOpenChange={(open) => !open && onClose()}>
      <DialogContent className="plugin-bundle-dialog">
        <div className="plugin-bundle-form">
          <header>
            <DialogTitle>
              {proposal.change === "new"
                ? `Install ${manifest.displayName}?`
                : `Update ${manifest.displayName}?`}
            </DialogTitle>
            <PluginBundleSourceLine
              source={proposal.source}
              version={manifest.version}
            />
            <DialogDescription>
              dx proposed this in{" "}
              <Link
                to="/threads/$threadId"
                params={{ threadId: proposal.threadId }}
              >
                {proposal.threadTitle ?? "a Thread"}
              </Link>
              . Approving installs exactly this commit; new Threads load it.
            </DialogDescription>
          </header>
          {proposal.note === "" ? null : (
            <blockquote className="skill-proposal-note">
              {proposal.note}
            </blockquote>
          )}
          {proposal.change === "new" ? (
            <BundleItems
              skills={manifest.skills}
              mcpServers={manifest.mcpServers}
              code={manifest.code}
              skipped={manifest.skipped}
            />
          ) : (
            <div className="plugin-bundle-items">
              <PluginBundleGroup
                icon={<KeyRound aria-hidden="true" />}
                title="Permissions"
                items={permissionItems(proposal.permissions?.changes ?? [])}
              />
              <PluginBundleGroup
                icon={<Library aria-hidden="true" />}
                title="Skills"
                items={changeItems(proposal.skills ?? [])}
              />
              <PluginBundleGroup
                icon={<PlugZap aria-hidden="true" />}
                title="MCP servers"
                items={changeItems(proposal.mcpServers ?? [])}
              />
            </div>
          )}
          {widens ? (
            <p className="plugin-bundle-help plugin-bundle-warning" role="note">
              This version asks for more than you approved.
            </p>
          ) : null}
          {error === undefined ? null : (
            <p className="plugin-bundle-error" role="alert">
              {error}
            </p>
          )}
          <footer className="plugin-bundle-actions">
            <Button
              size="xs"
              variant="ghost"
              disabled={pending !== undefined}
              onClick={() => onDecide("reject")}
            >
              {pending === "reject" ? "Rejecting…" : "Reject"}
            </Button>
            <Button
              size="xs"
              disabled={pending !== undefined}
              onClick={() => onDecide("approve")}
            >
              {pending === "approve"
                ? "Approving…"
                : proposal.change === "new"
                  ? "Approve and install"
                  : "Approve and update"}
            </Button>
          </footer>
        </div>
      </DialogContent>
    </DialogRoot>
  );
}

/**
 * Plugin installs and updates dx proposed from Threads (plugin plan M5),
 * each waiting for a person who could install it. A review link
 * (`?proposal=`) opens its proposal until it is closed.
 */
export function PluginProposals({
  target,
  proposals,
  report,
}: {
  readonly target: PluginsTarget;
  readonly proposals: ReadonlyArray<PluginProposalData>;
  readonly report: (message: string) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const mutation = useMutation(
    pluginProposalDecisionMutationOptions(queryClient, identity.id, target),
  );
  const linked = useRouterState({
    select: (state) =>
      new URLSearchParams(state.location.searchStr).get("proposal") ??
      undefined,
  });
  const [open, setOpen] = React.useState<string>();
  const [dismissed, setDismissed] = React.useState<string>();
  const pending = mutation.isPending ? mutation.variables.decision : undefined;
  const error = mutation.isError ? errorMessage(mutation.error) : undefined;
  const reviewing = proposals.find(
    ({ id }) => id === (open ?? (linked === dismissed ? undefined : linked)),
  );
  const close = () => {
    setOpen(undefined);
    setDismissed(linked);
    // A decision still running keeps its result for the page message.
    if (!mutation.isPending) mutation.reset();
  };
  const onDecide = (proposal: PluginProposalData, decision: Decision) =>
    mutation.mutate(
      { proposal, decision },
      {
        onSuccess: () => {
          close();
          report(
            decision === "reject"
              ? `Rejected dx's proposal for ${proposal.manifest.displayName}.`
              : proposal.change === "new"
                ? `${proposal.manifest.displayName} installed.`
                : `${proposal.manifest.displayName} updated.`,
          );
        },
      },
    );
  if (proposals.length === 0) return null;
  return (
    <section className="skill-proposals" aria-label="Proposed by dx">
      <h3>Proposed by dx</h3>
      <SettingsCard>
        {proposals.map((proposal) => (
          <div key={proposal.id} className="skill-row">
            <div className="skill-row-copy">
              <div className="skill-row-title">
                <strong>{proposal.manifest.displayName}</strong>
                <span>
                  {proposal.change === "new"
                    ? "Install"
                    : `Update${proposal.manifest.version === undefined ? "" : ` to ${proposal.manifest.version}`}`}
                </span>
                <span>from {proposal.threadTitle ?? "a Thread"}</span>
              </div>
              <p>{proposal.note || proposal.manifest.description}</p>
            </div>
            <Button
              size="xs"
              variant="outline"
              onClick={() => setOpen(proposal.id)}
            >
              Review
            </Button>
          </div>
        ))}
      </SettingsCard>
      {reviewing === undefined ? null : (
        <PluginProposalDialog
          proposal={reviewing}
          pending={pending}
          error={error}
          onDecide={(decision) => void onDecide(reviewing, decision)}
          onClose={close}
        />
      )}
    </section>
  );
}
