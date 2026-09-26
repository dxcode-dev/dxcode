import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { PageLimitQuerySchema } from "./page-limit-query.js";

describe("PageLimitQuerySchema", () => {
  it("decodes and encodes the supported HTTP lexical form", () => {
    for (const value of ["1", "20", "100"]) {
      const decoded = Schema.decodeSync(PageLimitQuerySchema)(value);
      expect(decoded).toBe(Number(value));
      expect(Schema.encodeSync(PageLimitQuerySchema)(decoded)).toBe(value);
    }
  });

  it("rejects values outside the range and non-canonical lexical forms", () => {
    for (const value of ["0", "101", " 20", "+20", "2e1", "2.0", "-1"]) {
      expect(() => Schema.decodeSync(PageLimitQuerySchema)(value)).toThrow();
    }
  });
});
