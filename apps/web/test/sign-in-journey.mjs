// Local sign-in journey against a supervised `pnpm dev` started with every
// sign-in provider enabled (see wiki/development-workflow.md, "Previewing
// sign-in providers"). Drives the agent-browser Chromium over CDP and writes
// screenshots, a video, a HAR, console output, and summary.json to <output>.
// Never contacts deployed providers: email goes to Miniflare's local outbox.
//
//   DX_PROOF_CDP=$(agent-browser get cdp-url) \
//     node apps/web/test/sign-in-journey.mjs http://127.0.0.1:3000 . out/
import assert from "node:assert/strict";
import {
  mkdirSync,
  readdirSync,
  readFileSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, checkout, outputArgument] = process.argv.slice(2);
assert(new URL(base).hostname === "127.0.0.1", "The journey is local-only.");
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const credentials = parseEnv(
  readFileSync(resolve(checkout, "apps/core/.dev.vars"), "utf8"),
);
const outbox = resolve(checkout, "apps/core/.wrangler/tmp/email");

const browser = await chromium.connectOverCDP(process.env.DX_PROOF_CDP);
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  colorScheme: "dark",
  recordHar: { path: join(output, "network.har"), content: "omit" },
  recordVideo: { dir: output, size: { width: 1280, height: 820 } },
});
// The development-only render inspector draws over every frame.
await context.addInitScript(() => {
  const style = document.createElement("style");
  style.textContent =
    "#react-scan-root, html > canvas, html > div:not(#root) { display: none !important; }";
  document.addEventListener("DOMContentLoaded", () =>
    document.documentElement.append(style),
  );
});
const page = await context.newPage();
const consoleMessages = [];
const pageErrors = [];
page.on("console", (message) =>
  consoleMessages.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));

const steps = [];
const step = async (name, run) => {
  const started = Date.now();
  try {
    await run();
  } catch (error) {
    await page
      .screenshot({ path: join(output, "failure.png") })
      .catch(() => {});
    console.error(`✗ ${name} at ${page.url()}`);
    throw error;
  }
  steps.push({ name, ms: Date.now() - started });
  console.log(`✓ ${name}`);
};
const shot = (name) => page.screenshot({ path: join(output, `${name}.png`) });
const heading = (name) => page.getByRole("heading", { name, level: 1 });

const newestEmail = (after) => {
  const files = readdirSync(outbox, { recursive: true })
    .map(String)
    .filter((file) => file.endsWith(".txt"))
    .map((file) => join(outbox, file))
    .filter((file) => statSync(file).mtimeMs > after)
    .sort((a, b) => statSync(b).mtimeMs - statSync(a).mtimeMs);
  assert(files[0], "No local email was written.");
  return {
    text: readFileSync(files[0], "utf8"),
    html: readFileSync(
      files[0].replace("email-text", "email-html").replace(/\.txt$/, ".html"),
      "utf8",
    ),
  };
};

const signOut = async () => {
  const response = await context.request.post(`${base}/api/auth/sign-out`, {
    headers: { origin: base },
    data: {},
  });
  assert(response.ok(), `sign-out ${response.status()}`);
};

