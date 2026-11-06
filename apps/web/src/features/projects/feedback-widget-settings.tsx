import type { FeedbackWidgetData } from "@dx/api";
import {
  MAX_FEEDBACK_WIDGET_ORIGINS,
  normalizeFeedbackWidgetOrigin,
  type ProjectId,
  type UserId,
} from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { Copy, ExternalLink, Plus, X } from "lucide-react";
import * as React from "react";
import { toast } from "sonner";
import { Button } from "../../shared/ui/button.js";
import { buttonVariants } from "../../shared/ui/button-variants.js";
import { ConfirmDialog } from "../../shared/ui/confirm-dialog.js";
import { Input } from "../../shared/ui/input.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../../shared/ui/settings.js";
import {
  changeFeedbackWidgetMutationOptions,
  type FeedbackWidgetChange,
  feedbackWidgetQueryOptions,
} from "./feedback-widget-queries.js";

const scriptTag = (scriptUrl: string) =>
  `<script src="${scriptUrl}" async></script>`;

/** The site with `?dx`, which shows the widget there. */
const openWithWidget = (origin: string) => `${origin}/?dx`;

const copy = (text: string, label: string) => {
  if (navigator.clipboard === undefined) {
    toast(text, { description: `Copy the ${label}.` });
    return;
  }
  void navigator.clipboard
    .writeText(text)
    .then(() => toast.success(`Copied ${label}`))
    .catch(() => toast(text, { description: `Copy the ${label}.` }));
};

/**
 * Project Settings → Feedback Widget (experimental). Off, it explains the
 * steps beside Enable; on, it shows the script tag, the allowed origins, and
 * Turn Off, each in its own card like the project's other settings.
 */
export function FeedbackWidgetProjectSettings({
  projectId,
  userId,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
}) {
  const widget = useQuery(feedbackWidgetQueryOptions(userId, projectId));
  return (
    <div className="project-settings-content project-feedback-widget">
      <SettingsHeading
        title="Feedback Widget"
        detail="Experimental"
        description="Let people who can start Threads in this project click any element on your website, write what to change, and send it to a new Thread here."
      />
      {widget.error ? (
        <p className="project-settings-state" role="alert">
          The Feedback Widget could not be loaded.
        </p>
      ) : widget.data === undefined ? (
        <p className="project-settings-state">Loading…</p>
      ) : (
        <FeedbackWidgetCards
          projectId={projectId}
          userId={userId}
          data={widget.data}
        />
      )}
    </div>
  );
}

function FeedbackWidgetCards({
  projectId,
  userId,
  data,
}: {
  readonly projectId: ProjectId;
  readonly userId: UserId;
  readonly data: FeedbackWidgetData;
}) {
  const queryClient = useQueryClient();
  const mutation = useMutation(
    changeFeedbackWidgetMutationOptions(queryClient, userId, projectId),
  );
  const [confirmOff, setConfirmOff] = React.useState(false);
  const change = (value: FeedbackWidgetChange, onSuccess?: () => void) =>
    mutation.mutate(value, { onSuccess });
  const error =
    mutation.error instanceof Error ? mutation.error.message : undefined;
  const errorLine =
    error === undefined ? null : (
      <p className="project-feedback-widget-error" role="alert">
        {error}
      </p>
    );
  if (!data.enabled || data.scriptUrl === undefined)
    return (
      <SettingsCard
        title="How It Works"
        actions={
          <Button
            size="xs"
            disabled={mutation.isPending}
            onClick={() => change({ kind: "enable" })}
          >
            {mutation.isPending ? "Enabling…" : "Enable"}
          </Button>
        }
      >
        <ol className="project-feedback-widget-steps">
          <li>Enable the widget.</li>
          <li>Add the script tag to your site.</li>
          <li>Add your site's origin under Allowed Origins.</li>
          <li>Open your site with ?dx in the address to show the widget.</li>
        </ol>
        {errorLine}
      </SettingsCard>
    );
  const tag = scriptTag(data.scriptUrl);
  return (
    <>
      <SettingsCard
        title="Script Tag"
        description={`Add it to every page of your site, such as in the <head>. If the site sends a Content-Security-Policy, allow ${new URL(data.scriptUrl).origin} in script-src and frame-src.`}
        actions={
          <Button
            size="xs"
            variant="outline"
            onClick={() => copy(tag, "script tag")}
          >
            <Copy aria-hidden="true" />
            Copy
          </Button>
        }
      >
        <pre className="project-feedback-widget-code">
          <code>{tag}</code>
        </pre>
      </SettingsCard>
      <AllowedOrigins
        origins={data.allowedOrigins}
        pending={mutation.isPending}
        onAdd={(origin, onSuccess) =>
          change({ kind: "add-origin", origin }, onSuccess)
        }
        onRemove={(origin) => change({ kind: "remove-origin", origin })}
      />
      <SettingsCard>
        <SettingsRow
          title="Turn Off"
          description="Stop the script on every site and sign everyone out of it. Turning it on again gives a new script tag."
          control={
            <Button
              size="xs"
              variant="destructive"
              disabled={mutation.isPending}
              onClick={() => setConfirmOff(true)}
            >
              Turn Off
            </Button>
          }
        />
        {errorLine}
      </SettingsCard>
      <ConfirmDialog
        open={confirmOff}
        onOpenChange={setConfirmOff}
        title="Turn off the Feedback Widget?"
        description="The script stops on every site and everyone who signed in to it loses access. Turning it on again gives a new script tag, so you would replace it on your sites. Allowed origins stay."
        confirmLabel="Turn Off"
        destructive
        pending={mutation.isPending}
        onConfirm={() =>
          change({ kind: "disable" }, () => setConfirmOff(false))
        }
      />
    </>
  );
}

