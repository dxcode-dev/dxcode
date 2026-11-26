import { useState } from "react";
import { useMountEffect } from "../hooks/use-mount-effect.js";
import { nativeShellWith, onShellEvent } from "./native-shell.js";

/**
 * Pair this Mac from the Add runner dialog, when dx runs inside a shell that
 * is also a runner (the Mac app): the shell pairs its bundled runner with
 * the code, so nobody copies a command into a terminal. Undefined in a
 * browser, where the dialog shows only the install command.
 */
export const usePairThisMachine = (code: string | undefined) => {
  const [status, setStatus] = useState<string | undefined>(undefined);
  useMountEffect(() =>
    nativeShellWith("runner") === undefined
      ? undefined
      : onShellEvent((event) => {
          if (event.type !== "runner.paired") return;
          setStatus(
            event.ok
              ? undefined
              : `Could not pair: ${event.error ?? "unknown error"}`,
          );
        }),
  );
  const shell = nativeShellWith("runner");
  if (shell === undefined || code === undefined) return undefined;
  return {
    status,
    pair: () => {
      setStatus("Pairing this Mac…");
      shell.post({ type: "runner.pair", code });
    },
  };
};
