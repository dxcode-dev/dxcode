import { Option, Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  EnvironmentVariableName,
  EnvironmentVariablePlaintext,
  environmentVariableNameProblem,
  isReservedEnvironmentVariableName,
  MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH,
  normalizeEnvironmentVariableName,
  RESERVED_ENVIRONMENT_VARIABLE_NAMES,
  RESERVED_ENVIRONMENT_VARIABLE_PREFIXES,
} from "./environment-variable.js";
import names from "./environment-variable-names.json" with { type: "json" };

describe("environment variable domain", () => {
  it("validates normalized portable names and reserves only names dx owns in Orbs", () => {
    expect(normalizeEnvironmentVariableName("  BUILD_CHANNEL  ")).toBe(
      "BUILD_CHANNEL",
    );
    for (const name of [
      ...names.allowed,
      "_SYNTHETIC_2",
      "X".repeat(MAX_ENVIRONMENT_VARIABLE_NAME_LENGTH),
    ]) {
      expect(
        Option.isSome(
          Schema.decodeUnknownOption(EnvironmentVariableName)(name),
        ),
        name,
      ).toBe(true);
      expect(isReservedEnvironmentVariableName(name), name).toBe(false);
      expect(environmentVariableNameProblem(name), name).toBeUndefined();
    }
    for (const name of ["lowercase", "2_START", "WITH-DASH", "X".repeat(65)]) {
      expect(
        Option.isNone(
          Schema.decodeUnknownOption(EnvironmentVariableName)(name),
        ),
      ).toBe(true);
    }
    // The fixture is the whole list; dxd's test compares its own to it too.
    expect([...RESERVED_ENVIRONMENT_VARIABLE_NAMES].sort()).toEqual(
      names.names,
    );
    expect(RESERVED_ENVIRONMENT_VARIABLE_PREFIXES).toEqual(names.prefixes);
    for (const name of [
      ...names.names,
      ...names.prefixes.map((prefix) => `${prefix}X`),
    ]) {
      expect(isReservedEnvironmentVariableName(name), name).toBe(true);
      expect(environmentVariableNameProblem(name)).toBe(
        `${name} is set by dx in Orbs. Choose a different name.`,
      );
    }
    expect(environmentVariableNameProblem("1ABC")).toBe(
      "Use uppercase letters, digits, and underscores, not starting with a digit (e.g. MY_VAR).",
    );
    expect(environmentVariableNameProblem("X".repeat(65))).toBe(
      "Name must be 64 characters or fewer.",
    );
  });

  it("bounds plaintext by UTF-8 bytes and rejects NUL and lone surrogates", () => {
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
