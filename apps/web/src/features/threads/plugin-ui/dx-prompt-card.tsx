import type { DxChangeItem, PluginPrompt } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { ChevronRight, KeyRound, SlidersHorizontal } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button } from "../../../shared/ui/button.js";
import { Input } from "../../../shared/ui/input.js";
import { answerPluginPrompt } from "./plugin-ui-mutations.js";

type DxPrompt = Extract<PluginPrompt, { kind: "change" | "secret" }>;

/**
 * dx's own cards above the composer (`manage_dx`): a settings change the
 * agent asks the owner to apply, showing exactly what changes, or a secret
 * the owner types here and dx stores directly. Only the owner answers;
 * others see who must.
 */
export function DxPromptCard({
  threadId,
  prompt,
  queued,
  isOwner,
}: {
  readonly threadId: ThreadId;
  readonly prompt: DxPrompt;
  readonly queued: number;
  readonly isOwner: boolean;
}) {
  const client = useQueryClient();
  const answer = useMutation({
    mutationFn: (value: null | boolean | string) =>
      answerPluginPrompt(client, threadId, prompt.id, value),
    onSuccess: (data, value) => {
      // Drop the typed secret from the mutation's state at once.
      answer.reset();
      if (data?.applied === false && data.error !== undefined)
        toast.error("dx could not apply it", { description: data.error });
      else if (data?.applied === true)
        toast.success(
          prompt.kind === "secret" ? `Saved ${prompt.name}` : "Applied",
          {
            description: prompt.kind === "secret" ? prompt.scope : prompt.title,
          },
        );
      else if (value === null || value === false) toast("Cancelled");
    },
  });
  const send = (value: null | boolean | string) => {
    if (!answer.isPending) answer.mutate(value);
  };
  const submit = (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (prompt.kind === "change") send(true);
    else {
      const value = String(
        new FormData(event.currentTarget).get("value") ?? "",
      );
      if (value.trim() !== "") send(value);
    }
  };
  const Icon = prompt.kind === "secret" ? KeyRound : SlidersHorizontal;
  return (
    <div className="plugin-ui-row">
      <form
        className="plugin-prompt-card dx-prompt-card"
        aria-label={`dx asks: ${prompt.title}`}
        data-kind={prompt.kind}
        data-destructive={
          prompt.kind === "change" && prompt.destructive === true
            ? "true"
            : undefined
        }
        onSubmit={submit}
        autoComplete="off"
      >
        <Icon aria-hidden="true" />
        <div className="plugin-prompt-copy">
          <span className="plugin-prompt-source">
            dx · {prompt.scope}
            {queued > 0 ? ` · ${queued} more waiting` : ""}
          </span>
          <strong>{prompt.title}</strong>
          {prompt.message === undefined ? null : (
            <p className="plugin-prompt-message">{prompt.message}</p>
          )}
          {prompt.kind === "change" ? (
            <ChangeItems items={prompt.items} />
          ) : isOwner ? (
            <div className="plugin-prompt-field">
              <label htmlFor={`${prompt.id}-value`}>
                <code>{prompt.name}</code>
              </label>
              <Input
                id={`${prompt.id}-value`}
                name="value"
                type="password"
                autoComplete="new-password"
                spellCheck={false}
                placeholder={prompt.replaces === true ? "New value" : "Value"}
                disabled={answer.isPending}
                // The card exists to take this value; focus saves a click.
                autoFocus
              />
              <span className="dx-prompt-hint">
                {prompt.replaces === true ? "Replaces the stored value. " : ""}
                Stored encrypted in {prompt.scope}. The agent never sees it.
              </span>
            </div>
          ) : null}
          {isOwner ? null : (
            <p className="plugin-prompt-message">
              Only the Thread's owner can answer this.
            </p>
          )}
          {!(answer.error instanceof Error) ? null : (
            <p className="plugin-prompt-error" role="alert">
              {answer.error.message}
            </p>
          )}
          {isOwner ? (
            <div className="plugin-prompt-actions">
              <Button
                variant="ghost"
                size="sm"
                disabled={answer.isPending}
                onClick={() => send(prompt.kind === "change" ? false : null)}
              >
                Cancel
              </Button>
              <Button
                type="submit"
                size="sm"
                variant={
                  prompt.kind === "change" && prompt.destructive === true
                    ? "destructive"
                    : "default"
                }
                disabled={answer.isPending}
              >
                {answer.isPending
                  ? prompt.kind === "secret"
                    ? "Saving…"
                    : "Applying…"
                  : prompt.kind === "secret"
                    ? "Save secret"
                    : (prompt.confirmLabel ?? "Apply")}
              </Button>
            </div>
          ) : null}
        </div>
      </form>
    </div>
  );
}

/**
 * What a change does, item by item. Text shows in full; files and diffs
 * fold, and render their lines only once opened. The first diff, or with
 * none the first file, starts open: it is usually the point of the change.
 */
function ChangeItems({
  items,
}: {
  readonly items: ReadonlyArray<DxChangeItem>;
}) {
  const firstDiff = items.findIndex(({ format }) => format === "diff");
  const firstOpen =
    firstDiff === -1
      ? items.findIndex(({ format }) => format === "code")
      : firstDiff;
  if (items.length === 0) return null;
  return (
    <ul className="dx-change-items">
      {items.map((item, index) =>
        item.format === "text" ? (
          <li key={item.label} className="dx-change-text">
            <span className="dx-change-label">{item.label}</span>
            <p>{item.content}</p>
          </li>
        ) : (
          <FoldedItem
            key={item.label}
            item={item}
            initiallyOpen={index === firstOpen || items.length === 1}
          />
        ),
      )}
    </ul>
  );
}

function FoldedItem({
  item,
  initiallyOpen,
}: {
  readonly item: DxChangeItem;
  readonly initiallyOpen: boolean;
}) {
  const [open, setOpen] = useState(initiallyOpen);
  const lines = item.content.split("\n");
  const added =
    item.format === "diff"
      ? lines.filter((line) => line.startsWith("+")).length
      : lines.length;
  const removed =
    item.format === "diff"
      ? lines.filter((line) => line.startsWith("-")).length
      : 0;
  return (
    <li className="dx-change-file" data-open={open ? "true" : undefined}>
      <button
        type="button"
        className="dx-change-toggle"
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronRight aria-hidden="true" />
        <span className="dx-change-label">{item.label}</span>
        <span className="dx-change-count">
          {item.format === "diff" ? (
            <>
              <span className="diff-added">+{added}</span>
              <span className="diff-removed">−{removed}</span>
            </>
          ) : (
            `${added} ${added === 1 ? "line" : "lines"}`
          )}
        </span>
      </button>
      {open ? (
        <pre className="dx-change-code" data-format={item.format}>
          {item.format === "diff"
            ? lines.map((line, index) => (
                <span
                  // Lines of one diff never reorder.
                  // biome-ignore lint/suspicious/noArrayIndexKey: static text
                  key={index}
                  data-line={
                    line.startsWith("@@")
                      ? "hunk"
                      : line.startsWith("+")
                        ? "add"
                        : line.startsWith("-")
                          ? "remove"
                          : undefined
                  }
                >
                  {line === "" ? " " : line}
                </span>
              ))
            : item.content}
        </pre>
      ) : null}
    </li>
  );
}
