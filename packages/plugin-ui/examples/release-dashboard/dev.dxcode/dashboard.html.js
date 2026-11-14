// The Release dashboard pane: built only from @dxcode/plugin-ui components.
export default String.raw`<!doctype html>
<html lang="en">
<head>
<title>Release dashboard</title>
<script type="module" src="dx:plugin-ui"></script>
<style>
  body { padding: 16px; }
  main { display: flex; flex-direction: column; gap: 16px; max-width: 880px; margin: 0 auto; }
  .top { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
  .top h1 { margin-right: auto; }
  .stats { display: grid; grid-template-columns: repeat(auto-fit, minmax(140px, 1fr)); gap: 16px; }
  .grid { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1fr); gap: 16px; align-items: start; }
  form { display: flex; flex-direction: column; gap: 14px; }
  .row { display: flex; gap: 8px; flex-wrap: wrap; align-items: center; }
  @media (max-width: 640px) { .grid { grid-template-columns: 1fr; } body { padding: 12px; } }
</style>
</head>
<body>
<main>
  <div class="top">
    <h1>Release dashboard</h1>
    <dx-chip id="status" tone="success" dot>Healthy</dx-chip>
    <dx-button id="refresh" variant="outline" size="xs" icon="refresh-cw">Refresh</dx-button>
    <dx-button id="ship" size="xs" icon="upload">Ship v2.4.0</dx-button>
  </div>

  <dx-card>
    <div class="stats">
      <dx-stat label="Deploys this week" value="38" delta="+12%" hint="vs. last week"></dx-stat>
      <dx-stat label="Change failure rate" value="2.6%" delta="-0.8 pts" tone="up" hint="lower is better"></dx-stat>
      <dx-stat label="Lead time" value="3h 12m" delta="+18m" tone="down" hint="median, commit to prod"></dx-stat>
      <dx-stat label="Open incidents" value="0" hint="none in 9 days"></dx-stat>
    </div>
  </dx-card>

  <dx-tabs id="tabs" value="deploys">
    <dx-tab value="deploys" label="Deploys" icon="git-branch">
      <dx-table id="deploys" sortable interactive empty="No deploys yet."></dx-table>
    </dx-tab>
    <dx-tab value="checks" label="Checks" icon="activity">
      <dx-list>
        <dx-list-item heading="Unit and integration tests" description="2,184 passed in 4m 51s" icon="circle-check">
          <dx-chip slot="trailing" tone="success">Passed</dx-chip>
        </dx-list-item>
        <dx-list-item heading="Browser journeys" description="Critical suite on the branch preview" icon="loader-circle">
          <dx-chip slot="trailing" tone="info" pulse>Running</dx-chip>
        </dx-list-item>
        <dx-list-item heading="Bundle size" description="Thread page first load: 412 KB of 420 KB" icon="triangle-alert">
          <dx-chip slot="trailing" tone="warning">Near limit</dx-chip>
        </dx-list-item>
        <dx-list-item heading="Release notes" description="Opens the changelog draft" icon="file" href="https://example.com/changelog">
        </dx-list-item>
      </dx-list>
    </dx-tab>
    <dx-tab value="settings" label="Settings" icon="settings">
      <div class="grid">
        <dx-card heading="Rollout" description="How the next release reaches people.">
          <form id="rollout">
            <dx-input name="version" label="Version" value="2.4.0" required></dx-input>
            <dx-select name="strategy" label="Strategy" hint="Canary sends 5% of traffic first.">
              <option value="canary" selected>Canary, then everyone</option>
              <option value="all">Everyone at once</option>
              <option value="manual">Manual approval</option>
            </dx-select>
            <dx-textarea name="notes" label="Notes" placeholder="What changed in this release" rows="3"></dx-textarea>
            <dx-switch name="autoRollback" checked>Roll back on failed checks</dx-switch>
            <dx-checkbox name="notify" checked>Tell #releases when it ships</dx-checkbox>
            <div class="row">
              <dx-button type="submit">Save rollout</dx-button>
              <dx-button type="reset" variant="ghost">Reset</dx-button>
            </div>
          </form>
        </dx-card>
        <div style="display:flex;flex-direction:column;gap:16px">
          <dx-card heading="Deploy command" description="Runs in the release Orb.">
            <dx-code language="bash">pnpm release --version 2.4.0 \
  --strategy canary --rollback-on-failure</dx-code>
          </dx-card>
          <dx-card heading="Canary preview" description="Live from the canary's screen." flush>
            <dx-player id="preview" muted autoplay></dx-player>
          </dx-card>
          <dx-card heading="Blocked deploys" flush>
            <dx-empty icon="circle-check" heading="Nothing is blocked">Deploys that fail a check wait here until someone retries them.
              <dx-button slot="actions" size="xs" variant="outline">View policy</dx-button>
            </dx-empty>
          </dx-card>
        </div>
      </div>
    </dx-tab>
  </dx-tabs>
</main>
<script type="module">
  // MCP Apps handshake with dx: the plugin's posts arrive as dx/plugin.message.
  let next = 1;
  const pending = new Map();
  const request = (method, params) => new Promise((resolve, reject) => {
    const id = next++;
    pending.set(id, { resolve, reject });
    parent.postMessage({ jsonrpc: "2.0", id, method, params }, "*");
  });
  addEventListener("message", (event) => {
    const data = event.data;
    if (event.source !== parent || data?.jsonrpc !== "2.0") return;
    if (data.id !== undefined && pending.has(data.id)) {
      const { resolve, reject } = pending.get(data.id);
      pending.delete(data.id);
      data.error ? reject(new Error(data.error.message)) : resolve(data.result);
    } else if (data.method === "dx/plugin.message") show(data.params.message);
  });

  const tone = { live: "success", canary: "info", "rolled back": "danger", queued: "neutral" };
  const chip = (status) => {
    const element = document.createElement("dx-chip");
    element.setAttribute("tone", tone[status] ?? "neutral");
    if (status === "canary") element.setAttribute("pulse", "");
    else element.setAttribute("dot", "");
    element.textContent = status[0].toUpperCase() + status.slice(1);
    return element;
  };
  const deploys = document.getElementById("deploys");
  deploys.columns = [
    { key: "version", label: "Version" },
    { key: "status", label: "Status", format: chip },
    { key: "author", label: "Author" },
    { key: "duration", label: "Duration", align: "end" },
    { key: "when", label: "When", align: "end" },
  ];
  deploys.rows = [];
  const show = (message) => {
    if (Array.isArray(message?.deploys)) deploys.rows = message.deploys;
    if (message?.status) {
      const status = document.getElementById("status");
      status.setAttribute("tone", message.status.tone);
      status.textContent = message.status.text;
    }
  };

  const refresh = document.getElementById("refresh");
  const load = async () => {
    refresh.loading = true;
    try { show((await request("dx/plugin.post", { message: { action: "load" } })).result); }
    finally { refresh.loading = false; }
  };
  refresh.addEventListener("click", load);
  document.getElementById("ship").addEventListener("click", async (event) => {
    const button = event.currentTarget;
    button.loading = true;
    try { show((await request("dx/plugin.post", { message: { action: "ship" } })).result); }
    finally { button.loading = false; }
  });
  document.getElementById("rollout").addEventListener("submit", async (event) => {
    event.preventDefault();
    const values = Object.fromEntries(new FormData(event.currentTarget));
    await request("dx/plugin.post", { message: { action: "save", values } });
  });

  // A live preview: a canvas stream, the same path a WebRTC MediaStream takes.
  const canvas = Object.assign(document.createElement("canvas"), { width: 640, height: 360 });
  const paint = canvas.getContext("2d");
  const frame = (now) => {
    const t = now / 1000;
    paint.fillStyle = "#0c1516"; paint.fillRect(0, 0, 640, 360);
    for (let i = 0; i < 24; i++) {
      const x = (i * 29 + t * 60) % 680 - 20;
      paint.fillStyle = i % 3 ? "#1f3a3c" : "#54b879";
      paint.fillRect(x, 300 - ((Math.sin(t + i) + 1.4) * 80), 18, 400);
    }
    paint.fillStyle = "#d4d7d1"; paint.font = "500 22px -apple-system, Segoe UI, sans-serif";
    paint.fillText("canary · eu-west · " + new Date().toISOString().slice(11, 19), 24, 44);
    requestAnimationFrame(frame);
  };
  requestAnimationFrame(frame);
  document.getElementById("preview").srcObject = canvas.captureStream(30);

  await request("ui/initialize", {
    protocolVersion: "2026-01-26",
    appInfo: { name: "release-dashboard", version: "1.0.0" },
    appCapabilities: {},
  });
  parent.postMessage({ jsonrpc: "2.0", method: "ui/notifications/initialized" }, "*");
  load();
</script>
</body>
</html>`;
