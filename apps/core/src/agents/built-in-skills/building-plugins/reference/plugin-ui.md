# @dxcode/plugin-ui

Web components that look like dx, for plugin panes, tabs, pages, thread views
and MCP Apps views. Ask for the kit with one tag, and dx inlines it into the
frame:

```html
<script type="module" src="dx:plugin-ui"></script>
```

A dx-view in the transcript can ask for the kit the same way.

The kit's look is dx's design system: its colors, fonts, type sizes, radii,
and shadows are generated from the dx web app's theme and token files, so
every dx palette, light or dark, and the reader's contrast and forced-colors
settings reach the kit as they reach dx.

Without that tag, nothing loads and the page stays plain HTML. Every plugin
frame gets dx's theme either way, as the [MCP Apps style
variables](https://github.com/modelcontextprotocol/ext-apps)
(`--color-background-primary`, `--color-text-secondary`, `--font-sans`,
`--border-radius-md` and the rest), so plain HTML can use them too. They
switch between light and dark as dx does, without reloading. dx also sends
them as `hostContext.styles.variables` in `ui/initialize` and
`ui/notifications/host-context-changed`. The kit applies those, so kit pages
also follow a palette change live. Plain HTML takes a new palette the next
time the frame opens, unless its own script applies `styles.variables`.

Put the kit tag before your own scripts. Properties you set before the kit
loads, such as `table.rows`, still apply once it does.

The kit sets page defaults (dx's font, 13px text, link and heading colors)
and draws each component in its own shadow root, so your own CSS can't break
it. Style a component's inner parts with `::part(...)`.

## Components

| Element | Attributes | Properties and events |
| --- | --- | --- |
| `<dx-button>` | `variant` (`primary` by default, or `secondary`, `outline`, `ghost`, `destructive`), `size` (`xs`, `sm` by default, `md`, `icon`), `icon`, `label` (accessible name for icon-only buttons), `loading`, `disabled`, `type` (`button`, `submit`, `reset`) | `.loading`, `.disabled`. A `submit` or `reset` button works inside a native `<form>`. |
| `<dx-chip>` | `tone` (`neutral`, `success`, `warning`, `danger`, `info`), `dot`, `pulse` (a live dot), `icon` | A status chip. |
| `<dx-icon>` | `name`, `size` (16 by default) | One of the kit's icons below. |
| `<dx-spinner>` | `size` | |
| `<dx-card>` | `heading`, `description`, `flush` (no padding) | Slot `actions` sits in the header. |
| `<dx-stat>` | `label`, `value`, `delta` (`+12%`, `-3`), `tone` (`up`, `down`; taken from the delta's sign by default), `hint` | |
| `<dx-list>` | `plain` (no card) | Holds `<dx-list-item>`s. |
| `<dx-list-item>` | `heading`, `description`, `icon`, `href` (asks the person before opening), `interactive`, `selected` | Slots `leading`, `trailing` and `description`. The default slot follows the heading. |
| `<dx-table>` | `sortable`, `interactive`, `empty` (text when there are no rows), `plain` | `.columns = [{ key, label, align: "end", width, format(value, row) }]` (`format` returns text or a `Node`), `.rows = [...]`, and a `row-click` event with `{ row, index }`. Without `.columns`, it styles a plain `<table>` placed inside it. |
| `<dx-input>` | `label`, `hint`, `error`, `type`, `name`, `value`, `placeholder`, `required`, `disabled`, `readonly`, `min`, `max`, `step`, `autocomplete` | `.value`, plus `input` and `change` events. Enter submits its form. |
| `<dx-textarea>` | as `dx-input`, plus `rows` | `.value` |
| `<dx-select>` | as `dx-input` | Takes its `<option>` children. `.value` |
| `<dx-checkbox>`, `<dx-switch>` | `label` (or the element's text), `checked`, `disabled`, `name`, `value` | `.checked` and a `change` event. |
| `<dx-tabs>` | `value` | Holds `<dx-tab value label icon>` panels. Fires a `change` event with `{ value }`. The arrow keys move between tabs. |
| `<dx-empty>` | `heading`, `icon` (`none` hides it) | The default slot is the description. Slot `actions`. |
| `<dx-code>` | `language`, `wrap` | Its text, or `.code = "…"`, with a copy button. |
| `<dx-player>` | `src`, `poster`, `muted`, `autoplay`, `loop`, `audio`, `live`, `stream`, `type` | `.srcObject` takes a `MediaStream` (WebRTC, a canvas). `.media` is the inner `<video>` or `<audio>`. |

Every form field is form-associated, so `new FormData(form)` reads it and
`form.reset()` restores it. A plugin frame never submits a form to a URL: its
sandbox blocks that. A `<dx-button type="submit">`, or Enter in a
`<dx-input>`, checks the form's fields and, if they are valid, fires its
`submit` event. Handle it in script and call `preventDefault()`.

### Icons

`icon` on a button, chip, list item, tab, or empty state, and `name` on
`<dx-icon>`, take one of these Lucide names; any other name draws nothing.
The same set is `window.dx.ui.icons`. A manifest or `registerPane` `icon`
is different: it takes any Lucide name as `lucide:<name>`.

`check` `x` `plus` `minus` `search` `chevron-down` `chevron-up` `chevron-right` `chevron-left` `copy` `external-link` `refresh-cw` `play` `pause` `volume-2` `volume-x` `maximize-2` `picture-in-picture-2` `circle-alert` `circle-check` `info` `triangle-alert` `loader-circle` `inbox` `settings` `trash-2` `pencil` `download` `upload` `git-branch` `git-pull-request` `activity` `clock` `file` `folder` `terminal` `ellipsis` `arrow-up-right` `arrow-down-right` `radio` `cpu` `server` `zap` `bug` `user` `users` `star` `bell` `link`

### Live media

`<dx-player stream type='video/mp4; codecs="avc1.42E01F"' autoplay muted>`
plays the pane's own `window.dx.stream()` (an empty `stream`, or the pane's
id). Only a registered pane at a trusted tier gets `window.dx`, not tabs or
pages, and a personal install's panes only for its owner. The
producer's first binary message is the fragmented MP4's init segment, and
each later binary message is one whole fragment that starts on a keyframe.
The player stays near the live edge and ignores string messages. Where
`window.dx.stream` isn't available, the player says live streams need a
trusted plugin. For WebRTC, set `.srcObject` to the remote `MediaStream`.

### Links

A link in a frame, including an `href` on a list item, asks the person
before opening, and opens in a new tab. `window.dx.ui.openLink(url)` does the
same from script.

## Example

[`examples/release-dashboard`](examples/release-dashboard) is a plugin whose
pane is built only from the kit:

```html
<script type="module" src="dx:plugin-ui"></script>
<dx-card heading="Deploys" flush>
  <dx-button slot="actions" size="xs" variant="outline" icon="refresh-cw">Refresh</dx-button>
  <dx-table id="deploys" sortable empty="No deploys yet."></dx-table>
</dx-card>
<script type="module">
  const table = document.getElementById("deploys");
  table.columns = [
    { key: "version", label: "Version" },
    { key: "status", label: "Status", format: (status) => Object.assign(document.createElement("dx-chip"), { textContent: status }) },
    { key: "when", label: "When", align: "end" },
  ];
  table.rows = [{ version: "2.3.9", status: "Live", when: "4 min ago" }];
</script>
```

Licensed under the Apache License, Version 2.0.
