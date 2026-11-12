// The dx Feedback Widget on a website. Core serves this file inside an IIFE
// that calls dxFeedbackWidget with the widget's config. It runs in the
// website's page, so it holds no dx credential: sending happens in the panel
// the dx origin serves in an iframe, shown in the same card.
//
// On a website it stays hidden until the page is opened with `?dx`; the
// browser then remembers it for the site. In a Thread's Portal (config.sendPath
// set) it shows at once and sends to that Thread through the Portal itself. Cmd+. or Ctrl+. hides or shows it; so does the button's
// context menu (right-click or long-press), and a triple tap where the
// button was shows it on touch screens.

// biome-ignore lint/correctness/noUnusedVariables: the served wrapper calls it.
function dxFeedbackWidget(config) {
  if (window.__dxFeedbackWidget !== undefined) return;
  window.__dxFeedbackWidget = config.clientId;

  const prefix = `dx-feedback-widget:${config.clientId}`;
  const VISIBLE_KEY = `${prefix}:visible`;
  const COMMENTS_KEY = `${prefix}:comments`;
  const MAX_COMMENTS = 20;
  const portal = typeof config.sendPath === "string";
  const allowedHere = portal || config.allowedOrigins.includes(location.origin);
  const scriptPath =
    config.scriptPath ?? `/api/feedback-widget/${config.clientId}.js`;

  const storage = {
    get(key) {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    set(key, value) {
      try {
        localStorage.setItem(key, value);
      } catch {}
    },
    remove(key) {
      try {
        localStorage.removeItem(key);
      } catch {}
    },
  };

  if (new URLSearchParams(location.search).has("dx"))
    storage.set(VISIBLE_KEY, "1");

  const loadComments = () => {
    try {
      const parsed = JSON.parse(storage.get(COMMENTS_KEY) ?? "[]");
      return Array.isArray(parsed) ? parsed.slice(0, MAX_COMMENTS) : [];
    } catch {
      return [];
    }
  };

  let comments = loadComments();
  /** idle | list | compose | panel | menu */
  let mode = "idle";
  /** The comment being written: its element, text, and the one it edits. */
  let draft;
  let notice = "";
  let noticeKind = "error";
  let sending = false;
  let panelFrame;
  let panelHeight = 220;

  const saveComments = () => {
    if (comments.length === 0) storage.remove(COMMENTS_KEY);
    else storage.set(COMMENTS_KEY, JSON.stringify(comments));
  };

  // A Portal shows the widget until someone hides it.
  const visible = () =>
    portal
      ? storage.get(VISIBLE_KEY) !== "0"
      : storage.get(VISIBLE_KEY) === "1";

  // The page address a comment records, without the `?dx` switch.
  const pageUrl = () => {
    const url = new URL(location.href);
    url.searchParams.delete("dx");
    url.hash = "";
    return url.href;
  };

  const ICONS = {
    chat: '<path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/>',
    pick: '<path d="M4 4l7 17 2.5-7.5L21 11z"/>',
    pencil: '<path d="M17 3a2.8 2.8 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5z"/>',
    trash:
      '<path d="M3 6h18"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6"/><path d="M8 6V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/>',
    plus: '<path d="M12 5v14M5 12h14"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    close: '<path d="M18 6 6 18M6 6l12 12"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

  // `data-bottom` on the script tag lifts the button, in pixels, off a
  // site's own corner control.
  const tag = [...document.querySelectorAll("script[src]")].find((script) =>
    script.src.includes(scriptPath),
  );
  const bottom = Math.min(
    Math.max(Number.parseInt(tag?.dataset.bottom ?? "20", 10) || 20, 0),
    400,
  );
  const host = document.createElement("dx-feedback-widget");
  host.setAttribute(
    "style",
    `all: initial; position: fixed; top: 0; left: 0; width: 0; height: 0; z-index: 2147483647; --dx-fw-bottom: ${bottom}px;`,
  );
  const root = host.attachShadow({ mode: "open" });
  root.innerHTML = `<style>
:host { all: initial; }
* { box-sizing: border-box; font-family: ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif; }
.launcher { position: fixed; right: 20px; bottom: var(--dx-fw-bottom); width: 44px; height: 44px; border-radius: 999px;
  border: 1px solid rgba(246,255,245,.14); background: #11191a; color: #f6fff5; cursor: pointer;
  display: flex; align-items: center; justify-content: center; box-shadow: 0 8px 28px rgba(0,0,0,.35); }
.launcher svg { width: 18px; height: 18px; }
.launcher[data-picking] { color: #f34e3f; box-shadow: 0 0 0 2px #f34e3f, 0 8px 28px rgba(0,0,0,.35); }
.launcher .count { position: absolute; top: -4px; right: -4px; min-width: 18px; height: 18px; padding: 0 5px; border-radius: 999px;
  background: #f34e3f; color: #fff; font-size: 11px; font-weight: 600; line-height: 18px; text-align: center; }
.card { position: fixed; right: 20px; bottom: calc(var(--dx-fw-bottom) + 56px); width: 380px; max-width: calc(100vw - 24px); color: #f6fff5;
  background: #0c1516; border: 1px solid rgba(135,139,134,.22); border-radius: 12px; overflow: hidden;
  box-shadow: 0 16px 48px rgba(0,0,0,.45); font-size: 13px; line-height: 1.45; }
.hint { display: flex; align-items: center; gap: 6px; padding: 12px 14px 0; color: #939b94; font-size: 12px; }
.hint svg { width: 12px; height: 12px; }
.chip { display: inline-flex; align-items: center; gap: 4px; max-width: 100%; padding: 1px 6px; border-radius: 6px;
  background: rgba(243,78,63,.14); color: #ff8a7d; font: 12px/18px ui-monospace, SFMono-Regular, Menlo, monospace; vertical-align: baseline; }
.chip svg { width: 10px; height: 10px; flex: none; }
.chip button { all: unset; cursor: pointer; display: inline-flex; color: inherit; opacity: .8; }
.compose { display: flex; flex-direction: column; }
.compose .reference { padding: 10px 14px 0; display: flex; align-items: center; gap: 6px; flex-wrap: wrap; }
.compose textarea { margin: 8px 14px 0; min-height: 64px; max-height: 200px; resize: vertical; border: 0; outline: 0; background: transparent;
  color: #f6fff5; font-size: 14px; line-height: 1.45; padding: 0; }
.compose textarea::placeholder { color: #6b736c; }
footer { display: flex; align-items: center; gap: 8px; padding: 10px 12px; margin-top: 10px; background: rgba(0,0,0,.25);
  border-top: 1px solid rgba(135,139,134,.14); }
footer .mark { color: #6b736c; font-weight: 700; font-size: 13px; letter-spacing: -.02em; }
.grow { flex: 1; }
button.action { display: inline-flex; align-items: center; gap: 6px; height: 30px; padding: 0 12px; border-radius: 999px; border: 0;
  background: rgba(246,255,245,.08); color: #f6fff5; font-size: 13px; font-weight: 500; cursor: pointer; }
button.action:hover { background: rgba(246,255,245,.14); }
button.primary { background: #dce6dc; color: #0b0d0b; }
button.primary:hover { background: #f6fff5; }
button.action:disabled { opacity: .45; cursor: default; }
ol { list-style: none; margin: 0; padding: 4px 0; max-height: min(360px, calc(100vh - 220px)); overflow: auto; }
li { display: flex; align-items: flex-start; gap: 8px; padding: 10px 14px; }
li + li { border-top: 1px solid rgba(135,139,134,.14); }
li .body { flex: 1; min-width: 0; overflow-wrap: anywhere; }
li .page { display: block; margin-top: 2px; color: #6b736c; font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; }
li .tools { display: flex; gap: 2px; flex: none; }
button.icon { all: unset; cursor: pointer; display: inline-flex; padding: 5px; border-radius: 6px; color: #939b94; }
button.icon:hover { color: #f6fff5; background: rgba(246,255,245,.08); }
button.icon:focus-visible, button.action:focus-visible, .launcher:focus-visible { outline: 2px solid #6ca0e0; outline-offset: 2px; }
.empty { padding: 14px; color: #939b94; }
.notice { margin: 0 14px 4px; padding: 8px 10px; border-radius: 8px; background: rgba(214,118,112,.14); color: #f0a49f; font-size: 12px; }
.notice.ok { background: rgba(84,184,121,.14); color: #8fd6a8; }
.highlight { position: fixed; pointer-events: none; border: 2px solid #f34e3f; background: rgba(243,78,63,.10); border-radius: 4px; display: none; }
.highlight span { position: absolute; left: -2px; bottom: 100%; margin-bottom: 4px; padding: 1px 6px; border-radius: 4px; background: #f34e3f; color: #fff;
  font: 11px/16px ui-monospace, SFMono-Regular, Menlo, monospace; white-space: nowrap; }
.marker { position: fixed; width: 20px; height: 20px; border-radius: 999px; background: #f34e3f; color: #fff; font-size: 11px; font-weight: 600;
  display: flex; align-items: center; justify-content: center; pointer-events: none; box-shadow: 0 2px 6px rgba(0,0,0,.35); }
.menu { width: auto; padding: 4px; }
.menu button { all: unset; display: block; padding: 8px 12px; border-radius: 8px; cursor: pointer; font-size: 13px; }
.menu button:hover { background: rgba(246,255,245,.08); }
.panel iframe { border: 0; width: 100%; display: block; background: #0c1516; }
@media (max-width: 480px) { .card { left: 12px; right: 12px; width: auto; } }
</style>
<div class="highlight"><span></span></div>
<div class="markers"></div>
<div class="layer"></div>
<button class="launcher" type="button" aria-label="dx Feedback Widget"></button>`;

  const launcher = root.querySelector(".launcher");
  const highlight = root.querySelector(".highlight");
  const highlightLabel = highlight.querySelector("span");
  const layer = root.querySelector(".layer");
  const markers = root.querySelector(".markers");

  const element = (tag, attributes = {}, children = []) => {
    const node = document.createElement(tag);
    for (const [name, value] of Object.entries(attributes)) {
      if (value === undefined) continue;
      if (name === "text") node.textContent = value;
      else if (name === "html") node.innerHTML = value;
      else if (name.startsWith("on"))
        node.addEventListener(name.slice(2), value);
      else node.setAttribute(name, value);
    }
    for (const child of children) node.append(child);
    return node;
  };

  const ownEvent = (event) => event.composedPath().includes(host);

  // A selector that finds the element again: its unique id, or a short path.
  const selectorOf = (target) => {
    const unique = (selector) => {
      try {
        return document.querySelectorAll(selector).length === 1;
      } catch {
        return false;
      }
    };
    if (target.id && unique(`#${CSS.escape(target.id)}`))
      return `#${CSS.escape(target.id)}`;
    const parts = [];
    let node = target;
    while (node && node.nodeType === 1 && node !== document.documentElement) {
      if (node !== target && node.id && unique(`#${CSS.escape(node.id)}`)) {
        parts.unshift(`#${CSS.escape(node.id)}`);
        break;
      }
      let part = node.localName;
      const classes = [...node.classList]
        .filter((name) => /^[A-Za-z_-][\w-]{0,39}$/.test(name))
        .slice(0, 2);
      if (classes.length > 0)
        part += `.${classes.map((name) => CSS.escape(name)).join(".")}`;
      const parent = node.parentElement;
      if (parent) {
        const same = [...parent.children].filter(
          (child) => child.localName === node.localName,
        );
        if (same.length > 1) part += `:nth-of-type(${same.indexOf(node) + 1})`;
      }
      parts.unshift(part);
      node = parent;
    }
    return parts.join(" > ").slice(0, 600);
  };

  const describe = (target) => {
    const names = [
      "id",
      "class",
      "name",
      "type",
      "href",
      "src",
      "role",
      "aria-label",
      "placeholder",
      "alt",
    ];
    const attributes = names
      .filter((name) => target.hasAttribute(name))
      .map(
        (name) =>
          ` ${name}="${(target.getAttribute(name) ?? "").slice(0, 120).replaceAll('"', "&quot;")}"`,
      )
      .join("");
    return `<${target.localName}${attributes}>`.slice(0, 600);
  };

  // The page itself has no text of its own worth quoting.
  const textOf = (target) =>
    target === document.documentElement || target === document.body
      ? ""
      : (target.innerText || target.value || target.getAttribute("alt") || "")
          .replace(/\s+/g, " ")
          .trim()
          .slice(0, 400);

  const reference = (target) => ({
    selector: selectorOf(target),
    element: describe(target),
    tag: target.localName,
    text: textOf(target),
  });

  const chip = (tag, onClear) =>
    element("span", { class: "chip" }, [
      element("span", { html: icon("pick") }).firstChild,
      document.createTextNode(`<${tag}>`),
      ...(onClear
        ? [
            element("button", {
              type: "button",
              "aria-label": "Clear element",
              html: icon("close"),
              onclick: onClear,
            }),
          ]
        : []),
    ]);

  const pathOf = (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };

  const samePage = (url) => {
    try {
      const a = new URL(url);
      const b = new URL(pageUrl());
      return a.pathname === b.pathname && a.search === b.search;
    } catch {
      return false;
    }
  };

  const drawMarkers = () => {
    markers.replaceChildren();
    if (!visible() || mode === "panel") return;
    comments.forEach((comment, index) => {
      if (!samePage(comment.pageUrl) || !comment.selector) return;
      let target;
      try {
        target = document.querySelector(comment.selector);
      } catch {
        target = null;
      }
      if (!target) return;
      const rect = target.getBoundingClientRect();
      if (rect.bottom < 0 || rect.top > innerHeight) return;
      const marker = element("div", { class: "marker", text: `${index + 1}` });
      marker.style.left = `${Math.max(4, rect.left - 10)}px`;
      marker.style.top = `${Math.max(4, rect.top - 10)}px`;
      markers.append(marker);
    });
  };

  let frame = 0;
  const scheduleMarkers = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      drawMarkers();
    });
  };

  const picking = () => mode === "compose";

  const render = () => {
    const shown = visible();
    launcher.style.display = shown ? "flex" : "none";
    launcher.toggleAttribute("data-picking", picking());
    launcher.innerHTML = icon(picking() ? "pick" : "chat");
    if (comments.length > 0)
      launcher.append(
        element("span", { class: "count", text: `${comments.length}` }),
      );
    if (!shown) {
      layer.replaceChildren();
      stopPicking();
      markers.replaceChildren();
      return;
    }
    // Moving an iframe reloads it: leave an open panel where it is.
    if (mode === "panel" && panelFrame && layer.contains(panelFrame)) {
      markers.replaceChildren();
      return;
    }
    layer.replaceChildren();
    if (mode === "compose") layer.append(composer());
    else if (mode === "list") layer.append(list());
    else if (mode === "menu")
      layer.append(
        element("div", { class: "card menu", role: "menu" }, [
          element("button", {
            type: "button",
            role: "menuitem",
            text: "Hide Review Button",
            onclick: () => setVisible(false),
          }),
        ]),
      );
    else if (mode === "panel" && panelFrame)
      layer.append(element("div", { class: "card panel" }, [panelFrame]));
    if (picking()) startPicking();
    else stopPicking();
    drawMarkers();
  };

  const composer = () => {
    const textarea = element("textarea", {
      placeholder: draft.target
        ? "What should change here?"
        : "What should change? Click an element to point at it.",
      "aria-label": "Comment",
    });
    textarea.value = draft.text;
    textarea.addEventListener("input", () => {
      draft.text = textarea.value;
      add.disabled = textarea.value.trim() === "";
    });
    const save = () => {
      const text = textarea.value.trim();
      if (text === "") return;
      const comment = {
        pageUrl: draft.pageUrl ?? pageUrl(),
        selector: draft.target?.selector ?? "",
        element: draft.target?.element ?? "",
        tag: draft.target?.tag ?? "",
        text: draft.target?.text ?? "",
        comment: text.slice(0, 4000),
      };
      comments =
        draft.editing === undefined
          ? [...comments, comment]
          : comments.map((other, index) =>
              index === draft.editing ? comment : other,
            );
      saveComments();
      draft = undefined;
      mode = "list";
      render();
    };
    const cancel = () => {
      draft = undefined;
      mode = comments.length > 0 ? "list" : "idle";
      render();
    };
    textarea.addEventListener("keydown", (event) => {
      if (event.key === "Enter" && !event.shiftKey && !event.isComposing) {
        event.preventDefault();
        save();
      } else if (event.key === "Escape") {
        event.preventDefault();
        cancel();
      }
    });
    const add = element("button", {
      class: "action primary",
      type: "button",
      html: `${icon("plus")}${draft.editing === undefined ? "Add" : "Save"}`,
      "aria-label": draft.editing === undefined ? "Add" : "Save",
      onclick: save,
    });
    add.disabled = textarea.value.trim() === "";
    queueMicrotask(() => {
      textarea.focus();
      textarea.setSelectionRange(textarea.value.length, textarea.value.length);
    });
    return element(
      "div",
      { class: "card compose", role: "dialog", "aria-label": "New comment" },
      [
        draft.target
          ? element("div", { class: "reference" }, [
              chip(draft.target.tag, () => {
                draft.target = undefined;
                render();
              }),
              element("span", {
                class: "page",
                style: "color:#6b736c;font-size:12px",
                text: "Click another element to change it",
              }),
            ])
          : element("div", {
              class: "hint",
              html: `${icon("pick")}<span>Click an element on the page to point at it</span>`,
            }),
        textarea,
        element("footer", {}, [
          element("span", { class: "mark", text: "dx" }),
          element("span", { class: "grow" }),
          element("button", {
            class: "action",
            type: "button",
            text: "Cancel",
            onclick: cancel,
          }),
          add,
        ]),
      ],
    );
  };

  const list = () =>
    element(
      "div",
      { class: "card", role: "dialog", "aria-label": "Feedback for dx" },
      [
        comments.length === 0
          ? element("p", {
              class: "empty",
              text: "Choose New Comment, click any element, and write what to change.",
            })
          : element(
              "ol",
              { "aria-label": "Comments" },
              comments.map((comment, index) =>
                element("li", {}, [
                  element("div", { class: "body" }, [
                    ...(comment.tag
                      ? [chip(comment.tag), document.createTextNode(" ")]
                      : []),
                    document.createTextNode(comment.comment),
                    ...(samePage(comment.pageUrl)
                      ? []
                      : [
                          element("span", {
                            class: "page",
                            text: pathOf(comment.pageUrl),
                          }),
                        ]),
                  ]),
                  element("div", { class: "tools" }, [
                    element("button", {
                      class: "icon",
                      type: "button",
                      "aria-label": `Edit comment ${index + 1}`,
                      html: icon("pencil"),
                      onclick: () => {
                        draft = {
                          editing: index,
                          pageUrl: comment.pageUrl,
                          text: comment.comment,
                          target: comment.tag
                            ? {
                                selector: comment.selector,
                                element: comment.element,
                                tag: comment.tag,
                                text: comment.text,
                              }
                            : undefined,
                        };
                        mode = "compose";
                        render();
                      },
                    }),
                    element("button", {
                      class: "icon",
                      type: "button",
                      "aria-label": `Delete comment ${index + 1}`,
                      html: icon("trash"),
                      onclick: () => {
                        comments = comments.filter(
                          (_, other) => other !== index,
                        );
                        saveComments();
                        if (comments.length === 0) mode = "idle";
                        render();
                      },
                    }),
                  ]),
                ]),
              ),
            ),
        ...(notice
          ? [
              element("div", {
                class: noticeKind === "ok" ? "notice ok" : "notice",
                role: noticeKind === "ok" ? "status" : "alert",
                text: notice,
              }),
            ]
          : []),
        element("footer", {}, [
          element("span", { class: "mark", text: "dx" }),
          element("span", { class: "grow" }),
          element("button", {
            class: "action",
            type: "button",
            html: `${icon("plus")}New Comment`,
            "aria-label": "New Comment",
            disabled: comments.length >= MAX_COMMENTS ? "" : undefined,
            onclick: newComment,
          }),
          element("button", {
            class: "action primary",
            type: "button",
            title: "Send all comments",
            "aria-label": "Send",
            html: sending ? "Sending…" : `Send${icon("arrow")}`,
            disabled: comments.length === 0 || sending ? "" : undefined,
            onclick: portal ? sendToThread : openPanel,
          }),
        ]),
      ],
    );

  const newComment = () => {
    notice = "";
    noticeKind = "error";
    draft = { text: "" };
    mode = "compose";
    render();
  };

  const onHover = (event) => {
    if (ownEvent(event)) {
      highlight.style.display = "none";
      return;
    }
    const target = event.target;
    if (!(target instanceof Element)) return;
    const rect = target.getBoundingClientRect();
    highlightLabel.textContent = target.localName;
    Object.assign(highlight.style, {
      display: "block",
      left: `${rect.left - 2}px`,
      top: `${rect.top - 2}px`,
      width: `${rect.width + 4}px`,
      height: `${rect.height + 4}px`,
    });
  };

  const swallow = (event) => {
    if (ownEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
  };

  const onPick = (event) => {
    if (ownEvent(event)) return;
    event.preventDefault();
    event.stopPropagation();
    const target = event.target;
    if (!(target instanceof Element) || !draft) return;
    draft.target = reference(target);
    draft.pageUrl = pageUrl();
    highlight.style.display = "none";
    render();
  };

  const pickEvents = ["pointerdown", "mousedown", "pointerup", "mouseup"];
  let listening = false;

  const startPicking = () => {
    if (listening) return;
    listening = true;
    document.addEventListener("mousemove", onHover, true);
    document.addEventListener("click", onPick, true);
    for (const name of pickEvents)
      document.addEventListener(name, swallow, true);
  };

  const stopPicking = () => {
    highlight.style.display = "none";
    if (!listening) return;
    listening = false;
    document.removeEventListener("mousemove", onHover, true);
    document.removeEventListener("click", onPick, true);
    for (const name of pickEvents)
      document.removeEventListener(name, swallow, true);
  };

  const closePanel = () => {
    panelFrame = undefined;
    mode = comments.length > 0 ? "list" : "idle";
    render();
  };

  const postComments = () => {
    panelFrame?.contentWindow?.postMessage(
      { type: "dx-fw:comments", comments },
      config.appOrigin,
    );
  };

  // In a Portal the page's own origin carries the Portal session, so the
  // comments go straight to the Thread.
  const sendToThread = async () => {
    if (sending || comments.length === 0) return;
    sending = true;
    notice = "";
    render();
    let failure;
    try {
      const response = await fetch(config.sendPath, {
        method: "POST",
        credentials: "same-origin",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ comments }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => undefined);
        failure =
          payload?.data?.message ??
          (response.status === 401
            ? "Your Portal sign-in ended. Reload the page."
            : "dx could not send the comments. Try again.");
      }
    } catch {
      failure = "dx could not be reached. Try again.";
    }
    sending = false;
    if (failure === undefined) {
      comments = [];
      saveComments();
      notice = "Sent to this Thread.";
      noticeKind = "ok";
    } else {
      notice = failure;
      noticeKind = "error";
    }
    mode = "list";
    render();
  };

  const openPanel = () => {
    if (!allowedHere) {
      notice = `${location.origin} isn't an allowed origin for this dx Project. Add it in Project Settings → Feedback Widget.`;
      render();
      return;
    }
    const iframe = element("iframe", {
      title: "Send to dx",
      src: `${config.appOrigin}/api/feedback-widget/${config.clientId}/panel`,
    });
    iframe.style.height = `${panelHeight}px`;
    iframe.addEventListener("load", postComments);
    panelFrame = iframe;
    mode = "panel";
    render();
  };

  window.addEventListener("message", (event) => {
    if (
      !panelFrame ||
      event.source !== panelFrame.contentWindow ||
      event.origin !== config.appOrigin
    )
      return;
    const type = event.data?.type;
    if (type === "dx-fw:ready") postComments();
    else if (type === "dx-fw:close") closePanel();
    else if (type === "dx-fw:resize") {
      const height = Number(event.data.height);
      if (Number.isFinite(height)) {
        panelHeight = Math.min(
          Math.max(height, 120),
          innerHeight - bottom - 90,
        );
        panelFrame.style.height = `${panelHeight}px`;
      }
    } else if (type === "dx-fw:sent") {
      comments = [];
      saveComments();
      render();
    }
  });

  const setVisible = (shown) => {
    if (shown) storage.set(VISIBLE_KEY, "1");
    else if (portal) storage.set(VISIBLE_KEY, "0");
    else storage.remove(VISIBLE_KEY);
    if (!shown) {
      panelFrame = undefined;
      draft = undefined;
    }
    mode = "idle";
    render();
  };

  launcher.addEventListener("click", () => {
    if (mode === "panel") {
      closePanel();
      return;
    }
    if (mode === "compose") {
      draft = undefined;
      mode = comments.length > 0 ? "list" : "idle";
    } else if (mode === "idle" || mode === "menu") {
      if (comments.length === 0) {
        newComment();
        return;
      }
      mode = "list";
    } else {
      mode = "idle";
    }
    render();
  });

  launcher.addEventListener("contextmenu", (event) => {
    event.preventDefault();
    mode = mode === "menu" ? "idle" : "menu";
    render();
  });

  document.addEventListener(
    "keydown",
    (event) => {
      if ((event.metaKey || event.ctrlKey) && event.key === ".") {
        event.preventDefault();
        setVisible(!visible());
      } else if (
        event.key === "Escape" &&
        mode === "compose" &&
        !ownEvent(event)
      ) {
        draft = undefined;
        mode = comments.length > 0 ? "list" : "idle";
        render();
      }
    },
    true,
  );

  // Three quick taps where the button sits bring it back on touch screens.
  let taps = [];
  document.addEventListener(
    "touchend",
    (event) => {
      if (visible()) return;
      const touch = event.changedTouches[0];
      if (
        !touch ||
        touch.clientX < innerWidth - 90 ||
        touch.clientY < innerHeight - 90
      )
        return;
      const now = Date.now();
      taps = [...taps.filter((time) => now - time < 700), now];
      if (taps.length >= 3) {
        taps = [];
        setVisible(true);
      }
    },
    { passive: true },
  );

  addEventListener("scroll", scheduleMarkers, true);
  addEventListener("resize", scheduleMarkers);
  // Another tab on the same site may add or send comments.
  addEventListener("storage", (event) => {
    if (event.key === COMMENTS_KEY || event.key === VISIBLE_KEY) {
      comments = loadComments();
      if (mode !== "compose" && mode !== "panel") render();
    }
  });

  const mount = () => {
    document.documentElement.append(host);
    render();
  };
  if (document.readyState === "loading")
    document.addEventListener("DOMContentLoaded", mount, { once: true });
  else mount();
}
