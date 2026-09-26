import type { LogRecord } from "@logtape/logtape";
import { describe, expect, it } from "vitest";
import { structuredConsoleFormatter } from "./logging.js";

describe("structured logging", () => {
  it("renders one structured object per record", () => {
    expect(
      structuredConsoleFormatter({
        timestamp: 0,
        level: "info",
        category: ["dx", "http", "request"],
        rawMessage: "Request completed.",
        message: ["Request completed."],
        properties: { event: "request_completed", status: 200 },
      } satisfies LogRecord),
    ).toEqual([
      {
        timestamp: "1970-01-01T00:00:00.000Z",
        level: "info",
        category: "dx.http.request",
        message: "Request completed.",
        event: "request_completed",
        status: 200,
      },
    ]);
  });
});
