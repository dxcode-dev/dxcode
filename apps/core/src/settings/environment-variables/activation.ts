import { isReservedEnvironmentVariableName } from "@dx/domain";
import { Redacted, Schema } from "effect";
import { encodeBase64Url } from "../../encoding/base64.js";
import {
  DXD_ENVIRONMENT_MAX_ENTRIES,
  DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES,
  DXD_ENVIRONMENT_MAX_VALUE_BYTES,
  type DxdEnvironmentActivateOperation,
  DxdEnvironmentActivateOperation as DxdEnvironmentActivateOperationSchema,
} from "../../execution/dxd/protocol.js";
import type { ExecutionEnvironmentSnapshot } from "./execution.js";

export const MAX_EFFECTIVE_ENVIRONMENT_ENTRIES = DXD_ENVIRONMENT_MAX_ENTRIES;
export const MAX_EFFECTIVE_ENVIRONMENT_VALUE_BYTES =
  DXD_ENVIRONMENT_MAX_VALUE_BYTES;
export const MAX_EFFECTIVE_ENVIRONMENT_TOTAL_BYTES =
  DXD_ENVIRONMENT_MAX_TOTAL_VALUE_BYTES;

export const environmentActivationOperation = (
  snapshot: ExecutionEnvironmentSnapshot,
  generation: number,
  git: DxdEnvironmentActivateOperation["git"] = {
    authorName: "dxcodeagent",
    authorEmail: "agent@dxcode.dev",
    threadUrl:
      "https://dx.example.test/threads/thr_00000000-0000-4000-8000-000000000000",
    signingEnabled: false,
  },
): DxdEnvironmentActivateOperation => {
  const encoder = new TextEncoder();
  let totalBytes = 0;
  const names = new Set<string>();
  const entries = snapshot.values
    .filter(({ name }) => !isReservedEnvironmentVariableName(name))
    .map(({ name, value }) => {
      if (names.has(name)) throw new Error("Duplicate environment variable.");
      names.add(name);
      const bytes = encoder.encode(Redacted.value(value));
      totalBytes += bytes.byteLength;
      if (
        bytes.byteLength < 1 ||
        bytes.byteLength > MAX_EFFECTIVE_ENVIRONMENT_VALUE_BYTES ||
        totalBytes > MAX_EFFECTIVE_ENVIRONMENT_TOTAL_BYTES
      )
        throw new Error("Environment snapshot exceeds its bounds.");
      return { name, valueBase64Url: encodeBase64Url(bytes) };
    });
  if (entries.length > MAX_EFFECTIVE_ENVIRONMENT_ENTRIES)
    throw new Error("Environment snapshot exceeds its bounds.");
  entries.sort((left, right) =>
    left.name < right.name ? -1 : left.name > right.name ? 1 : 0,
  );
  return Schema.decodeUnknownSync(DxdEnvironmentActivateOperationSchema)(
    { operation: "environment.activate", generation, entries, git },
    { onExcessProperty: "error" },
  );
};
