// Dictation proof: records through the real composer with Chromium's fake
// microphone playing a WAV, then measures the time from pressing stop to the
// transcript appearing in the prompt. Two runs per clip: the live socket
// (no upload may happen), and the socket refused so the composer must upload
// the recording instead. Writes report.json, a HAR, console output, page
// errors, and screenshots to <output>. Chromium's fake microphone starts
// playing at getUserMedia, before dx shows that it is recording, so start
// each clip with about 1.5 s of silence, as a speaker waits for the cue.
//
// Local (`pnpm dev -- --ui-only`, fixture transcript, no external calls):
//   node apps/web/test/dictation-latency-proof.mjs http://127.0.0.1:3640 out/ clip.wav
// Against real Sarvam (a deployed preview), set DX_PROOF_EXPECT to the
// "|"-separated phrases each transcript must hold; a preview also needs
// DX_PROOF_EMAIL and DX_PROOF_PASSWORD.
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const [base, outputArgument, ...clips] = process.argv.slice(2);
assert(
  base && outputArgument && clips.length > 0,
  "usage: <base> <output> <clip.wav>...",
);
const output = resolve(outputArgument);
mkdirSync(output, { recursive: true });
const local = new URL(base).hostname === "127.0.0.1";
const credentials = local
  ? (() => {
      const vars = parseEnv(
        readFileSync(
          resolve(import.meta.dirname, "../../core/.dev.vars"),
          "utf8",
        ),
      );
      return {
        email: vars.DX_LOCAL_AUTH_EMAIL,
        password: vars.DX_LOCAL_AUTH_PASSWORD,
      };
    })()
  : {
      email: process.env.DX_PROOF_EMAIL,
      password: process.env.DX_PROOF_PASSWORD,
    };
assert(
  credentials.email && credentials.password,
  "Sign-in credentials are required.",
);
const expected = process.env.DX_PROOF_EXPECT
  ? process.env.DX_PROOF_EXPECT.split("|")
  : ["This is a local dictation fixture."];
const budgetMs = Number(process.env.DX_PROOF_BUDGET_MS ?? 2_000);

const clipSeconds = (path) => {
  const bytes = readFileSync(path);
  return bytes.readUInt32LE(40) / bytes.readUInt32LE(28);
};

const results = [];
const consoleMessages = [];
const pageErrors = [];

