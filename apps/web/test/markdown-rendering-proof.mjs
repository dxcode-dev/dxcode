// Browser proof that agent Markdown renders Mermaid diagrams and math in the
// real thread page (local only; never contacts providers). Builds the thread
// page harness in production mode, streams one answer through the Flue
// session path, settles it, and checks the rendered transcript in dark and
// light appearance.
//
//   pnpm --filter @dx/web test:markdown-rendering
//   node test/markdown-rendering-proof.mjs [url] [--out <dir>]
//     [--answer <file.md> --views "<text>|<text>|<text>"]
//
// Launches Playwright's Chromium, or attaches to DX_PROOF_CDP when set (for
// example `$(agent-browser get cdp-url)`). Writes screenshots, a video, a
// HAR, console.json, and summary.json to the output directory (default
// .dx/journeys/markdown-rendering/). Exits 1 when any check fails.
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { chromium } from "playwright-core";

const outIndex = process.argv.indexOf("--out");
const output =
  outIndex > 0
    ? resolve(process.argv[outIndex + 1])
    : resolve(import.meta.dirname, "../../../.dx/journeys/markdown-rendering");
mkdirSync(output, { recursive: true });
const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
// --answer streams a captured model answer instead of the fixture and runs
// only the checks that hold for any answer; --views names the three blocks
// (by text they contain) to screenshot, separated by "|".
const answerFile = argument("--answer");
const urlArgument = process.argv[2]?.startsWith("http")
  ? process.argv[2]
  : undefined;
let server;
if (urlArgument === undefined) {
  const { build, preview } = await import("vite");
  const configFile = resolve(import.meta.dirname, "../vite.stress.config.ts");
  await build({ configFile, logLevel: "warn" });
  server = await preview({ configFile, preview: { port: 0 } });
}
const base = urlArgument ?? server.resolvedUrls.local[0].replace(/\/$/, "");

// The shape of the reported thread: a cost question answered with a sequence
// diagram, display and inline math in every delimiter style, prices, and code
// that contains dollar signs. The second diagram is invalid on purpose.
const fixtureAnswer = `## Dashboard computational cost

Each dashboard load fans out to the query service:

\`\`\`mermaid
sequenceDiagram
    participant U as User
    participant D as Dashboard
    participant Q as Query service
    participant W as Warehouse
    U->>D: Open dashboard
    D->>Q: Fetch 12 widgets
    loop For each widget
        Q->>W: Run aggregate query
        W-->>Q: Rows
    end
    Q-->>D: Widget data
    D-->>U: Render
\`\`\`

The cost of one load is

$$
C_{load} = \\sum_{i=1}^{n} \\left( t_i \\cdot r \\right) + c_{fixed}
$$

where \\(t_i\\) is the query time of widget \\(i\\) and $r$ is the warehouse rate. Monthly cost scales with traffic:

\\[
C_{month} = 30 \\cdot d \\cdot C_{load}
\\]

At $0.40 per compute-hour and $12 of fixed storage, 10,000 loads a day cost about $95/month.

| Widget | Query time | Cost share |
| --- | --- | --- |
| Revenue | 1.2 s | $\\frac{1.2}{4.0} = 30\\%$ |
| Funnel | 2.8 s | $\\frac{2.8}{4.0} = 70\\%$ |

Shell variables such as \`$HOME\` stay code:

\`\`\`sh
echo "PID $$ costs $5"
\`\`\`

\`\`\`mermaid
graph TD
  A[Unclosed -->
\`\`\`
`;

const answer =
  answerFile === undefined ? fixtureAnswer : readFileSync(answerFile, "utf8");
