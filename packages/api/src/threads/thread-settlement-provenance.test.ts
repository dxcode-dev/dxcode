import { describe, expect, it } from "vitest";
import { threadSettlementProvenance } from "./thread-settlement-provenance.js";

describe("threadSettlementProvenance", () => {
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
            version: 1,
            stage: "model",
            code: "cancelled",
            abortSource: "provider",
          },
        },
      }),
    ).toBe("non-user");
  });
});
