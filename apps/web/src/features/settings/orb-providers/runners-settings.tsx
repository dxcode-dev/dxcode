import type { RunnerMachine } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import * as React from "react";
import { usePairThisMachine } from "../../../shared/native-shell/use-pair-this-machine.js";
import { runnerPlatform } from "../../../shared/runner-format.js";
import { AddRunnerDialog } from "../../../shared/ui/add-runner-dialog.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import { ConfirmDialog } from "../../../shared/ui/confirm-dialog.js";
import { SettingsCard, SettingsRow } from "../../../shared/ui/settings.js";
import { removeRunnerMutationOptions } from "../../runners/runners-mutations.js";
import {
  type AddRunnerSession,
  startAddRunnerSession,
  useRunners,
} from "../../runners/runners-queries.js";

const errorMessage = (error: unknown) =>
  error instanceof Error ? error.message : "Request failed.";

/**
 * Settings → Orb Providers → Runners: the person's paired machines, each
 * with Remove, and Add runner. Shown only while the runner provider is on.
 */
export function RunnersSettings({ userId }: { readonly userId: UserId }) {
  const queryClient = useQueryClient();
  const [adding, setAdding] = React.useState<AddRunnerSession>();
  const [removing, setRemoving] = React.useState<RunnerMachine>();
  const { list, pairing, connected } = useRunners(userId, { session: adding });
  const thisMachine = usePairThisMachine(pairing.data?.code);
  const remove = useMutation(removeRunnerMutationOptions(queryClient, userId));
  const runners = list.data?.runners;
  return (
    <SettingsCard
      title="Runners"
      description="Your own Macs and Linux machines that Threads can run on. Threads run as you, each in its own folder; only you get their Terminal and a Mac's Desktop."
      actions={
        <Button
          size="xs"
          variant="outline"
          type="button"
          onClick={() => setAdding(startAddRunnerSession(runners))}
        >
          <Plus aria-hidden="true" />
          Add runner
        </Button>
      }
    >
      {list.error !== null && runners === undefined ? (
        <SettingsRow
          title="Runners didn't load"
          description={errorMessage(list.error)}
          control={
            <Button
              size="xs"
              variant="outline"
              type="button"
              onClick={() => void list.refetch()}
            >
              Retry
            </Button>
          }
        />
      ) : runners === undefined ? (
        <SettingsRow title="Loading runners…" />
      ) : runners.length === 0 ? (
        <SettingsRow
          title="No runners yet"
          description="Add one to start Threads on your own machine."
        />
      ) : (
        runners.map((runner) => (
          <SettingsRow
            key={runner.id}
            title={runner.name}
            badge={
              <Badge tone={runner.online ? "success" : "neutral"}>
                {runner.online ? "Online" : "Offline"}
              </Badge>
            }
            description={`${runnerPlatform(runner)} · version ${runner.version}`}
            control={
              <Button
                size="xs"
                variant="ghost"
                type="button"
                aria-label={`Remove ${runner.name}`}
                onClick={() => setRemoving(runner)}
              >
                Remove
              </Button>
            }
          />
        ))
      )}
      <AddRunnerDialog
        open={adding !== undefined}
        pairing={pairing.data}
        {...(pairing.error === null
          ? {}
          : { error: errorMessage(pairing.error) })}
        {...(connected === undefined ? {} : { connectedName: connected.name })}
        onRetry={() => void pairing.refetch()}
        onClose={() => setAdding(undefined)}
        {...(thisMachine === undefined ? {} : { thisMachine })}
      />
      <ConfirmDialog
        open={removing !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            setRemoving(undefined);
            remove.reset();
          }
        }}
        title={`Remove ${removing?.name ?? "runner"}?`}
        description="dx disconnects it at once and its Threads stop running. Their files stay on the machine; run `~/.dx/runner/bin/dxd runner uninstall` there to remove everything."
        confirmLabel="Remove"
        destructive
        pending={remove.isPending}
        {...(remove.error === null
          ? {}
          : { error: errorMessage(remove.error) })}
        onConfirm={() => {
          if (removing === undefined) return;
          remove.mutate(removing.id, {
            onSuccess: () => setRemoving(undefined),
          });
        }}
      />
    </SettingsCard>
  );
}
