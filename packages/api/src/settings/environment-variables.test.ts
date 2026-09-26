import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  ApplyBulkEnvironmentVariablesRequestSchema,
  ApplyBulkEnvironmentVariablesResponseSchema,
  CreateEnvironmentVariableResponseSchema,
  EnvironmentVariablesErrorResponseSchema,
  ListEnvironmentVariablesResponseSchema,
  PreviewBulkEnvironmentVariablesResponseSchema,
  RotateEnvironmentVariableResponseSchema,
} from "./environment-variables.js";

const secretValue = "synthetic-secret-value";
const item = {
  reference: {
    version: 1 as const,
    kind: "environment-variable" as const,
    id: "env_contract",
  },
  name: "BUILD_CHANNEL",
  kind: "secret" as const,
  scope: "personal" as const,
  enabled: true,
  source: "personal",
  value: "••••••••",
  createdAt: "2026-08-23T12:00:00.000Z",
  updatedAt: "2026-08-23T12:00:00.000Z",
  rotatedAt: "2026-08-23T12:00:00.000Z",
};

describe("environment variable API contracts", () => {
  it("keeps secret plaintext out of every response", () => {
    const created = Schema.decodeUnknownSync(
      CreateEnvironmentVariableResponseSchema,
    )({ status: "success", data: item });
    expect(JSON.stringify(created)).not.toContain(secretValue);

    const listed = Schema.decodeUnknownSync(
      ListEnvironmentVariablesResponseSchema,
    )({
      status: "success",
      data: {
        items: [item],
        precedence: ["personal", "project", "workspace"],
      },
    });
    expect(JSON.stringify(listed)).not.toContain(secretValue);
    expect(() =>
      Schema.decodeUnknownSync(ListEnvironmentVariablesResponseSchema)({
        ...listed,
        data: {
          ...listed.data,
          items: [{ ...item, value: secretValue }],
        },
      }),
    ).toThrow();
    for (const schema of [
      RotateEnvironmentVariableResponseSchema,
      ApplyBulkEnvironmentVariablesResponseSchema,
    ]) {
      expect(() =>
        Schema.decodeUnknownSync(schema)({
          status: "success",
          data:
            schema === RotateEnvironmentVariableResponseSchema
              ? { ...item, value: secretValue }
              : {
                  items: [{ ...item, value: secretValue }],
                  conflictBehavior: "replace",
                },
        }),
      ).toThrow();
    }
  });

  it("keeps bulk preview value-free and conflict behavior explicit", () => {
    const preview = Schema.decodeUnknownSync(
      PreviewBulkEnvironmentVariablesResponseSchema,
    )({
      status: "success",
      data: {
        items: [
          {
            line: 1,
            name: "BUILD_CHANNEL",
            status: "conflict",
            message: "This name already exists in the selected scope.",
          },
        ],
        canApply: true,
      },
    });
    expect(JSON.stringify(preview)).not.toContain(secretValue);
    expect(
      Schema.decodeUnknownSync(ApplyBulkEnvironmentVariablesRequestSchema)({
        scope: "personal",
        kind: "secret",
        contents: `BUILD_CHANNEL=${secretValue}`,
        conflictBehavior: "replace",
      }).conflictBehavior,
    ).toBe("replace");
  });

  it("decodes generic authorization errors without scope detail", () => {
    const response = {
      status: "error",
      data: {
        code: "SETTINGS_SCOPE_FORBIDDEN",
        message: "The settings scope is unavailable for this user.",
        requestId: "request-1",
      },
    };
    expect(
      Schema.decodeUnknownSync(EnvironmentVariablesErrorResponseSchema)(
        response,
      ),
    ).toEqual(response);
  });
});
