import { describe, expect, it } from "vitest";
import {
  composeDxAgentPrompt,
  dxAgentPrompt,
} from "../../agents/dx-agent-prompt.js";
import { buildSpaceSetupMessage } from "./setup-message.js";
import { buildSpaceSystemPrompt } from "./system-prompt.js";
import {
  SPACE_CREATE_THREAD_DESCRIPTION,
  SPACE_TOOL_DESCRIPTIONS,
  SPACE_TOOL_NAMES,
  SPACE_TOOL_PARAMETER_DESCRIPTIONS,
} from "./tool-descriptions.js";

// The tools a Space's main thread has (tasks/spaces-v2/SPEC.md): the Space
// tools plus the dx tools it keeps. The prompt may name only these, since a
// rule about a missing tool sends the model looking for it.
const SPACE_THREAD_TOOLS = new Set<string>([
  ...SPACE_TOOL_NAMES,
  "create_thread",
  "send_thread_message",
  "get_thread_status",
  "find_thread",
  "read_thread",
  "update_thread",
  "download_thread_changes",
  "thread_file_url",
  "artifact",
  "set_schedule",
  "get_schedule",
  "update_schedule",
  "clear_schedule",
  "notify_user",
  "view_media",
  "code_exec",
  "tool_search",
  "list_agent_modes",
  "list_orbs",
  "list_bug_reports",
  "read_bug_report",
]);

const project = {
  name: "dx",
  repositories: ["https://github.com/example/dx"],
};
const goal = "Get checkout under 2 seconds on mobile.";
const threadUrl = "https://dx.example.com/threads/thr_space";

const space = {
  spaceName: "Checkout speed",
  origin: "https://dx.example.com",
  ownerName: "Rhea",
  threadUrl,
};
const withProject = buildSpaceSystemPrompt({ ...space, goal, project });
const withoutProject = buildSpaceSystemPrompt({
  ...space,
  goal: null,
  project: null,
});

const allWords = [
  withProject,
  withoutProject,
  buildSpaceSetupMessage({
    spaceName: "Checkout speed",
    creatorName: "Rhea",
    project,
  }),
  buildSpaceSetupMessage({
    spaceName: "Notes",
    creatorName: "Rhea",
    project: null,
  }),
  ...Object.values(SPACE_TOOL_DESCRIPTIONS),
  SPACE_CREATE_THREAD_DESCRIPTION,
  ...Object.values(SPACE_TOOL_PARAMETER_DESCRIPTIONS).flatMap((parameters) =>
    Object.values(parameters ?? {}),
  ),
];

describe("Space agent system prompt", () => {
  it("tells a Space with a Project that threads run there without project_id", () => {
    expect(withProject).toContain('"dx"');
    expect(withProject).toContain("https://github.com/example/dx");
    expect(withProject).toContain("leave `project_id` out");
    expect(withProject).not.toContain("has no Project");
  });

  it("tells a Space without a Project to ask which Project code work is for", () => {
    expect(withoutProject).toContain("This Space has no Project");
    expect(withoutProject).toContain("ask which Project");
    expect(withoutProject).not.toContain("leave `project_id` out");
  });

  it("carries the goal once, in <space_goal>, and says when there is none", () => {
    expect(withProject).toContain(`<space_goal>\n${goal}\n</space_goal>`);
    expect(withProject.split(goal)).toHaveLength(2);
    expect(withoutProject).not.toContain("<space_goal>");
    expect(withoutProject).toContain("This Space has no goal yet");
  });

  it("ends with the Space's own thread URL and keeps the shared text first", () => {
    expect(withProject.trimEnd().endsWith(threadUrl)).toBe(true);
    expect(withProject).toContain('"Checkout speed"');
    const shared = withProject.slice(0, withProject.indexOf("# Project"));
    expect(withoutProject.startsWith(shared)).toBe(true);
  });

  it("names only tools a Space's main thread has", () => {
    const named = new Set(
      [...withProject.matchAll(/`([a-z]+(?:_[a-z]+)+)`/g)].map(
        (match) => match[1] ?? "",
      ),
    );
    const parameters = new Set([
      "project_id",
      "request_post_id",
      "bug_report",
      "run_mode",
      "waiting_on_input",
      "thumbs_up",
    ]);
    const unknown = [...named].filter(
      (name) => !SPACE_THREAD_TOOLS.has(name) && !parameters.has(name),
    );
    expect(unknown).toEqual([]);
  });

  it("puts the start post's thread link alone on its own line", () => {
    expect(withProject).toMatch(/\n>\n> \[[^\]]+\]\(<thread URL>\)\n/);
  });
});

describe("Space setup message", () => {
  it("names the Space, the Project, and its repositories, and asks for a wave", () => {
    const message = buildSpaceSetupMessage({
      spaceName: "Checkout speed",
      creatorName: "Rhea",
      project,
    });
    expect(message).toContain('"Checkout speed"');
    expect(message).toContain("- https://github.com/example/dx");
    expect(message).toContain("naming the Project");
    expect(message).toContain("restate the Space goal");
    expect(message).toContain("`wave`");
    expect(message).toContain("Only you see this message");
  });

  it("leaves out the Project for a Space without one", () => {
    const message = buildSpaceSetupMessage({
      spaceName: "Notes",
      creatorName: "Rhea",
      project: null,
    });
    expect(message).toContain("with no Project");
    expect(message).not.toContain("repositories");
    expect(message).not.toContain("naming the Project");
    expect(message).toContain("no goal yet");
  });
});

describe("Space tool descriptions", () => {
  it("describes every Space tool and the parameters the Space adds", () => {
    for (const name of SPACE_TOOL_NAMES)
      expect(SPACE_TOOL_DESCRIPTIONS[name].length).toBeGreaterThan(40);
    expect(
      SPACE_TOOL_PARAMETER_DESCRIPTIONS.create_thread?.request_post_id,
    ).toContain("pst_");
    for (const parameters of Object.values(SPACE_TOOL_PARAMETER_DESCRIPTIONS))
      for (const text of Object.values(parameters ?? {}))
        expect(text.length).toBeGreaterThan(10);
  });

  it("relays a ship request with send_thread_message's ship flag", () => {
    expect(
      SPACE_TOOL_PARAMETER_DESCRIPTIONS.send_thread_message?.ship,
    ).toContain("ship instructions");
    expect(
      buildSpaceSystemPrompt({
        spaceName: "Checkout v2",
        goal: null,
        project: { name: "checkout", repositories: [] },
        threadUrl: "https://dx.example.com/threads/thr_space",
        origin: "https://dx.example.com",
        ownerName: "Ada",
      }),
    ).toContain("`send_thread_message` with `ship: true`");
  });
});

// The reference product's name, from character codes so this public file
// never spells it.
const referenceName = String.fromCharCode(97, 109, 112);

describe("Space words", () => {
  it("name dx and no other product", () => {
    const reference = new RegExp(`\\b${referenceName}(code)?\\b`, "i");
    for (const text of allWords) expect(text).not.toMatch(reference);
    expect(`You are ${referenceName.toUpperCase()}`).toMatch(reference);
  });

  it("leave ordinary threads' prompt unchanged", () => {
    expect(composeDxAgentPrompt("")).toBe(dxAgentPrompt);
    expect(dxAgentPrompt).not.toContain("Worker report from");
    expect(dxAgentPrompt).not.toContain("<space_goal>");
  });
});
