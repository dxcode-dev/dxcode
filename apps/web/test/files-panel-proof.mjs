// Browser proof for the Files panel and file viewers against a running dx
// (local `pnpm dev` by default, or a deployed preview with --base and
// credentials). It creates a Project and Thread, seeds the Thread workspace
// with code, Markdown, CSV, audio, video, and PDF files, then:
//
//   1. drives a refresh storm (workspace writes plus tab-away/tab-back) while
//      sampling every animation frame of the Files panel: "Refreshing" text,
//      panel height, tree remounts, git status colors, and DOM churn;
//   2. tabs away and back with a code file open and samples the editor;
//   3. opens each file type and checks its viewer.
//
//   node apps/web/test/files-panel-proof.mjs [--base http://127.0.0.1:3000]
//     [--label after] [--out <dir>] [--workspace <dir>]
//
// Local runs write files into the Thread's checkout-owned workspace. With
// --workspace none (a deployment), they go through the Thread's terminal
// socket, and the Thread uses the account's first Project. Writes video, network.har,
// console.json, page-errors.json, screenshots, and summary.json to the
// output directory (default .dx/journeys/files-panel/<label>/). Exits 1
// when any check fails.
import { execFileSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from "node:fs";
import { dirname, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import { chromium } from "playwright-core";

const argument = (name) => {
  const index = process.argv.indexOf(name);
  return index > 0 ? process.argv[index + 1] : undefined;
};
const repoRoot = resolve(import.meta.dirname, "../../..");
const base = (argument("--base") ?? "http://127.0.0.1:3000").replace(/\/$/, "");
const label = argument("--label") ?? "run";
const output = resolve(
  argument("--out") ?? join(repoRoot, ".dx/journeys/files-panel", label),
);
mkdirSync(output, { recursive: true });
const localVars = existsSync(join(repoRoot, "apps/core/.dev.vars"))
  ? parseEnv(readFileSync(join(repoRoot, "apps/core/.dev.vars"), "utf8"))
  : {};
const email = process.env.DX_PROOF_EMAIL ?? localVars.DX_LOCAL_AUTH_EMAIL;
const password =
  process.env.DX_PROOF_PASSWORD ?? localVars.DX_LOCAL_AUTH_PASSWORD;
if (!email || !password) throw new Error("No sign-in credentials.");

// Local dxd runs on this machine: its terminal is this machine's shell, so
// terminal seeding would write into the checkout that runs the proof.
const localBase = /^http:\/\/(127\.0\.0\.1|localhost)[:/]/.test(`${base}/`);
if (argument("--workspace") === "none" && localBase)
  throw new Error(
    "--workspace none is for deployments; local runs seed the Thread workspace directly.",
  );

const checks = [];
const check = (name, pass, detail) => {
  checks.push({ name, pass: Boolean(pass), detail });
  console.log(`${pass ? "PASS" : "FAIL"} ${name}`, JSON.stringify(detail));
};
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

// ---------- fixtures ----------
const wav = () => {
  const rate = 8_000;
  const samples = rate * 2;
  const buffer = Buffer.alloc(44 + samples * 2);
  buffer.write("RIFF", 0);
  buffer.writeUInt32LE(36 + samples * 2, 4);
  buffer.write("WAVEfmt ", 8);
  buffer.writeUInt32LE(16, 16);
  buffer.writeUInt16LE(1, 20);
  buffer.writeUInt16LE(1, 22);
  buffer.writeUInt32LE(rate, 24);
  buffer.writeUInt32LE(rate * 2, 28);
  buffer.writeUInt16LE(2, 32);
  buffer.writeUInt16LE(16, 34);
  buffer.write("data", 36);
  buffer.writeUInt32LE(samples * 2, 40);
  for (let index = 0; index < samples; index += 1)
    buffer.writeInt16LE(
      Math.round(Math.sin((2 * Math.PI * 440 * index) / rate) * 12_000),
      44 + index * 2,
    );
  return buffer;
};
const pdf = () => {
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    null,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const text =
    "BT /F1 36 Tf 72 700 Td (dx PDF proof) Tj 0 -48 Td /F1 18 Tf (Rendered inside the Files viewer.) Tj ET";
  objects[3] = `<< /Length ${text.length} >>\nstream\n${text}\nendstream`;
  let body = "%PDF-1.4\n";
  const offsets = [];
  objects.forEach((object, index) => {
    offsets.push(body.length);
    body += `${index + 1} 0 obj\n${object}\nendobj\n`;
  });
  const xref = body.length;
  body += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets)
    body += `${String(offset).padStart(10, "0")} 00000 n \n`;
  body += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(body, "latin1");
};
const ffmpeg = existsSync("/opt/dx/desktop/bin/ffmpeg")
  ? "/opt/dx/desktop/bin/ffmpeg"
  : "ffmpeg";
const generated = (args, extension) => {
  const target = join(output, `fixture.${extension}`);
  try {
    execFileSync(ffmpeg, [
      "-hide_banner",
      "-loglevel",
      "error",
      "-y",
      ...args,
      target,
    ]);
    return readFileSync(target);
  } catch {
    return undefined;
  }
};
const guide = `# Files proof guide

This document is rendered by the same Markdown renderer as the transcript.
A hard-wrapped line continues the same paragraph
instead of breaking it.

| Feature | Rendered as | Status |
| --- | --- | --- |
| Tables | GFM table | ✅ |
| Mermaid | Diagram | ✅ |
| Math | KaTeX | ✅ |

\`\`\`mermaid
flowchart LR
  Agent[Agent edits] --> Capture[Changes capture]
  Capture --> Files[Files panel]
  Files --> Viewer[File viewer]
\`\`\`

\`\`\`mermaid
sequenceDiagram
  participant U as User
  participant W as Web
  participant D as dxd
  U->>W: Open file
  W->>D: Read
  D-->>W: Bytes
  W-->>U: Render
\`\`\`

The cost is $$C = \\sum_{i=1}^{n} t_i$$ per load.

![Logo](../media/logo.png)

\`\`\`ts
export const answer = 42;
\`\`\`
`;
const csv = [
  "region,product,units,revenue",
  'North,"Widget, large",120,"$1,200.00"',
  'South,Gadget,75,"$937.50"',
  'East,"Quoted ""name""",44,$440.00',
  "West,Sprocket,310,$3100.00",
].join("\n");
const code = (index) =>
  Array.from(
    { length: 80 },
    (_, line) =>
      `export const value${line} = ${line * index}; // line ${line + 1}`,
  ).join("\n");

// ---------- browser ----------
const browser = await chromium.launch({
  executablePath: process.env.DX_PROOF_CHROMIUM ?? "/usr/bin/chromium",
  args: ["--autoplay-policy=no-user-gesture-required"],
});
const context = await browser.newContext({
  viewport: { width: 1440, height: 900 },
  recordVideo: { dir: output, size: { width: 1440, height: 900 } },
  recordHar: { path: join(output, "network.har"), content: "omit" },
});
const page = await context.newPage();
const consoleEntries = [];
const pageErrors = [];
page.on("console", (message) =>
  consoleEntries.push({ type: message.type(), text: message.text() }),
);
page.on("pageerror", (error) => pageErrors.push(String(error)));
// Local reads finish in milliseconds; a deployment takes hundreds. Delay dx
// API reads so in-flight states last as long as they do for a user.
const latency = Number(argument("--latency") ?? "300");
if (latency > 0)
  await context.route(
    (url) => url.pathname.startsWith("/v1/threads/"),
    async (route) => {
      if (route.request().method() === "GET") await sleep(latency);
      await route.continue().catch(() => undefined);
    },
  );
const requests = [];
page.on("request", (request) => {
  const url = new URL(request.url());
  if (url.pathname.startsWith("/v1/threads/"))
    requests.push({
      at: Date.now(),
      method: request.method(),
      path: url.pathname,
      search: url.search,
    });
});

const api = async (method, path, data) => {
  const response = await context.request.fetch(`${base}${path}`, {
    method,
    headers: { origin: base, "content-type": "application/json" },
    ...(data === undefined ? {} : { data }),
  });
  const body = await response.json().catch(() => undefined);
  if (!response.ok())
    throw new Error(
      `${method} ${path} → ${response.status()} ${JSON.stringify(body)}`,
    );
  return body;
};
const openFilesTab = async (timeout) => {
  const tab = page.locator("#thread-workspace-tab-files");
  await tab.waitFor({ state: "attached", timeout });
  const show = page.locator('[aria-label="Show Right Pane"]');
  if (await show.isVisible().catch(() => false)) await show.click();
  await tab.click({ timeout: 30_000 });
};
const shot = async (name) =>
  page.screenshot({ path: join(output, `${name}.png`) }).catch(() => undefined);

let exitCode = 0;
try {
  const signIn = await context.request.post(`${base}/api/auth/sign-in/email`, {
    headers: { origin: base, "content-type": "application/json" },
    data: { email, password },
  });
  if (!signIn.ok()) throw new Error(`sign-in ${signIn.status()}`);
  const identity = crypto.randomUUID().slice(0, 8);
  if (
    base.startsWith("http://127.0.0.1") ||
    base.startsWith("http://localhost")
  )
    await api("POST", "/v1/settings/personal/model-routing/connections", {
      name: `files-proof-${identity}`,
      kind: "provider",
      providerId: "openai",
      apiKey: "sk-local-fixture-never-used",
      enabled: true,
    }).catch(() => undefined);
  const remote = argument("--workspace") === "none";
  // Local runs clone the checkout-owned fixture; a deployment clones a
  // small public repository.
  const sourceUrl =
    argument("--source") ??
    (remote
      ? "https://github.com/octocat/Hello-World.git"
      : "https://github.com/dxcode-dev/local-fixture.git");
  const existingProject = remote
    ? (await api("GET", "/v1/projects")).data?.items?.find(
        (project) =>
          project.name.startsWith("files-proof-") &&
          project.repository?.cloneUrl === sourceUrl,
      )?.id
    : undefined;
  const projectId =
    argument("--project") ??
    existingProject ??
    (
      await api("POST", "/v1/projects", {
        name: `files-proof-${identity}`,
        source: { kind: "github-url", url: sourceUrl },
      })
    ).data.id;
  const thread = await api("POST", "/v1/threads", {
    projectId,
    title: `Files proof ${label} ${identity}`,
  });
  const threadId = thread.data.id;
  console.log("thread", threadId);

  await page.goto(`${base}/threads/${threadId}`);
  // The first message provisions the workspace. Locally this is the approved
  // fixture prompt; on a deployment any short instruction works.
  const composer = page.getByRole("textbox").first();
  await composer.click({ timeout: 60_000 });
  await composer.fill(
    process.env.DX_PROOF_PROMPT ??
      "Use the create_file tool to create /home/user/workspace/repo/.dx-glm-journey.txt containing exactly synthetic-glm-tool-result. After the tool result, reply with one short confirmation sentence.",
  );
  await page.keyboard.press("Enter");
  await openFilesTab(180_000);
  await page
    .locator(".thread-files-panel [data-item-path]")
    .first()
    .waitFor({ timeout: 300_000 });

  // ---------- seed the workspace ----------
  const workspaceArgument = argument("--workspace");
  const workspace =
    workspaceArgument === "none"
      ? undefined
      : (workspaceArgument ??
        join(
          repoRoot,
          ".dx/local/workspaces",
          threadId,
          "home/workspace/repo",
        ));
  const files = {
    "src/app.ts": code(1),
    "src/util.ts": code(2),
    "src/components/button.tsx": code(3),
    "docs/guide.md": guide,
    "data/sales.csv": csv,
  };
  const binaries = {
    "media/tone.wav": wav(),
    "docs/report.pdf": pdf(),
    "media/logo.png": generated(
      ["-f", "lavfi", "-i", "testsrc=size=160x90:rate=1", "-frames:v", "1"],
      "png",
    ),
    "media/clip.webm": generated(
      [
        "-f",
        "lavfi",
        "-i",
        "testsrc=duration=2:size=320x180:rate=15",
        "-c:v",
        "libvpx",
        "-b:v",
        "300k",
      ],
      "webm",
    ),
  };
  // A remote workspace is written through the Thread's terminal socket,
  // opened inside the signed-in page.
  const openShell = async (threadId) => {
    const socket = new WebSocket(
      `${location.origin.replace(/^http/, "ws")}/v1/threads/${encodeURIComponent(threadId)}/terminal`,
      "dx-terminal.v1",
    );
    socket.binaryType = "arraybuffer";
    let output = "";
    let ready = false;
    socket.addEventListener("message", (event) => {
      if (typeof event.data === "string") {
        if (JSON.parse(event.data).type === "ready") ready = true;
      } else output += new TextDecoder().decode(event.data);
    });
    await new Promise((resolve, reject) => {
      socket.addEventListener("open", resolve, { once: true });
      socket.addEventListener("error", reject, { once: true });
    });
    socket.send(
      JSON.stringify({
        v: 1,
        type: "attach",
        terminal: "default",
        dimensions: { columns: 200, rows: 50 },
      }),
    );
    const until = async (test, ms) => {
      const end = Date.now() + ms;
      while (!test()) {
        if (Date.now() > end)
          throw new Error(`terminal: ${output.slice(-400)}`);
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
    };
    await until(() => ready, 60_000);
    let sequence = 0;
    window.__proofShell = async (command) => {
      const marker = `DXPROOF${++sequence}DONE`;
      socket.send(
        new TextEncoder().encode(
          `${command}; printf '%s%s\\n' DXPROOF${sequence} DONE\n`,
        ),
      );
      await until(() => output.includes(marker), 60_000);
    };
  };
  const shell = async (command) => {
    // A reload drops the page's socket; reopen it on demand.
    if (!(await page.evaluate(() => typeof window.__proofShell === "function")))
      await page.evaluate(openShell, threadId);
    return page.evaluate((command) => window.__proofShell(command), command);
  };
  const remoteRoot = "/home/user/workspace/repo";
  const write = async (path, content) => {
    if (workspace !== undefined) {
      mkdirSync(dirname(join(workspace, path)), { recursive: true });
      writeFileSync(join(workspace, path), content);
      return;
    }
    const encoded = Buffer.from(content).toString("base64");
    const staging = `/tmp/dx-proof-${path.replaceAll("/", "_")}.b64`;
    await shell(`mkdir -p ${remoteRoot}/${dirname(path)} && : > ${staging}`);
    for (let offset = 0; offset < encoded.length; offset += 3_000)
      await shell(
        `printf %s '${encoded.slice(offset, offset + 3_000)}' >> ${staging}`,
      );
    await shell(
      `base64 -d ${staging} > ${remoteRoot}/${path} && rm ${staging}`,
    );
  };
  for (const [path, content] of Object.entries(files))
    await write(path, content);
  for (const [path, content] of Object.entries(binaries))
    if (content !== undefined) await write(path, content);
  const git = async (...args) => {
    const full = [
      "-c",
      "user.email=proof@dx.local",
      "-c",
      "user.name=proof",
      ...args,
    ];
    if (workspace === undefined)
      return shell(
        `git -C ${remoteRoot} ${full.map((part) => `'${part}'`).join(" ")}`,
      );
    execFileSync("git", full, { cwd: workspace, stdio: "pipe" });
  };
  // Commit some, then change them: modified, untracked, and clean rows.
  await git("add", "src", "media/logo.png");
  await git("commit", "-q", "-m", "files proof baseline");
  await write("src/app.ts", `${code(1)}\n// modified\n`);
  await write("README.md", "# Local fixture\n\nModified by the Files proof.\n");
  await page.reload();
  await openFilesTab(60_000);
  await page
    .locator('.thread-files-panel [data-item-path="src/"]')
    .waitFor({ timeout: 60_000 });
  // Expand src/ and src/components/ so several directory listings refresh.
  await page.locator('.thread-files-panel [data-item-path="src/"]').click();
  await page
    .locator('.thread-files-panel [data-item-path="src/components/"]')
    .click({ timeout: 30_000 });
  await page
    .locator('.thread-files-panel [data-item-path="src/components/button.tsx"]')
    .waitFor({ timeout: 30_000 });
  await page.waitForFunction(
    () =>
      (document
        .querySelector(".thread-files-panel file-tree-container")
        ?.shadowRoot?.querySelectorAll("[data-item-git-status]").length ?? 0) >
      0,
    undefined,
    { timeout: 60_000 },
  );
  await sleep(1_500);
  await shot("01-files-panel");

  // ---------- frame sampler ----------
  await page.evaluate(() => {
    const state = {
      frames: 0,
      refreshingFrames: 0,
      panelHeights: new Set(),
      heightChanges: 0,
      lastHeight: undefined,
      treeTops: new Set(),
      treeJumps: 0,
      lastTreeTop: undefined,
      hosts: new Set(),
      gitMin: Number.POSITIVE_INFINITY,
      gitMax: 0,
      gitDropFrames: 0,
      gitSeries: [],
      mutations: 0,
      centerRefreshingFrames: 0,
      editorHeights: new Set(),
      running: true,
    };
    const observers = new WeakSet();
    const observer = new MutationObserver((records) => {
      state.mutations += records.length;
    });
    let id = 0;
    const sample = () => {
      if (!state.running) return;
      state.frames += 1;
      const panel = document.querySelector(".thread-files-panel");
      if (panel !== null) {
        if (panel.textContent.includes("Refreshing"))
          state.refreshingFrames += 1;
        const list = panel.querySelector(".thread-files-worktrees");
        const height = list?.scrollHeight;
        state.panelHeights.add(height);
        if (state.lastHeight !== undefined && height !== state.lastHeight)
          state.heightChanges += 1;
        state.lastHeight = height;
        const tree = panel.querySelector(".thread-files-tree");
        const top =
          tree === null
            ? undefined
            : Math.round(tree.getBoundingClientRect().top);
        state.treeTops.add(top);
        if (state.lastTreeTop !== undefined && top !== state.lastTreeTop)
          state.treeJumps += 1;
        state.lastTreeTop = top;
        for (const host of panel.querySelectorAll("file-tree-container")) {
          if (host.__proofId === undefined) host.__proofId = ++id;
          state.hosts.add(host.__proofId);
          if (host.shadowRoot && !observers.has(host.shadowRoot)) {
            observers.add(host.shadowRoot);
            observer.observe(host.shadowRoot, {
              subtree: true,
              childList: true,
              attributes: true,
              characterData: true,
            });
          }
          const git =
            host.shadowRoot?.querySelectorAll("[data-item-git-status]")
              .length ?? 0;
          state.gitMin = Math.min(state.gitMin, git);
          state.gitMax = Math.max(state.gitMax, git);
          if (git === 0) state.gitDropFrames += 1;
          if (state.gitSeries.at(-1) !== git) state.gitSeries.push(git);
        }
      }
      const viewer = document.querySelector(
        ".agent-panel-stack .thread-file-viewer:not([hidden])",
      );
      if (viewer !== null) {
        if (viewer.textContent.includes("Refreshing"))
          state.centerRefreshingFrames += 1;
        const source = viewer.querySelector(".thread-file-source");
        if (source !== null)
          state.editorHeights.add(source.getBoundingClientRect().height);
      }
      requestAnimationFrame(sample);
    };
    window.__filesProof = {
      reset: () => {
        Object.assign(state, {
          frames: 0,
          refreshingFrames: 0,
          heightChanges: 0,
          lastHeight: undefined,
          treeJumps: 0,
          lastTreeTop: undefined,
          gitMin: Number.POSITIVE_INFINITY,
          gitMax: 0,
          gitDropFrames: 0,
          gitSeries: [],
          mutations: 0,
          centerRefreshingFrames: 0,
        });
        state.panelHeights = new Set();
        state.treeTops = new Set();
        state.hosts = new Set();
        state.editorHeights = new Set();
      },
      report: () => ({
        frames: state.frames,
        refreshingFrames: state.refreshingFrames,
        panelHeights: [...state.panelHeights],
        heightChanges: state.heightChanges,
        treeTops: [...state.treeTops],
        treeJumps: state.treeJumps,
        treeHosts: state.hosts.size,
        gitMin: state.gitMin,
        gitMax: state.gitMax,
        gitDropFrames: state.gitDropFrames,
        gitSeries: state.gitSeries.slice(0, 40),
        shadowMutations: state.mutations,
        centerRefreshingFrames: state.centerRefreshingFrames,
        editorHeights: [...state.editorHeights],
      }),
    };
    requestAnimationFrame(sample);
  });
  const tabAwayAndBack = () =>
    page.evaluate(async () => {
      const set = (value) => {
        Object.defineProperty(document, "visibilityState", {
          configurable: true,
          get: () => value,
        });
        Object.defineProperty(document, "hidden", {
          configurable: true,
          get: () => value === "hidden",
        });
        document.dispatchEvent(
          new Event("visibilitychange", { bubbles: true }),
        );
      };
      set("hidden");
      await new Promise((resolve) => setTimeout(resolve, 150));
      set("visible");
    });

  // ---------- 1. refresh storm on the Files panel ----------
  await page.evaluate(() => window.__filesProof.reset());
  const stormStart = Date.now();
  for (let tick = 0; tick < 24; tick += 1) {
    // The same files keep changing: no row appears or disappears.
    await write("src/app.ts", `${code(1)}\n// modified ${tick}\n`);
    await write(
      "README.md",
      `# Local fixture\n\nModified by the Files proof ${tick}.\n`,
    );
    if (tick % 4 === 0) await tabAwayAndBack();
    await sleep(500);
  }
  await sleep(2_500);
  const storm = await page.evaluate(() => window.__filesProof.report());
  const stormRequests = requests.filter((request) => request.at >= stormStart);
  storm.treeRequests = stormRequests.filter((request) =>
    request.path.endsWith("/files"),
  ).length;
  storm.changesRequests = stormRequests.filter((request) =>
    request.path.endsWith("/changes"),
  ).length;
  await shot("02-after-refresh-storm");
  check(
    "storm: refreshes happened",
    storm.treeRequests >= 3 && storm.changesRequests >= 3,
    {
      treeRequests: storm.treeRequests,
      changesRequests: storm.changesRequests,
    },
  );
  check(
    "storm: no Refreshing text in the Files panel",
    storm.refreshingFrames === 0,
    {
      refreshingFrames: storm.refreshingFrames,
      frames: storm.frames,
    },
  );
  check("storm: Files panel height never changed", storm.heightChanges === 0, {
    heightChanges: storm.heightChanges,
    panelHeights: storm.panelHeights,
  });
  check("storm: the tree never jumped up or down", storm.treeJumps === 0, {
    treeJumps: storm.treeJumps,
    treeTops: storm.treeTops,
  });
  check("storm: the tree never remounted", storm.treeHosts === 1, {
    treeHosts: storm.treeHosts,
  });
  check(
    "storm: git status colors never disappeared",
    storm.gitDropFrames === 0 && storm.gitMin > 0,
    {
      gitMin: storm.gitMin,
      gitMax: storm.gitMax,
      gitDropFrames: storm.gitDropFrames,
      gitSeries: storm.gitSeries,
    },
  );
  console.log("storm shadow DOM mutations", storm.shadowMutations);

  // A new file arrives in an expanded folder: the row appears in place.
  await page.evaluate(() => window.__filesProof.reset());
  await write("src/components/added.tsx", code(4));
  const added = await page
    .locator('.thread-files-panel [data-item-path="src/components/added.tsx"]')
    .waitFor({ timeout: 30_000 })
    .then(() => true)
    .catch(() => false);
  await sleep(500);
  const arrival = await page.evaluate(() => window.__filesProof.report());
  const stillExpanded = await page
    .locator('.thread-files-panel [data-item-path="src/components/button.tsx"]')
    .isVisible();
  await shot("02b-new-file-arrived");
  check(
    "new file: row appears without remounting or collapsing the tree",
    added && arrival.treeHosts === 1 && stillExpanded,
    {
      added,
      treeHosts: arrival.treeHosts,
      stillExpanded,
    },
  );

  // ---------- 2. tab away and back with a code file open ----------
  await page
    .locator('.thread-files-panel [data-item-path="src/util.ts"]')
    .click();
  await page
    .locator(
      '.thread-file-viewer[aria-label="File src/util.ts"] .thread-file-source',
    )
    .waitFor({ timeout: 30_000 });
  await sleep(1_500);
  await page.evaluate(() => window.__filesProof.reset());
  const tabbingStart = Date.now();
  for (let round = 0; round < 5; round += 1) {
    await sleep(1_300);
    await tabAwayAndBack();
  }
  await sleep(1_500);
  const tabbing = await page.evaluate(() => window.__filesProof.report());
  tabbing.fileReads = requests.filter(
    (request) =>
      request.at >= tabbingStart &&
      request.path.endsWith("/files/src%2Futil.ts"),
  ).length;
  check("tab back: the open file was re-read", tabbing.fileReads >= 3, {
    fileReads: tabbing.fileReads,
  });
  await shot("03-code-file-after-tabbing");
  check(
    "tab back: no Refreshing text over the open file",
    tabbing.centerRefreshingFrames === 0,
    {
      centerRefreshingFrames: tabbing.centerRefreshingFrames,
      frames: tabbing.frames,
    },
  );
  check(
    "tab back: editor height never changed",
    tabbing.editorHeights.length === 1,
    {
      editorHeights: tabbing.editorHeights,
    },
  );

  // ---------- 3. viewers ----------
  const open = async (directory, path) => {
    const row = page.locator(`.thread-files-panel [data-item-path="${path}"]`);
    if (!(await row.isVisible().catch(() => false)))
      await page
        .locator(`.thread-files-panel [data-item-path="${directory}/"]`)
        .click();
    await row.click({ timeout: 30_000 });
    const viewer = page.locator(`.thread-file-viewer[aria-label$="${path}"]`);
    await viewer.waitFor({ timeout: 30_000 });
    return viewer;
  };

  const audioViewer = await open("media", "media/tone.wav");
  const audio = await audioViewer
    .locator("audio")
    .evaluate(
      (element) =>
        new Promise((resolve) => {
          const done = () =>
            resolve({
              readyState: element.readyState,
              duration: element.duration,
            });
          if (element.readyState >= 1) done();
          else element.addEventListener("loadedmetadata", done, { once: true });
          setTimeout(done, 10_000);
        }),
      undefined,
      { timeout: 15_000 },
    )
    .catch((error) => ({ error: String(error).slice(0, 200) }));
  await shot("04-audio-wav");
  check(
    "WAV opens in an audio player that loaded it",
    audio.readyState >= 1 && audio.duration > 1.5,
    audio,
  );

  if (binaries["media/clip.webm"] !== undefined) {
    const videoViewer = await open("media", "media/clip.webm");
    const video = await videoViewer
      .locator("video")
      .evaluate(
        (element) =>
          new Promise((resolve) => {
            const done = () =>
              resolve({
                readyState: element.readyState,
                width: element.videoWidth,
                duration: element.duration,
              });
            if (element.readyState >= 1) done();
            else
              element.addEventListener("loadedmetadata", done, { once: true });
            setTimeout(done, 10_000);
          }),
        undefined,
        { timeout: 15_000 },
      )
      .catch((error) => ({ error: String(error).slice(0, 200) }));
    await shot("05-video-webm");
    check(
      "WebM opens in a video player that loaded it",
      video.readyState >= 1 && video.width === 320,
      video,
    );
  }

  const pdfViewer = await open("docs", "docs/report.pdf");
  const frame = await pdfViewer
    .locator("iframe.thread-file-pdf")
    .evaluate((element) => ({ src: element.src.slice(0, 5) }), undefined, {
      timeout: 20_000,
    })
    .catch((error) => ({ error: String(error).slice(0, 200) }));
  await sleep(2_000);
  await shot("06-pdf");
  check("PDF opens in a PDF frame", frame.src === "blob:", frame);

  const csvViewer = await open("data", "data/sales.csv");
  const table = await csvViewer
    .locator(".thread-file-table table")
    .evaluate(
      (element) => ({
        headers: [...element.querySelectorAll("thead th")].map(
          (cell) => cell.textContent,
        ),
        rows: element.querySelectorAll("tbody tr").length,
        quoted: element.querySelector("tbody tr:nth-child(1) td:nth-child(3)")
          ?.textContent,
        escaped: element.querySelector("tbody tr:nth-child(3) td:nth-child(3)")
          ?.textContent,
      }),
      undefined,
      { timeout: 10_000 },
    )
    .catch((error) => ({ error: String(error).slice(0, 200) }));
  await shot("07-csv");
  check(
    "CSV opens as a table",
    table.rows === 4 &&
      table.headers?.join("|") === "|region|product|units|revenue" &&
      table.quoted === "Widget, large" &&
      table.escaped === 'Quoted "name"',
    table,
  );

  const markdownViewer = await open("docs", "docs/guide.md");
  await markdownViewer
    .locator(".markdown-mermaid img")
    .nth(1)
    .waitFor({ timeout: 30_000 })
    .catch(() => undefined);
  await markdownViewer
    .locator('img[alt="Logo"]')
    .evaluate(
      (image) =>
        image.complete ||
        new Promise((resolve) =>
          image.addEventListener("load", resolve, { once: true }),
        ),
      undefined,
      { timeout: 10_000 },
    )
    .catch(() => undefined);
  const markdown = await markdownViewer
    .evaluate((element) => {
      const preview = element.querySelector(".thread-file-preview");
      const logo = preview?.querySelector('img[alt="Logo"]');
      return {
        diagrams:
          preview?.querySelectorAll(".markdown-mermaid img").length ?? 0,
        diagramLabels: [
          ...(preview?.querySelectorAll(".markdown-mermaid") ?? []),
        ].map((figure) => figure.getAttribute("data-diagram-label")),
        tableCells: preview?.querySelectorAll("table td").length ?? 0,
        math: preview?.querySelectorAll(".katex").length ?? 0,
        highlightedCode:
          preview?.querySelectorAll("pre code .hljs-keyword").length ?? 0,
        image:
          logo === null || logo === undefined
            ? null
            : {
                width: logo.naturalWidth,
                src: logo.getAttribute("src")?.slice(0, 60),
              },
        softBreakJoined: (() => {
          const paragraph = [...(preview?.querySelectorAll("p") ?? [])].find(
            (candidate) =>
              candidate.textContent.includes("continues the same paragraph"),
          );
          return (
            paragraph !== undefined && paragraph.querySelector("br") === null
          );
        })(),
      };
    })
    .catch((error) => ({ error: String(error).slice(0, 200) }));
  await markdownViewer
    .locator(".thread-file-preview")
    .evaluate((element) => element.scrollTo(0, 0))
    .catch(() => undefined);
  await shot("08-markdown-top");
  await markdownViewer
    .locator(".markdown-mermaid")
    .nth(1)
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await shot("09-markdown-diagrams");
  await markdownViewer
    .locator('img[alt="Logo"]')
    .scrollIntoViewIfNeeded()
    .catch(() => undefined);
  await shot("10-markdown-image");
  check(
    "Markdown renders Mermaid flowchart and sequence diagrams",
    markdown.diagrams === 2,
    markdown,
  );
  check("Markdown renders the GFM table", markdown.tableCells === 9, {
    tableCells: markdown.tableCells,
  });
  check("Markdown renders math", markdown.math >= 1, { math: markdown.math });
  check("Markdown highlights code", markdown.highlightedCode >= 1, {
    highlightedCode: markdown.highlightedCode,
  });
  check(
    "Markdown loads a relative image from the workspace",
    markdown.image?.width === 160,
    { image: markdown.image },
  );
  check("Markdown joins hard-wrapped lines", markdown.softBreakJoined, {
    softBreakJoined: markdown.softBreakJoined,
  });

  const reactErrors = consoleEntries.filter(
    (entry) =>
      entry.type === "error" &&
      (entry.text.includes("react.dev") || entry.text.startsWith("Warning")),
  );
  check(
    "no page errors or React errors in the console",
    pageErrors.length === 0 && reactErrors.length === 0,
    {
      pageErrors: pageErrors.slice(0, 5),
      reactErrors: reactErrors
        .slice(0, 5)
        .map((entry) => entry.text.slice(0, 300)),
    },
  );

  writeFileSync(
    join(output, "storm.json"),
    JSON.stringify({ storm, tabbing, requests: stormRequests }, null, 2),
  );
} catch (error) {
  console.error(error);
  check("journey completed", false, { error: String(error).slice(0, 500) });
  await shot("error");
} finally {
  await context.close();
  await browser.close();
  for (const name of readdirSync(output))
    if (
      name.endsWith(".webm") &&
      !name.startsWith("fixture") &&
      name !== "files-panel-proof.webm"
    )
      renameSync(join(output, name), join(output, "files-panel-proof.webm"));
  writeFileSync(
    join(output, "console.json"),
    JSON.stringify(consoleEntries, null, 2),
  );
  writeFileSync(
    join(output, "page-errors.json"),
    JSON.stringify(pageErrors, null, 2),
  );
  const failed = checks.filter((entry) => !entry.pass);
  writeFileSync(
    join(output, "summary.json"),
    JSON.stringify(
      {
        label,
        base,
        passed: checks.length - failed.length,
        failed: failed.length,
        checks,
        pageErrors: pageErrors.length,
      },
      null,
      2,
    ),
  );
  console.log(
    `\n${checks.length - failed.length}/${checks.length} checks passed; artifacts in ${output}`,
  );
  exitCode = failed.length === 0 ? 0 : 1;
}
process.exit(exitCode);
