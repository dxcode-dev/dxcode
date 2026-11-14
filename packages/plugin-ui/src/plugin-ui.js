// @ts-nocheck: dx inlines this file as a module script into plugin frames that ask for it with
// <script type="module" src="dx:plugin-ui"></script>. It is never imported by dx's own code.
/* @dxcode/plugin-ui: web components in dx's design language. They read the MCP Apps style
   variables (--color-*, --font-*, --border-radius-*), which dx sets in every plugin frame for
   the current palette and light or dark, so they follow the host without reloading. */
(() => {
  if (customElements.get("dx-button")) return;
  const VERSION = "1";
  /** A live stream keeps at most this many chunks waiting for its buffer. */
  const STREAM_MAX_QUEUE = 64;
  /** Appends that fail in a row before a stream gives up. */
  const STREAM_MAX_FAILURES = 3;

  /* Icons: a subset of Lucide (ISC), drawn as dx draws them, 1.75px strokes. */
  const ICONS = {
    check: '<path d="M20 6 9 17l-5-5"/>',
    x: '<path d="M18 6 6 18"/><path d="m6 6 12 12"/>',
    plus: '<path d="M5 12h14"/><path d="M12 5v14"/>',
    minus: '<path d="M5 12h14"/>',
    search: '<path d="m21 21-4.34-4.34"/><circle cx="11" cy="11" r="8"/>',
    "chevron-down": '<path d="m6 9 6 6 6-6"/>',
    "chevron-up": '<path d="m18 15-6-6-6 6"/>',
    "chevron-right": '<path d="m9 18 6-6-6-6"/>',
    "chevron-left": '<path d="m15 18-6-6 6-6"/>',
    copy: '<rect width="14" height="14" x="8" y="8" rx="2" ry="2"/><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2"/>',
    "external-link":
      '<path d="M15 3h6v6"/><path d="M10 14 21 3"/><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/>',
    "refresh-cw":
      '<path d="M3 12a9 9 0 0 1 9-9 9.75 9.75 0 0 1 6.74 2.74L21 8"/><path d="M21 3v5h-5"/><path d="M21 12a9 9 0 0 1-9 9 9.75 9.75 0 0 1-6.74-2.74L3 16"/><path d="M8 16H3v5"/>',
    play: '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>',
    pause:
      '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>',
    "volume-2":
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><path d="M16 9a5 5 0 0 1 0 6"/><path d="M19.364 18.364a9 9 0 0 0 0-12.728"/>',
    "volume-x":
      '<path d="M11 4.702a.705.705 0 0 0-1.203-.498L6.413 7.587A1.4 1.4 0 0 1 5.416 8H3a1 1 0 0 0-1 1v6a1 1 0 0 0 1 1h2.416a1.4 1.4 0 0 1 .997.413l3.383 3.384A.705.705 0 0 0 11 19.298z"/><line x1="22" x2="16" y1="9" y2="15"/><line x1="16" x2="22" y1="9" y2="15"/>',
    "maximize-2":
      '<path d="M15 3h6v6"/><path d="m21 3-7 7"/><path d="m3 21 7-7"/><path d="M9 21H3v-6"/>',
    "picture-in-picture-2":
      '<path d="M21 9V6a2 2 0 0 0-2-2H4a2 2 0 0 0-2 2v10c0 1.1.9 2 2 2h4"/><rect width="10" height="7" x="12" y="13" rx="2"/>',
    "circle-alert":
      '<circle cx="12" cy="12" r="10"/><line x1="12" x2="12" y1="8" y2="12"/><line x1="12" x2="12.01" y1="16" y2="16"/>',
    "circle-check": '<circle cx="12" cy="12" r="10"/><path d="m9 12 2 2 4-4"/>',
    info: '<circle cx="12" cy="12" r="10"/><path d="M12 16v-4"/><path d="M12 8h.01"/>',
    "triangle-alert":
      '<path d="m21.73 18-8-14a2 2 0 0 0-3.48 0l-8 14A2 2 0 0 0 4 21h16a2 2 0 0 0 1.73-3"/><path d="M12 9v4"/><path d="M12 17h.01"/>',
    "loader-circle": '<path d="M21 12a9 9 0 1 1-6.219-8.56"/>',
    inbox:
      '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
    settings:
      '<path d="M9.671 4.136a2.34 2.34 0 0 1 4.659 0 2.34 2.34 0 0 0 3.319 1.915 2.34 2.34 0 0 1 2.33 4.033 2.34 2.34 0 0 0 0 3.831 2.34 2.34 0 0 1-2.33 4.033 2.34 2.34 0 0 0-3.319 1.915 2.34 2.34 0 0 1-4.659 0 2.34 2.34 0 0 0-3.32-1.915 2.34 2.34 0 0 1-2.33-4.033 2.34 2.34 0 0 0 0-3.831A2.34 2.34 0 0 1 6.35 6.051a2.34 2.34 0 0 0 3.319-1.915"/><circle cx="12" cy="12" r="3"/>',
    "trash-2":
      '<path d="M10 11v6"/><path d="M14 11v6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M3 6h18"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    pencil:
      '<path d="M21.174 6.812a1 1 0 0 0-3.986-3.987L3.842 16.174a2 2 0 0 0-.5.83l-1.321 4.352a.5.5 0 0 0 .623.622l4.353-1.32a2 2 0 0 0 .83-.497z"/><path d="m15 5 4 4"/>',
    download:
      '<path d="M12 15V3"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><path d="m7 10 5 5 5-5"/>',
    upload:
      '<path d="M12 3v12"/><path d="m17 8-5-5-5 5"/><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/>',
    "git-branch":
      '<path d="M15 6a9 9 0 0 0-9 9V3"/><circle cx="18" cy="6" r="3"/><circle cx="6" cy="18" r="3"/>',
    "git-pull-request":
      '<circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="M13 6h3a2 2 0 0 1 2 2v7"/><line x1="6" x2="6" y1="9" y2="21"/>',
    activity:
      '<path d="M22 12h-2.48a2 2 0 0 0-1.93 1.46l-2.35 8.36a.25.25 0 0 1-.48 0L9.24 2.18a.25.25 0 0 0-.48 0l-2.35 8.36A2 2 0 0 1 4.49 12H2"/>',
    clock: '<circle cx="12" cy="12" r="10"/><path d="M12 6v6l4 2"/>',
    file: '<path d="M6 22a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h8a2.4 2.4 0 0 1 1.704.706l3.588 3.588A2.4 2.4 0 0 1 20 8v12a2 2 0 0 1-2 2z"/><path d="M14 2v5a1 1 0 0 0 1 1h5"/>',
    folder:
      '<path d="M20 20a2 2 0 0 0 2-2V8a2 2 0 0 0-2-2h-7.9a2 2 0 0 1-1.69-.9L9.6 3.9A2 2 0 0 0 7.93 3H4a2 2 0 0 0-2 2v13a2 2 0 0 0 2 2Z"/>',
    terminal: '<path d="M12 19h8"/><path d="m4 17 6-6-6-6"/>',
    ellipsis:
      '<circle cx="12" cy="12" r="1"/><circle cx="19" cy="12" r="1"/><circle cx="5" cy="12" r="1"/>',
    "arrow-up-right": '<path d="M7 7h10v10"/><path d="M7 17 17 7"/>',
    "arrow-down-right": '<path d="m7 7 10 10"/><path d="M17 7v10H7"/>',
    radio:
      '<path d="M16.247 7.761a6 6 0 0 1 0 8.478"/><path d="M19.075 4.933a10 10 0 0 1 0 14.134"/><path d="M4.925 19.067a10 10 0 0 1 0-14.134"/><path d="M7.753 16.239a6 6 0 0 1 0-8.478"/><circle cx="12" cy="12" r="2"/>',
    cpu: '<path d="M12 20v2"/><path d="M12 2v2"/><path d="M17 20v2"/><path d="M17 2v2"/><path d="M2 12h2"/><path d="M2 17h2"/><path d="M2 7h2"/><path d="M20 12h2"/><path d="M20 17h2"/><path d="M20 7h2"/><path d="M7 20v2"/><path d="M7 2v2"/><rect x="4" y="4" width="16" height="16" rx="2"/><rect x="8" y="8" width="8" height="8" rx="1"/>',
    server:
      '<rect width="20" height="8" x="2" y="2" rx="2" ry="2"/><rect width="20" height="8" x="2" y="14" rx="2" ry="2"/><line x1="6" x2="6.01" y1="6" y2="6"/><line x1="6" x2="6.01" y1="18" y2="18"/>',
    zap: '<path d="M15.914 4a1.5 1.5 0 00-2.474-1.561l-9 9A1.5 1.5 0 005.5 14h4.002a.5.5 0 01.471.666L8.086 20a1.5 1.5 0 002.475 1.56l9-9A1.5 1.5 0 0018.5 10h-3.997a.5.5 0 01-.472-.667z"/>',
    bug: '<path d="M12 20v-9"/><path d="M14 7a4 4 0 0 1 4 4v3a6 6 0 0 1-12 0v-3a4 4 0 0 1 4-4z"/><path d="M14.12 3.88 16 2"/><path d="M21 21a4 4 0 0 0-3.81-4"/><path d="M21 5a4 4 0 0 1-3.55 3.97"/><path d="M22 13h-4"/><path d="M3 21a4 4 0 0 1 3.81-4"/><path d="M3 5a4 4 0 0 0 3.55 3.97"/><path d="M6 13H2"/><path d="m8 2 1.88 1.88"/><path d="M9 7.13V6a3 3 0 1 1 6 0v1.13"/>',
    user: '<path d="M19 21v-2a4 4 0 0 0-4-4H9a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
    users:
      '<path d="M16 21v-2a4 4 0 0 0-4-4H6a4 4 0 0 0-4 4v2"/><path d="M16 3.128a4 4 0 0 1 0 7.744"/><path d="M22 21v-2a4 4 0 0 0-3-3.87"/><circle cx="9" cy="7" r="4"/>',
    star: '<path d="M11.525 2.295a.53.53 0 0 1 .95 0l2.31 4.679a2.123 2.123 0 0 0 1.595 1.16l5.166.756a.53.53 0 0 1 .294.904l-3.736 3.638a2.123 2.123 0 0 0-.611 1.878l.882 5.14a.53.53 0 0 1-.771.56l-4.618-2.428a2.122 2.122 0 0 0-1.973 0L6.396 21.01a.53.53 0 0 1-.77-.56l.881-5.139a2.122 2.122 0 0 0-.611-1.879L2.16 9.795a.53.53 0 0 1 .294-.906l5.165-.755a2.122 2.122 0 0 0 1.597-1.16z"/>',
    bell: '<path d="M10.268 21a2 2 0 0 0 3.464 0"/><path d="M3.262 15.326A1 1 0 0 0 4 17h16a1 1 0 0 0 .74-1.673C19.41 13.956 18 12.499 18 8A6 6 0 0 0 6 8c0 4.499-1.411 5.956-2.738 7.326"/>',
    link: '<path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/>',
  };
  const svg = (name, size = 16) =>
    ICONS[name]
      ? `<svg part="icon" class="icon" width="${size}" height="${size}" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`
      : "";
  const esc = (value) =>
    String(value ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );

  /* The host: theme from MCP Apps host context, and links through dx's confirmation. */
  const root = document.documentElement;
  const applyContext = (context) => {
    if (!context || typeof context !== "object") return;
    if (context.theme === "light" || context.theme === "dark")
      root.style.colorScheme = context.theme;
    const variables = context.styles?.variables;
    if (variables && typeof variables === "object")
      for (const [name, value] of Object.entries(variables))
        if (name.startsWith("--") && typeof value === "string")
          root.style.setProperty(name, value);
  };
  addEventListener("message", (event) => {
    if (event.source !== parent) return;
    const data = event.data;
    if (data?.jsonrpc !== "2.0") return;
    if (data.result?.hostContext) applyContext(data.result.hostContext);
    else if (data.method === "ui/notifications/host-context-changed")
      applyContext(data.params);
  });
  const openLink = (url) =>
    parent.postMessage(
      { source: "dx-view", type: "open", url: String(url) },
      "*",
    );

  /* Page defaults, so a plain page around the components reads like dx. Only for the
	   document's own elements: none of it reaches a component's shadow. */
  const page = new CSSStyleSheet();
  page.replaceSync(`
:root{font-family:var(--font-sans);font-size:var(--font-text-md-size,13px);line-height:var(--font-text-md-line-height,20px);color:var(--color-text-primary);-webkit-font-smoothing:antialiased;-moz-osx-font-smoothing:grayscale;-webkit-text-size-adjust:100%}
body{margin:0}
:where(h1,h2,h3,h4){margin:0;font-weight:var(--font-weight-medium);color:var(--color-text-primary)}
:where(h1){font-size:var(--font-heading-sm-size);line-height:var(--font-heading-sm-line-height)}
:where(h2,h3,h4){font-size:var(--font-text-md-size);line-height:var(--font-text-md-line-height)}
:where(p){margin:0}
:where(a){color:var(--color-text-info);text-underline-offset:2px}
:where(code,kbd,pre){font-family:var(--font-mono);font-size:12px}
::selection{background:color-mix(in oklab,var(--color-ring-info) 30%,transparent)}
:where(dx-button,dx-chip,dx-icon,dx-spinner,dx-stat,dx-card,dx-list,dx-list-item,dx-table,dx-input,dx-textarea,dx-select,dx-checkbox,dx-switch,dx-tabs,dx-tab,dx-empty,dx-code,dx-player):not(:defined){visibility:hidden}
dx-table>table{width:100%;border-collapse:collapse;font-variant-numeric:tabular-nums;font-size:12px}
dx-table>table th{height:32px;padding:0 12px;border-bottom:1px solid var(--color-border-secondary);color:var(--color-text-secondary);font-weight:var(--font-weight-normal);text-align:left;white-space:nowrap}
dx-table>table td{height:36px;padding:0 12px;border-bottom:1px solid var(--color-border-tertiary)}
dx-table>table tr:last-child td{border-bottom:0}
dx-table>table :is(th,td):first-child{padding-left:16px}
dx-table>table :is(th,td):last-child{padding-right:16px}
dx-table>table :is(th,td)[data-align=end]{text-align:right}
`);
  document.adoptedStyleSheets = [...document.adoptedStyleSheets, page];

  const sheet = (css) => {
    const s = new CSSStyleSheet();
    s.replaceSync(css);
    return s;
  };
  const base = sheet(`
:host{box-sizing:border-box;font-family:var(--font-sans);-webkit-font-smoothing:antialiased}
:host([hidden]){display:none!important}
*,*::before,*::after{box-sizing:border-box}
.icon{flex:none;display:block}
button,input,select,textarea{font:inherit;color:inherit;margin:0}
:focus-visible{outline:none}
.spin{animation:spin .8s linear infinite}
@keyframes spin{to{transform:rotate(360deg)}}
@media (prefers-reduced-motion:reduce){.spin{animation-duration:2.4s}}
`);

  /* The base element: a shadow root with the shared sheet, re-rendered when an observed
	   attribute changes. */
  class Base extends HTMLElement {
    static styles = [];
    constructor() {
      super();
      const shadow = this.attachShadow({
        mode: "open",
        delegatesFocus: this.constructor.focusable === true,
      });
      shadow.adoptedStyleSheets = [base, ...this.constructor.styles];
    }
    connectedCallback() {
      if (this._rendered) return;
      // A page script may set a property before the kit defines the element; that value hides
      // the setter, so take it back through the setter.
      for (const name of this.constructor.properties ?? [])
        if (Object.hasOwn(this, name)) {
          const value = this[name];
          delete this[name];
          this[name] = value;
        }
      this._rendered = true;
      this.render();
    }
    attributeChangedCallback(name, previous, next) {
      if (!this._rendered || previous === next) return;
      if (this.update) this.update(name);
      else this.render();
    }
    emit(type, detail) {
      return this.dispatchEvent(
        new CustomEvent(type, { detail, bubbles: true, composed: true }),
      );
    }
    flag(name) {
      return this.hasAttribute(name);
    }
  }
  /* A plugin frame's sandbox has no allow-forms, so the browser never submits a form there and
     fires no submit event. Kit buttons and fields fire it themselves once the form is valid;
     handle it, and call preventDefault() out of habit. */
  const submit = (form) => {
    if (!form.reportValidity()) return;
    form.dispatchEvent(
      new SubmitEvent("submit", { bubbles: true, cancelable: true }),
    );
  };
  const define = (name, element) =>
    customElements.get(name) || customElements.define(name, element);

  /* <dx-icon name size> */
  define(
    "dx-icon",
    class extends Base {
      static observedAttributes = ["name", "size"];
      static styles = [
        sheet(":host{display:inline-flex;vertical-align:-3px;color:inherit}"),
      ];
      render() {
        this.shadowRoot.innerHTML = svg(
          this.getAttribute("name") ?? "",
          Number(this.getAttribute("size")) || 16,
        );
      }
    },
  );

  /* <dx-spinner size> */
  define(
    "dx-spinner",
    class extends Base {
      static observedAttributes = ["size"];
      static styles = [
        sheet(":host{display:inline-flex;color:var(--color-text-secondary)}"),
      ];
      render() {
        this.setAttribute("role", "status");
        if (!this.hasAttribute("aria-label"))
          this.setAttribute("aria-label", "Loading");
        this.shadowRoot.innerHTML = svg(
          "loader-circle",
          Number(this.getAttribute("size")) || 16,
        ).replace('class="icon"', 'class="icon spin"');
      }
    },
  );

  /* <dx-button variant="primary|secondary|outline|ghost|destructive" size="xs|sm|md|icon" icon
	   loading disabled type="button|submit|reset"> */
  define(
    "dx-button",
    class extends Base {
      static formAssociated = true;
      static focusable = true;
      static observedAttributes = [
        "variant",
        "size",
        "icon",
        "loading",
        "disabled",
        "type",
        "label",
      ];
      static styles = [
        sheet(`
:host{display:inline-flex;vertical-align:middle}
:host(:is([loading],[disabled])){pointer-events:none}
button{display:inline-flex;align-items:center;justify-content:center;gap:6px;width:100%;height:32px;padding:0 12px;border:0;border-radius:var(--border-radius-md);font-size:12px;font-weight:var(--font-weight-medium);line-height:16px;white-space:nowrap;cursor:pointer;user-select:none;transition:background-color .15s,opacity .15s,box-shadow .15s;background:var(--color-background-inverse);color:var(--color-text-inverse)}
button:hover{opacity:.9}
button:focus-visible{box-shadow:0 0 0 1px var(--color-ring-primary),0 0 0 4px color-mix(in oklab,var(--color-ring-primary) 50%,transparent)}
button:disabled{pointer-events:none;opacity:.5}
:host([variant=secondary]) button{background:var(--color-background-tertiary);color:var(--color-text-primary)}
:host([variant=secondary]) button:hover{opacity:.8}
:host([variant=outline]) button{background:transparent;color:var(--color-text-primary);box-shadow:inset 0 0 0 1px var(--color-border-primary)}
:host([variant=outline]) button:hover,:host([variant=ghost]) button:hover{opacity:1;background:var(--color-background-ghost)}
:host([variant=ghost]) button{background:transparent;color:var(--color-text-primary)}
:host([variant=destructive]) button{background:var(--color-text-danger);color:#fff}
:host([size=xs]) button{height:24px;padding:0 8px;gap:4px}
:host([size=xs]) .icon{width:12px;height:12px}
:host([size=md]) button{height:36px;padding:0 16px;font-size:13px}
:host([size=icon]) button{width:32px;padding:0}
:host([size=icon][variant]) button{width:32px}
.icon{width:14px;height:14px}
`),
      ];
      static properties = ["disabled", "loading"];
      constructor() {
        super();
        this.internals = this.attachInternals();
      }
      formDisabledCallback(disabled) {
        this._fieldsetDisabled = disabled;
        this.update();
      }
      // In place, so the button keeps focus while its state changes.
      update() {
        const button = this.shadowRoot.querySelector("button");
        if (!button) return;
        const icon = this.getAttribute("icon");
        const loading = this.flag("loading");
        const label = this.getAttribute("label");
        button.disabled =
          this.flag("disabled") || loading || this._fieldsetDisabled === true;
        button.toggleAttribute("aria-busy", loading);
        if (label) {
          button.setAttribute("aria-label", label);
          button.title = label;
        } else {
          button.removeAttribute("aria-label");
          button.removeAttribute("title");
        }
        button.querySelector("svg")?.remove();
        button.insertAdjacentHTML(
          "afterbegin",
          loading
            ? svg("loader-circle").replace('class="icon"', 'class="icon spin"')
            : icon
              ? svg(icon)
              : "",
        );
      }
      render() {
        this.shadowRoot.innerHTML =
          '<button part="button" type="button"><slot></slot></button>';
        this.update();
        this.shadowRoot
          .querySelector("button")
          .addEventListener("click", () => {
            const type = this.getAttribute("type");
            const form = this.internals.form;
            if (!form) return;
            if (type === "submit") submit(form);
            else if (type === "reset") form.reset();
          });
      }
      get disabled() {
        return this.flag("disabled");
      }
      set disabled(value) {
        this.toggleAttribute("disabled", Boolean(value));
      }
      get loading() {
        return this.flag("loading");
      }
      set loading(value) {
        this.toggleAttribute("loading", Boolean(value));
      }
    },
  );

  /* <dx-chip tone="neutral|success|warning|danger|info" dot pulse icon> */
  define(
    "dx-chip",
    class extends Base {
      static observedAttributes = ["tone", "dot", "pulse", "icon"];
      static styles = [
        sheet(`
:host{--tone:var(--color-text-secondary);--fill:transparent;--edge:var(--color-border-secondary);display:inline-flex;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:5px;box-shadow:inset 0 0 0 1px var(--edge);background:var(--fill);color:var(--tone);font-size:11px;font-weight:var(--font-weight-medium);line-height:16px;white-space:nowrap;vertical-align:middle;font-variant-numeric:tabular-nums}
:host([tone=success]){--tone:var(--color-text-success);--fill:var(--color-background-success);--edge:var(--color-border-success)}
:host([tone=warning]){--tone:var(--color-text-warning);--fill:var(--color-background-warning);--edge:var(--color-border-warning)}
:host([tone=danger]){--tone:var(--color-text-danger);--fill:var(--color-background-danger);--edge:var(--color-border-danger)}
:host([tone=info]){--tone:var(--color-text-info);--fill:var(--color-background-info);--edge:var(--color-border-info)}
.dot{width:6px;height:6px;border-radius:50%;background:currentColor;flex:none}
:host([pulse]) .dot{animation:pulse 1.6s ease-in-out infinite}
@keyframes pulse{50%{opacity:.35}}
.icon{width:12px;height:12px}
`),
      ];
      render() {
        const icon = this.getAttribute("icon");
        this.shadowRoot.innerHTML = `${this.flag("dot") || this.flag("pulse") ? '<span class="dot" part="dot"></span>' : icon ? svg(icon, 12) : ""}<slot></slot>`;
      }
    },
  );

  /* <dx-card heading description>…<div slot="actions">…</div></dx-card> */
  define(
    "dx-card",
    class extends Base {
      static observedAttributes = ["heading", "description", "flush"];
      static styles = [
        sheet(`
:host{display:block;overflow:hidden;border-radius:var(--border-radius-md);background:color-mix(in srgb,var(--color-background-primary) 80%,transparent);box-shadow:0 0 0 1px var(--color-border-tertiary),var(--shadow-sm)}
header{display:flex;align-items:center;gap:12px;min-height:44px;padding:10px 16px;border-bottom:1px solid var(--color-border-tertiary)}
header[hidden]{display:none}
.copy{flex:1;min-width:0}
h2{margin:0;font-size:12px;font-weight:var(--font-weight-medium);line-height:16px;letter-spacing:-.01em;color:var(--color-text-primary)}
p{margin:2px 0 0;font-size:11px;line-height:16px;color:var(--color-text-secondary)}
p:empty{display:none}
.actions{display:flex;align-items:center;gap:6px}
.body{padding:16px}
:host([flush]) .body{padding:0}
`),
      ];
      render() {
        const heading = this.getAttribute("heading");
        const description = this.getAttribute("description");
        this.shadowRoot.innerHTML = `<header part="header"${heading ? "" : " hidden"}><div class="copy"><h2 part="heading">${esc(heading)}</h2><p>${esc(description)}</p></div><div class="actions"><slot name="actions"></slot></div></header><div class="body" part="body"><slot></slot></div>`;
      }
    },
  );

  /* <dx-stat label value delta tone hint> */
  define(
    "dx-stat",
    class extends Base {
      static observedAttributes = ["label", "value", "delta", "tone", "hint"];
      static styles = [
        sheet(`
:host{display:flex;flex-direction:column;gap:4px;min-width:0}
.label{font-size:11px;line-height:16px;color:var(--color-text-secondary);white-space:nowrap;overflow:hidden;text-overflow:ellipsis}
.row{display:flex;align-items:baseline;gap:8px}
.value{font-size:var(--font-heading-lg-size);line-height:var(--font-heading-lg-line-height);font-weight:var(--font-weight-medium);letter-spacing:-.02em;color:var(--color-text-primary);font-variant-numeric:tabular-nums}
.delta{display:inline-flex;align-items:center;gap:2px;font-size:11px;font-weight:var(--font-weight-medium);font-variant-numeric:tabular-nums;color:var(--color-text-secondary)}
.delta.up{color:var(--color-text-success)}.delta.down{color:var(--color-text-danger)}
.hint{font-size:11px;line-height:16px;color:var(--color-text-tertiary)}
.hint:empty{display:none}
.icon{width:12px;height:12px}
`),
      ];
      render() {
        const delta = this.getAttribute("delta") ?? "";
        const tone =
          this.getAttribute("tone") ??
          (/^[+]/.test(delta) ? "up" : /^[-−]/.test(delta) ? "down" : "");
        const arrow =
          tone === "up"
            ? svg("arrow-up-right", 12)
            : tone === "down"
              ? svg("arrow-down-right", 12)
              : "";
        this.shadowRoot.innerHTML = `<div class="label" part="label">${esc(this.getAttribute("label"))}</div><div class="row"><span class="value" part="value">${esc(this.getAttribute("value"))}<slot></slot></span>${delta ? `<span class="delta ${tone}" part="delta">${arrow}${esc(delta.replace(/^-/, "−"))}</span>` : ""}</div><div class="hint">${esc(this.getAttribute("hint"))}</div>`;
      }
    },
  );

  /* <dx-list> of <dx-list-item heading description icon href interactive>, with slots
	   "leading" and "trailing". */
  define(
    "dx-list",
    class extends Base {
      static observedAttributes = ["plain"];
      static styles = [
        sheet(`
:host{display:block;overflow:hidden;border-radius:var(--border-radius-md);background:color-mix(in srgb,var(--color-background-primary) 80%,transparent);box-shadow:0 0 0 1px var(--color-border-tertiary),var(--shadow-sm)}
:host([plain]){border-radius:0;background:none;box-shadow:none}
::slotted(dx-list-item:not(:last-child)){border-bottom:1px solid var(--color-border-tertiary)}
`),
      ];
      render() {
        this.setAttribute("role", "list");
        this.shadowRoot.innerHTML = "<slot></slot>";
      }
    },
  );
  define(
    "dx-list-item",
    class extends Base {
      static observedAttributes = [
        "heading",
        "description",
        "icon",
        "href",
        "interactive",
        "selected",
      ];
      static styles = [
        sheet(`
:host{display:block;outline:none}
.row{display:grid;grid-template-columns:auto minmax(0,1fr) auto;align-items:center;gap:12px;min-height:52px;padding:10px 16px}
:host(:is([interactive],[href])) .row{cursor:pointer;transition:background-color .12s}
:host(:is([interactive],[href]):hover) .row,:host([selected]) .row{background:var(--color-background-ghost)}
:host(:focus-visible) .row{box-shadow:inset 0 0 0 2px var(--color-ring-primary)}
.lead{display:flex;align-items:center;color:var(--color-text-secondary)}
:host(:not([data-lead])) .lead{display:none}
:host(:not([data-lead])) .row{grid-template-columns:minmax(0,1fr) auto}
.title{display:flex;align-items:center;gap:7px;min-width:0;font-size:12px;font-weight:var(--font-weight-medium);line-height:16px;letter-spacing:-.01em;color:var(--color-text-primary)}
.title span{overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.desc{margin-top:3px;font-size:11px;line-height:16px;color:var(--color-text-secondary)}
.desc:empty{display:none}
.trail{display:flex;align-items:center;gap:8px;color:var(--color-text-secondary);font-size:12px}
.icon{width:16px;height:16px}
`),
      ];
      render() {
        this.setAttribute("role", "listitem");
        const linked = this.flag("href") || this.flag("interactive");
        if (linked && !this.hasAttribute("tabindex")) {
          this.tabIndex = 0;
          this._ownTabIndex = true;
        } else if (!linked && this._ownTabIndex) {
          this.removeAttribute("tabindex");
          this._ownTabIndex = false;
        }
        const icon = this.getAttribute("icon");
        const heading = this.getAttribute("heading");
        const description = this.getAttribute("description");
        this.shadowRoot.innerHTML = `<div class="row" part="row"><div class="lead">${icon ? svg(icon) : ""}<slot name="leading"></slot></div><div class="copy"><div class="title" part="heading">${heading ? `<span>${esc(heading)}</span>` : ""}<slot></slot></div><div class="desc" part="description">${esc(description)}</div><slot name="description"></slot></div><div class="trail"><slot name="trailing"></slot>${this.flag("href") ? svg("arrow-up-right", 14) : ""}</div></div>`;
        const leading = this.shadowRoot.querySelector("slot[name=leading]");
        const lead = () =>
          this.toggleAttribute(
            "data-lead",
            Boolean(icon) || leading.assignedElements().length > 0,
          );
        leading.addEventListener("slotchange", lead);
        lead();
        if (!this._wired) {
          this._wired = true;
          this.addEventListener("click", (event) => {
            const href = this.getAttribute("href");
            if (href && !event.defaultPrevented) {
              if (href.startsWith("#")) location.hash = href;
              else
                try {
                  openLink(new URL(href, location.href).href);
                } catch {
                  // A relative href has no base in a srcdoc frame.
                }
            }
          });
          this.addEventListener("keydown", (event) => {
            if (
              (event.key === "Enter" || event.key === " ") &&
              event.target === this &&
              (this.flag("href") || this.flag("interactive"))
            ) {
              event.preventDefault();
              this.click();
            }
          });
        }
      }
    },
  );

  /* <dx-table sortable empty="…"> with .columns = [{ key, label, align, format, width }] and
	   .rows = [...], or with a plain <table> inside it. */
  define(
    "dx-table",
    class extends Base {
      static observedAttributes = ["sortable", "empty", "interactive"];
      static styles = [
        sheet(`
:host{display:block;overflow:auto;border-radius:var(--border-radius-md);background:color-mix(in srgb,var(--color-background-primary) 80%,transparent);box-shadow:0 0 0 1px var(--color-border-tertiary),var(--shadow-sm)}
:host([plain]){border-radius:0;background:none;box-shadow:none}
table{width:100%;border-collapse:collapse;font-size:12px;font-variant-numeric:tabular-nums}
th{position:sticky;top:0;z-index:1;height:32px;padding:0 12px;border-bottom:1px solid var(--color-border-secondary);background:var(--color-background-primary);color:var(--color-text-secondary);font-weight:var(--font-weight-normal);text-align:left;white-space:nowrap}
th button{all:unset;display:inline-flex;align-items:center;gap:4px;cursor:pointer;border-radius:3px}
th button:hover{color:var(--color-text-primary)}
th button:focus-visible{box-shadow:0 0 0 2px var(--color-ring-primary)}
th .icon{width:12px;height:12px;opacity:0}
th[aria-sort] .icon{opacity:1}
td{height:36px;padding:0 12px;border-bottom:1px solid var(--color-border-tertiary);color:var(--color-text-primary)}
tr:last-child td{border-bottom:0}
:is(th,td):first-child{padding-left:16px}
:is(th,td):last-child{padding-right:16px}
.end{text-align:right}
th.end button{flex-direction:row-reverse}
:host([interactive]) tbody tr{cursor:pointer}
:host([interactive]) tbody tr:hover td{background:var(--color-background-ghost)}
.empty{padding:24px 16px;text-align:center;color:var(--color-text-secondary);font-size:12px}
`),
      ];
      static properties = ["columns", "rows"];
      _columns = null;
      _rows = [];
      _sort = null;
      get columns() {
        return this._columns;
      }
      set columns(value) {
        this._columns = Array.isArray(value) ? value : null;
        this._rendered && this.render();
      }
      get rows() {
        return this._rows;
      }
      set rows(value) {
        this._rows = Array.isArray(value) ? value : [];
        this._rendered && this.render();
      }
      render() {
        const columns = this._columns;
        if (!columns) {
          this.shadowRoot.innerHTML = "<slot></slot>";
          return;
        }
        let rows = this._rows;
        if (this._sort) {
          const { key, direction } = this._sort;
          rows = [...rows].sort((a, b) => {
            const x = a?.[key];
            const y = b?.[key];
            const order =
              typeof x === "number" && typeof y === "number"
                ? x - y
                : String(x ?? "").localeCompare(String(y ?? ""), undefined, {
                    numeric: true,
                  });
            return direction === "ascending" ? order : -order;
          });
        }
        const sortable = this.flag("sortable");
        const head = columns
          .map((column, index) => {
            const sorted =
              this._sort?.key === column.key ? this._sort.direction : null;
            const label = esc(column.label ?? column.key);
            const style = column.width
              ? ` style="width:${esc(column.width)}"`
              : "";
            return `<th scope="col" class="${column.align === "end" ? "end" : ""}"${sorted ? ` aria-sort="${sorted}"` : ""}${style}>${sortable ? `<button type="button" data-index="${index}">${label}${svg(sorted === "ascending" ? "chevron-up" : "chevron-down", 12)}</button>` : label}</th>`;
          })
          .join("");
        this.shadowRoot.innerHTML = `<table part="table"><thead><tr>${head}</tr></thead><tbody></tbody></table>${rows.length === 0 ? `<div class="empty" part="empty">${esc(this.getAttribute("empty") ?? "Nothing to show yet.")}</div>` : ""}`;
        const body = this.shadowRoot.querySelector("tbody");
        const fragment = document.createDocumentFragment();
        rows.forEach((row, index) => {
          const tr = document.createElement("tr");
          for (const column of columns) {
            const td = document.createElement("td");
            if (column.align === "end") td.className = "end";
            const value = column.format
              ? column.format(row?.[column.key], row)
              : row?.[column.key];
            if (value instanceof Node) td.append(value);
            else td.textContent = value ?? "";
            tr.append(td);
          }
          tr.addEventListener("click", () =>
            this.emit("row-click", { row, index }),
          );
          fragment.append(tr);
        });
        body.append(fragment);
        for (const button of this.shadowRoot.querySelectorAll("th button"))
          button.addEventListener("click", () => {
            const key = columns[Number(button.dataset.index)].key;
            this._sort = {
              key,
              direction:
                this._sort?.key === key && this._sort.direction === "ascending"
                  ? "descending"
                  : "ascending",
            };
            this.render();
            this.shadowRoot
              .querySelector(`th button[data-index="${button.dataset.index}"]`)
              ?.focus();
          });
      }
    },
  );

  /* Form fields. Each one is form-associated, so a native <form> submits its value. */
  const fieldStyles = sheet(`
:host{display:flex;flex-direction:column;gap:6px;min-width:0}
label{font-size:12px;font-weight:var(--font-weight-medium);line-height:16px;color:var(--color-text-primary)}
label:empty{display:none}
.hint{font-size:11px;line-height:16px;color:var(--color-text-secondary)}
.hint:empty{display:none}
.error{color:var(--color-text-danger)}
.control{width:100%;min-width:0;height:32px;padding:0 10px;border:0;border-radius:var(--border-radius-md);background:transparent;box-shadow:inset 0 0 0 1px var(--color-border-primary);font-size:13px;color:var(--color-text-primary);transition:box-shadow .15s}
.control::placeholder{color:var(--color-text-tertiary)}
.control:focus-visible{box-shadow:inset 0 0 0 1px var(--color-ring-primary),0 0 0 3px color-mix(in oklab,var(--color-ring-primary) 40%,transparent)}
.control:disabled{opacity:.5;cursor:not-allowed}
:host([invalid]) .control,:host([error]) .control{box-shadow:inset 0 0 0 1px var(--color-text-danger)}
textarea.control{height:auto;min-height:72px;padding:7px 10px;line-height:18px;resize:vertical}
.select{position:relative;display:flex}
select.control{appearance:none;padding-right:30px;cursor:pointer;background:var(--color-background-primary)}
.select .icon{position:absolute;right:9px;top:9px;width:14px;height:14px;pointer-events:none;color:var(--color-text-secondary)}
`);
  let fieldIds = 0;
  class Field extends Base {
    static formAssociated = true;
    static focusable = true;
    static observedAttributes = [
      "label",
      "hint",
      "error",
      "placeholder",
      "disabled",
      "required",
      "readonly",
      "type",
      "rows",
      "value",
      "name",
      "min",
      "max",
      "step",
      "autocomplete",
    ];
    static styles = [fieldStyles];
    static properties = ["value"];
    constructor() {
      super();
      this.internals = this.attachInternals();
      this._id = `f${++fieldIds}`;
    }
    get form() {
      return this.internals.form;
    }
    get name() {
      return this.getAttribute("name");
    }
    get value() {
      return this.control?.value ?? this.getAttribute("value") ?? "";
    }
    set value(next) {
      if (this.control) this.control.value = next ?? "";
      else this.setAttribute("value", next ?? "");
      this.sync();
    }
    sync() {
      this.internals.setFormValue(this.value);
      const control = this.control;
      if (control)
        this.internals.setValidity(
          control.validity,
          control.validationMessage,
          control,
        );
    }
    formResetCallback() {
      this.value = this.getAttribute("value") ?? "";
    }
    formDisabledCallback(disabled) {
      this._fieldsetDisabled = disabled;
      this.decorate();
    }
    update(name) {
      if (name === "value") {
        if (this.control && this.control.value !== this.getAttribute("value"))
          this.value = this.getAttribute("value");
        return;
      }
      // Only a new kind of control rebuilds; the rest change in place, so typing keeps focus.
      if (name === "type" || name === "rows") this.render();
      else this.decorate();
    }
    /** The label, hint, error, and attributes, onto the current control. */
    decorate() {
      const element = this.control;
      if (!element) return;
      const error = this.getAttribute("error");
      const hint = error ?? this.getAttribute("hint");
      this.shadowRoot.querySelector("label").textContent =
        this.getAttribute("label") ?? "";
      const hintElement = this.shadowRoot.querySelector(".hint");
      hintElement.textContent = hint ?? "";
      hintElement.classList.toggle("error", Boolean(error));
      if (hint) element.setAttribute("aria-describedby", `${this._id}-hint`);
      else element.removeAttribute("aria-describedby");
      element.toggleAttribute("aria-invalid", Boolean(error));
      for (const attribute of [
        "placeholder",
        "name",
        "min",
        "max",
        "step",
        "autocomplete",
      ])
        if (this.hasAttribute(attribute))
          element.setAttribute(attribute, this.getAttribute(attribute));
        else element.removeAttribute(attribute);
      for (const attribute of ["required", "readonly"])
        element.toggleAttribute(attribute, this.flag(attribute));
      element.disabled =
        this.flag("disabled") || this._fieldsetDisabled === true;
      this.sync();
    }
    frame(control) {
      this.shadowRoot.innerHTML = `<label for="${this._id}" part="label"></label>${control}<div class="hint" id="${this._id}-hint" part="hint"></div>`;
      const element = this.shadowRoot.getElementById(this._id);
      const previous = this.control?.value ?? this.getAttribute("value");
      this.control = element;
      // A select keeps its value only while an option still has it.
      if (
        previous !== null &&
        (element.localName !== "select" ||
          [...element.options].some((option) => option.value === previous))
      )
        element.value = previous;
      this.decorate();
      element.addEventListener("input", () => this.sync());
      element.addEventListener("change", () => {
        this.sync();
        this.dispatchEvent(new Event("change", { bubbles: true }));
      });
      this.sync();
    }
    focus(options) {
      this.control?.focus(options);
    }
  }
  define(
    "dx-input",
    class extends Field {
      render() {
        const type = this.getAttribute("type") ?? "text";
        this.frame(
          `<input class="control" part="control" id="${this._id}" type="${esc(type)}">`,
        );
        this.control.addEventListener("keydown", (event) => {
          if (event.key === "Enter" && this.form) {
            event.preventDefault();
            submit(this.form);
          }
        });
      }
    },
  );
  define(
    "dx-textarea",
    class extends Field {
      render() {
        this.frame(
          `<textarea class="control" part="control" id="${this._id}" rows="${Number(this.getAttribute("rows")) || 3}"></textarea>`,
        );
      }
    },
  );
  define(
    "dx-select",
    class extends Field {
      connectedCallback() {
        super.connectedCallback();
        this._observer ??= new MutationObserver(() => this.render());
        this._observer.observe(this, {
          childList: true,
          subtree: true,
          characterData: true,
        });
      }
      disconnectedCallback() {
        this._observer?.disconnect();
      }
      render() {
        const options = [...this.querySelectorAll("option")]
          .map(
            (option) =>
              `<option value="${esc(option.value)}"${option.disabled ? " disabled" : ""}${option.selected && !this.hasAttribute("value") ? " selected" : ""}>${esc(option.textContent)}</option>`,
          )
          .join("");
        this.frame(
          `<div class="select"><select class="control" part="control" id="${this._id}">${options}</select>${svg("chevron-down", 14)}</div>`,
        );
        if (!this.hasAttribute("value") && this.control.selectedIndex >= 0)
          this.sync();
      }
    },
  );

  /* <dx-checkbox label checked> and <dx-switch label checked>. */
  const toggleStyles = sheet(`
:host{display:inline-flex;align-self:flex-start;max-width:100%;vertical-align:middle}
label{display:inline-flex;align-items:center;gap:8px;font-size:12px;line-height:16px;color:var(--color-text-primary);cursor:pointer;user-select:none}
:host([disabled]) label{opacity:.5;cursor:not-allowed}
input{position:absolute;opacity:0;width:1px;height:1px;pointer-events:none}
.box{display:grid;place-items:center;width:16px;height:16px;border-radius:4px;box-shadow:inset 0 0 0 1px var(--color-border-primary);color:var(--color-text-inverse);transition:background-color .12s,box-shadow .12s}
.box .icon{width:12px;height:12px;opacity:0}
input:checked+.box{background:var(--color-background-inverse);box-shadow:none}
input:checked+.box .icon{opacity:1}
.track{position:relative;width:28px;height:16px;border-radius:999px;background:var(--color-border-primary);transition:background-color .15s}
.track::after{content:"";position:absolute;top:2px;left:2px;width:12px;height:12px;border-radius:50%;background:var(--color-background-primary);box-shadow:0 1px 2px rgb(0 0 0/.2);transition:transform .15s cubic-bezier(.2,.8,.2,1)}
input:checked+.track{background:var(--color-background-inverse)}
input:checked+.track::after{transform:translateX(12px)}
input:focus-visible+:is(.box,.track){box-shadow:0 0 0 1px var(--color-ring-primary),0 0 0 4px color-mix(in oklab,var(--color-ring-primary) 40%,transparent)}
`);
  class Toggle extends Base {
    static formAssociated = true;
    static focusable = true;
    static observedAttributes = [
      "label",
      "checked",
      "disabled",
      "name",
      "value",
    ];
    static styles = [toggleStyles];
    constructor() {
      super();
      this.internals = this.attachInternals();
    }
    static properties = ["checked"];
    get checked() {
      return this.input?.checked ?? this._checked ?? this.flag("checked");
    }
    set checked(value) {
      this._checked = Boolean(value);
      if (this.input) this.input.checked = this._checked;
      this.sync();
    }
    formDisabledCallback(disabled) {
      this._fieldsetDisabled = disabled;
      if (this.input) this.input.disabled = this.flag("disabled") || disabled;
    }
    get value() {
      return this.getAttribute("value") ?? "on";
    }
    get form() {
      return this.internals.form;
    }
    sync() {
      this.internals.setFormValue(this.checked ? this.value : null);
      this.internals.states?.[this.checked ? "add" : "delete"]?.("checked");
    }
    formResetCallback() {
      this.checked = this.flag("checked");
    }
    update(name) {
      if (name === "checked" && this.input) this.checked = this.flag("checked");
      else this.render();
    }
    render() {
      const previous = this.checked;
      const control = this.constructor.track
        ? '<span class="track" part="track"></span>'
        : `<span class="box" part="box">${svg("check", 12)}</span>`;
      this.shadowRoot.innerHTML = `<label part="label"><input type="checkbox" role="${this.constructor.track ? "switch" : "checkbox"}"${this.flag("disabled") || this._fieldsetDisabled ? " disabled" : ""}>${control}<slot>${esc(this.getAttribute("label"))}</slot></label>`;
      this.input = this.shadowRoot.querySelector("input");
      this.input.checked = previous;
      this.input.addEventListener("change", () => {
        this.sync();
        this.dispatchEvent(new Event("change", { bubbles: true }));
      });
      this.sync();
    }
  }
  define("dx-checkbox", class extends Toggle {});
  define(
    "dx-switch",
    class extends Toggle {
      static track = true;
    },
  );

  /* <dx-tabs value> of <dx-tab value label icon>panel</dx-tab>. */
  define(
    "dx-tab",
    class extends HTMLElement {
      static observedAttributes = ["label", "icon"];
      connectedCallback() {
        this.setAttribute("role", "tabpanel");
      }
      attributeChangedCallback() {
        const tabs = this.parentElement;
        if (tabs?.localName === "dx-tabs" && tabs._rendered) tabs.render();
      }
    },
  );
  define(
    "dx-tabs",
    class extends Base {
      static observedAttributes = ["value"];
      static styles = [
        sheet(`
:host{display:flex;flex-direction:column;gap:12px;min-width:0}
[role=tablist]{position:relative;display:inline-flex;align-self:flex-start;gap:2px;max-width:100%;padding:2px;overflow-x:auto;border-radius:8px;background:var(--color-background-secondary);isolation:isolate;scrollbar-width:none}
button{position:relative;z-index:1;display:inline-flex;align-items:center;gap:6px;height:24px;padding:0 10px;border:0;border-radius:6px;background:none;color:var(--color-text-secondary);font-size:12px;font-weight:var(--font-weight-medium);white-space:nowrap;cursor:pointer;transition:color .15s}
button:hover{color:var(--color-text-primary)}
button[aria-selected=true]{color:var(--color-text-primary)}
button:focus-visible{box-shadow:0 0 0 2px var(--color-ring-primary)}
.thumb{position:absolute;z-index:0;top:2px;left:0;height:24px;border-radius:6px;background:var(--color-background-primary);box-shadow:0 0 0 1px var(--color-border-secondary),0 1px 2px rgb(0 0 0/.06);transition:transform .22s cubic-bezier(.2,.8,.2,1),width .22s cubic-bezier(.2,.8,.2,1)}
@media (prefers-reduced-motion:reduce){.thumb{transition:none}}
.icon{width:14px;height:14px}
`),
      ];
      connectedCallback() {
        super.connectedCallback();
        this._observer ??= new MutationObserver(() => this.render());
        this._observer.observe(this, { childList: true });
      }
      disconnectedCallback() {
        this._observer?.disconnect();
      }
      static properties = ["value"];
      get value() {
        return (
          this.getAttribute("value") ??
          this.tabs()[0]?.getAttribute("value") ??
          ""
        );
      }
      set value(next) {
        this.setAttribute("value", next);
      }
      tabs() {
        return [...this.children].filter(
          (child) => child.localName === "dx-tab",
        );
      }
      update() {
        this.select(true);
      }
      render() {
        const tabs = this.tabs();
        tabs.forEach((tab, index) => {
          if (!tab.hasAttribute("value"))
            tab.setAttribute("value", String(index));
        });
        this.shadowRoot.innerHTML = `<div role="tablist" part="tablist"><span class="thumb" part="thumb"></span>${tabs
          .map(
            (tab) =>
              `<button type="button" role="tab" part="tab" data-value="${esc(tab.getAttribute("value"))}">${tab.hasAttribute("icon") ? svg(tab.getAttribute("icon"), 14) : ""}${esc(tab.getAttribute("label") ?? tab.getAttribute("value"))}</button>`,
          )
          .join("")}</div><slot></slot>`;
        const list = this.shadowRoot.querySelector("[role=tablist]");
        list.addEventListener("click", (event) => {
          const button = event.target.closest("button");
          if (button) this.choose(button.dataset.value);
        });
        list.addEventListener("keydown", (event) => {
          const buttons = [...list.querySelectorAll("button")];
          const index = buttons.indexOf(this.shadowRoot.activeElement);
          const step = {
            ArrowRight: 1,
            ArrowLeft: -1,
            Home: -index,
            End: buttons.length - 1 - index,
          }[event.key];
          if (step === undefined || index < 0) return;
          event.preventDefault();
          const next =
            buttons[(index + step + buttons.length) % buttons.length];
          next.focus();
          this.choose(next.dataset.value);
        });
        this.select(false);
        this._resize?.disconnect();
        this._resize = new ResizeObserver(() => this.select(false));
        this._resize.observe(list);
      }
      choose(value) {
        if (value === this.value) return;
        this.setAttribute("value", value);
        this.emit("change", { value });
      }
      select(animate = true) {
        const value = this.value;
        for (const tab of this.tabs())
          tab.hidden = tab.getAttribute("value") !== value;
        let active;
        for (const button of this.shadowRoot.querySelectorAll("button")) {
          const selected = button.dataset.value === value;
          button.setAttribute("aria-selected", String(selected));
          button.tabIndex = selected ? 0 : -1;
          if (selected) active = button;
        }
        const thumb = this.shadowRoot.querySelector(".thumb");
        if (!thumb) return;
        thumb.style.display = active ? "" : "none";
        if (!active) return;
        if (!animate) thumb.style.transition = "none";
        thumb.style.width = `${active.offsetWidth}px`;
        thumb.style.transform = `translateX(${active.offsetLeft}px)`;
        if (!animate)
          requestAnimationFrame(() => (thumb.style.transition = ""));
      }
    },
  );

  /* <dx-empty icon heading>description<div slot="actions">…</div></dx-empty> */
  define(
    "dx-empty",
    class extends Base {
      static observedAttributes = ["icon", "heading"];
      static styles = [
        sheet(`
:host{display:flex;flex-direction:column;align-items:center;justify-content:center;gap:4px;padding:32px 16px;text-align:center}
.mark{display:grid;place-items:center;width:32px;height:32px;margin-bottom:8px;border-radius:8px;background:var(--color-background-secondary);color:var(--color-text-secondary)}
h2{margin:0;font-size:13px;font-weight:var(--font-weight-medium);line-height:20px;color:var(--color-text-primary)}
.text{max-width:320px;font-size:12px;line-height:18px;color:var(--color-text-secondary);text-wrap:pretty}
.actions{display:flex;gap:8px;margin-top:12px}
.actions:not(:has(slot.filled)){display:none}
`),
      ];
      render() {
        const icon = this.getAttribute("icon") ?? "inbox";
        this.shadowRoot.innerHTML = `${icon === "none" ? "" : `<div class="mark" part="icon">${svg(icon)}</div>`}<h2 part="heading">${esc(this.getAttribute("heading") ?? "")}</h2><div class="text" part="description"><slot></slot></div><div class="actions"><slot name="actions"></slot></div>`;
        const actions = this.shadowRoot.querySelector("slot[name=actions]");
        const mark = () =>
          actions.classList.toggle(
            "filled",
            actions.assignedElements().length > 0,
          );
        actions.addEventListener("slotchange", mark);
        mark();
      }
    },
  );

  /* <dx-code language wrap>source</dx-code>, or .code = "…". */
  define(
    "dx-code",
    class extends Base {
      static observedAttributes = ["language", "wrap"];
      static styles = [
        sheet(`
:host{position:relative;display:block;min-width:0}
pre{margin:0;max-width:100%;padding:8px 36px 8px 12px;overflow:auto;border-radius:var(--border-radius-md);background:color-mix(in srgb,var(--color-text-secondary) 5%,transparent);outline:1px solid color-mix(in oklab,var(--color-text-primary) 10%,transparent);outline-offset:-1px;font:12.5px/1.375 var(--font-mono);color:var(--color-text-primary);white-space:pre;tab-size:2}
:host([wrap]) pre{white-space:pre-wrap;overflow-wrap:anywhere}
.lang{position:absolute;top:6px;right:34px;font:11px/16px var(--font-sans);color:var(--color-text-tertiary);pointer-events:none}
.lang:empty{display:none}
button{position:absolute;top:4px;right:4px;display:grid;place-items:center;width:24px;height:24px;border:0;border-radius:var(--border-radius-sm);background:transparent;color:var(--color-text-secondary);cursor:pointer;opacity:0;transition:opacity .12s,background-color .12s}
:host(:hover) button,button:focus-visible,button.done{opacity:1}
button:hover{background:var(--color-background-ghost);color:var(--color-text-primary)}
button:focus-visible{box-shadow:0 0 0 2px var(--color-ring-primary)}
@media (hover:none){button{opacity:1}}
.icon{width:14px;height:14px}
`),
      ];
      static properties = ["code"];
      get code() {
        return (
          this._code ??
          this.textContent.replace(/^\n/, "").replace(/\n\s*$/, "")
        );
      }
      set code(value) {
        this._code = String(value ?? "");
        this._rendered && this.render();
      }
      render() {
        this.shadowRoot.innerHTML = `<pre part="pre"><code></code></pre><span class="lang">${esc(this.getAttribute("language") ?? "")}</span><button type="button" part="copy" aria-label="Copy code" title="Copy">${svg("copy", 14)}</button>`;
        this.shadowRoot.querySelector("code").textContent = this.code;
        const button = this.shadowRoot.querySelector("button");
        button.addEventListener("click", async () => {
          const copied = await copy(this.code);
          button.innerHTML = svg(copied ? "check" : "x", 14);
          button.classList.add("done");
          button.setAttribute("aria-label", copied ? "Copied" : "Copy failed");
          setTimeout(() => {
            button.innerHTML = svg("copy", 14);
            button.classList.remove("done");
            button.setAttribute("aria-label", "Copy code");
          }, 1400);
        });
        if (!this._observer && this._code === undefined) {
          this._observer = new MutationObserver(() => this.render());
          this._observer.observe(this, {
            childList: true,
            characterData: true,
            subtree: true,
          });
        }
      }
    },
  );
  // A sandboxed frame has no clipboard permission; a selection copy still works on a click.
  const copy = async (text) => {
    try {
      await navigator.clipboard.writeText(text);
      return true;
    } catch {}
    const area = document.createElement("textarea");
    area.value = text;
    area.style.cssText = "position:fixed;opacity:0;pointer-events:none";
    document.body.append(area);
    area.select();
    let done = false;
    try {
      done = document.execCommand("copy");
    } catch {}
    area.remove();
    return done;
  };

  /* <dx-player src poster live muted autoplay loop audio stream="id" type="video/mp4; codecs=…">
	   A dx-styled <video> or <audio>. .srcObject takes a MediaStream (WebRTC); `stream` plays a
	   window.dx.stream whose first binary message is the fMP4 init segment and each later one a
	   whole fragment; .media is the element, for anything else. */
  const time = (seconds) => {
    if (!Number.isFinite(seconds)) return "0:00";
    const s = Math.max(0, Math.floor(seconds));
    const h = Math.floor(s / 3600);
    const m = Math.floor((s % 3600) / 60);
    const r = String(s % 60).padStart(2, "0");
    return h ? `${h}:${String(m).padStart(2, "0")}:${r}` : `${m}:${r}`;
  };
  define(
    "dx-player",
    class extends Base {
      static observedAttributes = [
        "src",
        "poster",
        "live",
        "muted",
        "loop",
        "audio",
        "stream",
        "type",
        "autoplay",
      ];
      static styles = [
        sheet(`
:host{position:relative;display:block;overflow:hidden;border-radius:var(--border-radius-md);background:#000;box-shadow:0 0 0 1px var(--color-border-tertiary);color:#fff;container-type:inline-size}
:host([audio]){background:color-mix(in srgb,var(--color-background-primary) 80%,transparent);color:var(--color-text-primary)}
video{display:block;width:100%;height:100%;max-height:inherit;object-fit:contain;background:#000}
audio{display:none}
.bar{position:absolute;inset:auto 0 0;display:flex;align-items:center;gap:6px;padding:28px 8px 8px;background:linear-gradient(to top,rgb(0 0 0/.6),transparent);opacity:0;transition:opacity .18s}
:host(:hover) .bar,:host(:focus-within) .bar,:host([paused]) .bar,:host([audio]) .bar{opacity:1}
:host([audio]) .bar{position:static;padding:8px;background:none}
@media (hover:none){.bar{opacity:1}}
button{display:grid;place-items:center;flex:none;width:28px;height:28px;border:0;border-radius:var(--border-radius-md);background:transparent;color:inherit;cursor:pointer}
button:hover{background:rgb(255 255 255/.14)}
:host([audio]) button:hover{background:var(--color-background-ghost)}
button:focus-visible{box-shadow:0 0 0 2px var(--color-ring-primary)}
button[hidden]{display:none}
.icon{width:16px;height:16px}
.time{font:11px/16px var(--font-sans);font-variant-numeric:tabular-nums;opacity:.9;white-space:nowrap}
input[type=range]{flex:1;min-width:40px;height:16px;margin:0;accent-color:currentColor;cursor:pointer;background:transparent}
.volume{width:64px;flex:none}
@container (max-width:340px){.volume{display:none}}
.live{display:none;align-items:center;gap:5px;height:20px;padding:0 7px;border-radius:5px;background:rgb(0 0 0/.45);font:500 11px/16px var(--font-sans);letter-spacing:.02em}
.live::before{content:"";width:6px;height:6px;border-radius:50%;background:#ef4444;animation:pulse 1.6s ease-in-out infinite}
:host([live]) .live{display:inline-flex}
:host([live]) :is(.seek,.time){display:none}
:host([live]) .spacer{flex:1}
.spacer{display:none}
@keyframes pulse{50%{opacity:.35}}
.state{position:absolute;inset:0;display:none;place-items:center;font:12px/18px var(--font-sans);color:rgb(255 255 255/.8);text-align:center;padding:16px}
:host([state]) .state{display:grid}
`),
      ];
      render() {
        const audio = this.flag("audio");
        this.shadowRoot.innerHTML = `${audio ? '<audio part="media"></audio>' : '<video part="media" playsinline></video>'}<div class="state" part="state" aria-live="polite"></div><div class="bar" part="controls"><button type="button" class="play" aria-label="Play">${svg("play")}</button><span class="live">LIVE</span><input class="seek" type="range" min="0" max="1000" value="0" step="1" aria-label="Seek"><span class="time">0:00</span><span class="spacer"></span><button type="button" class="mute" aria-label="Mute">${svg("volume-2")}</button><input class="volume" type="range" min="0" max="1" step="0.05" value="1" aria-label="Volume"><button type="button" class="pip" aria-label="Picture in picture" hidden>${svg("picture-in-picture-2")}</button><button type="button" class="full" aria-label="Full screen" hidden>${svg("maximize-2")}</button></div>`;
        this.media = this.shadowRoot.querySelector(audio ? "audio" : "video");
        const media = this.media;
        const $ = (selector) => this.shadowRoot.querySelector(selector);
        const play = $(".play");
        const seek = $(".seek");
        const mute = $(".mute");
        const volume = $(".volume");
        const sync = () => {
          const paused = media.paused;
          this.toggleAttribute("paused", paused);
          play.innerHTML = svg(paused ? "play" : "pause");
          play.setAttribute("aria-label", paused ? "Play" : "Pause");
          const silent = media.muted || media.volume === 0;
          mute.innerHTML = svg(silent ? "volume-x" : "volume-2");
          mute.setAttribute("aria-label", silent ? "Unmute" : "Mute");
          volume.value = String(media.muted ? 0 : media.volume);
          const duration = media.duration;
          if (Number.isFinite(duration) && duration > 0 && !this._seeking)
            seek.value = String(
              Math.round((media.currentTime / duration) * 1000),
            );
          $(".time").textContent =
            `${time(media.currentTime)} / ${time(duration)}`;
        };
        for (const type of [
          "play",
          "pause",
          "timeupdate",
          "durationchange",
          "volumechange",
          "loadedmetadata",
        ])
          media.addEventListener(type, sync);
        media.addEventListener("waiting", () => this.state("Loading…"));
        media.addEventListener("playing", () => this.state(""));
        media.addEventListener("error", () =>
          this.state("This media could not play."),
        );
        play.addEventListener("click", () =>
          media.paused ? media.play().catch(() => undefined) : media.pause(),
        );
        if (!audio) media.addEventListener("click", () => play.click());
        seek.addEventListener("input", () => {
          this._seeking = true;
          if (Number.isFinite(media.duration))
            media.currentTime = (Number(seek.value) / 1000) * media.duration;
        });
        seek.addEventListener("change", () => (this._seeking = false));
        mute.addEventListener("click", () => (media.muted = !media.muted));
        volume.addEventListener("input", () => {
          media.volume = Number(volume.value);
          media.muted = media.volume === 0;
        });
        const pip = $(".pip");
        if (!audio && document.pictureInPictureEnabled) {
          pip.hidden = false;
          pip.addEventListener("click", () =>
            (document.pictureInPictureElement
              ? document.exitPictureInPicture()
              : media.requestPictureInPicture()
            ).catch(() => undefined),
          );
        }
        const full = $(".full");
        if (!audio && document.fullscreenEnabled) {
          full.hidden = false;
          full.addEventListener("click", () =>
            (document.fullscreenElement
              ? document.exitFullscreen()
              : this.requestFullscreen()
            ).catch(() => undefined),
          );
        }
        this.load();
        sync();
      }
      update(name) {
        if (name === "audio") return this.render();
        if (name === "muted") this.media.muted = this.flag("muted");
        else if (name === "loop") this.media.loop = this.flag("loop");
        else if (name === "poster" && "poster" in this.media)
          this.media.poster = this.getAttribute("poster") ?? "";
        else if (name !== "live") this.load();
      }
      state(text) {
        this.toggleAttribute("state", Boolean(text));
        this.shadowRoot.querySelector(".state").textContent = text;
      }
      get srcObject() {
        return this.media?.srcObject ?? this._srcObject ?? null;
      }
      set srcObject(value) {
        this._srcObject = value;
        if (this.media) this.load();
      }
      static properties = ["srcObject"];
      connectedCallback() {
        const moved = this._rendered;
        super.connectedCallback();
        // Moved within the page: the stream closed when it left, so open it again.
        if (moved && this.hasAttribute("stream") && !this._stream) this.load();
      }
      disconnectedCallback() {
        this._stream?.close?.();
        this._stream = undefined;
      }
      /** `live` set for a stream, not by the page; dropped when the source changes. */
      goLive() {
        if (!this.flag("live")) this._autoLive = true;
        this.toggleAttribute("live", true);
      }
      load() {
        const media = this.media;
        this._stream?.close?.();
        this._stream = undefined;
        if (this._autoLive) {
          this._autoLive = false;
          this.removeAttribute("live");
        }
        media.muted = this.flag("muted");
        media.loop = this.flag("loop");
        media.autoplay = this.flag("autoplay");
        if ("poster" in media && this.hasAttribute("poster"))
          media.poster = this.getAttribute("poster");
        this.state("");
        if (this._srcObject) {
          media.srcObject = this._srcObject;
          this.goLive();
          media.play().catch(() => undefined);
          return;
        }
        media.srcObject = null;
        const stream = this.getAttribute("stream");
        if (stream !== null) return this.playStream(stream);
        const src = this.getAttribute("src");
        if (src) media.src = src;
        else media.removeAttribute("src");
      }
      playStream(id) {
        const media = this.media;
        const type =
          this.getAttribute("type") ?? 'video/mp4; codecs="avc1.42E01F"';
        const open = window.dx?.stream;
        if (typeof open !== "function")
          return this.state("Live streams need a trusted plugin.");
        if (!window.MediaSource?.isTypeSupported(type))
          return this.state("This browser cannot play this stream.");
        this.goLive();
        this.state("Connecting…");
        const source = new MediaSource();
        media.src = URL.createObjectURL(source);
        const queue = [];
        let buffer;
        // Appends that failed in a row; a success resets it.
        let failures = 0;
        let failed = false;
        const fail = () => {
          failed = true;
          queue.length = 0;
          this._stream?.close?.();
          this.state("This browser cannot play this stream.");
        };
        const pump = () => {
          if (failed || !buffer || buffer.updating || queue.length === 0)
            return;
          const chunk = queue.shift();
          try {
            buffer.appendBuffer(chunk);
          } catch (error) {
            failures += 1;
            if (failures >= STREAM_MAX_FAILURES) return fail();
            queue.unshift(chunk);
            // The buffer is full: drop what has already played and try again
            // when the removal ends. Any other error, or nothing played to
            // drop yet, waits for the next chunk to retry.
            if (error?.name === "QuotaExceededError" && media.currentTime > 4)
              buffer.remove(0, media.currentTime - 2);
          }
        };
        source.addEventListener(
          "sourceopen",
          () => {
            URL.revokeObjectURL(media.src);
            buffer = source.addSourceBuffer(type);
            buffer.mode = "sequence";
            buffer.addEventListener("error", () => {
              failures += 1;
              if (failures >= STREAM_MAX_FAILURES) fail();
            });
            buffer.addEventListener("update", () => {
              failures = 0;
            });
            buffer.addEventListener("updateend", () => {
              // Stay at the live edge so latency stays low.
              const end = buffer.buffered.length
                ? buffer.buffered.end(buffer.buffered.length - 1)
                : 0;
              if (end - media.currentTime > 1) media.currentTime = end - 0.1;
              if (
                !buffer.updating &&
                media.currentTime > 30 &&
                buffer.buffered.length > 0 &&
                buffer.buffered.start(0) < media.currentTime - 20
              )
                buffer.remove(0, media.currentTime - 10);
              pump();
            });
            pump();
          },
          { once: true },
        );
        this._stream = open(id || undefined);
        const channel = this._stream;
        channel.addEventListener("open", () => this.state(""));
        channel.addEventListener("message", (event) => {
          if (failed || typeof event.data === "string") return;
          queue.push(event.data);
          // Live: past the cap, the oldest waiting chunks go, so a stalled
          // buffer never holds more than a few seconds of memory.
          if (queue.length > STREAM_MAX_QUEUE)
            queue.splice(0, queue.length - STREAM_MAX_QUEUE);
          pump();
          if (media.paused && this.flag("autoplay"))
            media.play().catch(() => undefined);
        });
        channel.addEventListener("close", () => {
          if (!failed) this.state("The stream ended.");
        });
      }
    },
  );

  window.dx = Object.assign(window.dx ?? {}, {
    ui: { version: VERSION, openLink, icons: Object.keys(ICONS) },
  });
})();
