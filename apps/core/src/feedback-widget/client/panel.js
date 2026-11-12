// The Feedback Widget's panel, served from the dx origin and framed by an
// allowed website inside the widget's card. Core wraps this file in an IIFE
// that calls dxFeedbackPanel with the widget's config. The grant it keeps in
// its own storage, which browsers partition by the framing site, never
// reaches the website.

// biome-ignore lint/correctness/noUnusedVariables: the served wrapper calls it.
function dxFeedbackPanel(config) {
  const TOKEN_KEY = `dx-feedback-widget:${config.clientId}:token`;
  const api = `/api/feedback-widget/${config.clientId}`;
  const allowed = new Set(config.allowedOrigins);
  const main = document.getElementById("panel");
  const LIMITS = {
    pageUrl: 2000,
    selector: 600,
    element: 600,
    text: 400,
    comment: 4000,
    tag: 40,
  };

  let memoryToken;
  const token = {
    get() {
      try {
        return localStorage.getItem(TOKEN_KEY) ?? memoryToken;
      } catch {
        return memoryToken;
      }
    },
    set(value) {
      memoryToken = value;
      try {
        if (value === undefined) localStorage.removeItem(TOKEN_KEY);
        else localStorage.setItem(TOKEN_KEY, value);
      } catch {}
    },
  };

  let comments = [];
  let parentOrigin;
  /** loading | signed-out | waiting | ready | sending | sent | blocked | error */
  let view = "loading";
  let me;
  let message = "";
  let sent;
  let waitTimer;

  const ICONS = {
    external: '<path d="M7 17 17 7M8 7h9v9"/>',
    pick: '<path d="M4 4l7 17 2.5-7.5L21 11z"/>',
    check: '<path d="M20 6 9 17l-5-5"/>',
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">${ICONS[name]}</svg>`;

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

  const toParent = (data) => {
    if (parentOrigin) window.parent.postMessage(data, parentOrigin);
  };

  const button = (text, onclick, kind = "", extra = {}) =>
    element("button", {
      type: "button",
      class: kind || undefined,
      text,
      onclick,
      ...extra,
    });

  const back = (label = "Back") =>
    button(label, () => toParent({ type: "dx-fw:close" }), "quiet");

  const pathOf = (url) => {
    try {
      const parsed = new URL(url);
      return `${parsed.pathname}${parsed.search}`;
    } catch {
      return url;
    }
  };

  const plural = (count) => (count === 1 ? "comment" : "comments");

  const bubbles = () =>
    element(
      "ol",
      { class: "bubbles", "aria-label": "Comments" },
      comments.map((comment) =>
        element("li", {}, [
          element("div", { class: "bubble" }, [
            ...(comment.tag
              ? [
                  element("span", {
                    class: "chip",
                    html: `${icon("pick")}&lt;${comment.tag.replace(/[^a-z0-9-]/gi, "")}&gt;`,
                  }),
                  document.createTextNode(" "),
                ]
              : []),
            document.createTextNode(comment.comment),
          ]),
          element("div", {
            class: "where",
            text: [comment.selector, pathOf(comment.pageUrl)]
              .filter((part) => part !== "")
              .join(" · "),
          }),
        ]),
      ),
    );

  const footer = (...children) =>
    element("footer", {}, [element("span", { class: "grow" }), ...children]);

  const render = () => {
    const body = [];
    let bottom = footer(back());
    if (view === "loading") {
      body.push(
        element("p", { class: "loading", html: "<span></span>Loading…" }),
      );
    } else if (view === "blocked") {
      body.push(
        element("h1", { text: "Can't open here" }),
        element("p", { text: message }),
      );
      bottom = undefined;
    } else if (view === "signed-out") {
      body.push(
        element("h1", { text: "Continue with dx" }),
        element("p", {
          text: "Connect your dx account once to send from here. Nothing is sent until you confirm.",
        }),
        ...(message ? [element("p", { class: "error", text: message })] : []),
        element("div", { class: "actions" }, [
          element("button", {
            type: "button",
            class: "light",
            html: `Continue with dx${icon("external")}`,
            onclick: continueWithDx,
          }),
        ]),
      );
    } else if (view === "waiting") {
      body.push(
        element("h1", { text: "Finish in the dx window" }),
        element("p", {
          text: "Sign in to dx and choose Allow in the window that opened. This panel continues by itself.",
        }),
      );
      bottom = footer(
        button(
          "Cancel",
          () => {
            clearTimeout(waitTimer);
            view = "signed-out";
            render();
          },
          "quiet",
        ),
      );
    } else if (view === "ready" || view === "sending") {
      const blocked =
        me.readiness === "access-required"
          ? `Access Required: you can't start Threads in ${config.projectLabel}.`
          : "";
      body.push(
        element("div", { class: "eyebrow", text: me.projectLabel }),
        element("h1", {
          text: `Send ${comments.length} ${plural(comments.length)} to dx`,
        }),
        comments.length === 0
          ? element("p", { text: "No comments to send." })
          : bubbles(),
        ...(blocked ? [element("p", { class: "error", text: blocked })] : []),
        ...(message ? [element("p", { class: "error", text: message })] : []),
        button(view === "sending" ? "Sending…" : "Start in Orb", send, "wide", {
          disabled:
            view === "sending" || comments.length === 0 || blocked !== ""
              ? ""
              : undefined,
        }),
      );
      bottom = element("footer", {}, [
        element("span", {
          class: "identity",
          text: `Signed in as ${me.email || me.name}`,
        }),
        button("Sign out", signOut, "link"),
        element("span", { class: "grow" }),
        back(),
      ]);
    } else if (view === "sent") {
      body.push(
        element("div", { class: "done", html: icon("check") }),
        element("h1", { text: "Sent to dx" }),
        element("p", {
          text: `dx is starting an Orb on ${sent.count} ${plural(sent.count)} for ${me.projectLabel}.`,
        }),
        element("a", {
          class: "wide",
          href: sent.threadUrl,
          target: "_blank",
          rel: "noopener",
          html: `Open Thread${icon("external")}`,
        }),
      );
      bottom = footer(back("Done"));
    } else {
      body.push(
        element("h1", { text: "Something went wrong" }),
        element("p", { class: "error", text: message }),
      );
    }
    main.replaceChildren(
      element("section", {}, body),
      ...(bottom ? [bottom] : []),
    );
    queueMicrotask(reportHeight);
  };

  const reportHeight = () =>
    toParent({
      type: "dx-fw:resize",
      height: Math.ceil(main.getBoundingClientRect().height),
    });

  const call = async (method, path, body) => {
    const headers = { accept: "application/json" };
    const current = token.get();
    if (current) headers.authorization = `Bearer ${current}`;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetch(`${api}${path}`, {
      method,
      headers,
      credentials: "omit",
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const payload = await response.json().catch(() => undefined);
    return { response, payload };
  };

  const loadMe = async () => {
    if (!token.get()) {
      view = "signed-out";
      render();
      return;
    }
    const { response, payload } = await call("GET", "/me").catch(() => ({
      response: { status: 0 },
    }));
    if (response.status === 200) {
      me = payload.data;
      view = "ready";
    } else if (response.status === 401) {
      token.set(undefined);
      view = "signed-out";
    } else {
      view = "error";
      message =
        payload?.data?.message ?? "dx is unreachable. Check your connection.";
    }
    render();
  };

  const randomVerifier = () => {
    const bytes = crypto.getRandomValues(new Uint8Array(32));
    return btoa(String.fromCharCode(...bytes))
      .replaceAll("+", "-")
      .replaceAll("/", "_")
      .replace(/=+$/, "");
  };

  const hex = (buffer) =>
    [...new Uint8Array(buffer)]
      .map((byte) => byte.toString(16).padStart(2, "0"))
      .join("");

  let claimNow;

  const continueWithDx = async () => {
    message = "";
    // Open first, inside the click, so pop-up blockers allow it.
    // A window of its own each time, never an older sign-in window.
    const popup = window.open(
      "",
      `dx-sign-in-${Date.now().toString(36)}`,
      "popup,width=520,height=680",
    );
    if (!popup) {
      message =
        "Your browser blocked the dx window. Allow pop-ups for this site and try again.";
      render();
      return;
    }
    const verifier = randomVerifier();
    const challenge = hex(
      await crypto.subtle.digest("SHA-256", new TextEncoder().encode(verifier)),
    );
    popup.location.href = `${config.appOrigin}${api}/authorize?challenge=${challenge}`;
    view = "waiting";
    render();
    const deadline = Date.now() + 10 * 60 * 1000;
    const claim = async () => {
      clearTimeout(waitTimer);
      if (view !== "waiting") return;
      const { response, payload } = await call("POST", "/token", {
        verifier,
      }).catch(() => ({ response: { status: 0 } }));
      if (response.status === 200) {
        claimNow = undefined;
        token.set(payload.data.token);
        await loadMe();
        return;
      }
      if (response.status === 404) {
        view = "error";
        message = "This Feedback Widget was turned off.";
        render();
        return;
      }
      if (Date.now() > deadline) {
        view = "signed-out";
        message = "Sign-in timed out. Try again.";
        render();
        return;
      }
      waitTimer = setTimeout(claim, 1500);
    };
    claimNow = claim;
    waitTimer = setTimeout(claim, 1500);
  };

  const signOut = async () => {
    await call("POST", "/sign-out").catch(() => undefined);
    token.set(undefined);
    view = "signed-out";
    render();
  };

  const send = async () => {
    view = "sending";
    message = "";
    render();
    const count = comments.length;
    const { response, payload } = await call("POST", "/threads", {
      comments,
    }).catch(() => ({ response: { status: 0 } }));
    if (response.status === 201) {
      sent = { ...payload.data, count };
      view = "sent";
      toParent({ type: "dx-fw:sent", threadId: sent.threadId });
    } else if (response.status === 401) {
      token.set(undefined);
      view = "signed-out";
      message = "Your dx sign-in ended. Continue with dx again.";
    } else {
      view = "ready";
      message =
        payload?.data?.message ?? "dx is unreachable. Check your connection.";
    }
    render();
  };

  const clean = (raw) => {
    if (!Array.isArray(raw)) return [];
    return raw.slice(0, 20).flatMap((item) => {
      if (typeof item !== "object" || item === null) return [];
      const value = {};
      for (const [field, limit] of Object.entries(LIMITS)) {
        const text = typeof item[field] === "string" ? item[field] : "";
        value[field] = text.slice(0, limit);
      }
      try {
        if (!allowed.has(new URL(value.pageUrl).origin)) return [];
      } catch {
        return [];
      }
      return value.comment.trim() === "" ? [] : [value];
    });
  };

  // Every page around the panel must be on an allowed origin; the
  // frame-ancestors policy already enforces it where ancestorOrigins is
  // missing.
  const ancestors = location.ancestorOrigins
    ? [...location.ancestorOrigins]
    : [];
  if (
    window.parent === window ||
    ancestors.some((origin) => !allowed.has(origin))
  ) {
    view = "blocked";
    message = "Open the Feedback Widget from your website.";
    render();
    return;
  }

  window.addEventListener("message", (event) => {
    if (
      event.origin === config.appOrigin &&
      event.data?.type === "dx-fw:approved"
    ) {
      claimNow?.();
      return;
    }
    if (event.source !== window.parent || !allowed.has(event.origin)) return;
    if (event.data?.type === "dx-fw:comments") {
      parentOrigin = event.origin;
      comments = clean(event.data.comments);
      if (view === "sent") return;
      if (view === "loading") void loadMe();
      else render();
    }
  });

  render();
  window.parent.postMessage({ type: "dx-fw:ready" }, "*");
}
