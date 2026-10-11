import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import {
  CreateThreadRequestSchema,
  FLUE_MAX_IMAGE_DATA_LENGTH,
  InitialThreadMessageSchema,
} from "./create-thread.js";

const projectId = "prj_00000000-0000-4000-8000-000000000072";
const threadId = "thr_00000000-0000-4000-8000-000000000073";
describe("Create Thread contract", () => {
  it("uses Flue's per-image attachment contract for the initial prompt", () => {
    const image = {
      type: "image",
      data: "not base64!",
      mimeType: "image/avif",
      filename: "x".repeat(256),
    };
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
        initialMessage: { body: "Prompt", attachments: [image] },
      }),
    ).toThrow();
    expect(
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
        initialMessage: {
          body: "Prompt",
          attachments: [{ ...image, data: "aGVsbG8\n" }],
        },
      }),
    ).toMatchObject({
      initialMessage: { attachments: [{ ...image, data: "aGVsbG8\n" }] },
    });
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: "a".repeat(FLUE_MAX_IMAGE_DATA_LENGTH + 1) },
        ],
      }),
    ).toThrow();
  });

  it("requires a stable Thread identifier for an initial prompt", () => {
    const initialMessage = { body: "Prompt", attachments: [] };
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        initialMessage,
      }),
    ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(CreateThreadRequestSchema)({
        projectId,
        threadId,
      }),
    ).toThrow();
  });

  it("allows Flue-sized initial prompts while requiring content", () => {
    const image = {
      type: "image" as const,
      mimeType: "image/png" as const,
    };
    for (const body of ["", "   \n\t"]) {
      expect(() =>
        Schema.decodeUnknownSync(InitialThreadMessageSchema)({
          body,
          attachments: [],
        }),
      ).toThrow();
    }
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: "A".repeat(FLUE_MAX_IMAGE_DATA_LENGTH + 1) },
        ],
      }),
    ).toThrow();
    const smallImage = { ...image, data: "aGVsbG8=" };
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "a".repeat(64 * 1024 + 1),
        attachments: Array.from({ length: 10 }, () => smallImage),
      }),
    ).toMatchObject({
      body: "a".repeat(64 * 1024 + 1),
      attachments: Array.from({ length: 10 }, () => smallImage),
    });
    expect(() =>
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: Array.from({ length: 11 }, () => smallImage),
      }),
    ).toThrow();
    const imageData = "A".repeat(8 * 1024 * 1024);
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "Prompt",
        attachments: [
          { ...image, data: imageData },
          { ...image, data: imageData },
        ],
      }).attachments,
    ).toHaveLength(2);
    expect(
      Schema.decodeUnknownSync(InitialThreadMessageSchema)({
        body: "",
        attachments: [{ ...image, data: "aGVsbG8=" }],
      }),
    ).toMatchObject({
      attachments: [{ ...image, data: "aGVsbG8=" }],
    });
  });
});
