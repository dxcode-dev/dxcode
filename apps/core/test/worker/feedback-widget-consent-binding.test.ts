import { afterEach, describe, expect, it, vi } from "vitest";
import {
  allow,
  claim,
  pkce,
  signUp,
  start,
  widgetFor,
} from "./feedback-widget-fixture.js";

// Anyone can pick a verifier and put its challenge in a sign-in link (#2406).
// dx records consent only for a sign-in a widget panel started for that
// widget in the last 10 minutes, and issues a grant only for that sign-in,
// once, within 10 minutes of Allow (#2420).

const minutes = (count: number) => count * 60 * 1000;

afterEach(() => vi.useRealTimers());

describe("Feedback Widget consent is bound on the server to the sign-in a panel started", () => {
  it("records nothing for a challenge no panel started", async () => {
    const person = await signUp("widget-unstarted@example.com");
    const site = await widgetFor(person);
    // The attacker keeps the verifier and gets the person to choose Allow.
    const { verifier, challenge } = await pkce();
    const allowed = await allow(person, site, challenge);
    expect(allowed.status).toBe(400);
    expect(await allowed.text()).toMatch(/choose Continue with dx/);
    expect((await claim(site, verifier)).status).toBe(202);
  });

  it("records nothing for a challenge started for another widget", async () => {
    const person = await signUp("widget-other-site@example.com");
    const siteA = await widgetFor(person);
    const siteB = await widgetFor(person);
    const { verifier, challenge } = await pkce();
    expect((await start(siteB, challenge)).status).toBe(204);
    expect((await allow(person, siteA, challenge)).status).toBe(400);
    expect((await claim(siteA, verifier)).status).toBe(202);
    expect((await claim(siteB, verifier)).status).toBe(202);
  });

  it("refuses Allow on a sign-in started more than 10 minutes ago", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const person = await signUp("widget-stale-start@example.com");
    const site = await widgetFor(person);
    const { verifier, challenge } = await pkce();
    expect((await start(site, challenge)).status).toBe(204);
    vi.setSystemTime(Date.now() + minutes(11));
    expect((await allow(person, site, challenge)).status).toBe(400);
    expect((await claim(site, verifier)).status).toBe(202);
  });

  it("issues no grant for a consent left unclaimed for more than 10 minutes", async () => {
    vi.useFakeTimers({ toFake: ["Date"], now: Date.now() });
    const person = await signUp("widget-stale-consent@example.com");
    const site = await widgetFor(person);
    const { verifier, challenge } = await pkce();
    expect((await start(site, challenge)).status).toBe(204);
    expect((await allow(person, site, challenge)).status).toBe(200);
    vi.setSystemTime(Date.now() + minutes(11));
    expect((await claim(site, verifier)).status).toBe(202);
  });

  it("issues one grant for the sign-in the panel started", async () => {
    const person = await signUp("widget-bound-sign-in@example.com");
    const site = await widgetFor(person);
    const { verifier, challenge } = await pkce();
    expect((await start(site, challenge)).status).toBe(204);
    // Starting the same sign-in again changes nothing.
    expect((await start(site, challenge)).status).toBe(204);
    expect((await allow(person, site, challenge)).status).toBe(200);
    const claimed = await claim(site, verifier);
    expect(claimed.status).toBe(200);
    expect(
      ((await claimed.json()) as { data: { token: string } }).data.token,
    ).toMatch(/^dxw_/);
    expect((await claim(site, verifier)).status).toBe(202);
    // A spent sign-in can't be allowed again.
    expect((await allow(person, site, challenge)).status).toBe(400);
  });

  it("refuses to start a sign-in for a widget that is off or a malformed challenge", async () => {
    const person = await signUp("widget-start-refused@example.com");
    const site = await widgetFor(person);
    expect(
      (await start("fbw_aaaaaaaaaaaaaaaaaaaaaaaa", (await pkce()).challenge))
        .status,
    ).toBe(404);
    expect((await start(site, "not-a-challenge")).status).toBe(400);
  });
});
