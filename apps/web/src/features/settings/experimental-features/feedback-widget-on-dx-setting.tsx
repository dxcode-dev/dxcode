import { parseFeedbackWidgetScriptUrl } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsRow, SettingsSelect } from "../../../shared/ui/settings.js";
import {
  personalFeedbackWidgetQueryOptions,
  updatePersonalFeedbackWidgetMutationOptions,
} from "../../projects/feedback-widget-queries.js";

const OFF = "off";
const OTHER = "other";

const reloadToast = () =>
  toast("Reload dx to switch the Feedback Widget.", {
    action: { label: "Reload", onClick: () => window.location.reload() },
  });

/**
 * Feedback Widget on dx: which dx host and Project receive feedback about
 * dx itself. Shown under the experimental flag while it is on.
 */
export function FeedbackWidgetOnDxSetting() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const embed = useQuery(personalFeedbackWidgetQueryOptions(identity.id));
  const mutation = useMutation(
    updatePersonalFeedbackWidgetMutationOptions(queryClient, identity.id),
  );
  const [choosingOther, setChoosingOther] = React.useState(false);
  const [draft, setDraft] = React.useState("");
  const data = embed.data;
  const current = data?.scriptUrl;
  const onThisDx = data?.projects.find(
    (project) => project.scriptUrl === current,
  );
  const selected =
    current === undefined && !choosingOther
      ? OFF
      : onThisDx !== undefined && !choosingOther
        ? onThisDx.projectId
        : OTHER;
  const save = (scriptUrl: string | null) =>
    mutation.mutate(scriptUrl, {
      onSuccess: () => {
        setChoosingOther(false);
        setDraft("");
        reloadToast();
      },
    });
  const parsed =
    draft.trim() === "" ? undefined : parseFeedbackWidgetScriptUrl(draft);
  const otherHost =
    current !== undefined && onThisDx === undefined
      ? parseFeedbackWidgetScriptUrl(current)?.host
      : undefined;
  const error =
    mutation.error instanceof Error ? mutation.error.message : undefined;
  return (
    <div className="feedback-widget-on-dx">
      <SettingsRow
        title="Show on dx"
        description={
          otherHost === undefined
            ? "Comment on dx's own pages and send it to a project. Open any dx page with ?dx to show the widget."
            : `Sending to a project on ${otherHost}. Open any dx page with ?dx to show the widget.`
        }
        control={
          <SettingsSelect
            label="Project that receives feedback about dx"
            value={selected}
            disabled={data === undefined || mutation.isPending}
            options={[
              [OFF, "Off"],
              ...(data?.projects ?? []).map(
                (project) => [project.projectId, project.projectLabel] as const,
              ),
              [OTHER, otherHost ?? "Another dx host…"],
            ]}
            onValueChange={(value) => {
              if (value === OTHER) {
                setChoosingOther(true);
                return;
              }
              setChoosingOther(false);
              if (value === OFF) save(null);
              else
                save(
                  data?.projects.find((project) => project.projectId === value)
                    ?.scriptUrl ?? null,
                );
            }}
          />
        }
      />
      {selected === OTHER && (choosingOther || current === undefined) ? (
        <form
          className="feedback-widget-on-dx-other"
          onSubmit={(event) => {
            event.preventDefault();
            if (parsed !== undefined) save(parsed.scriptUrl);
          }}
        >
          <p>
            {draft.trim() !== "" && parsed === undefined
              ? "Paste the Script Tag from a project's Feedback Widget settings on any dx host."
              : `Paste the Script Tag from the project's Feedback Widget settings on that dx, and add ${window.location.origin} to its Allowed Origins.`}
          </p>
          <div className="feedback-widget-on-dx-other-row">
            <Input
              aria-label="Script tag from another dx host"
              aria-invalid={
                draft.trim() !== "" && parsed === undefined ? true : undefined
              }
              placeholder='<script src="https://dx.example.com/api/feedback-widget/fbw_….js" async></script>'
              value={draft}
              disabled={mutation.isPending}
              onChange={(event) => setDraft(event.target.value)}
            />
            <Button
              size="xs"
              variant="ghost"
              disabled={mutation.isPending}
              onClick={() => {
                setChoosingOther(false);
                setDraft("");
              }}
            >
              Cancel
            </Button>
            <Button
              size="xs"
              type="submit"
              disabled={parsed === undefined || mutation.isPending}
            >
              {mutation.isPending ? "Saving…" : "Save"}
            </Button>
          </div>
        </form>
      ) : null}
      {error === undefined ? null : (
        <p className="feedback-widget-on-dx-error" role="alert">
          {error}
        </p>
      )}
    </div>
  );
}
