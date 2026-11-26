import {
  type DataViewAction,
  type DataViewScope,
  renderViewArgs,
  renderViewTemplate,
  THREAD_TITLE_MAX_LENGTH,
  type ThreadId,
  type ThreadTitle,
} from "@dx/domain";
import { useMutation, useQueryClient } from "@tanstack/react-query";
import { useNavigate } from "@tanstack/react-router";
import * as React from "react";
import { toast } from "sonner";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { createThreadMutationOptions } from "../../threads/thread-mutations.js";
import {
  type DataViewAddress,
  dataViewCallMutationOptions,
  invalidateDataViewStates,
} from "./data-view-queries.js";

/**
 * What a view's buttons, rows, and forms do. Every action is one of dx's
 * own: opening a Thread is the app's own navigation; starting one is the
 * New Thread request; a call runs the plugin's exposed function as the
 * person who clicked; a link to another site asks first.
 */

/** A question waiting on the person before an action runs. */
export interface PendingConfirm {
  readonly title: string;
  readonly description?: string;
  readonly confirmLabel: string;
  readonly run: () => Promise<void>;
}

const sameOrigin = (url: URL) => url.origin === window.location.origin;

/** A link the view may open: http(s) only, resolved against dx's origin. */
const linkOf = (text: string): URL | undefined => {
  try {
    const url = new URL(text, window.location.origin);
    return url.protocol === "https:" || url.protocol === "http:"
      ? url
      : undefined;
  } catch {
    return undefined;
  }
};

const titleOf = (text: string) => {
  const line = text.trim().split("\n")[0]?.trim() ?? "";
  const title =
    line.length > THREAD_TITLE_MAX_LENGTH
      ? `${line.slice(0, THREAD_TITLE_MAX_LENGTH - 1)}…`
      : line;
  return (title === "" ? "New thread" : title) as ThreadTitle;
};

export const useDataViewActions = (
  address: DataViewAddress,
  /** Why actions are off here, such as a member viewing the owner's plugin. */
  disabledReason: string | undefined,
) => {
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { identity } = useAuthenticatedIdentity();
  const call = useMutation(dataViewCallMutationOptions(address));
  const create = useMutation(
    createThreadMutationOptions(queryClient, identity.id),
  );
  const [confirm, setConfirm] = React.useState<PendingConfirm>();
  const [busy, setBusy] = React.useState<string>();

  const openThread = (threadId: string) =>
    navigate({ to: "/threads/$threadId", params: { threadId } });

  const perform = async (action: DataViewAction, scope: DataViewScope) => {
    switch (action.type) {
      case "open_thread": {
        const threadId = renderViewTemplate(action.thread, scope).trim();
        if (!/^thr_[A-Za-z0-9_-]{1,64}$/.test(threadId)) {
          toast.error("This row names no Thread to open.");
          return;
        }
        await openThread(threadId);
        return;
      }
      case "start_thread": {
        const prompt = renderViewTemplate(action.prompt, scope).trim();
        if (prompt === "") {
          toast.error("There is nothing to start a Thread with yet.");
          return;
        }
        const threadId = `thr_${crypto.randomUUID()}` as ThreadId;
        await create.mutateAsync({
          threadId,
          title: titleOf(
            action.title === undefined
              ? prompt
              : renderViewTemplate(action.title, scope),
          ),
          initialMessage: { body: prompt, attachments: [] },
        });
        await openThread(threadId);
        return;
      }
      case "call": {
        const result = await call.mutateAsync({
          fn: action.fn,
          args: (renderViewArgs(action.args ?? {}, scope) ?? {}) as Record<
            string,
            unknown
          >,
          ...(action.result === undefined ? {} : { result: action.result }),
        });
        // The new state comes on the realtime connection; this view reads
        // it at once in case that connection is down.
        if (result.version !== undefined)
          void invalidateDataViewStates(queryClient);
        return;
      }
      case "open_link": {
        const url = linkOf(renderViewTemplate(action.url, scope));
        if (url === undefined) {
          toast.error("This link is not a web address dx can open.");
          return;
        }
        if (sameOrigin(url)) {
          await navigate({ href: `${url.pathname}${url.search}${url.hash}` });
          return;
        }
        setConfirm({
          title: `Open ${url.host}?`,
          description: `This link leaves dx for ${url.href}.`,
          confirmLabel: "Open Link",
          run: async () => {
            window.open(url.href, "_blank", "noopener,noreferrer");
          },
        });
        return;
      }
      case "copy": {
        await navigator.clipboard.writeText(
          renderViewTemplate(action.text, scope),
        );
        toast("Copied.");
        return;
      }
    }
  };

  /** Runs an action; `id` names the control that shows it busy. */
  const run = async (
    id: string,
    action: DataViewAction,
    scope: DataViewScope,
  ) => {
    if (disabledReason !== undefined) {
      toast.error(disabledReason);
      return;
    }
    const go = async () => {
      setBusy(id);
      await perform(action, scope).catch((error: unknown) => {
        toast.error(
          error instanceof Error ? error.message : "That did not work.",
        );
      });
      setBusy(undefined);
    };
    if (action.type === "call" && action.confirm !== undefined) {
      setConfirm({
        title: renderViewTemplate(action.confirm, scope),
        confirmLabel: "Continue",
        run: go,
      });
      return;
    }
    await go();
  };

  return {
    run,
    busy,
    confirm,
    clearConfirm: () => setConfirm(undefined),
  };
};
