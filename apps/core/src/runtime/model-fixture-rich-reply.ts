/**
 * The local fixture's rich reply: two ```dx-view blocks and three workspace
 * media files, as the creating-views skill and the agent prompt describe
 * them. The rich-reply journey writes the media files into the Thread's
 * workspace and listens on `RICH_REPLY_PROBE_ORIGIN` for anything the
 * sandbox check view manages to send.
 */
export const RICH_REPLY_MEDIA_DIRECTORY = "/home/user/artifacts/rich-reply";

export const RICH_REPLY_PROBE_ORIGIN = "http://127.0.0.1:47919";

const chartView = `<div class="ui-header">
  <p class="ui-title">Weekly threads tripled after the launch</p>
  <p class="ui-sub">Synthetic data, per week</p>
</div>
<div class="ui-row" style="justify-content: space-between; margin-bottom: 12px">
  <div class="ui-seg" id="measure">
    <button data-value="threads" aria-selected="true">Threads</button>
    <button data-value="messages">Messages</button>
  </div>
  <span class="ui-label">Latest week <span class="ui-num" id="latest" style="color: var(--foreground)">1,010</span></span>
</div>
<div id="chart"></div>
<p class="ui-caption" style="margin-top: 8px"><a id="source" href="https://example.com/rich-reply-source">Source data</a></p>
<script>
{
  const x = ['Aug 18', 'Aug 25', 'Sep 1', 'Sep 8', 'Sep 15', 'Sep 22', 'Sep 29', 'Oct 6', 'Oct 13', 'Oct 20', 'Oct 27', 'Nov 3'];
  const data = {
    threads: [310, 320, 300, 330, 340, 360, 520, 680, 770, 850, 930, 1010],
    messages: [2400, 2500, 2380, 2600, 2700, 2900, 4100, 5600, 6300, 7200, 7900, 8600],
  };
  const latest = document.getElementById('latest');
  const series = (measure) => [{ name: measure === 'threads' ? 'Threads' : 'Messages', values: data[measure], highlight: true }];
  const chart = ui.line(document.getElementById('chart'), {
    x,
    series: series('threads'),
    annotations: [{ type: 'band', from: 5, to: 11, label: 'Since launch' }],
    format: (v) => ui.format(v, { compact: true }),
  });
  document.getElementById('measure').addEventListener('change', (event) => {
    const measure = event.detail.value;
    chart.update({ series: series(measure) });
    ui.tween(latest, data[measure].at(-1));
    document.body.dataset.measure = measure;
  });
}
</script>`;

const sandboxView = `<div class="ui-header">
  <p class="ui-title">This view cannot reach anything outside its frame</p>
  <p class="ui-sub">Each check runs inside the view</p>
</div>
<table class="ui-table" style="width: 100%"><tbody id="checks"></tbody></table>
<div class="ui-row" style="margin-top: 12px">
  <button class="ui-btn outline sm" id="leave">Try to leave the frame</button>
</div>
<img alt="" src="${RICH_REPLY_PROBE_ORIGIN}/pixel.png" width="1" height="1">
<script>
{
  const checks = document.getElementById('checks');
  const check = async (name, attempt) => {
    let result = 'blocked';
    try {
      await attempt();
      result = 'reached';
    } catch {}
    checks.insertAdjacentHTML('beforeend', '<tr><td>' + name + '</td><td class="num" data-check="' + name + '">' + result + '</td></tr>');
  };
  (async () => {
    await check('Network', () => fetch('${RICH_REPLY_PROBE_ORIGIN}/fetch', { mode: 'no-cors' }));
    await check('Storage', () => localStorage.setItem('dx-view', '1'));
    await check('Cookies', () => { document.cookie = 'dx-view=1'; if (!document.cookie) throw new Error('none'); });
    await check('dx page', () => top.document.title);
    await check('Popup', () => { if (!window.open('${RICH_REPLY_PROBE_ORIGIN}/popup')) throw new Error('none'); });
    document.body.dataset.checked = 'true';
  })();
  document.getElementById('leave').addEventListener('click', () => {
    location.href = '${RICH_REPLY_PROBE_ORIGIN}/leave';
  });
}
</script>`;

export const RICH_REPLY_TEXT = `Here is the synthetic rich reply.

\`\`\`dx-view
${chartView}
\`\`\`

\`\`\`dx-view
${sandboxView}
\`\`\`

![Synthetic chart frame](${RICH_REPLY_MEDIA_DIRECTORY}/frame.png)

![Synthetic screen recording](${RICH_REPLY_MEDIA_DIRECTORY}/clip.webm)

![Synthetic tone](${RICH_REPLY_MEDIA_DIRECTORY}/tone.wav)

The synthetic rich reply ends here.`;
