import { type DxChangeItem, PluginPrompt } from "@dx/api";
import { Option, Schema } from "effect";
import type { Bindings } from "../../http/types.js";
import {
  promptPollDelay,
  waitForPromptAnswer,
} from "../../plugins/thread-ui/prompt-wake.js";
import {
  expirePrompt,
  insertPrompt,
  invalidatePluginUi,
  type PromptSpec,
  takePromptAnswer,
} from "../../plugins/thread-ui/store.js";
import type { DxChangePlan, DxOutcome, DxSecretPlan } from "./apply.js";

/**
 * Shows a `manage_dx` prompt above the Thread's composer and waits for the
 * owner: a change to apply or cancel, or a secret to type. The row is the
 * one plugin prompts use (migration 0176), so the Thread page reads both
 * at once and the answer wakes this call the same way.
 */

const decodePrompt = Schema.decodeUnknownOption(PluginPrompt);

/** How long the owner has to answer, in seconds. */
export const DX_PROMPT_SECONDS = 600;
/** Waiting past the deadline for a change that is already being applied. */
const APPLYING_GRACE_MS = 60_000;

export type DxPrompt =
  | {
      readonly kind: "change";
      readonly title: string;
      readonly message?: string;
      readonly scope: string;
      readonly confirmLabel?: string;
      readonly destructive?: boolean;
      readonly items: ReadonlyArray<DxChangeItem>;
      readonly plan: DxChangePlan;
    }
  | {
      readonly kind: "secret";
      readonly title: string;
      readonly message?: string;
      readonly name: string;
      readonly scope: string;
      readonly replaces: boolean;
      readonly plan: DxSecretPlan;
    };

/** The prompt's outcome, or "expired" when nobody answered in time. */
export const askOwner = async (
  context: {
    readonly db: D1Database;
    readonly bindings: Bindings;
    readonly threadId: string;
    readonly signal?: AbortSignal;
  },
  prompt: DxPrompt,
): Promise<DxOutcome | "expired"> => {
  const { db, bindings, threadId } = context;
  const { kind, plan, ...spec } = prompt;
  // The page drops a card it cannot decode, so check it the same way first.
  const now = new Date().toISOString();
  if (
    Option.isNone(
      decodePrompt({
        ...spec,
        kind,
        id: "pui_check",
        plugin: "dx",
        createdAt: now,
        expiresAt: now,
      }),
    ) ||
    JSON.stringify(spec).length > 590_000
  )
    throw new Error(
      "This change is too large to show on one card. Split it into smaller changes.",
    );
  const id = await insertPrompt(db, {
    threadId,
    pluginId: null,
    pluginName: "dx",
    kind,
    spec: spec as unknown as PromptSpec,
    ownerOnly: true,
    seconds: DX_PROMPT_SECONDS,
    plan,
  });
  await invalidatePluginUi(bindings, threadId);
  const started = Date.now();
  let deadline = started + DX_PROMPT_SECONDS * 1_000;
  while (Date.now() < deadline && context.signal?.aborted !== true) {
    await waitForPromptAnswer(id, promptPollDelay(Date.now() - started));
    const state = await takePromptAnswer(db, id);
    if (state.status === "answered") return state.answer as DxOutcome;
    if (state.status === "gone") return "expired";
    // A change the owner applied just before the deadline still finishes.
    if (
      Date.now() >= deadline &&
      deadline < started + DX_PROMPT_SECONDS * 1_000 + APPLYING_GRACE_MS
    ) {
      const row = await db
        .prepare("SELECT status FROM plugin_ui_prompt WHERE id = ?")
        .bind(id)
        .first<{ status: string }>();
      if (row?.status === "applying") deadline += APPLYING_GRACE_MS;
    }
  }
  if (await expirePrompt(db, id)) await invalidatePluginUi(bindings, threadId);
  return "expired";
};
