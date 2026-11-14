import type {
  PluginIconSetData,
  PluginPaneEntry,
  PluginPrompt,
  PluginQuickAction,
  PluginThreadUiData,
} from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { PanelsTopLeft } from "lucide-react";
import { toast } from "sonner";
import { requestPluginPane } from "../../../shared/commands/thread-open-view-event.js";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { PluginIcon } from "../../../shared/ui/plugin-icon.js";
import { Textarea } from "../../../shared/ui/textarea.js";
import { pluginUiQueryOptions } from "../thread-queries.js";
import { DxPromptCard } from "./dx-prompt-card.js";
import { iconForItem } from "./plugin-ui-icon-lookup.js";
import { answerPluginPrompt, runPluginCommand } from "./plugin-ui-mutations.js";
import "./plugin-ui.css";

type Answer = null | boolean | string | Readonly<Record<string, string>>;

/**
 * Installed plugins' UI above a Thread's composer: the oldest prompt a
 * plugin is waiting on, and the plugins' quick actions. Loaded lazily after
 * the composer paints; renders nothing until a plugin shows something.
 */
export function PluginThreadUi({
  threadId,
  isOwner,
  onSend,
}: {
  readonly threadId: ThreadId;
  readonly isOwner: boolean;
  readonly onSend: (message: string) => void;
}) {
  const { data } = useQuery(pluginUiQueryOptions(threadId));
  if (data === undefined) return null;
  const prompt = data.prompts[0];
  return (
    <>
      {data.threadType === undefined || data.threadType.available ? null : (
        <ThreadTypeUnavailable title={data.threadType.title} />
      )}
      {prompt === undefined ? null : prompt.kind === "change" ||
        prompt.kind === "secret" ? (
        <DxPromptCard
          key={prompt.id}
          threadId={threadId}
          prompt={prompt}
          queued={data.prompts.length - 1}
          isOwner={isOwner}
        />
      ) : (
        <PluginPromptCard
          key={prompt.id}
          threadId={threadId}
          prompt={prompt}
          icon={iconForItem(data, prompt)}
          queued={data.prompts.length - 1}
          isOwner={isOwner}
        />
      )}
      {data.quickActions.length === 0 ? null : (
        <PluginQuickActions
          threadId={threadId}
          actions={data.quickActions}
          panes={data.panes ?? []}
          plugins={data.plugins ?? []}
          onSend={onSend}
        />
      )}
    </>
  );
}

/**
 * The same notice where there is no composer: a View member's Thread,
 * whose plugin type is not shown to them.
 */
export function PluginThreadTypeNotice({
  threadId,
}: {
  readonly threadId: ThreadId;
}) {
  const type = useQuery({
    ...pluginUiQueryOptions(threadId),
    select: (data) => data.threadType,
  }).data;
  return type === undefined || type.available ? null : (
    <ThreadTypeUnavailable title={type.title} />
  );
}

/**
 * A Thread whose plugin type is off, removed, or no longer trusted opens
 * as a plain chat; this says why its view is missing.
 */
function ThreadTypeUnavailable({ title }: { readonly title: string }) {
  return (
    <div className="plugin-ui-row">
      <p className="plugin-thread-type-notice" role="note">
        <PanelsTopLeft aria-hidden="true" />
        <span>
          {title} view is unavailable here, so this Thread shows its chat. Its
          plugin may be off, removed, or not trusted for you.
        </span>
      </p>
    </div>
  );
}

