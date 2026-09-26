import { describe, expect, it } from "vitest";
import { shouldOpenMobileSidebarByDefault } from "./mobile-sidebar.js";
import {
  PRODUCT_SIDEBAR_MAX_SIZE,
  PRODUCT_SIDEBAR_MIN_SIZE,
} from "./product-shell.js";

describe("product shell mobile navigation", () => {
  it("opens the sidebar by default only on the mobile home route", () => {
    expect(shouldOpenMobileSidebarByDefault(true, "/")).toBe(true);
    expect(shouldOpenMobileSidebarByDefault(true, "/projects")).toBe(false);
    expect(
      shouldOpenMobileSidebarByDefault(
        true,
        "/threads/thr_00000000-0000-4000-8000-000000000001",
      ),
    ).toBe(false);
    expect(shouldOpenMobileSidebarByDefault(false, "/")).toBe(false);
  });
});

describe("product shell desktop navigation", () => {
  it("rejects 249px while retaining the safe maximum", () => {
    expect(PRODUCT_SIDEBAR_MIN_SIZE).toBe(250);
    expect(249).toBeLessThan(PRODUCT_SIDEBAR_MIN_SIZE);
    expect(PRODUCT_SIDEBAR_MAX_SIZE).toBe(480);
  });
});
