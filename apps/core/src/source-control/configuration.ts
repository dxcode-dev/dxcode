import { Option, Schema } from "effect";
import type { Bindings } from "../http/types.js";

const ShallowCloneFlag = Schema.Literal("true");

export const loadSourceWorkspaceConfiguration = (bindings: Bindings) => ({
  shallowClone:
    bindings.DX_ENV === "preview" &&
    Option.isSome(
      Schema.decodeUnknownOption(ShallowCloneFlag)(
        bindings.DX_SOURCE_SHALLOW_CLONE,
      ),
    ),
});
