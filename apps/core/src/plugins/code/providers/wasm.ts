import baseVariant from "@jitl/quickjs-wasmfile-release-sync";
import {
  newQuickJSWASMModuleFromVariant,
  newVariant,
} from "quickjs-emscripten-core";
// A literal .wasm suffix lets the Cloudflare plugin recognize the compiled module.
import wasmModule from "../../../../node_modules/@jitl/quickjs-wasmfile-release-sync/dist/emscripten-module.wasm";

// Workerd instantiates a precompiled module, never fetches or compiles wasm bytes.
let modulePromise:
  | ReturnType<typeof newQuickJSWASMModuleFromVariant>
  | undefined;
export const getCodeWasm = () =>
  (modulePromise ??= newQuickJSWASMModuleFromVariant(
    newVariant(
      // Upstream publishes CJS-shaped declarations for its ESM default export.
      baseVariant as unknown as Extract<
        Parameters<typeof newVariant>[0],
        { type: "sync" }
      >,
      { wasmModule },
    ),
  ));
