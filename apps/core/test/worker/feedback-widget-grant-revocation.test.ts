import { describe, expect, it } from "vitest";
import {
  type Browser,
  grant,
  panelStatus,
  password,
  signIn,
  signUp,
  widgetFor,
} from "./feedback-widget-fixture.js";

// A Feedback Widget grant lets a website's widget panel start Threads as the
// person who allowed it. Signing out everywhere or changing the password is
// what someone does after losing a laptop, so both must end every grant
// (#2420). Signing out one browser leaves them.

const otherSessionId = async (current: Browser) => {
  const response = await current.request(
    "/v1/settings/personal/security/sessions",
  );
  expect(response.status).toBe(200);
  const body = (await response.json()) as {
    data: { items: Array<{ id: string; isCurrent: boolean }> };
  };
  const other = body.data.items.find((session) => !session.isCurrent);
  if (other === undefined) throw new Error("Expected another session.");
  return other.id;
};

describe("Feedback Widget grants end with the person's sessions", () => {
  it("Sign out other sessions ends every grant; signing out one browser does not", async () => {
    const email = "widget-sign-out-everywhere@example.com";
    const laptop = await signUp(email);
    const phone = await signIn(email);
    const siteA = await widgetFor(laptop);
    const siteB = await widgetFor(laptop);
    const tokenA = await grant(laptop, siteA);
    const tokenB = await grant(phone, siteB);
    // Someone else's grant is theirs to end.
    const bystander = await signUp("widget-bystander@example.com");
    const bystanderSite = await widgetFor(bystander);
    const bystanderToken = await grant(bystander, bystanderSite);

    const oneBrowser = await laptop.request(
      `/v1/settings/personal/security/sessions/${await otherSessionId(laptop)}`,
      { method: "DELETE" },
    );
    expect(oneBrowser.status).toBe(200);
    expect(await panelStatus(siteA, tokenA)).toBe(200);
    expect(await panelStatus(siteB, tokenB)).toBe(200);

    await signIn(email);
    const everywhere = await laptop.request(
      "/v1/settings/personal/security/sessions/revoke-others",
      { method: "POST" },
    );
    expect(everywhere.status).toBe(200);
    expect(await panelStatus(siteA, tokenA)).toBe(401);
    expect(await panelStatus(siteB, tokenB)).toBe(401);
    expect(await panelStatus(bystanderSite, bystanderToken)).toBe(200);

    // Continue with dx again works as before.
    expect(await panelStatus(siteA, await grant(laptop, siteA))).toBe(200);
  });

  it("changing the password ends every grant", async () => {
    const email = "widget-password-change@example.com";
    const laptop = await signUp(email);
    const site = await widgetFor(laptop);
    const token = await grant(laptop, site);
    expect(await panelStatus(site, token)).toBe(200);

    await laptop.json("/api/auth/change-password", {
      currentPassword: password,
      newPassword: "widget-grant-password-456",
    });
    expect(await panelStatus(site, token)).toBe(401);

    const again = await signIn(email, "widget-grant-password-456");
    expect(await panelStatus(site, await grant(again, site))).toBe(200);
  });
});
