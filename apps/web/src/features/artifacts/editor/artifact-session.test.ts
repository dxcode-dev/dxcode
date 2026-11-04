/**
 * The save session against an in-memory artifact server (compare-and-swap on
 * `baseRevision`, as the API does), with the real codec and merge.
 *
 * Ways it can fail, each covered below:
 *  1. An edit never saves: a timer is lost, the conflict hold is never
 *     released, or the in-flight flag sticks.
 *  2. A newer revision arriving during conflict review leaves saving stuck
 *     or saves both versions before the person chose.
 *  3. A conflict met while the editor unmounts strands the draft in a
 *     session nobody shows.
 *  4. Keep My Version throws away the other side's changes to blocks the
 *     person never touched.
 *  5. A failed save loses the draft or never retries.
 *  6. The session's own save echoing back is treated as someone else's.
 */
import type { ThreadArtifact } from "@dx/api";
import type { ThreadId } from "@dx/domain";
import { QueryClient } from "@tanstack/react-query";
import { describe, expect, it, vi } from "vitest";
import {
  ArtifactApiError,
  type ArtifactDocument,
  type ArtifactsApi,
} from "../artifacts-api.js";
import { ArtifactSession } from "./artifact-session.js";

const threadId = "thr_00000000-0000-4000-8000-000000000001" as ThreadId;
const artifactId = `art_${"0".repeat(32)}`;

const artifact = (revision: number, title = "Plan"): ThreadArtifact => ({
  id: artifactId,
  threadId,
  folder: "",
  title,
  revision,
  sizeBytes: 0,
  createdBy: { kind: "agent" },
  updatedBy: { kind: "agent" },
  openCommentCount: 0,
  createdAt: 0,
  updatedAt: revision,
});

/** One artifact on a server that refuses a save from an old revision. */
const server = (markdown: string) => {
  const state = { revision: 1, markdown, title: "Plan", failNext: 0 };
  const current = (): ArtifactDocument => ({
    artifact: artifact(state.revision, state.title),
    markdown: state.markdown,
  });
  const saves: Array<{ baseRevision: number; markdown: string }> = [];
  const api: ArtifactsApi = {
    list: async () => [current().artifact],
    get: async () => current(),
    create: async () => current(),
    uploadImage: () => Promise.reject(new Error("No images here.")),
    save: async (_thread, _id, input) => {
      await Promise.resolve();
      if (state.failNext > 0) {
        state.failNext -= 1;
        throw new ArtifactApiError(503, "ARTIFACTS_UNAVAILABLE", "Down.");
      }
      if (input.baseRevision !== state.revision)
        throw new ArtifactApiError(
          409,
          "ARTIFACT_CONFLICT",
          "Newer.",
          current(),
        );
      saves.push({
        baseRevision: input.baseRevision,
        markdown: input.markdown,
      });
      state.revision += 1;
      state.markdown = input.markdown;
      if (input.title !== undefined) state.title = input.title;
      return current();
    },
  };
  /** Someone else saves a newer revision. */
  const external = (change: (markdown: string) => string) => {
    state.revision += 1;
    state.markdown = change(state.markdown);
    return current();
  };
  return { state, api, saves, current, external };
};

const start = (markdown: string) => {
  const remote = server(markdown);
  const session = new ArtifactSession({
    threadId,
    initial: remote.current(),
    api: remote.api,
    queryClient: new QueryClient(),
    delay: 1,
  });
  /** Types `text` at the end of the first textblock whose text starts with `prefix`. */
  const type = (prefix: string, text: string) => {
    let at: number | undefined;
    session.state.doc.descendants((node, pos) => {
      if (
        at === undefined &&
        node.isTextblock &&
        node.textContent.startsWith(prefix)
      )
        at = pos + node.nodeSize - 1;
      return at === undefined;
    });
    if (at === undefined) throw new Error(`no block ${prefix}`);
    session.dispatch(session.state.tr.insertText(text, at));
  };
  const settled = () =>
    vi.waitFor(() => {
      const kind = session.getSnapshot().save.kind;
      if (kind === "saving" || kind === "unsaved") throw new Error(kind);
    });
  return { session, remote, type, settled };
};

const BASE = "# Plan\n\nIntro.\n\n- [ ] one\n- [ ] two\n\nOutro.\n";

