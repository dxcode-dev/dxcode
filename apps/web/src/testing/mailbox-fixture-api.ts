import type {
  MailAddress,
  MailboxData,
  MailConversationSummary,
  MailFolder,
  MailLabel,
  MailMessage,
  ProjectMailData,
} from "@dx/api";
import { type ThreadId, UserId } from "@dx/domain";
import { Schema } from "effect";

/**
 * Fixture mail for the Mailbox's Storybook stories: one person's Mailbox,
 * served by an in-memory API that answers the Mailbox routes as Core will,
 * so every state renders through the real queries, mutations, and
 * optimistic updates.
 */

export const DOMAIN = "mail.dx.example";
export const ME: MailAddress = {
  name: "Alex Rivera",
  address: `alex@${DOMAIN}`,
};
export const fixtureUserId = Schema.decodeUnknownSync(UserId)("user-alex");

const hex = (seed: number) => seed.toString(16).padStart(32, "0");
const mailId = (seed: number) => `mail_${hex(seed)}`;
const labelId = (seed: number) => `mlb_${hex(seed)}`;
const threadId = (seed: number) =>
  `thr_00000000-0000-4000-8000-${seed.toString().padStart(12, "0")}` as ThreadId;
export const projectId = (seed: number) =>
  `prj_00000000-0000-4000-8000-${seed.toString().padStart(12, "0")}`;
const ago = (minutes: number) =>
  new Date(Date.now() - minutes * 60_000).toISOString();

const LABELS = {
  customers: { id: labelId(1), name: "Customers", kind: "user" },
  personal: { id: labelId(2), name: "Personal", kind: "user" },
  codes: { id: labelId(3), name: "Sign-in & codes", kind: "auto" },
  receipts: { id: labelId(4), name: "Receipts", kind: "auto" },
  newsletters: { id: labelId(5), name: "Newsletters", kind: "auto" },
} as const;
type LabelKey = keyof typeof LABELS;

const PROJECTS = [
  { tag: "web", projectId: projectId(1), projectName: "dx web" },
  { tag: "api", projectId: projectId(2), projectName: "dx api" },
] as const;

interface FixtureConversation {
  readonly key: string;
  folder: MailFolder;
  readonly subject: string;
  messages: MailMessage[];
}

let seed = 100;
const message = (
  options: Omit<Partial<MailMessage>, "labels"> & {
    readonly from: MailAddress;
    readonly minutesAgo: number;
    readonly text: string;
    readonly labels?: ReadonlyArray<LabelKey>;
  },
): MailMessage => {
  seed += 1;
  const { minutesAgo, labels = [], ...rest } = options;
  return {
    id: mailId(seed),
    direction: "in",
    folder: "inbox",
    to: [ME],
    cc: [],
    subject: "",
    receivedAt: ago(minutesAgo),
    attachments: [],
    authenticated: true,
    tag: undefined,
    private: false,
    read: true,
    readBy: [],
    ...rest,
    labels: labels.map((key) => ({
      id: LABELS[key].id,
      name: LABELS[key].name,
      automatic: LABELS[key].kind === "auto",
    })),
  };
};

const GITHUB: MailAddress = { name: "GitHub", address: "noreply@github.com" };
const PRIYA: MailAddress = {
  name: "Priya Shah",
  address: "priya@northwind.example",
};
export const BEN: MailAddress = {
  name: "Ben Ortiz",
  address: "ben@northwind.example",
};
const BILLING: MailAddress = {
  name: "Acme Billing",
  address: "receipts@acme-billing.example",
};
const DIGEST: MailAddress = {
  name: "Build Digest",
  address: "digest@ci.example",
};
const FAKE: MailAddress = {
  name: "Account Security",
  address: "security@paypa1-support.example",
};
const SAM: MailAddress = { name: "Sam Chen", address: "sam@chen.example" };
const CLOUD: MailAddress = {
  name: "Cloud Deploys",
  address: "deploys@cloud.example",
};
const PRIZE: MailAddress = {
  name: "Rewards Team",
  address: "win@prize-center.example",
};
const TAYLOR: MailAddress = {
  name: "Taylor Kim",
  address: "taylor@lawfirm.example",
};

