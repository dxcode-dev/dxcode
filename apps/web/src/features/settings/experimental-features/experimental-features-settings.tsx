import type {
  ExperimentalFeaturePreferenceData,
  PersonalExperimentalFeaturesData,
} from "@dx/api";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, FlaskConical, ShieldX } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
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
      return "Applies immediately";
    case "restart":
      return "Requires an app restart";
    case "new-thread":
      return "Applies only to new Threads";
  }
};

const denialLabel = (flag: ExperimentalFeaturePreferenceData) => {
  switch (flag.denialReason) {
    case "prerequisite-disabled":
      return `Requires ${flag.blockedBy.join(", ")}`;
    case "incompatible-feature":
      return `Incompatible with ${flag.blockedBy.join(", ")}`;
    case undefined:
      return undefined;
  }
};

function FeatureMetadata({
  flag,
}: {
  readonly flag: ExperimentalFeaturePreferenceData;
}) {
  const feature = flag.registration;
  const relationship =
    feature.prerequisites.length > 0
      ? `Requires ${feature.prerequisites.join(", ")}`
      : feature.incompatibilities.length > 0
        ? `Incompatible with ${feature.incompatibilities.join(", ")}`
        : undefined;
  return (
    <div className="experimental-feature-description">
      <p>{feature.description}</p>
      <div className="experimental-feature-metadata">
        <span>{feature.owner.team}</span>
        <span>{feature.risk} risk</span>
        <span>Personal scope</span>
        <span>Review {feature.reviewDate}</span>
      </div>
      <div className="experimental-feature-semantics">
        <span>{activationLabel(feature.activation)}</span>
        {relationship === undefined ? null : <span>{relationship}</span>}
        <a href={feature.owner.issue} target="_blank" rel="noreferrer">
          Lifecycle issue
        </a>
      </div>
      {denialLabel(flag) === undefined ? null : (
        <div className="experimental-feature-denial" role="status">
          <ShieldX aria-hidden="true" /> {denialLabel(flag)}
        </div>
      )}
      <details className="experimental-feature-lifecycle">
        <summary>Migration, graduation, and removal plan</summary>
        <dl>
          <div>
            <dt>Migration</dt>
            <dd>{feature.lifecyclePlan.migration}</dd>
          </div>
          <div>
            <dt>Graduation</dt>
            <dd>{feature.lifecyclePlan.graduation}</dd>
          </div>
          <div>
            <dt>Removal</dt>
            <dd>{feature.lifecyclePlan.removal}</dd>
          </div>
        </dl>
      </details>
    </div>
  );
}

export function ExperimentalFeaturesPanel({
  data,
  savingFeatureId,
  message,
  error,
  onToggle,
}: {
  readonly data: PersonalExperimentalFeaturesData;
  readonly savingFeatureId?: string;
  readonly message?: string;
  readonly error?: string;
  readonly onToggle: (flag: ExperimentalFeaturePreferenceData) => void;
}) {
  return (
    <div className="experimental-features-settings">
      <SettingsHeading
        title="Experimental Features"
        description="Opt into lifecycle-managed previews supported by this dx build. Experiments may change or disappear."
      />

      {data.flags.length === 0 ? (
        <SettingsCard>
          <div className="experimental-features-empty" role="status">
            <FlaskConical aria-hidden="true" />
            <strong>
              No experimental features are available in this build.
            </strong>
            <span>
              This is expected: dx registers a switch only for a real capability
              with an owner and lifecycle plan.
            </span>
          </div>
        </SettingsCard>
      ) : (
        <SettingsCard title="Available in this build">
          {data.flags.map((flag) => (
            <SettingsRow
              key={flag.registration.id}
              title={flag.registration.title}
              badge={flag.registration.status}
              description={<FeatureMetadata flag={flag} />}
              control={
                <SettingsToggle
                  checked={flag.personalEnabled}
                  disabled={savingFeatureId !== undefined}
                  label={`${flag.personalEnabled ? "Disable" : "Enable"} ${flag.registration.title}`}
                  onCheckedChange={() => onToggle(flag)}
                />
              }
            />
          ))}
        </SettingsCard>
      )}

      {message === undefined && error === undefined ? null : (
        <div
          className="experimental-features-message"
          role={error === undefined ? "status" : "alert"}
          data-error={error === undefined ? undefined : true}
        >
          {error ?? message}
        </div>
      )}
    </div>
  );
}

export function ExperimentalFeaturesErrorState({
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
  const [message, setMessage] = React.useState<string>();
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
    setMessage(undefined);
    setError(undefined);
    try {
      const saved = await updateFeature.mutateAsync([
        flag.registration.id,
        !flag.personalEnabled,
        data.revision,
      ]);
      const updated = saved.flags.find(
        ({ registration }) => registration.id === flag.registration.id,
      );
      setMessage(
        updated?.effectiveEnabled === true
          ? `${flag.registration.title} enabled. ${activationLabel(flag.registration.activation)}.`
          : `${flag.registration.title} disabled.`,
      );
    } catch (cause) {
      setError(
        cause instanceof Error
          ? cause.message
          : "The experimental feature preference could not be saved.",
      );
    } finally {
      updateFeature.reset();
    }
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
        message={message}
        error={error}
        onToggle={(flag) => void toggle(flag)}
      />
    </>
  );
}