for (const clip of clips) {
  const seconds = clipSeconds(clip);
  for (const mode of ["live", "upload"]) {
    const name = `${clip
      .split("/")
      .pop()
      .replace(/\.wav$/, "")}-${mode}`;
    const browser = await chromium.launch({
      args: [
        "--use-fake-ui-for-media-stream",
        "--use-fake-device-for-media-stream",
        `--use-file-for-fake-audio-capture=${resolve(clip)}%noloop`,
        "--autoplay-policy=no-user-gesture-required",
      ],
    });
    const context = await browser.newContext({
      viewport: { width: 1280, height: 820 },
      permissions: ["microphone"],
      // Headless Chromium on a POSIX-locale host reports "en-US@posix",
      // which Intl rejects; real browsers never send it.
      locale: "en-US",
      recordHar: { path: join(output, `${name}.har`), content: "omit" },
    });
    const page = await context.newPage();
    page.on("console", (message) =>
      consoleMessages.push({
        run: name,
        type: message.type(),
        text: message.text(),
      }),
    );
    page.on("pageerror", (error) =>
      pageErrors.push({
        run: name,
        error: String(error),
        stack: error.stack?.split("\n").slice(0, 6),
      }),
    );
    const uploads = [];
    page.on("request", (request) => {
      if (
        request.method() === "POST" &&
        /\/v1\/dictation\//.test(request.url())
      )
        uploads.push(request.url());
    });
    const socket = { binaryFrames: 0, binaryBytes: 0, sent: [], received: [] };
    page.on("websocket", (ws) => {
      if (!/\/v1\/dictation\/.+\/stream/.test(ws.url())) return;
      ws.on("framesent", ({ payload }) => {
        if (typeof payload === "string") socket.sent.push(payload);
        else {
          socket.binaryFrames += 1;
          socket.binaryBytes += payload.length;
        }
      });
      ws.on("framereceived", ({ payload }) =>
        socket.received.push(String(payload)),
      );
    });
    // A real browser socket to a closed port: the live session fails to
    // connect, as on a network that refuses WebSockets.
    if (mode === "upload")
      await context.addInitScript(() => {
        const Native = window.WebSocket;
        window.WebSocket = class extends Native {
          constructor(url, protocols) {
            super(
              /\/v1\/dictation\/.+\/stream/.test(String(url))
                ? "ws://127.0.0.1:9/refused"
                : url,
              protocols,
            );
          }
        };
      });

    await page.goto(`${base}/signin`);
    await page.getByRole("heading", { name: "Sign in to dx" }).waitFor();
    const passwordSignIn = page.getByRole("button", {
      name: "Sign in with a password",
    });
    if (await passwordSignIn.isVisible()) await passwordSignIn.click();
    await page.getByLabel("Email").fill(credentials.email);
    await page.getByLabel("Password").fill(credentials.password);
    await page.getByRole("button", { name: /^Sign in$/ }).click();
    await page.waitForURL((url) => url.pathname !== "/signin");
    await page.goto(`${base}/new`);
    const prompt = page.getByLabel("Prompt");
    await prompt.waitFor();
    await prompt.click();

    await page.getByRole("button", { name: "Start dictation" }).click();
    await page.getByRole("button", { name: "Stop dictation" }).waitFor();
    // Let the whole clip play, plus a short tail, as a speaker would.
    await page.waitForTimeout(seconds * 1_000 + 300);
    await page.screenshot({ path: join(output, `${name}-recording.png`) });
    const stoppedAt = Date.now();
    await page.getByRole("button", { name: "Stop dictation" }).click();
    await page.waitForFunction(
      () =>
        document.querySelector('[aria-label="Prompt"]')?.value.trim().length >
        0,
      undefined,
      { timeout: 30_000 },
    );
    const latencyMs = Date.now() - stoppedAt;
    const text = await prompt.inputValue();
    await page.screenshot({ path: join(output, `${name}-transcribed.png`) });
    await context.close();
    await browser.close();

    const checks = {
      // Case-insensitive: an upload is cut into chunks, and Sarvam capitalizes
      // the first word of each.
      transcriptHasExpectedWords: expected.every((words) =>
        text.toLowerCase().includes(words.toLowerCase()),
      ),
      // The budget is for live dictation; an upload is the recovery path.
      ...(mode === "live" ? { underBudget: latencyMs <= budgetMs } : {}),
      ...(mode === "live"
        ? {
            streamedWhileSpeaking: socket.binaryFrames > 0,
            sentFinish: socket.sent.includes('{"type":"finish"}'),
            noUpload: uploads.length === 0,
          }
        : { uploadedOnce: uploads.length === 1 }),
    };
    const passed = Object.values(checks).every(Boolean);
    results.push({
      run: name,
      mode,
      clipSeconds: seconds,
      latencyMs,
      text,
      checks,
      socket: {
        binaryFrames: socket.binaryFrames,
        binaryBytes: socket.binaryBytes,
        sent: socket.sent,
        received: socket.received,
      },
      uploads: uploads.length,
      passed,
    });
    console.log(
      `${passed ? "PASS" : "FAIL"} ${name}: stop -> transcript ${latencyMs} ms (${seconds.toFixed(1)} s clip) ${JSON.stringify(checks)}\n     ${JSON.stringify(text)}`,
    );
  }
}

const errors = consoleMessages.filter(({ type }) => type === "error");
writeFileSync(
  join(output, "console.json"),
  JSON.stringify(consoleMessages, null, 2),
);
writeFileSync(
  join(output, "page-errors.json"),
  JSON.stringify(pageErrors, null, 2),
);
writeFileSync(
  join(output, "report.json"),
  JSON.stringify(
    { base, budgetMs, results, consoleErrors: errors, pageErrors },
    null,
    2,
  ),
);
console.log(
  `console errors: ${errors.length}, page errors: ${pageErrors.length}`,
);
const failed =
  results.filter(({ passed }) => !passed).length + pageErrors.length;
console.log(
  `${results.length - results.filter(({ passed }) => !passed).length}/${results.length} runs passed`,
);
process.exitCode = failed > 0 ? 1 : 0;
