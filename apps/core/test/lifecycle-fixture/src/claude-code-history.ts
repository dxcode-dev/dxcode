import { Type } from "@earendil-works/pi-ai";
import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { type SandboxToolFactory, setProvider } from "@flue/runtime";
import { claudeCodeContextAttachments } from "../../../src/claude-code/provider.js";

/**
 * A Claude Code Thread whose history fills with screenshots, as
 * thr_ba669347's did: each turn reads one large image, as Claude Code's Read
 * does. The model is a stand-in registered as `claude-code` with dx's own
 * attachment selection, and it records what each call was given.
 */

/** Bytes of one screenshot: a phone screenshot strip is a few megabytes. */
export const SCREENSHOT_BYTES = 1_500_000;

/** A screenshot's bytes: a PNG signature, then a pattern of its turn. */
export const screenshot = (turn: number) => {
  const bytes = new Uint8Array(SCREENSHOT_BYTES);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  for (let index = 8; index < bytes.length; index += 1)
    bytes[index] = (index * 31 + turn * 7) & 0xff;
  return bytes;
};

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

type AgentTool = ReturnType<SandboxToolFactory>[number];

/** Claude Code's Read of a screenshot, as a sandbox tool records it. */
export const screenshotTool: AgentTool = {
  name: "Read",
  label: "Read",
  description: "Read a screenshot.",
  parameters: Type.Object({ turn: Type.Number() }),
  async execute(_toolCallId: string, params: unknown) {
    return {
      content: [
        {
          type: "image",
          data: base64(screenshot((params as { turn: number }).turn)),
          mimeType: "image/png",
        },
      ],
      details: {},
    };
  },
};

/** What one model call was given. */
export interface ClaudeCodeCall {
  /** Characters of base64 image data in the context. */
  readonly imageChars: number;
  readonly images: number;
  /** Tool results whose image Flue left out as `[image]`. */
  readonly omitted: number;
  readonly lastUser: string;
}
const calls: ClaudeCodeCall[] = [];
export const claudeCodeCalls = () => calls;

type Block = { type: string; text?: string; data?: string };
const blocks = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : [];

/**
 * A message's first step reads that turn's screenshot; the step after the
 * screenshot answers. A message that says "look" answers at once.
 */
const step = (context: {
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
}) => {
  const messages = context.messages;
  let imageChars = 0;
  let images = 0;
  let omitted = 0;
  for (const message of messages)
    for (const block of blocks(message.content)) {
      if (block.type === "image") {
        images += 1;
        imageChars += block.data?.length ?? 0;
      }
      if (
        message.role === "toolResult" &&
        block.type === "text" &&
        block.text === "[image]"
      )
        omitted += 1;
    }
  const user = messages.findLast(({ role }) => role === "user");
  const lastUser =
    typeof user?.content === "string"
      ? user.content
      : blocks(user?.content)
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
  calls.push({ imageChars, images, omitted, lastUser });
  const turn = Number(/turn (\d+)/.exec(lastUser)?.[1] ?? 0);
  if (messages.at(-1)?.role === "toolResult" || lastUser.includes("look"))
    return fauxAssistantMessage(`answered turn ${turn}`);
  return fauxAssistantMessage([fauxToolCall("Read", { turn })], {
    stopReason: "toolUse",
  });
};

// Claude Code mode's provider never compacts: its context window is 0.
const faux = fauxProvider({
  provider: "claude-code",
  models: [{ id: "fixture-claude-code", contextWindow: 0 }],
});
faux.setResponses(Array.from({ length: 500 }, () => step));
setProvider(faux.provider, {
  selectContextAttachments: claudeCodeContextAttachments,
});
