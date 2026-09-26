import { UsagePriceMetadata } from "@dx/domain";
import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { MODEL_CATALOG_SOURCE } from "../model-routing/catalog.js";
import { catalogUsagePrice } from "./pricing.js";

describe("usage pricing", () => {
  it("derives versioned, effective-dated estimated USD metadata from the bundled catalog", () => {
    const price = catalogUsagePrice("cloudflare", "@cf/zai-org/glm-5.2");
    expect(price).toBeDefined();
    if (price === undefined) return;

    const encoded = Schema.encodeSync(UsagePriceMetadata)(price);
    expect(encoded).toMatchObject({
      providerId: "cloudflare",
      modelId: "@cf/zai-org/glm-5.2",
      currency: "USD",
      source: "catalog",
      sourceVersion: MODEL_CATALOG_SOURCE,
      effectiveTo: null,
      estimated: true,
    });
    expect(Date.parse(encoded.freshUntil)).toBeGreaterThan(
      Date.parse(encoded.effectiveFrom),
    );
  });

  it("does not fabricate price metadata for an unknown model", () => {
    expect(catalogUsagePrice("cloudflare", "unknown-model")).toBeUndefined();
  });
});