describe("artifact save session", () => {
  it("saves an edit from the loaded revision, and ignores its own echo", async () => {
    const { session, remote, type, settled } = start(BASE);
    type("Intro.", " Mine.");
    await settled();
    expect(remote.saves).toEqual([
      { baseRevision: 1, markdown: BASE.replace("Intro.", "Intro. Mine.") },
    ]);
    session.receive(remote.current());
    expect(session.getSnapshot().save.kind).toBe("saved");
    expect(session.dirty).toBe(false);
  });

  it("merges a newer revision under an unsaved edit and saves both", async () => {
    const { session, remote, type, settled } = start(BASE);
    type("Intro.", " Mine.");
    remote.external((markdown) => markdown.replace("Outro.", "Outro, theirs."));
    await settled();
    expect(remote.state.markdown).toBe(
      BASE.replace("Intro.", "Intro. Mine.").replace(
        "Outro.",
        "Outro, theirs.",
      ),
    );
    expect(session.getSnapshot().save.kind).toBe("saved");
  });

  it("stays in review when another revision arrives, then Done saves everything", async () => {
    const { session, remote, type, settled } = start(BASE);
    type("Intro.", " Mine.");
    remote.external((markdown) => markdown.replace("Intro.", "Intro, theirs."));
    await vi.waitFor(() =>
      expect(session.getSnapshot().save.kind).toBe("conflict"),
    );
    const savesInReview = remote.saves.length;
    session.receive(
      remote.external((markdown) =>
        markdown.replace("Outro.", "Outro, later."),
      ),
    );
    expect(session.getSnapshot().save.kind).toBe("conflict");
    expect(remote.saves.length).toBe(savesInReview);

    session.keepBoth();
    await settled();
    expect(session.getSnapshot().save.kind).toBe("saved");
    expect(remote.state.markdown).toContain("Intro, theirs.");
    expect(remote.state.markdown).toContain("Intro. Mine.");
    expect(remote.state.markdown).toContain("Outro, later.");

    type("Outro, later.", " More.");
    await settled();
    expect(remote.state.markdown).toContain("Outro, later. More.");
  });

  it("saves both versions when a conflict is met as the editor unmounts", async () => {
    const { session, remote, type } = start(BASE);
    type("Intro.", " Mine.");
    remote.external((markdown) => markdown.replace("Intro.", "Intro, theirs."));
    session.detach();
    await vi.waitFor(() => {
      expect(remote.state.markdown).toContain("Intro. Mine.");
      expect(remote.state.markdown).toContain("Intro, theirs.");
    });
  });

  it("saves both versions when the editor unmounts during review", async () => {
    const { session, remote, type } = start(BASE);
    type("Intro.", " Mine.");
    remote.external((markdown) => markdown.replace("Intro.", "Intro, theirs."));
    await vi.waitFor(() =>
      expect(session.getSnapshot().save.kind).toBe("conflict"),
    );
    session.detach();
    await vi.waitFor(() => {
      expect(remote.state.markdown).toContain("Intro. Mine.");
      expect(remote.state.markdown).toContain("Intro, theirs.");
    });
  });

  it("Keep My Version keeps the other side's changes to other blocks", async () => {
    const { session, remote, type, settled } = start(BASE);
    type("Intro.", " Mine.");
    remote.external((markdown) =>
      markdown
        .replace("Intro.", "Intro, theirs.")
        .replace("Outro.", "Outro, theirs."),
    );
    await vi.waitFor(() =>
      expect(session.getSnapshot().save.kind).toBe("conflict"),
    );
    session.keepMine();
    await settled();
    expect(remote.state.markdown).toBe(
      BASE.replace("Intro.", "Intro. Mine.").replace(
        "Outro.",
        "Outro, theirs.",
      ),
    );
  });

  it("keeps the draft through a failed save and saves on retry", async () => {
    const { session, remote, type, settled } = start(BASE);
    remote.state.failNext = 1;
    type("Intro.", " Mine.");
    await vi.waitFor(() =>
      expect(session.getSnapshot().save.kind).toBe("error"),
    );
    expect(session.markdown()).toContain("Intro. Mine.");
    await vi.waitFor(
      () => expect(remote.state.markdown).toContain("Intro. Mine."),
      {
        timeout: 5_000,
      },
    );
    await settled();
    expect(session.getSnapshot().save.kind).toBe("saved");
  });
});
