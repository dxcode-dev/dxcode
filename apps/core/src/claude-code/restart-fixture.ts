/**
 * One process of the restart test in claude-code.test.ts: a Flue runtime over
 * a SQLite file whose agent has Claude Code's `mcp__dx__wait_for_threads`.
 * `start` sends a message whose answer calls the tool and prints the receipt
 * once the call runs, which never finishes; the test kills the process there,
 * as a Durable Object restart ends an attempt. `resume` starts a runtime over
 * the same file, which recovers the submission once the killed attempt's
 * lease lapses (about 45 seconds), and prints the reply.
 */
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import {
  type AgentProps,
  defineTool,
  init,
  type Sandbox,
  type SandboxFactory,
  useModel,
  useSandbox,
  useTool,
} from "@flue/runtime";
import { local, sqlite, start } from "@flue/runtime/node";
import * as v from "valibot";
import { claudeCodeDxTools } from "./dx-tools.js";

const [mode, db, home, submissionId] = process.argv.slice(2);
/** One JSON line the test reads. */
const say = (line: object) => process.stdout.write(`${JSON.stringify(line)}\n`);
if (db === undefined || home === undefined) throw new Error("Missing paths.");

/** The workspace, with the guest's home in a temporary directory. */
const workspace: SandboxFactory = {
  async createSandbox(options) {
    const base = await local({ cwd: home }).createSandbox(options);
    const map = (value: unknown) =>
      typeof value === "string" ? value.replaceAll("/home/user", home) : value;
    return new Proxy(base, {
      get: (target, key) => {
        const value = Reflect.get(target, key);
        return typeof value === "function"
          ? (...args: unknown[]) => value.apply(target, args.map(map))
          : value;
      },
    }) as Sandbox;
  },
};

const waitForThreads = defineTool({
  name: "wait_for_threads",
  description: "Wait for Threads.",
  input: v.object({ threads: v.array(v.string()) }),
  run: async () => {
    if (mode === "start") {
      say({ calling: true });
      // Running until the test kills the process, as a lost instance does.
      await new Promise(() => setInterval(() => undefined, 60_000));
    }
    return { output: { settled: true, lastMessage: "REPORT\nEND-OF-REPORT" } };
  },
});

const faux = fauxProvider({ models: [{ id: "faux-1" }] });
faux.setResponses(
  mode === "start"
    ? [
        fauxAssistantMessage(
          [
            fauxToolCall(
              "mcp__dx__wait_for_threads",
              { threads: ["thr_child"] },
              { id: "toolu_wait" },
            ),
          ],
          { stopReason: "toolUse" },
        ),
      ]
    : [
        (context) => {
          const result = context.messages.findLast(
            (message) => message.role === "toolResult",
          );
          return fauxAssistantMessage(
            result?.role === "toolResult"
              ? result.content
                  .flatMap((block) =>
                    block.type === "text" ? [block.text] : [],
                  )
                  .join("\n")
              : "no tool result",
          );
        },
      ],
);

export function RestartAgent(_props: AgentProps) {
  useModel("faux/faux-1");
  useSandbox(workspace);
  for (const tool of claudeCodeDxTools("thr_restart", [waitForThreads]))
    useTool(tool);
  return "Wait for the child Thread.";
}
RestartAgent.agentName = "restart-agent";

const flue = await start({
  agents: [RestartAgent],
  db: sqlite(db),
  providers: [faux.provider],
});
const agent = init(RestartAgent, { id: "thr_restart" });
if (mode === "start") {
  const receipt = await agent.dispatch("Wait for the child.");
  say({ submissionId: receipt.submissionId });
} else {
  if (submissionId === undefined) throw new Error("Missing submission.");
  const reply = await agent.read(submissionId);
  say({ reply: reply.text });
  await flue.stop();
}
