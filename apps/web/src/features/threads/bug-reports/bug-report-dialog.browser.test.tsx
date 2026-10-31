/**
 * Report Bug's optional diagnostics, rendered and sent through the real
 * dialog and transport. Ways it could fail, each covered below:
 *   1. Diff or Dictation Diagnostics can be checked with nothing to send.
 *   2. A checked option sends nothing, or an unchecked one sends its data.
 *   3. The dictation's audio leaves the device without the option checked.
 *   4. Diff Diagnostics miss the open pane's view or its loaded diffs.
 */
import type { ThreadDetailData } from "@dx/api";
import { defaultThreadModelSelection } from "@dx/domain";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { DateTime } from "effect";
import type * as React from "react";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("@tanstack/react-router", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@tanstack/react-router")>()),
  // Your Reports is a Link; no router renders here.
  Link: ({
    children,
    ...props
  }: React.ComponentProps<"a"> & { readonly to?: string }) => (
    <a {...props}>{children}</a>
  ),
}));
vi.mock("../../../shared/auth/auth-context.js", async (importOriginal) => ({
  ...(await importOriginal<
    typeof import("../../../shared/auth/auth-context.js")
  >()),
  useAuthenticatedIdentity: () => ({
    identity: { id: "usr_00000000000000000000000000000001" },
  }),
}));

import { changesKeys } from "../changes/changes-queries.js";
import type { DictationRecord } from "../dictation/dictation-session.js";
import { deriveTranscriptViewModel } from "../transcript-view-model.js";
import { BugReportDialog } from "./bug-report-dialog.js";

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const thread = {
  id: "thr_00000000-0000-4000-8000-0000000000d1",
  title: "Dictation bug",
  visibility: "private",
  lifecycleState: "active",
  activityStatus: "idle",
  createdAt: DateTime.makeUnsafe("2026-10-31T00:00:00.000Z"),
  updatedAt: DateTime.makeUnsafe("2026-10-31T00:00:00.000Z"),
  agentInitialization: { selection: defaultThreadModelSelection() },
} as unknown as ThreadDetailData;

const dictation: DictationRecord = {
  audio: new Blob([new Uint8Array([0x52, 0x49, 0x46, 0x46])], {
    type: "audio/wav",
  }),
  transcript: "images vanish",
  outcome: "completed",
  mode: "live",
  jobId: "job-1",
  startedAt: "2026-10-31T00:00:00.000Z",
  finishedAt: "2026-10-31T00:00:01.000Z",
};

let root: Root | undefined;
let host: HTMLElement | undefined;
afterEach(() => {
  act(() => root?.unmount());
  host?.remove();
  document.querySelector(".changes-pane")?.remove();
  vi.restoreAllMocks();
});

const render = (props: {
  readonly changesOpen: boolean;
  readonly dictation?: DictationRecord;
}) => {
  const queryClient = new QueryClient();
  queryClient.setQueryData(changesKeys.range(thread.id, { kind: "all" }), {
    kind: "changes",
    files: [{ path: "src/app.ts" }],
  });
  host = document.createElement("div");
  document.body.append(host);
  root = createRoot(host);
  act(() =>
    root?.render(
      <QueryClientProvider client={queryClient}>
        <BugReportDialog
          thread={thread}
          transcript={() =>
            deriveTranscriptViewModel({ messages: [], settlements: [] })
          }
          onClose={() => undefined}
          {...props}
        />
      </QueryClientProvider>,
    ),
  );
};

const option = (name: RegExp) =>
  [
    ...document.querySelectorAll<HTMLInputElement>('input[type="checkbox"]'),
  ].find((input) =>
    name.test(input.closest("label")?.textContent ?? ""),
  ) as HTMLInputElement;

/** Sends the report and answers what the dialog posted. */
const sendReport = async () => {
  const posted: FormData[] = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
    posted.push(init?.body as FormData);
    return Response.json(
      {
        status: "success",
        data: {
          id: `bug_${"0".repeat(32)}`,
          threadId: thread.id,
          message: "Bug",
          createdAt: "2026-10-31T00:00:00.000Z",
          status: "saved",
          imageCount: 0,
          diagnostics: [],
        },
      },
      { status: 201 },
    );
  });
  const textarea = document.querySelector("textarea") as HTMLTextAreaElement;
  act(() => {
    const setter = Object.getOwnPropertyDescriptor(
      HTMLTextAreaElement.prototype,
      "value",
    )?.set;
    setter?.call(textarea, "Bug");
    textarea.dispatchEvent(new Event("input", { bubbles: true }));
  });
  await act(async () => {
    (
      document.querySelector('button[type="submit"]') as HTMLButtonElement
    ).click();
  });
  await vi.waitFor(() => expect(posted).toHaveLength(1));
  const form = posted[0] as FormData;
  return {
    report: JSON.parse(String(form.get("report"))) as {
      diagnostics: Record<string, unknown>;
    },
    audio: form.get("audio"),
  };
};

describe("Report Bug's Diff and Dictation Diagnostics", () => {
  it("offers neither without an open Changes pane or a dictation, and sends neither", async () => {
    render({ changesOpen: false });
    expect(option(/Diff Diagnostics/).disabled).toBe(true);
    expect(option(/Dictation Diagnostics/).disabled).toBe(true);
    expect(document.body.textContent).toContain(
      "Open Changes to include diff diagnostics.",
    );
    expect(document.body.textContent).toContain(
      "Dictate in this Thread to include it.",
    );
    const { report, audio } = await sendReport();
    expect(Object.keys(report.diagnostics)).toEqual(["threadAndApp"]);
    expect(audio).toBeNull();
  });

  it("keeps the audio on the device until Dictation Diagnostics are checked", async () => {
    render({ changesOpen: false, dictation });
    expect(option(/Dictation Diagnostics/).disabled).toBe(false);
    expect(option(/Dictation Diagnostics/).checked).toBe(false);
    const { report, audio } = await sendReport();
    expect(report.diagnostics.dictation).toBeUndefined();
    expect(audio).toBeNull();
  });

  it("sends the dictation's audio and details, and the open pane's view and diffs", async () => {
    const pane = document.createElement("section");
    pane.className = "changes-pane";
    Object.assign(pane.dataset, {
      threadId: thread.id,
      range: '{"kind":"all"}',
      diffStyle: "split",
      overflow: "wrap",
      sort: "path",
      expanded: "primary:src/app.ts",
    });
    document.body.append(pane);
    render({ changesOpen: true, dictation });
    act(() => option(/Diff Diagnostics/).click());
    act(() => option(/Dictation Diagnostics/).click());
    const { report, audio } = await sendReport();
    expect(report.diagnostics.dictation).toEqual({
      transcript: "images vanish",
      outcome: "completed",
      mode: "live",
      jobId: "job-1",
      startedAt: "2026-10-31T00:00:00.000Z",
      finishedAt: "2026-10-31T00:00:01.000Z",
      audioBytes: 4,
      audioType: "audio/wav",
    });
    expect(audio).toBeInstanceOf(Blob);
    expect((audio as Blob).size).toBe(4);
    expect(report.diagnostics.changes).toEqual({
      view: {
        range: '{"kind":"all"}',
        diffStyle: "split",
        overflow: "wrap",
        sortByName: false,
        expanded: ["primary:src/app.ts"],
      },
      loaded: [
        {
          key: ["thread-changes", thread.id, "range", { kind: "all" }],
          data: { kind: "changes", files: [{ path: "src/app.ts" }] },
        },
      ],
      truncated: false,
    });
  });
});
