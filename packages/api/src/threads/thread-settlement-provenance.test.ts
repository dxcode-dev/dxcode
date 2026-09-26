import { describe, expect, it } from "vitest";
import { threadSettlementProvenance } from "./thread-settlement-provenance.js";

const executionFailure = {
  version: 1,
  stage: "model",
  code: "cancelled",
  abortSource: "user",
  requestDisposition: "sent_uncommitted",
  retryDisposition: "aborted",
  safeMessage: "The response was cancelled before it completed.",
  correlationId: "correlation-id",
};

describe("threadSettlementProvenance", () => {
  it("recognizes explicit user cancellation metadata", () => {
    expect(
      threadSettlementProvenance({
        meta: { dxExecutionFailure: executionFailure },
      }),
    ).toBe("user-stop");
  });

  it("recognizes Flue's typed native response to an explicit abort request", () => {
    expect(
      threadSettlementProvenance({
        name: "SubmissionAbortedError",
        message: "Submission was aborted.",
        type: "submission_aborted",
        details: "The operation was stopped before completion.",
      }),
    ).toBe("user-stop");
    expect(
      threadSettlementProvenance({
        type: "submission_interrupted",
        message: "The lifecycle ended unexpectedly.",
      }),
    ).toBe("non-user");
    expect(
      threadSettlementProvenance({
        type: "submission_aborted",
        meta: {
          dxExecutionFailure: {
            ...executionFailure,
            abortSource: "provider",
          },
        },
      }),
    ).toBe("non-user");
  });

  it.each([undefined, {}, { type: "submission_interrupted" }])(
    "keeps unknown abort provenance non-user: %j",
    (error) => {
      expect(threadSettlementProvenance(error)).toBe("non-user");
    },
  );
});
