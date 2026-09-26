import { describe, expect, it } from "vitest";
import { coarseSessionDevice, redactSessionNetwork } from "./repository-d1.js";

describe("personal security session metadata", () => {
  it("redacts valid IPv4 and IPv6 addresses and rejects arbitrary values", () => {
    expect(redactSessionNetwork("203.0.113.42")).toBe("203.0.113.x");
    expect(redactSessionNetwork("2001:db8:abcd:1234:5678:90ab:cdef:1234")).toBe(
      "2001:db8:abcd:1234::/64",
    );
    expect(redactSessionNetwork("2001:db8::5678:90ab:cdef:1234")).toBe(
      "2001:db8:0:0::/64",
    );
    expect(redactSessionNetwork("workstation.internal")).toBe(
      "Unknown network",
    );
    expect(redactSessionNetwork(null)).toBe("Unknown network");
  });

  it("reduces user agents to browser and operating-system classes", () => {
    expect(
      coarseSessionDevice(
        "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 Chrome/140.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on macOS");
    expect(coarseSessionDevice("private-custom-agent/with-identifiers")).toBe(
      "Unknown browser on unknown device",
    );
  });
});