function PluginPromptCard({
  threadId,
  prompt,
  queued,
  isOwner,
  icon,
}: {
  readonly threadId: ThreadId;
  readonly prompt: Exclude<PluginPrompt, { kind: "change" | "secret" }>;
  readonly icon: PluginIconSetData | undefined;
  readonly queued: number;
  readonly isOwner: boolean;
}) {
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (value: Answer) =>
      answerPluginPrompt(client, threadId, prompt.id, value),
  });
  const send = (value: Answer) => {
    if (!answer.isPending) answer.mutate(value);
  };
  const ownerOnly = prompt.kind === "input" && prompt.secret === true;
  const blocked = ownerOnly && !isOwner;
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    if (prompt.kind === "input") send(String(form.get("value") ?? ""));
    else if (prompt.kind === "confirm" && prompt.fields !== undefined)
      send(
        Object.fromEntries(
          prompt.fields.map(({ key }) => [key, String(form.get(key) ?? "")]),
        ),
      );
    else if (prompt.kind === "confirm") send(true);
  };
  return (
    <div className="plugin-ui-row">
      <form
        className="plugin-prompt-card"
        aria-label={`${prompt.plugin} asks: ${prompt.title}`}
        data-kind={prompt.kind}
        onSubmit={submit}
      >
        <PluginIcon
          name={prompt.plugin}
          icon={icon}
          size={20}
          className="plugin-prompt-icon"
        />
        <div className="plugin-prompt-copy">
          <span className="plugin-prompt-source">
            {prompt.plugin}
            {queued > 0 ? ` · ${queued} more waiting` : ""}
          </span>
          <strong>{prompt.title}</strong>
          {prompt.message === undefined ? null : (
            <p className="plugin-prompt-message">{prompt.message}</p>
          )}
          {prompt.kind === "confirm"
            ? prompt.fields?.map((field) => (
                <div key={field.key} className="plugin-prompt-field">
                  <label htmlFor={`${prompt.id}-${field.key}`}>
                    {field.label}
                  </label>
                  {field.multiline === true ? (
                    <Textarea
                      id={`${prompt.id}-${field.key}`}
                      name={field.key}
                      defaultValue={field.value}
                      rows={3}
                    />
                  ) : (
                    <Input
                      id={`${prompt.id}-${field.key}`}
                      name={field.key}
                      defaultValue={field.value}
                    />
                  )}
                </div>
              ))
            : null}
          {prompt.kind === "input" && !blocked ? (
            prompt.multiline === true && prompt.secret !== true ? (
              <Textarea
                name="value"
                aria-label={prompt.title}
                placeholder={prompt.placeholder}
                defaultValue={prompt.defaultValue}
                rows={3}
              />
            ) : (
              <Input
                name="value"
                aria-label={prompt.title}
                type={prompt.secret === true ? "password" : "text"}
                autoComplete={prompt.secret === true ? "off" : undefined}
                placeholder={prompt.placeholder}
                defaultValue={prompt.defaultValue}
              />
            )
          ) : null}
          {blocked ? (
            <p className="plugin-prompt-message">
              Only the Thread's owner can answer this.
            </p>
          ) : null}
          {prompt.kind === "select" ? (
            <div className="plugin-prompt-options">
              {prompt.options.map((option) => (
                <Button
                  key={option.value}
                  variant="outline"
                  size="sm"
                  className="plugin-prompt-option"
                  disabled={answer.isPending}
                  onClick={() => send(option.value)}
                >
                  <span>{option.label}</span>
                  {option.description === undefined ? null : (
                    <span className="plugin-prompt-option-detail">
                      {option.description}
                    </span>
                  )}
                </Button>
              ))}
            </div>
          ) : null}
          {!(answer.error instanceof Error) ? null : (
            <p className="plugin-prompt-error" role="alert">
              {answer.error.message}
            </p>
          )}
          <div className="plugin-prompt-actions">
            <Button
              variant="ghost"
              size="sm"
              disabled={answer.isPending}
              onClick={() => send(prompt.kind === "confirm" ? false : null)}
            >
              {prompt.kind === "confirm"
                ? (prompt.cancelLabel ?? "Cancel")
                : "Dismiss"}
            </Button>
            {prompt.kind === "select" || blocked ? null : (
              <Button
                type="submit"
                size="sm"
                variant={
                  prompt.kind === "confirm" && prompt.destructive === true
                    ? "destructive"
                    : "default"
                }
                disabled={answer.isPending}
              >
                {prompt.kind === "confirm"
                  ? (prompt.confirmLabel ?? "Confirm")
                  : "Submit"}
              </Button>
            )}
          </div>
        </div>
      </form>
    </div>
  );
}

function PluginQuickActions({
  threadId,
  actions,
  panes,
  plugins,
  onSend,
}: {
  readonly threadId: ThreadId;
  readonly actions: ReadonlyArray<PluginQuickAction>;
  readonly panes: ReadonlyArray<PluginPaneEntry>;
  readonly plugins: NonNullable<PluginThreadUiData["plugins"]>;
  readonly onSend: (message: string) => void;
}) {
  const perform = (action: PluginQuickAction) => {
    const { text, url, command, pane } = action.args;
    if (action.action === "send-message" && text !== undefined) onSend(text);
    else if (action.action === "copy" && text !== undefined)
      void navigator.clipboard.writeText(text).then(
        () => toast.success("Copied", { description: action.plugin }),
        () => toast.error("Could not copy"),
      );
    else if (action.action === "open-url" && url !== undefined)
      window.open(url, "_blank", "noopener,noreferrer");
    else if (action.action === "run-command" && command !== undefined)
      void runPluginCommand(threadId, command, action.label);
    else if (action.action === "open-pane" && pane !== undefined) {
      const offered = panes.find(
        (entry) => `${entry.plugin}/${entry.pane}` === pane,
      );
      if (offered === undefined)
        toast.error("That plugin pane is not available", {
          description: action.plugin,
        });
      else
        requestPluginPane({
          threadId,
          plugin: offered.plugin,
          pane: offered.pane,
          title: offered.title,
        });
    }
  };
  return (
    <div className="plugin-ui-row">
      <ul className="plugin-quick-actions" aria-label="Plugin actions">
        {actions.map((action) => (
          <li key={action.id}>
            <Button
              variant="outline"
              size="xs"
              title={action.plugin}
              onClick={() => perform(action)}
            >
              <PluginIcon
                name={action.plugin}
                icon={iconForItem({ plugins }, action)}
                size={16}
              />
              {action.label}
            </Button>
          </li>
        ))}
      </ul>
    </div>
  );
}