const NEWSLETTER_HTML = `<html><head><style>
body{font-family:-apple-system,Segoe UI,sans-serif;color:#1d2433;margin:0;padding:24px;background:#f5f7fb}
.card{background:#fff;border-radius:10px;padding:20px 24px;box-shadow:0 1px 3px rgba(0,0,0,.08)}
h1{font-size:20px;margin:0 0 8px} .ok{color:#18794e} .bad{color:#c4320a}
a.btn{display:inline-block;margin-top:12px;background:#1d2433;color:#fff;padding:8px 14px;border-radius:6px;text-decoration:none}
</style></head><body><div class="card"><h1>Weekly build report</h1>
<p><b class="ok">142 builds passed</b>, <b class="bad">3 failed</b> across 6 repositories.</p>
<p>Slowest job: <code>e2e-chromium</code> at 11m 42s.</p>
<a class="btn" href="https://ci.example/report" target="_top">Open the report</a>
<img src="https://ci.example/pixel.gif" alt=""></div></body></html>`;

const conversations = (): FixtureConversation[] => {
  seed = 100;
  return [
    {
      key: "c-code",
      folder: "inbox",
      subject: "Your GitHub launch code",
      messages: [
        message({
          from: GITHUB,
          minutesAgo: 4,
          subject: "Your GitHub launch code",
          read: false,
          labels: ["codes"],
          text: "Here is your GitHub launch code: 482917\n\nIf you didn't try to sign in, you can ignore this email.\n\nThanks,\nThe GitHub Team",
          readBy: [
            { threadId: threadId(11), title: "Fix signup bug", readAt: ago(3) },
          ],
        }),
      ],
    },
    {
      key: "c-checkout",
      folder: "inbox",
      subject: "Mobile layout regression on checkout",
      messages: [
        message({
          from: PRIYA,
          minutesAgo: 60 * 26,
          subject: "Mobile layout regression on checkout",
          tag: "web",
          to: [{ address: `alex+web@${DOMAIN}` }],
          cc: [BEN],
          labels: ["customers"],
          text: "Hi Alex,\n\nSince yesterday's release the checkout button sits under the keyboard on iPhone, so customers can't pay. Screenshot attached.\n\nCould your team take a look today?\n\nPriya",
          attachments: [
            {
              index: 0,
              filename: "checkout-iphone.png",
              mimeType: "image/png",
              size: 482_133,
            },
          ],
          thread: {
            threadId: threadId(12),
            title: "Fix checkout layout on mobile",
            kind: "started",
          },
          readBy: [
            {
              threadId: threadId(12),
              title: "Fix checkout layout on mobile",
              readAt: ago(60 * 25),
            },
          ],
        }),
        message({
          from: ME,
          direction: "out",
          folder: "sent",
          minutesAgo: 60 * 25,
          subject: "Re: Mobile layout regression on checkout",
          tag: "web",
          to: [PRIYA],
          cc: [BEN],
          labels: ["customers"],
          text: "Thanks Priya, we're on it. An agent is reproducing it now.\n\nAlex",
        }),
        message({
          from: BEN,
          minutesAgo: 35,
          subject: "Re: Mobile layout regression on checkout",
          tag: "web",
          to: [ME, PRIYA],
          read: false,
          labels: ["customers"],
          html: "<p>Confirmed fixed on <b>iOS 18</b> and Android 15. 🎉</p><p>Thanks for the quick turnaround.</p><p>Ben</p>",
          text: "Confirmed fixed on iOS 18 and Android 15.\n\nThanks for the quick turnaround.\n\nBen",
        }),
      ],
    },
    {
      key: "c-invoice",
      folder: "inbox",
      subject: "Invoice #2041 for November",
      messages: [
        message({
          from: BILLING,
          minutesAgo: 60 * 5,
          subject: "Invoice #2041 for November",
          labels: ["receipts"],
          text: "Your invoice for November is ready. Amount due: $1,240.00, paid automatically on Nov 30.",
          attachments: [
            {
              index: 0,
              filename: "invoice-2041.pdf",
              mimeType: "application/pdf",
              size: 88_412,
            },
          ],
        }),
      ],
    },
    {
      key: "c-phish",
      folder: "inbox",
      subject: "Urgent: confirm your account",
      messages: [
        message({
          from: FAKE,
          minutesAgo: 60 * 7,
          subject: "Urgent: confirm your account",
          authenticated: false,
          read: false,
          text: "We noticed unusual activity. Confirm your password within 24 hours or your account will be closed: https://paypa1-support.example/confirm",
        }),
      ],
    },
    {
      key: "c-digest",
      folder: "inbox",
      subject: "Weekly build report",
      messages: [
        message({
          from: DIGEST,
          minutesAgo: 60 * 30,
          subject: "Weekly build report",
          labels: ["newsletters"],
          html: NEWSLETTER_HTML,
          text: "Weekly build report\n\n142 builds passed, 3 failed across 6 repositories.\nSlowest job: e2e-chromium at 11m 42s.",
        }),
      ],
    },
    {
      key: "c-lunch",
      folder: "inbox",
      subject: "Lunch next week?",
      messages: [
        message({
          from: SAM,
          minutesAgo: 60 * 50,
          subject: "Lunch next week?",
          private: true,
          labels: ["personal"],
          text: "Are you free Tuesday or Wednesday? There's a new ramen place near the office.",
        }),
      ],
    },
    {
      key: "c-deploy",
      folder: "inbox",
      subject: "Deploy failed: api-worker",
      messages: [
        message({
          from: CLOUD,
          minutesAgo: 60 * 24 * 9,
          subject: "Deploy failed: api-worker",
          tag: "api",
          to: [{ address: `alex+api@${DOMAIN}` }],
          text: "The deployment of api-worker failed at step 'migrate'. See the logs for details.",
        }),
      ],
    },
    {
      key: "c-prize",
      folder: "spam",
      subject: "You've won a $500 gift card",
      messages: [
        message({
          from: PRIZE,
          minutesAgo: 90,
          folder: "spam",
          subject: "You've won a $500 gift card",
          authenticated: false,
          read: false,
          spamReason:
            "The sender's domain failed its DMARC check, and the email had no matching DKIM signature.",
          text: "Congratulations! Claim your $500 gift card now by entering your card details.",
        }),
      ],
    },
    {
      key: "c-contract",
      folder: "sent",
      subject: "Contract draft",
      messages: [
        message({
          from: ME,
          direction: "out",
          folder: "sent",
          minutesAgo: 60 * 3,
          subject: "Contract draft",
          to: [TAYLOR],
          text: "Hi Taylor, the redlined draft is attached. Let me know what you think.",
          attachments: [
            {
              index: 0,
              filename: "contract-v3.docx",
              mimeType:
                "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
              size: 54_220,
            },
          ],
        }),
      ],
    },
    {
      key: "c-welcome",
      folder: "archive",
      subject: "Welcome to dx",
      messages: [
        message({
          from: { name: "dx", address: `hello@${DOMAIN}` },
          minutesAgo: 60 * 24 * 40,
          folder: "archive",
          subject: "Welcome to dx",
          text: "Your Mailbox is ready. You and your agents share this address.",
        }),
      ],
    },
  ];
};

