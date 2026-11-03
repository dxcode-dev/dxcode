import type {
  ExperimentalFeaturePreferenceData,
  PersonalExperimentalFeaturesData,
} from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";
import {
  personalExperimentalFeaturesQueryOptions,
  updatePersonalExperimentalFeatureMutationOptions,
} from "./experimental-features-queries.js";

const activationLabel = (
  activation: ExperimentalFeaturePreferenceData["registration"]["activation"],
) => {
  switch (activation) {
    case "immediate":
      return undefined;
    case "restart":
      return "Applies after an app restart.";
    case "new-thread":
      return "Applies to new Threads.";
  }
};

/**
 * Why the switch has no effect yet, or when a change takes effect; absent
 * when it applies at once.
 */
const featureHint = (flag: ExperimentalFeaturePreferenceData) => {
  switch (flag.denialReason) {
    case "prerequisite-disabled":
      return `Needs ${flag.blockedBy.join(", ")} on.`;
    case "incompatible-feature":
      return `Can't run with ${flag.blockedBy.join(", ")}.`;
    case undefined:
      return activationLabel(flag.registration.activation);
  }
};

function ExperimentalFeaturesPanel({
  data,
  savingFeatureId,
  error,
  onToggle,
}: {
  readonly data: PersonalExperimentalFeaturesData;
  readonly savingFeatureId?: string;
  readonly error?: string;
  readonly onToggle: (flag: ExperimentalFeaturePreferenceData) => void;
}) {
  return (
    <div className="experimental-features-settings">
      <SettingsHeading
        title="Experimental Features"
        actions={
          error === undefined ? null : (
            <span
              className="first-party-plugins-heading-actions"
              role="alert"
              data-error
            >
              {error}
            </span>
          )
        }
      />
      <SettingsCard>
        {data.flags.length === 0 ? (
          <p className="settings-card-empty">
            No experimental features in this build.
          </p>
        ) : (
          data.flags.map((flag) => {
            const hint = featureHint(flag);
            return (
              <SettingsRow
                key={flag.registration.id}
                title={flag.registration.title}
                description={
                  hint === undefined
                    ? flag.registration.description
                    : `${flag.registration.description} ${hint}`
                }
                control={
                  <SettingsToggle
                    checked={flag.personalEnabled}
                    disabled={savingFeatureId !== undefined}
                    label={`${flag.personalEnabled ? "Disable" : "Enable"} ${flag.registration.title}`}
                    onCheckedChange={() => onToggle(flag)}
                  />
                }
              />
            );
          })
        )}
      </SettingsCard>
    </div>
  );
}

function ExperimentalFeaturesErrorState({
  error,
  onRetry,
}: {
  readonly error: string;
  readonly onRetry: () => void;
}) {
  return (
    <div className="settings-route-state" role="alert">
      <AlertTriangle aria-hidden="true" />
      <strong>{error}</strong>
      <span>Your saved preferences have not been changed.</span>
      <Button size="sm" variant="outline" onClick={onRetry}>
        Try again
      </Button>
    </div>
  );
}

export function ExperimentalFeaturesSettings() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const features = useQuery(
    personalExperimentalFeaturesQueryOptions(identity.id),
  );
  const updateFeature = useMutation(
    updatePersonalExperimentalFeatureMutationOptions(queryClient, identity.id),
  );
  const [error, setError] = React.useState<string>();

  if (features.isPending && features.data === undefined) {
    return (
      <div className="settings-route-state" aria-busy="true">
        <span className="tool-spinner" />
        <strong>Loading experimental features…</strong>
      </div>
    );
  }
  if (features.data === undefined) {
    return (
      <ExperimentalFeaturesErrorState
        error={
          features.error instanceof Error
            ? features.error.message
            : "Experimental features could not be loaded."
        }
        onRetry={() => void features.refetch()}
      />
    );
  }
  const data = features.data;

  const toggle = async (flag: ExperimentalFeaturePreferenceData) => {
    if (updateFeature.isPending) return;
    setError(undefined);
    // The switch shows the saved state, so only a failure needs words.
    const outcome = await settle(() =>
      updateFeature.mutateAsync([
        flag.registration.id,
        !flag.personalEnabled,
        data.revision,
      ]),
    );
    if (!outcome.ok) {
      setError(
        outcome.error instanceof Error
          ? outcome.error.message
          : "The experimental feature preference could not be saved.",
      );
    }
    updateFeature.reset();
  };

  return (
    <>
      {features.error === null ? null : (
        <SettingsBackgroundError onRetry={() => void features.refetch()}>
          Experimental features could not be refreshed. Showing the last loaded
          settings.
        </SettingsBackgroundError>
      )}
      <ExperimentalFeaturesPanel
        data={data}
        savingFeatureId={
          updateFeature.isPending ? updateFeature.variables?.[0] : undefined
        }
        error={error}
        onToggle={(flag) => void toggle(flag)}
      />
    </>
  );
}
