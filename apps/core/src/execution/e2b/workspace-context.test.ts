import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentProps,
  init,
  type Sandbox,
  type SandboxFactory,
  useModel,
  useSandbox,
  type WorkspaceContextSnapshot,
} from "@flue/runtime";
import { start } from "@flue/runtime/node";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const cwd = "/workspace";
const skillDirectories = Array.from(
  { length: 100 },
  (_, index) => `skill-${String(index).padStart(3, "0")}`,
);
const skillContent = (directoryName: string) =>
  `---\nname: ${directoryName}\ndescription: ${directoryName} description\n---\n${directoryName} body`;
const directoryListing = ["z-last", "AGENTS.md", ".agents", "a-first"];

const snapshot: WorkspaceContextSnapshot = {
  instructionFiles: {
    "AGENTS.md": "  workspace instructions  ",
  },
  skillFiles: skillDirectories.map((directoryName) => ({
    kind: "file",
    directoryName,
    content: skillContent(directoryName),
  })),
  directoryListing,
};

const primitiveSandbox = (operations: string[]): Sandbox => ({
  cwd,
  resolvePath: (path) => (path.startsWith("/") ? path : `${cwd}/${path}`),
  exec: vi.fn(),
  readFile: async (path) => {
    operations.push(`read:${path}`);
    if (path === `${cwd}/AGENTS.md`)
      return snapshot.instructionFiles["AGENTS.md"] ?? "";
    const directoryName = path.split("/").at(-2) ?? "";
    return skillContent(directoryName);
  },
  readFileBuffer: vi.fn(),
  writeFile: vi.fn(),
  stat: async (path) => {
    operations.push(`stat:${path}`);
    return {
      isFile: false,
      isDirectory: skillDirectories.includes(path.split("/").at(-1) ?? ""),
    };
  },
  readdir: async (path) => {
    operations.push(`readdir:${path}`);
    return path === `${cwd}/.agents/skills`
      ? skillDirectories
      : directoryListing;
  },
  exists: async (path) => {
    operations.push(`exists:${path}`);
    return (
      path === `${cwd}/AGENTS.md` ||
      path === `${cwd}/.agents/skills` ||
      path.endsWith("/SKILL.md")
    );
  },
  mkdir: vi.fn(),
  rm: vi.fn(),
});

const provider = fauxProvider();
let factory: SandboxFactory;

function WorkspaceContextAgent(_props: AgentProps) {
  useModel("faux/faux-1");
  useSandbox(factory);
  return "agent instructions";
}
WorkspaceContextAgent.agentName = "workspace-context-test";

let runtime: Awaited<ReturnType<typeof start>>;

beforeAll(async () => {
  runtime = await start({
    agents: [WorkspaceContextAgent],
    providers: [provider.provider],
  });
});

afterAll(async () => {
  await runtime[Symbol.asyncDispose]();
});

const promptWith = async (id: string, nextFactory: SandboxFactory) => {
  let systemPrompt = "";
  factory = nextFactory;
  provider.setResponses([
    (context) => {
      systemPrompt = context.systemPrompt ?? "";
      return fauxAssistantMessage("done");
    },
  ]);
  const handle = init(WorkspaceContextAgent, { id });
  const receipt = await handle.dispatch("Inspect the workspace.");
  await handle.read(receipt);
  return systemPrompt;
};

describe("Flue workspace-context discovery", () => {
  it("preserves prompt semantics and provider order for 100 skills while reducing 306 primitive operations to one", async () => {
    const primitiveOperations: string[] = [];
    const primitivePrompt = await promptWith("primitive-context", {
      createSandbox: async () => primitiveSandbox(primitiveOperations),
    });
    expect(primitiveOperations).toHaveLength(306);

    const snapshotWorkspaceContext = vi.fn(async () => snapshot);
    const bulkPrompt = await promptWith("bulk-context", {
      createSandbox: async () => ({
        ...primitiveSandbox([]),
        snapshotWorkspaceContext,
      }),
    });

    expect(snapshotWorkspaceContext).toHaveBeenCalledOnce();
    expect(snapshotWorkspaceContext).toHaveBeenCalledWith(cwd);
    expect(bulkPrompt).toBe(primitivePrompt);
    expect(bulkPrompt.indexOf("skill-000")).toBeLessThan(
      bulkPrompt.indexOf("skill-099"),
    );
    expect(bulkPrompt.indexOf("z-last")).toBeLessThan(
      bulkPrompt.indexOf("a-first"),
    );
  });

  it("uses the complete primitive fallback only for an explicit local safety decline", async () => {
    const expectedOperations: string[] = [];
    const expectedPrompt = await promptWith("decline-reference", {
      createSandbox: async () => primitiveSandbox(expectedOperations),
    });
    const fallbackOperations: string[] = [];
    const snapshotWorkspaceContext = vi.fn(async () => ({
      kind: "declined" as const,
    }));

    const fallbackPrompt = await promptWith("decline-fallback", {
      createSandbox: async () => ({
        ...primitiveSandbox(fallbackOperations),
        snapshotWorkspaceContext,
      }),
    });

    expect(snapshotWorkspaceContext).toHaveBeenCalledOnce();
    expect(fallbackOperations).toEqual(expectedOperations);
    expect(fallbackPrompt).toBe(expectedPrompt);
  });

  it("propagates an advertised snapshot failure without issuing primitive calls", async () => {
    const primitiveOperations: string[] = [];
    const failure = new Error("snapshot transport failed");

    await expect(
      promptWith("snapshot-failure", {
        createSandbox: async () => ({
          ...primitiveSandbox(primitiveOperations),
          snapshotWorkspaceContext: async () => Promise.reject(failure),
        }),
      }),
    ).rejects.toMatchObject({
      name: "AgentRunError",
      outcome: "failed",
    });
    expect(primitiveOperations).toEqual([]);
  });

  it("keeps activation rereads live after snapshot discovery", async () => {
    let currentSkill = skillContent("skill-00");
    let secondTurnMessages = "";
    const readFile = vi.fn(async () => currentSkill);
    factory = {
      createSandbox: async () => ({
        ...primitiveSandbox([]),
        readFile,
        snapshotWorkspaceContext: async () => ({
          instructionFiles: {},
          skillFiles: [
            {
              kind: "file" as const,
              directoryName: "skill-00",
              content: currentSkill,
            },
          ],
          directoryListing: [],
        }),
      }),
    };
    provider.setResponses([
      () => {
        currentSkill = currentSkill.replace("skill-00 body", "updated body");
        return fauxAssistantMessage(
          [fauxToolCall("activate_skill", { name: "skill-00" })],
          { stopReason: "toolUse" },
        );
      },
      (context) => {
        secondTurnMessages = JSON.stringify(context.messages);
        return fauxAssistantMessage("done");
      },
    ]);
    const handle = init(WorkspaceContextAgent, { id: "activation-reread" });
    const receipt = await handle.dispatch("Activate the skill.");
    await handle.read(receipt);

    expect(readFile).toHaveBeenCalledWith(
      `${cwd}/.agents/skills/skill-00/SKILL.md`,
    );
    expect(secondTurnMessages).toContain("updated body");
  });
});