type MailboxOverrides = Partial<Extract<MailboxData, { enabled: true }>>;

export interface FixtureOptions {
  readonly mailbox?: MailboxOverrides;
  readonly empty?: boolean;
  /** Routes that answer 500. */
  readonly fail?: ReadonlyArray<"mailbox" | "list" | "conversation" | "send">;
  /** Routes that never answer, to show loading. */
  readonly hang?: ReadonlyArray<"mailbox" | "list" | "conversation">;
  readonly sendError?: { readonly code: string; readonly message: string };
  readonly disabled?: boolean;
  readonly projectMail?: ProjectMailData;
}

const json = (data: unknown, status = 200) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { "content-type": "application/json" },
  });
const ok = (data: unknown) => json({ status: "success", data });
const failure = (status: number, code: string, message: string) =>
  json(
    { status: "error", data: { code, message, requestId: "req_fixture" } },
    status,
  );
const never = () => new Promise<Response>(() => undefined);

const summaryOf = (
  conversation: FixtureConversation,
): MailConversationSummary => {
  const messages = conversation.messages;
  const last = messages.at(-1) as MailMessage;
  const others = new Map<string, MailAddress>();
  for (const item of [...messages].reverse())
    for (const address of item.direction === "in" ? [item.from] : item.to)
      if (address.address !== ME.address) others.set(address.address, address);
  const labels = new Map(
    messages.flatMap((item) => item.labels).map((label) => [label.id, label]),
  );
  const received = messages.filter((item) => item.direction === "in");
  return {
    key: conversation.key,
    subject: conversation.subject,
    participants: [...others.values()],
    latestAt: last.receivedAt,
    count: messages.length,
    unread: messages.some((item) => !item.read),
    preview: last.text.replace(/\s+/g, " ").slice(0, 140),
    labels: [...labels.values()],
    tag: messages.find((item) => item.tag !== undefined)?.tag,
    private: messages.every((item) => item.private),
    hasAttachments: messages.some((item) => item.attachments.length > 0),
    authenticated: received.every((item) => item.authenticated),
    readByAgent: messages.some((item) => item.readBy.length > 0),
  };
};

