import {
  RUNNER_PROFILE_ID,
  RUNNER_PROVIDER_ID,
  type RunnerMachine,
} from "@dx/api";
import type { RunnerProfileId, UserId } from "@dx/domain";
import { lazyRouteComponent } from "@tanstack/react-router";
import * as React from "react";
import { usePairThisMachine } from "../../shared/native-shell/use-pair-this-machine.js";
import {
  type AddRunnerSession,
  effectiveRunner,
  startAddRunnerSession,
  useRunners,
} from "../runners/runners-queries.js";

// Loads when the person first opens Add runner, so the New Thread page's
// first load carries none of it.
const AddRunnerDialog = lazyRouteComponent(
  () => import("../../shared/ui/add-runner-dialog.js"),
  "AddRunnerDialog",
);

/**
 * The New Thread composer's runner state: the person's machines, the one a
 * runner Thread (`rn.machine`) starts on, and the Add runner dialog.
 * Core lists the runner provider only while its experimental feature is
 * on; until then nothing is fetched and every prop is empty.
 */
export const useNewThreadRunner = (
  userId: UserId,
  /** The size the Thread would start on now. */
  runnerProfileId: string | undefined,
  input: {
    /** Core's resolved Orb providers. */
    readonly providers:
      | ReadonlyArray<{ readonly providerId: string }>
      | undefined;
    /** Picks the runner size after a new machine is chosen in the dialog. */
    readonly chooseRunnerProfile: (id: RunnerProfileId) => void;
  },
) => {
  const offered =
    input.providers?.some(
      ({ providerId }) => providerId === RUNNER_PROVIDER_ID,
    ) ?? false;
  const [chosenId, setChosenId] = React.useState<string>();
  const [session, setSession] = React.useState<AddRunnerSession>();
  const { list, pairing, connected } = useRunners(userId, {
    enabled: offered,
    session,
  });
  const thisMachine = usePairThisMachine(pairing.data?.code);
  const runners = list.data?.runners;
  const runner = effectiveRunner(runners, chosenId);
  const runnerMachineId =
    runnerProfileId === RUNNER_PROFILE_ID ? runner?.id : undefined;
  const dialog =
    session === undefined ? null : (
      <React.Suspense fallback={null}>
        <AddRunnerDialog
          open
          stacked
          pairing={pairing.data}
          {...(pairing.error === null
            ? {}
            : {
                error:
                  pairing.error instanceof Error
                    ? pairing.error.message
                    : "Request failed.",
              })}
          {...(connected === undefined
            ? {}
            : { connectedName: connected.name })}
          onRetry={() => void pairing.refetch()}
          onClose={() => setSession(undefined)}
          {...(thisMachine === undefined ? {} : { thisMachine })}
          onUse={() => {
            if (connected !== undefined) setChosenId(connected.id);
            input.chooseRunnerProfile(RUNNER_PROFILE_ID as RunnerProfileId);
            setSession(undefined);
          }}
        />
      </React.Suspense>
    );
  const pickerMachines = offered
    ? {
        runners,
        selectedId: runner?.id,
        onSelect: ({ id }: RunnerMachine) => setChosenId(id),
        onAdd: () => setSession(startAddRunnerSession(runners)),
        dialog,
      }
    : undefined;
  return {
    /** Spread into the create request. */
    createProps: runnerMachineId === undefined ? {} : { runnerMachineId },
    /** Spread into the configuration strip. */
    pickerProps:
      pickerMachines === undefined ? {} : { runnerMachines: pickerMachines },
  };
};
