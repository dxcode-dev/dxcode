import type { DeploymentAdminPerson } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsToggle,
} from "../settings-primitives.js";
import {
  peopleAdminErrorMessage,
  peopleAdminPersonQueryOptions,
  resetUsernameChangeMutationOptions,
  setMailSendingMutationOptions,
} from "./people-admin-queries.js";
import "./people-admin.css";

/**
 * Settings → People, for deployment administrators: find one person by
 * their exact sign-in email or username, then give back their one username
 * change or pause their Mail sending. Both are support actions the
 * server logs with the admin's id.
 */
export function PeopleAdminSettings() {
  const { identity } = useAuthenticatedIdentity();
  const [draft, setDraft] = React.useState("");
  const [query, setQuery] = React.useState("");
  const person = useQuery(peopleAdminPersonQueryOptions(identity.id, query));
  const find = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    setQuery(draft.trim());
  };
  return (
    <div className="people-admin-settings">
      <SettingsHeading
        title="People"
        description="Support actions for one person on this deployment. Every change is logged with your name."
      />
      <SettingsCard>
        <form className="people-admin-find" onSubmit={find}>
          <Input
            aria-label="Sign-in email or username"
            placeholder="Sign-in email or username"
            autoComplete="off"
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
          />
          <Button
            type="submit"
            size="sm"
            disabled={draft.trim() === "" || person.isFetching}
          >
            {person.isFetching ? "Finding…" : "Find"}
          </Button>
        </form>
        {query === "" ? null : person.data !== undefined ? (
          <PersonActions
            adminUserId={identity.id}
            query={query}
            person={person.data}
          />
        ) : person.error === null ? null : (
          <p className="people-admin-message" role="alert">
            {peopleAdminErrorMessage(
              person.error,
              "That person could not be found.",
            )}
          </p>
        )}
      </SettingsCard>
    </div>
  );
}

function PersonActions({
  adminUserId,
  query,
  person,
}: {
  readonly adminUserId: UserId;
  readonly query: string;
  readonly person: DeploymentAdminPerson;
}) {
  const client = useQueryClient();
  const reset = useMutation(
    resetUsernameChangeMutationOptions(client, adminUserId, query),
  );
  const sending = useMutation(
    setMailSendingMutationOptions(client, adminUserId, query),
  );
  const error = reset.error ?? sending.error;
  return (
    <div className="people-admin-person">
      <SettingsRow
        title={person.name}
        description={`${person.email} · @${person.username}`}
      />
      <SettingsRow
        title="Username change"
        description={
          person.usernameChangeAvailable
            ? "Available: they can change their username once."
            : "Used: their username is fixed."
        }
        control={
          <Button
            size="xs"
            variant="outline"
            disabled={person.usernameChangeAvailable || reset.isPending}
            onClick={() => reset.mutate(person.userId)}
          >
            {reset.isPending ? "Giving back…" : "Give back the change"}
          </Button>
        }
      />
      <SettingsRow
        title="Mail sending"
        description={
          person.mailSendingSuspended
            ? "Paused: they can read mail but not send it."
            : "On: they can send from their Mail."
        }
        control={
          <SettingsToggle
            label="Mail sending"
            checked={!person.mailSendingSuspended}
            pending={sending.isPending}
            disabled={sending.isPending}
            onCheckedChange={(on) =>
              sending.mutate({ userId: person.userId, suspended: !on })
            }
          />
        }
      />
      {error === null ? null : (
        <p className="people-admin-message" role="alert">
          {peopleAdminErrorMessage(error, "The change could not be saved.")}
        </p>
      )}
    </div>
  );
}