try {
  await step(
    "a signed-out deep link opens /signin and keeps the destination",
    async () => {
      // A controllable clock lets the next step age the session past staleTime.
      await page.clock.install();
      await page.goto(`${base}/threads/abc?view=files`);
      await heading("Sign in to dx").waitFor();
      const url = new URL(page.url());
      assert.equal(url.pathname, "/signin");
      assert.equal(url.searchParams.get("next"), "/threads/abc?view=files");
      await page.getByRole("button", { name: "Continue with email" }).waitFor();
      await page
        .getByRole("button", { name: "Continue with Google" })
        .waitFor();
      await page
        .getByRole("button", { name: "Sign in with a password" })
        .waitFor();
      await page.getByRole("link", { name: "Terms of Service" }).waitFor();
      await shot("01-signin-dark");
    },
  );

  await step("a focus refetch keeps the typed email (no reload)", async () => {
    const email = page.getByLabel("Email");
    await email.fill("keep-me@example.com");
    // Coming back to a tab after a few minutes refetches the session.
    await page.clock.fastForward("05:00");
    const refetch = page.waitForResponse((response) =>
      response.url().includes("/api/auth/get-session"),
    );
    await page.evaluate(() => {
      window.dispatchEvent(new Event("visibilitychange"));
      window.dispatchEvent(new Event("focus"));
    });
    await refetch;
    await page.waitForTimeout(2500);
    assert.equal(await email.inputValue(), "keep-me@example.com");
    assert.equal(await page.locator(".dx-loading").count(), 0);
  });

  const waitlisted = `journey-${Date.now()}@example.com`;
  await step("an unknown email opens the waitlist dialog", async () => {
    await page.getByLabel("Email").fill(waitlisted);
    await page.getByRole("button", { name: "Continue with email" }).click();
    const dialog = page.getByRole("dialog");
    await dialog
      .getByRole("heading", { name: "You're on the waitlist" })
      .waitFor();
    assert.match(await dialog.innerText(), new RegExp(waitlisted));
    await page.waitForTimeout(300);
    await shot("02-waitlist-dialog");
    await dialog.getByRole("button", { name: "Got it" }).click();
    await dialog.waitFor({ state: "hidden" });
    await heading("Sign in to dx").waitFor();
  });

  await step(
    "a password sign-up for an unapproved email joins the waitlist",
    async () => {
      await page.goto(`${base}/signup`);
      await heading("Create your dx account").waitFor();
      await page
        .getByRole("button", { name: "Create an account with a password" })
        .click();
      const email = `journey-signup-${Date.now()}@example.com`;
      await page.getByLabel("Name").fill("Journey Person");
      await page.getByLabel("Email").fill(email);
      await page.getByLabel("Password").fill("journey-password-123");
      await page.getByRole("button", { name: "Create account" }).click();
      const dialog = page.getByRole("dialog");
      await dialog
        .getByRole("heading", { name: "You're on the waitlist" })
        .waitFor();
      assert.match(await dialog.innerText(), new RegExp(email));
      await shot("02b-signup-waitlisted");
      await dialog.getByRole("button", { name: "Got it" }).click();
    },
  );

  await step(
    "Continue with Google starts Google's consent with this deployment's callback",
    async () => {
      // Stub Google so the journey never leaves the local machine.
      let authorization;
      await page.route("https://accounts.google.com/**", (route) => {
        authorization = new URL(route.request().url());
        return route.fulfill({
          contentType: "text/html",
          body: "<h1>Google consent (stub)</h1>",
        });
      });
      await page.goto(`${base}/signin?next=%2Fprojects`);
      await page.getByRole("button", { name: "Continue with Google" }).click();
      await page
        .getByRole("heading", { name: "Google consent (stub)" })
        .waitFor();
      assert(authorization, "The browser did not open Google.");
      assert.equal(
        authorization.searchParams.get("redirect_uri"),
        `${base}/api/auth/callback/google`,
      );
      assert(authorization.searchParams.get("client_id"));
      assert(authorization.searchParams.get("state"));
      await page.unroute("https://accounts.google.com/**");
    },
  );

  await step("the page follows a light system appearance", async () => {
    await page.emulateMedia({ colorScheme: "light" });
    await page.waitForTimeout(200);
    await shot("03-signin-light");
    await page.emulateMedia({ colorScheme: "dark" });
  });

  await step(
    "provider redirects explain failures and the waitlist",
    async () => {
      await page.goto(`${base}/signin?error=INVALID_TOKEN`);
      await page
        .getByRole("alert")
        .filter({ hasText: "invalid or was already used" })
        .waitFor();
      await shot("04-expired-link");
      await page.goto(`${base}/signin?error=waitlisted`);
      await page
        .getByRole("dialog")
        .getByRole("heading", { name: "You're on the waitlist" })
        .waitFor();
      await page.getByRole("button", { name: "Got it" }).click();
      await page.waitForURL((url) => !url.searchParams.has("error"));
    },
  );

  await step(
    "a magic link signs an existing user in and opens the destination",
    async () => {
      await page.goto(`${base}/signin?next=%2Fsettings`);
      const sentAfter = Date.now();
      await page.getByLabel("Email").fill(credentials.DX_LOCAL_AUTH_EMAIL);
      await page.getByRole("button", { name: "Continue with email" }).click();
      await page.getByRole("heading", { name: "Check your email" }).waitFor();
      assert.match(
        await page.getByRole("status").innerText(),
        new RegExp(credentials.DX_LOCAL_AUTH_EMAIL),
      );
      await shot("05-check-email");
      await page.waitForTimeout(1500);
      const resentAfter = Date.now();
      await page.getByRole("button", { name: "Resend link" }).click();
      await page.getByRole("button", { name: "Sent again" }).waitFor();
      await page.waitForTimeout(1500);
      // The resend wrote a second email; sign in with the newest link.
      const email = newestEmail(resentAfter - 500);
      assert(
        email.text.includes(credentials.DX_LOCAL_AUTH_EMAIL) ||
          email.text.includes("Sign in to dx"),
      );
      const link = /https?:\/\/\S+/.exec(email.text)?.[0];
      assert(link, "The email has no sign-in link.");
      const preview = await context.newPage();
      await preview.setContent(email.html);
      await preview.screenshot({ path: join(output, "06-sign-in-email.png") });
      await preview.close();
      await page.goto(link);
      await page.waitForURL((url) => url.pathname.startsWith("/settings"));
      await page.waitForTimeout(2500);
      assert.equal(await heading("Sign in to dx").count(), 0);
      await shot("07-signed-in-settings");
    },
  );

  await step("a signed-in visit to /signin continues to next", async () => {
    await page.goto(`${base}/signin?next=%2Fprojects`);
    await page.waitForURL((url) => url.pathname === "/projects");
  });

  await step("password sign-in works beside magic link", async () => {
    await signOut();
    await page.goto(`${base}/signin?next=%2Fprojects`);
    await page.getByRole("button", { name: "Sign in with a password" }).click();
    await page.getByLabel("Email").fill(credentials.DX_LOCAL_AUTH_EMAIL);
    await page.getByLabel("Password").fill(credentials.DX_LOCAL_AUTH_PASSWORD);
    await shot("08-password");
    await page.getByRole("button", { name: "Sign in", exact: true }).click();
    await page.waitForURL((url) => url.pathname === "/projects");
  });

  await step(
    "a wrong password shows an error and keeps the email",
    async () => {
      await signOut();
      await page.goto(`${base}/signin`);
      await page
        .getByRole("button", { name: "Sign in with a password" })
        .click();
      await page.getByLabel("Email").fill(credentials.DX_LOCAL_AUTH_EMAIL);
      await page.getByLabel("Password").fill("not-the-password");
      await page.getByRole("button", { name: "Sign in", exact: true }).click();
      await page
        .getByRole("alert")
        .filter({ hasText: "don't match" })
        .waitFor();
      assert.equal(
        await page.getByLabel("Email").inputValue(),
        credentials.DX_LOCAL_AUTH_EMAIL,
      );
      await shot("09-wrong-password");
    },
  );

  await step(
    "an existing user can sign in from a workspace invite link",
    async () => {
      const api = async (path, method = "GET", data) => {
        const response = await context.request.fetch(`${base}${path}`, {
          method,

          ...(data === undefined ? {} : { data }),

          headers: { origin: base },
        });

        return { status: response.status(), body: await response.json() };
      };

      const signedIn = await api("/api/auth/sign-in/email", "POST", {
        email: credentials.DX_LOCAL_AUTH_EMAIL,

        password: credentials.DX_LOCAL_AUTH_PASSWORD,
      });

      assert.equal(signedIn.status, 200);

      const created = await api("/v1/settings/workspaces", "POST", {
        displayName: "Journey Team",

        shortName: `journey-${Date.now().toString(36)}`,
      });

      const personal = await api("/v1/settings/personal");

      const slug = (JSON.stringify(
        created.status < 300 ? created.body : personal.body,
      ).match(/"shortName":"([^"]+)"/) ?? [])[1];

      assert(slug, `No workspace for the invite (${created.status}).`);

      const link = await api(
        `/v1/settings/workspaces/${slug}/invite-links`,

        "POST",

        { title: "Journey invite" },
      );

      assert.equal(link.status, 201, JSON.stringify(link.body));

      const invitePath = new URL(
        JSON.stringify(link.body).match(
          /https?:\/\/[^"]+\/join\/[A-Za-z0-9_-]{43}/,
        )[0],
      ).pathname;

      await signOut();

      await page.goto(`${base}${invitePath}`);

      await heading(/^Join .+ on dx$/).waitFor();

      await shot("10a-invite-sign-up");

      await page.getByRole("button", { name: "Sign in", exact: true }).click();

      await page
        .getByRole("button", { name: "Sign in with a password" })
        .click();

      await page.getByLabel("Email").fill(credentials.DX_LOCAL_AUTH_EMAIL);

      await page
        .getByLabel("Password")
        .fill(credentials.DX_LOCAL_AUTH_PASSWORD);

      await shot("10b-invite-sign-in");
      // Better Auth allows three password sign-ins per IP every 10 seconds.
      await page.waitForTimeout(11_000);

      await page

        .locator("form")

        .getByRole("button", { name: "Sign in", exact: true })

        .click();

      await page.waitForURL((url) => url.pathname === invitePath);

      await page.waitForTimeout(1500);

      assert.equal(await heading(/^Join .+ on dx$/).count(), 0);
    },
  );

  await step("the page fits a phone screen", async () => {
    await signOut();
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto(`${base}/signin`);
    await heading("Sign in to dx").waitFor();
    await shot("10-signin-mobile");
  });
} finally {
  const video = page.video();
  await context.close();
  await browser.close();
  writeFileSync(
    join(output, "summary.json"),
    `${JSON.stringify(
      {
        base,
        steps,
        video: video ? await video.path() : undefined,
        consoleErrors: consoleMessages.filter(
          (message) => message.type === "error",
        ),
        consoleMessages: consoleMessages.length,
        pageErrors,
      },
      null,
      2,
    )}\n`,
  );
  writeFileSync(
    join(output, "console.json"),
    `${JSON.stringify(consoleMessages, null, 2)}\n`,
  );
}
assert.deepEqual(pageErrors, [], "The journey raised page errors.");
console.log(`Journey passed; evidence in ${output}`);