const ACCOUNT = {
  displayName: ME.name,
  username: "alex",
  email: "alex@example.com",
  emailVerified: true,
  identityAuthority: "cloudflare-access",
  appearance: "dark",
  palette: "daydream",
  terminalTheme: "github",
  textSize: "default",
  threadWidth: "default",
  terminalAppearance: "match",
  codeFontFamily: null,
  codeFontSize: null,
  codeLineHeight: null,
  logoAnimation: true,
  uiSounds: false,
};

const projectData = (id: string, name: string) => ({
  id,
  name,
  configuration: {
    shipAction: "ship",
    commitAuthor: { preference: "dx", name: "dx", email: "noreply@dx.local" },
    signingPreference: "disabled",
    runnerProfileId: "e2b-default",
    publicCodeEnabled: false,
    dxCoAuthor: true,
  },
  revision: 0,
  createdAt: "2026-08-25T00:00:00.000Z",
  updatedAt: "2026-08-25T00:00:00.000Z",
});

/** Answers the Mailbox's routes from memory; returns the restore. */
export const installMailboxApi = (options: FixtureOptions) => {
  const state = {
    conversations: options.empty ? [] : conversations(),
    labels: Object.values(LABELS).map((label) => ({ ...label })) as Array<{
      id: string;
      name: string;
      kind: MailLabel["kind"];
    }>,
    privateSenders: ["alerts@mybank.example"],
    agentAccess: "all" as const as "all" | "project" | "none",
    username: options.mailbox?.username ?? "alex",
    needsUsername: options.mailbox?.needsUsername ?? false,
    canChangeUsername: options.mailbox?.canChangeUsername ?? true,
    sentToday: 12,
  };
  const address = () => `${state.username}@${DOMAIN}`;
  const account = () => ({
    ...ACCOUNT,
    username: state.username,
    usernameChangeAvailable: state.canChangeUsername || state.needsUsername,
    usernameNeedsPick: state.needsUsername,
  });
  const mailbox = (): MailboxData => {
    if (options.disabled) return { enabled: false };
    const inFolder = (folder: MailFolder) =>
      state.conversations.filter((item) => item.folder === folder);
    const unread = (items: ReadonlyArray<FixtureConversation>) =>
      items.filter((item) => item.messages.some((m) => !m.read)).length;
    return {
      enabled: true,
      domain: DOMAIN,
      username: state.username,
      address: address(),
      needsUsername: state.needsUsername,
      canChangeUsername: state.canChangeUsername,
      canSend: true,
      agentAccess: state.agentAccess,
      unread: {
        inbox: unread(inFolder("inbox")),
        spam: unread(inFolder("spam")),
      },
      labels: state.labels.map((label) => ({
        ...label,
        unread: unread(
          inFolder("inbox").filter((item) =>
            item.messages.some((m) => m.labels.some((l) => l.id === label.id)),
          ),
        ),
      })),
      projects: PROJECTS.map((project) => ({
        ...project,
        address: `${state.username}+${project.tag}@${DOMAIN}`,
        unread: unread(
          inFolder("inbox").filter((item) =>
            item.messages.some((m) => m.tag === project.tag),
          ),
        ),
      })),
      privateSenders: state.privateSenders,
      limits: {
        sendsPerDay: 100,
        recipientsPerEmail: 20,
        attachmentBytes: 10 * 1024 * 1024,
        sentToday: state.sentToday,
      },
      ...options.mailbox,
      ...(options.mailbox?.username === undefined
        ? {}
        : { username: state.username }),
      ...(options.mailbox?.needsUsername === undefined
        ? {}
        : { needsUsername: state.needsUsername }),
    } as MailboxData;
  };
  const find = (key: string) =>
    state.conversations.find((item) => item.key === key);
  const original = window.fetch;
  const handle = async (
    url: URL,
    init: RequestInit | undefined,
  ): Promise<Response> => {
    const method = init?.method ?? "GET";
    const body =
      typeof init?.body === "string" ? JSON.parse(init.body) : undefined;
    const path = url.pathname;
    if (path === "/v1/mailbox") {
      if (options.hang?.includes("mailbox")) return never();
      if (options.fail?.includes("mailbox"))
        return failure(500, "INTERNAL", "Failed.");
      return ok(mailbox());
    }
    if (path === "/v1/mailbox/conversations") {
      if (options.hang?.includes("list")) return never();
      if (options.fail?.includes("list"))
        return failure(500, "INTERNAL", "Failed.");
      const folder = url.searchParams.get("folder");
      const label = url.searchParams.get("label");
      const tag = url.searchParams.get("tag");
      const q = url.searchParams.get("q")?.toLowerCase();
      const listed = state.conversations
        .filter((item) =>
          label !== null
            ? item.folder !== "spam" &&
              item.messages.some((m) => m.labels.some((l) => l.id === label))
            : tag !== null
              ? item.folder !== "spam" &&
                item.messages.some((m) => m.tag === tag)
              : folder === "sent"
                ? item.messages.some((m) => m.direction === "out")
                : item.folder === folder,
        )
        .map(summaryOf)
        .filter(
          (item) =>
            q === undefined ||
            `${item.subject} ${item.preview} ${item.participants.map((p) => `${p.name} ${p.address}`).join(" ")}`
              .toLowerCase()
              .includes(q),
        )
        .sort((a, b) => b.latestAt.localeCompare(a.latestAt));
      return ok({ conversations: listed });
    }
    const conversationMatch = /^\/v1\/mailbox\/conversations\/(.+)$/.exec(path);
    if (conversationMatch !== null) {
      const key = decodeURIComponent(conversationMatch[1] as string);
      if (method === "GET" && options.hang?.includes("conversation"))
        return never();
      if (method === "GET" && options.fail?.includes("conversation"))
        return failure(500, "INTERNAL", "Failed.");
      const conversation = find(key);
      if (conversation === undefined)
        return failure(404, "MAIL_NOT_FOUND", "That email was not found.");
      if (method === "PATCH") {
        if (body.folder !== undefined) {
          conversation.folder = body.folder;
          for (const item of conversation.messages)
            if (item.direction === "in")
              Object.assign(item, { folder: body.folder });
        }
        conversation.messages = conversation.messages.map((item) => ({
          ...item,
          ...(body.read === undefined ? {} : { read: body.read }),
          ...(body.private === undefined ? {} : { private: body.private }),
          labels: [
            ...item.labels.filter(
              (l) => !(body.removeLabels ?? []).includes(l.id),
            ),
            ...(body.addLabels ?? [])
              .filter((id: string) => !item.labels.some((l) => l.id === id))
              .flatMap((id: string) => {
                const found = state.labels.find((l) => l.id === id);
                return found === undefined
                  ? []
                  : [
                      {
                        id,
                        name: found.name,
                        automatic: found.kind === "auto",
                      },
                    ];
              }),
          ],
        }));
        return ok({});
      }
      return ok({
        key,
        subject: conversation.subject,
        messages: conversation.messages,
      });
    }
    if (path === "/v1/mailbox/labels" && method === "POST") {
      seed += 1;
      const label = {
        id: labelId(seed),
        name: body.name,
        kind: "user" as const,
      };
      state.labels.push(label);
      return ok({ ...label, unread: 0 });
    }
    const labelMatch = /^\/v1\/mailbox\/labels\/(.+)$/.exec(path);
    if (labelMatch !== null) {
      const id = labelMatch[1];
      if (method === "DELETE") {
        state.labels = state.labels.filter((label) => label.id !== id);
        return ok({});
      }
      const label = state.labels.find((item) => item.id === id);
      if (label !== undefined) label.name = body.name;
      return ok({ ...label, unread: 0 });
    }
    if (path === "/v1/mailbox/settings") {
      if (body.agentAccess !== undefined) state.agentAccess = body.agentAccess;
      if (body.addPrivateSender !== undefined)
        state.privateSenders.push(body.addPrivateSender);
      if (body.removePrivateSender !== undefined)
        state.privateSenders = state.privateSenders.filter(
          (s) => s !== body.removePrivateSender,
        );
      return ok({});
    }
    if (path === "/v1/mailbox/send") {
      if (options.sendError !== undefined)
        return failure(422, options.sendError.code, options.sendError.message);
      if (options.fail?.includes("send"))
        return failure(
          500,
          "MAIL_SEND_FAILED",
          "The email could not be sent. Try again.",
        );
      seed += 1;
      const sent = message({
        from: { name: ME.name, address: address() },
        direction: "out",
        folder: "sent",
        minutesAgo: 0,
        subject: body.subject,
        to: body.to.map((a: string) => ({ address: a })),
        cc: (body.cc ?? []).map((a: string) => ({ address: a })),
        text: body.text,
      });
      const replied = state.conversations.find((item) =>
        item.messages.some((m) => m.id === body.replyTo),
      );
      state.sentToday += 1;
      if (replied !== undefined) {
        replied.messages = [...replied.messages, sent];
        return ok({ id: sent.id, conversationKey: replied.key });
      }
      const key = `c-sent-${seed}`;
      state.conversations.push({
        key,
        folder: "sent",
        subject: body.subject,
        messages: [sent],
      });
      return ok({ id: sent.id, conversationKey: key });
    }
    if (/^\/v1\/mailbox\/messages\/.+\/start-thread$/.test(path))
      return ok({ threadId: threadId(99) });
    if (path === "/v1/projects")
      return ok({
        items: [
          projectData(projectId(1), "dx web"),
          projectData(projectId(2), "dx api"),
          projectData(projectId(3), "docs"),
        ],
      });
    if (/^\/v1\/projects\/.+\/mail$/.test(path))
      return ok(
        options.projectMail ?? {
          enabled: true,
          address: `alex+web@${DOMAIN}`,
          visibility: "private",
          startThreads: true,
          workspace: true,
          canManage: true,
        },
      );
    if (path === "/v1/settings/personal/account") {
      if (method === "PATCH") {
        if (body.username === "maya")
          return json(
            {
              status: "error",
              data: {
                code: "USERNAME_UNAVAILABLE",
                message: "That username is already in use.",
                requestId: "req_fixture",
                fieldErrors: [],
              },
            },
            409,
          );
        state.username = body.username;
        state.needsUsername = false;
        state.canChangeUsername = false;
        return ok(account());
      }
      return ok(account());
    }
    return original(url, init);
  };
  window.fetch = (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    if (!url.pathname.startsWith("/v1/")) return original(input, init);
    return new Promise((resolve) => setTimeout(resolve, 120)).then(() =>
      handle(url, init),
    );
  };
  return () => {
    window.fetch = original;
  };
};

/** Answers the Project's mail route from memory; returns the restore. */
export const installProjectMailApi = (data: ProjectMailData) => {
  let current = data;
  const original = window.fetch;
  window.fetch = async (input, init) => {
    const url = new URL(
      typeof input === "string"
        ? input
        : input instanceof URL
          ? input.href
          : input.url,
      window.location.origin,
    );
    if (!/^\/v1\/projects\/.+\/mail$/.test(url.pathname))
      return original(input, init);
    if (init?.method === "PATCH" && current.enabled) {
      const change = JSON.parse(String(init.body));
      current = {
        ...current,
        ...(change.visibility === undefined
          ? {}
          : { visibility: change.visibility }),
        ...(change.startThreads === undefined
          ? {}
          : { startThreads: change.startThreads }),
        ...(change.agentMode === undefined
          ? {}
          : change.agentMode === null
            ? { agentMode: undefined }
            : { agentMode: change.agentMode }),
      };
    }
    return Response.json({ status: "success", data: current });
  };
  return () => {
    window.fetch = original;
  };
};
