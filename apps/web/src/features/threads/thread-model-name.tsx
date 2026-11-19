import type { ThreadDetailData } from "@dx/api";
import { isClaudeCodeModel } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { modelDisplayName } from "../../shared/model-display-name.js";
import { effortLabel } from "../../shared/model-effort-label.js";
import { ClaudeIcon } from "../../shared/ui/claude-icon.js";
import { modelRoutingChoicesQueryOptions } from "../settings/model-routing/model-routing-queries.js";

const ThreadModelMark = React.lazy(() =>
  import("./thread-model-mark.js").then((module) => ({
    default: module.ThreadModelMark,
  })),
);

type ModelSelection = Extract<
  ThreadDetailData["agentInitialization"]["selection"],
  { readonly kind: "model" }
>;

/**
 * A Thread's model as the model picker names it: the catalog's name, its
 * maker's logo (Claude Code's own mark for a Claude Code model), and its
 * effort, such as "DeepSeek V4 Flash 0731", "High".
 */
export function useThreadModelName(selection: ModelSelection) {
  const { identity } = useAuthenticatedIdentity();
  const choices = useQuery(modelRoutingChoicesQueryOptions(identity.id)).data;
  const catalogName =
    choices?.models.find(({ canonical }) => canonical === selection.model)
      ?.name ??
    choices?.modes.find(({ config }) => config.model === selection.model)
      ?.modelName;
  const name = modelDisplayName(catalogName ?? selection.model);
  const claudeCode = isClaudeCodeModel(selection.model);
  const effort =
    selection.thinking === undefined
      ? undefined
      : effortLabel(selection.thinking);
  return {
    name,
    effort,
    title: `${claudeCode ? "Claude Code: " : ""}${name}${effort === undefined ? "" : `, ${effort} effort`}`,
    mark: claudeCode ? (
      <ClaudeIcon aria-hidden="true" />
    ) : (
      // An empty icon box holds the logo's place while it loads.
      <React.Suspense fallback={<svg aria-hidden="true" />}>
        <ThreadModelMark model={selection.model} name={name} />
      </React.Suspense>
    ),
  };
}
