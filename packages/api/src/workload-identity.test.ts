import {
  WorkloadIdentityAudience,
  WorkloadIdentityTtlSeconds,
} from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { IssueWorkloadIdentityRequestSchema } from "./workload-identity.js";

const decodeAudience = Schema.decodeUnknownSync(WorkloadIdentityAudience);
const decodeTtl = Schema.decodeUnknownSync(WorkloadIdentityTtlSeconds);

describe("workload identity API", () => {
  it.each(["", "contains a space", "\n", "x".repeat(257)])(
    "rejects an invalid audience",
    (audience) => {
      expect(() => decodeAudience(audience)).toThrow();
    },
  );

  it.each([59, 3_601, 60.5, Number.NaN, "300"])(
    "rejects an invalid TTL",
    (ttl) => {
      expect(() => decodeTtl(ttl)).toThrow();
    },
  );

  it("rejects caller-supplied identity claims", () => {
    expect(() =>
      Schema.decodeUnknownSync(IssueWorkloadIdentityRequestSchema)(
        {
          audience: "sts.amazonaws.com",
          threadId: "attacker-selected-thread",
        },
        { onExcessProperty: "error" },
      ),
    ).toThrow();
  });
});
