import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  configReferenceFor,
  EnvironmentVariableId,
  EnvironmentVariableName,
  EnvironmentVariablePlaintext,
  isReservedEnvironmentVariableName,
  MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS,
  MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH,
  MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES,
  MAX_ENVIRONMENT_VARIABLES_PER_SCOPE,
  normalizeEnvironmentVariableName,
} from "./environment-variable.js";

describe("environment variable domain", () => {
  it("publishes an opaque reusable reference without scope, name, or plaintext", () => {
    const id = Schema.decodeUnknownSync(EnvironmentVariableId)("env_reference");
    const reference = configReferenceFor(id);
    expect(reference).toEqual({
      version: 1,
      kind: "environment-variable",
      id,
    });
    expect(JSON.stringify(reference)).not.toMatch(/name|scope|value|secret/i);
  });

  it("validates normalized portable names and reserves runtime-owned names", () => {
    expect(normalizeEnvironmentVariableName("  BUILD_CHANNEL  ")).toBe(
      "BUILD_CHANNEL",
    );
    for (const name of [
      "BUILD_CHANNEL",
      "DX_PARITY_SCOPE",
      "_SYNTHETIC_2",
      "X".repeat(MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH),
    ]) {
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(EnvironmentVariableName)(name),
        ),
      ).toBe(true);
      expect(isReservedEnvironmentVariableName(name)).toBe(false);
    }
    for (const name of ["lowercase", "2_START", "WITH-DASH", "X".repeat(65)]) {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(EnvironmentVariableName)(name),
        ),
      ).toBe(true);
    }
    for (const name of [
      "PATH",
      "LOGNAME",
      "TERM",
      "HISTFILE",
      "TMUX_PANE",
      "BASHOPTS",
      "IFS",
      "_",
      "BETTER_AUTH_SECRET",
      "DX_ENV",
      "DX_CONFIG_ENCRYPTION_KEYS",
      "DX_SOURCE_COMMAND_SOCKET",
      "DX_STORAGE",
      "DX_INTEGRATION_BITBUCKET_OAUTH",
      "DX_BITBUCKET_GIT_TOKEN",
      "DX_BITBUCKET_GIT_ORIGIN",
      "DX_BITBUCKET_GIT_PATH",
      "CF_INTERNAL",
      "CLOUDFLARE_ACCOUNT_ID",
      "DYLD_INSERT_LIBRARIES",
    ]) {
      expect(isReservedEnvironmentVariableName(name)).toBe(true);
    }
  });

  it("exports stable scope, value, and bulk limits", () => {
    expect({
      name: MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH,
      valueBytes: MAX_ENVIRONMENT_VARIABLE_VALUE_BYTES,
      scope: MAX_ENVIRONMENT_VARIABLES_PER_SCOPE,
      bulk: MAX_ENVIRONMENT_VARIABLE_BULK_ITEMS,
    }).toEqual({ name: 64, valueBytes: 32_768, scope: 100, bulk: 100 });
    expect(() =>
      Schema.decodeUnknownSync(EnvironmentVariablePlaintext)(
        "x".repeat(32_768),
      ),
    ).not.toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EnvironmentVariablePlaintext)(
        "é".repeat(16_385),
      ),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EnvironmentVariablePlaintext)("before\0after"),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(EnvironmentVariablePlaintext)("\ud800"),
    ).toThrow();
  });
});