const views = (
  argument("--views") ??
  "Dashboard computational cost|The cost of one load is|compute-hour"
).split("|");
const mermaidFences = answer.match(/^```mermaid$/gm)?.length ?? 0;
// Formulas the answer writes outside code: each \[ or $$ block is one display
// formula and each \( one inline formula.
const prose = answer.replace(/^```[\s\S]*?^```$/gm, "");
const expectedDisplay =
  (prose.match(/\\\[/g)?.length ?? 0) +
  (prose.match(/^\s*\$\$.+\$\$\s*$/gm)?.length ?? 0) +
  (prose.match(/^\s*\$\$\s*$/gm)?.length ?? 0) / 2;
const expectedInline = prose.match(/\\\(/g)?.length ?? 0;
// The last line of the first diagram: once streamed, the diagram is complete
// but still the unsettled tail.
const diagramEnd = /^```mermaid\n([\s\S]*?)\n```$/m
  .exec(answer)?.[1]
  .split("\n")
  .at(-1)
  ?.trim();

const browser = process.env.DX_PROOF_CDP
  ? await chromium.connectOverCDP(process.env.DX_PROOF_CDP)
  : await chromium.launch();
const context = await browser.newContext({
  viewport: { width: 1280, height: 820 },
  deviceScaleFactor: 2,
  recordHar: { path: join(output, "network.har"), content: "omit" },
  recordVideo: { dir: output, size: { width: 1280, height: 820 } },
});
const page = await context.newPage();
const consoleEntries = [];
const pageErrors = [];
page.on("console", (message) =>
  consoleEntries.push({
    type: message.type(),
    text: message.text(),
    url: message.location().url,
  }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));
const failedResponses = [];
page.on("response", (response) => {
  if (response.status() >= 400)
    failedResponses.push({ status: response.status(), url: response.url() });
});

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, detail ?? "");
};

const turn = '[data-turn-id="turn:t-live-1"]';
const runAppearance = async (appearance) => {
  await page.goto(
    `${base}/thread-page-stress.html?turns=1&appearance=${appearance}`,
  );
  await page.waitForSelector(".transcript-markdown");
  // Sample every frame while streaming: a half-written formula must never
  // flash as a red KaTeX error.
  await page.evaluate(() => {
    window.__proofErrorFrames = 0;
    window.__proofSampling = true;
    const sample = () => {
      if (document.querySelector(".transcript-markdown .katex-error"))
        window.__proofErrorFrames += 1;
      if (window.__proofSampling) requestAnimationFrame(sample);
    };
    requestAnimationFrame(sample);
  });
  // Stream at a visible pace, then settle as a completed response does.
  const streaming = page.evaluate(
    (text) =>
      window.dxPerf.stream({
        text,
        deltaChars: 12,
        intervalMs: 16,
        settle: true,
      }),
    answer,
  );
  // While the diagram is the unsettled tail it stays source, never a
  // half-drawn image.
  await page.waitForFunction(
    ([selector, needle]) =>
      document.querySelector(selector)?.textContent?.includes(needle),
    [turn, diagramEnd ?? ""],
  );
  const whileStreaming = await page.evaluate(
    (selector) =>
      document.querySelectorAll(`${selector} .markdown-mermaid img`).length,
    turn,
  );
  await page.screenshot({ path: join(output, `${appearance}-streaming.png`) });
  await streaming;
  const errorFramesWhileStreaming = await page.evaluate(() => {
    window.__proofSampling = false;
    return window.__proofErrorFrames;
  });
  await page
    .waitForSelector(`${turn} .markdown-mermaid img`, { timeout: 15_000 })
    .catch(() => undefined);
  await page
    .waitForFunction(
      (selector) =>
        [
          ...document.querySelectorAll(`${selector} .markdown-mermaid img`),
        ].every((image) => image.complete && image.naturalWidth > 0) &&
        document.querySelectorAll(`${selector} .katex`).length > 0,
      turn,
      { timeout: 15_000 },
    )
    .catch(() => undefined);
  const facts = await page.evaluate((selector) => {
    const root = document.querySelector(selector);
    const images = [...root.querySelectorAll(".markdown-mermaid img")];
    const paragraphs = [...root.querySelectorAll("p")].map(
      (p) => p.textContent,
    );
    return {
      mermaidImages: images.map((image) => ({
        alt: image.alt,
        naturalWidth: image.naturalWidth,
        naturalHeight: image.naturalHeight,
        renderedWidth: Math.round(image.getBoundingClientRect().width),
        dataUrl: image.src.startsWith("data:image/svg+xml"),
      })),
      rawMermaidVisible: [...root.querySelectorAll("pre code")].some((code) =>
        code.textContent.includes("sequenceDiagram"),
      ),
      invalidDiagramSource: [...root.querySelectorAll("pre code")].some(
        (code) => code.textContent.includes("A[Unclosed -->"),
      ),
      displayMath: [...root.querySelectorAll(".markdown-math-display")].map(
        (node) => node.querySelector("annotation")?.textContent?.trim(),
      ),
      inlineMath: [...root.querySelectorAll(".markdown-math-inline")].map(
        (node) => node.querySelector("annotation")?.textContent?.trim(),
      ),
      katexErrors: root.querySelectorAll(".katex-error").length,
      rawDelimitersVisible: [...root.querySelectorAll("p, li, td, th")]
        .filter((node) => node.closest(".katex") === null)
        .some((node) =>
          // Delimiters or any TeX command such as \frac or \Delta.
          /\\\(|\\\[|\$\$|\\[A-Za-z]+/.test(
            [...node.childNodes]
              .filter((child) => child.nodeType === Node.TEXT_NODE)
              .map((child) => child.textContent)
              .join(""),
          ),
        ),
      katexCount: root.querySelectorAll(".katex").length,
      pricesParagraph: paragraphs.find((text) =>
        text?.includes("compute-hour"),
      ),
      inlineCode: [...root.querySelectorAll("p code")].map(
        (code) => code.textContent,
      ),
      shellBlock: [...root.querySelectorAll("pre code")]
        .map((code) => code.textContent)
        .find((text) => text.includes("PID")),
      strayMermaidNodes: document.querySelectorAll(
        'body > [id^="ddx-mermaid"], body > [id^="dx-mermaid"]',
      ).length,
    };
  }, turn);
  // The same three views in both runs, whatever each one renders.
  const show = async (text, file) => {
    await page.evaluate(
      ([selector, needle]) => {
        const block = [
          ...document.querySelectorAll(`${selector} .transcript-markdown > *`),
        ].find((node) => node.textContent.includes(needle));
        block?.scrollIntoView({ block: "start" });
        return new Promise((done) =>
          requestAnimationFrame(() => requestAnimationFrame(done)),
        );
      },
      [turn, text],
    );
    await page.waitForTimeout(400);
    await page.screenshot({ path: join(output, file) });
  };
  await show(views[0], `${appearance}-diagram.png`);
  await show(views[1], `${appearance}-math.png`);
  await show(views[2], `${appearance}-prices-table.png`);

  // Source toggle: the diagram's Mermaid source stays one click away.
  const hasDiagram =
    (await page.locator(`${turn} .markdown-mermaid`).count()) > 0;
  if (hasDiagram) {
    await page.locator(`${turn} .markdown-mermaid`).hover();
    await page.getByRole("button", { name: "Show Mermaid source" }).click();
  }
  const sourceShown =
    hasDiagram &&
    (await page.evaluate(
      (selector) =>
        [...document.querySelectorAll(`${selector} pre code`)].some((code) =>
          code.textContent.includes("sequenceDiagram"),
        ),
      turn,
    ));
  if (hasDiagram)
    await page.getByRole("button", { name: "Show diagram" }).click();
  const diagramBack =
    (await page.locator(`${turn} .markdown-mermaid img`).count()) === 1;

  const label = (name) => `${appearance}: ${name}`;
  check(
    label("no diagram image while the diagram is the streaming tail"),
    whileStreaming === 0,
    { whileStreaming },
  );
  check(label("no KaTeX errors"), facts.katexErrors === 0, facts.katexErrors);
  check(
    label("no KaTeX error frames while streaming"),
    errorFramesWhileStreaming === 0,
    { errorFramesWhileStreaming },
  );
  check(label("no raw TeX delimiters in prose"), !facts.rawDelimitersVisible);
  check(
    label("Mermaid leaves no measuring nodes in the page"),
    facts.strayMermaidNodes === 0,
    facts.strayMermaidNodes,
  );
  if (answerFile !== undefined) {
    check(
      label("every Mermaid fence renders as a decoded image"),
      facts.mermaidImages.length === mermaidFences &&
        facts.mermaidImages.every((image) => image.naturalWidth > 0),
      { mermaidFences, images: facts.mermaidImages },
    );
    check(
      label("every formula renders with KaTeX"),
      // An answer without math must not gain any.
      (expectedDisplay + expectedInline === 0
        ? facts.katexCount === 0
        : facts.katexCount > 0) &&
        facts.displayMath.length === expectedDisplay &&
        facts.inlineMath.length >= expectedInline,
      {
        expectedDisplay,
        display: facts.displayMath.length,
        expectedInline,
        inline: facts.inlineMath.length,
      },
    );
    return facts;
  }
  check(
    label("valid sequence diagram renders as one decoded image"),
    facts.mermaidImages.length === 1 &&
      facts.mermaidImages[0].naturalWidth > 0 &&
      facts.mermaidImages[0].dataUrl,
    facts.mermaidImages,
  );
  check(
    label("diagram image has an accessible name"),
    /sequence/i.test(facts.mermaidImages[0]?.alt ?? ""),
    facts.mermaidImages[0]?.alt,
  );
  check(
    label("raw sequenceDiagram source is not shown"),
    !facts.rawMermaidVisible,
  );
  check(
    label("invalid Mermaid falls back to its source"),
    facts.invalidDiagramSource,
  );
  check(
    label("$$ and \\[ \\] render as display math"),
    facts.displayMath.length === 2 && facts.displayMath.every(Boolean),
    facts.displayMath,
  );
  check(
    label("\\( \\), $x$, and table-cell math render inline"),
    facts.inlineMath.length === 5,
    facts.inlineMath,
  );
  check(
    label("prices stay text"),
    facts.pricesParagraph?.includes(
      "$0.40 per compute-hour and $12 of fixed storage",
    ) && facts.pricesParagraph?.includes("$95/month"),
    facts.pricesParagraph,
  );
  check(
    label("dollars in inline code stay code"),
    facts.inlineCode.includes("$HOME"),
    facts.inlineCode,
  );
  check(
    label("dollars in fenced code stay code"),
    facts.shellBlock?.includes('echo "PID $$ costs $5"'),
    facts.shellBlock,
  );
  check(
    label("source toggle shows and hides Mermaid source"),
    sourceShown && diagramBack,
    { sourceShown, diagramBack },
  );
  return facts;
};

const results = {};
try {
  for (const appearance of ["dark", "light"])
    results[appearance] = await runAppearance(appearance);
} finally {
  const video = page.video();
  await context.close();
  if (video) {
    await video.saveAs(join(output, "markdown-rendering.webm"));
    await video.delete();
  }
  await browser.close().catch(() => undefined);
  await server?.close();
}
// The harness page ships no favicon; every other console error fails.
const errors = consoleEntries.filter(
  (entry) => entry.type === "error" && !entry.url?.endsWith("/favicon.ico"),
);
check("no page errors", pageErrors.length === 0, pageErrors);
check("no console errors", errors.length === 0, { errors, failedResponses });
writeFileSync(
  join(output, "console.json"),
  JSON.stringify({ consoleEntries, pageErrors }, null, 2),
);
writeFileSync(
  join(output, "summary.json"),
  JSON.stringify({ base, checks, results }, null, 2),
);
const failed = checks.filter((entry) => !entry.pass);
console.log(
  `${checks.length - failed.length}/${checks.length} checks passed; artifacts in ${output}`,
);
process.exit(failed.length === 0 ? 0 : 1);