function AllowedOrigins({
  origins,
  pending,
  onAdd,
  onRemove,
}: {
  readonly origins: ReadonlyArray<string>;
  readonly pending: boolean;
  readonly onAdd: (origin: string, onSuccess: () => void) => void;
  readonly onRemove: (origin: string) => void;
}) {
  const [text, setText] = React.useState("");
  const [invalid, setInvalid] = React.useState(false);
  const full = origins.length >= MAX_FEEDBACK_WIDGET_ORIGINS;
  const add = () => {
    const origin = normalizeFeedbackWidgetOrigin(text);
    if (origin === undefined) {
      setInvalid(true);
      return;
    }
    onAdd(origin, () => setText(""));
  };
  return (
    <SettingsCard
      title="Allowed Origins"
      description="The widget opens only on these sites. dx keeps the scheme, host, and port of each address; add production and staging separately."
    >
      {origins.length === 0 ? null : (
        <ul
          className="project-feedback-widget-origins"
          aria-label="Allowed origins"
        >
          {origins.map((origin) => (
            <li key={origin} title={origin}>
              <span>{origin}</span>
              <a
                className={buttonVariants({ size: "xs", variant: "ghost" })}
                href={openWithWidget(origin)}
                target="_blank"
                rel="noopener"
                aria-label={`Open ${origin} with the widget`}
              >
                <ExternalLink aria-hidden="true" />
                Open with ?dx
              </a>
              <Button
                size="icon-xs"
                variant="ghost"
                aria-label={`Remove ${origin}`}
                disabled={pending}
                onClick={() => onRemove(origin)}
              >
                <X />
              </Button>
            </li>
          ))}
        </ul>
      )}
      <form
        className="project-feedback-widget-origin-form"
        onSubmit={(event) => {
          event.preventDefault();
          add();
        }}
      >
        <Input
          aria-label="Origin"
          aria-invalid={invalid || undefined}
          placeholder="https://staging.example.com"
          value={text}
          disabled={pending || full}
          onChange={(event) => {
            setText(event.target.value);
            setInvalid(false);
          }}
        />
        <Button
          type="submit"
          size="xs"
          variant="outline"
          aria-label="Add origin"
          disabled={pending || full || text.trim() === ""}
        >
          <Plus aria-hidden="true" />
          Add
        </Button>
      </form>
      {invalid ? (
        <p className="project-feedback-widget-error" role="alert">
          Enter an https address, or http on localhost, 127.0.0.1, or [::1].
        </p>
      ) : null}
    </SettingsCard>
  );
}
