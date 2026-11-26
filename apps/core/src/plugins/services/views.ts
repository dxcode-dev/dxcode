import type { Bindings } from "../../http/types.js";
import { setPluginViewState } from "../views/state.js";
import type { PluginInstallRecord } from "../worker-host/host.js";
import type { ServiceReply } from "./requests.js";

/**
 * `POST /views/<viewId>/state` from a service: M4's view-state store
 * (`setPluginViewState`, plugins/views/state.ts) is the only store, the same
 * one function code's `ctx.views.set` writes.
 */
export const setServiceViewState = async (
  bindings: Bindings,
  install: PluginInstallRecord,
  viewId: string,
  body: Record<string, unknown>,
): Promise<ServiceReply> => {
  if (typeof body.path !== "string" || !("value" in body))
    return {
      status: 400,
      body: {
        error: {
          code: "bad-body",
          message: 'Send { "path": "…", "value": … }.',
        },
      },
    };
  const result = await setPluginViewState(bindings, {
    install,
    viewId,
    path: body.path,
    value: body.value,
  });
  if (result.ok) return { status: 200, body: { version: result.version } };
  return {
    status:
      result.code === "unknown-view"
        ? 404
        : result.code === "too-large"
          ? 413
          : result.code === "busy"
            ? 429
            : 400,
    body: { error: { code: result.code, message: result.message } },
  };
};
