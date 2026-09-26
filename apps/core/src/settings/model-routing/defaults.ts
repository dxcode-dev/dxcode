import {
  type ModeConfig,
  type ModeId,
  ModelId,
  type Profile,
} from "@dx/domain";
import { Schema } from "effect";

const model = (id: string): ModelId => Schema.decodeUnknownSync(ModelId)(id);

/**
 * Shipped production profile (decision 19). Modes resolve to canonical
 * catalog ids; a mode whose model has no serving connection is "not served"
 * until the user adds a provider or picks another model.
 */
export const DEFAULT_PROFILE: Profile = {
  id: "default",
  modes: {
    low: { agent: { model: model("openai/gpt-5.6-terra"), thinking: "max" } },
    medium: {
      agent: { model: model("openai/gpt-5.6-sol"), thinking: "high" },
    },
    high: { agent: { model: model("openai/gpt-6-astra"), thinking: "medium" } },
    ultra: {
      agent: { model: model("anthropic/claude-fable-5-1"), thinking: "high" },
    },
  },
};

export const defaultModeConfig = (mode: ModeId): ModeConfig =>
  DEFAULT_PROFILE.modes[mode];
