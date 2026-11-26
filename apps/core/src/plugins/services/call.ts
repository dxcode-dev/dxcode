import type { Bindings } from "../../http/types.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import { callService, type ServiceRefusal } from "./host.js";
import { loadServiceInstall } from "./installs.js";

/**
 * Calls into an install's running service from dx: an agent's call to a
 * tool the service answers (`POST /tools/<name>`), and a view's `call`
 * action (`POST /calls/<function>`, for M4's views). Each wakes the plugin
 * Orb when it sleeps. A `tool.call` gate never comes here.
 */

export type ServiceCallResult =
  | { readonly ok: true; readonly value: unknown }
  | {
      readonly ok: false;
      readonly code: ServiceRefusal | "no-service" | "timeout";
      readonly message: string;
    };

const TOOL_TIMEOUT_MS = 2 * 60_000;
const CALL_TIMEOUT_MS = 60_000;

const errorMessage = (body: unknown) => {
  const error = (body as { error?: { message?: unknown } } | null)?.error;
  return typeof error?.message === "string" ? error.message : undefined;
};

export const callPluginService = async (
  bindings: Bindings,
  input: {
    readonly install: Pick<PluginInstallRecord, "pluginId" | "displayName">;
    readonly kind: "tool" | "call";
    readonly name: string;
    /** A tool's input, or a function's arguments. */
    readonly args: unknown;
    readonly actorUserId: string;
    readonly threadId?: string;
  },
): Promise<ServiceCallResult> => {
  const db = bindings.DB;
  const install =
    db === undefined
      ? undefined
      : await loadServiceInstall(db, input.install.pluginId);
  if (install === undefined)
    return {
      ok: false,
      code: "no-service",
      message: `${input.install.displayName} has no running program here.`,
    };
  const outcome = await callService(bindings, install, {
    path: `/${input.kind === "tool" ? "tools" : "calls"}/${encodeURIComponent(input.name)}`,
    body:
      input.kind === "tool"
        ? {
            input: input.args,
            userId: input.actorUserId,
            ...(input.threadId === undefined
              ? {}
              : { threadId: input.threadId }),
          }
        : { args: input.args, userId: input.actorUserId },
    timeoutMs: input.kind === "tool" ? TOOL_TIMEOUT_MS : CALL_TIMEOUT_MS,
  });
  if (!outcome.ok)
    return { ok: false, code: outcome.reason, message: outcome.message };
  const { status, body } = outcome.value;
  if (status >= 400)
    return {
      ok: false,
      code: "failed",
      message:
        errorMessage(body) ??
        `${install.displayName}'s program answered ${status}.`,
    };
  const value =
    body !== null && typeof body === "object"
      ? input.kind === "tool"
        ? (body as { output?: unknown }).output
        : (body as { value?: unknown }).value
      : body;
  return { ok: true, value };
};

/** Whether `name` is a tool the install's service answers. */
export const isServiceTool = (
  install: Pick<PluginInstallRecord, "code">,
  name: string,
) => (install.code.service?.tools ?? []).some((tool) => tool.name === name);
