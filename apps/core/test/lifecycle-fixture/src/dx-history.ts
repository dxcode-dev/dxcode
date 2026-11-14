import {
  fauxAssistantMessage,
  fauxProvider,
  fauxToolCall,
} from "@earendil-works/pi-ai/providers/faux";
import { setProvider } from "@flue/runtime";
import { dxContextAttachments } from "../../../src/runtime/context-attachments.js";
import { screenshot } from "./claude-code-history.js";

/**
 * A dx-mode Thread that views many contact sheets, as thr_063852b2 did. A
 * message asks for a range of screenshots, which one turn reads one tool
 * call at a time. The model is a stand-in that is sent the whole context,
 * registered with dx-mode's own attachment selection, and it records which
 * screenshots each call was given.
 */

const base64 = (bytes: Uint8Array) => {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000)
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  return btoa(binary);
};

/** Each screenshot by the start of its base64, which differs per number. */
const PREFIX = 16;
const numbers = new Map(
  Array.from({ length: 36 }, (_, index) => [
    base64(screenshot(index + 1).subarray(0, 12)).slice(0, PREFIX),
    index + 1,
  ]),
);

/** What one model call was given. */
export interface DxHistoryCall {
  /** Screenshots whose bytes the call held, in context order. */
  readonly screenshots: ReadonlyArray<number>;
  /** Decoded bytes of every image the call held. */
  readonly imageBytes: number;
  /** Images of other kinds: the owner's attachment. */
  readonly otherImages: number;
  /** Tool results whose image Flue left out as `[image]`. */
  readonly omitted: number;
  readonly lastUser: string;
}
const calls: DxHistoryCall[] = [];
export const dxHistoryCalls = () => calls;

type Block = { type: string; text?: string; data?: string };
const blocks = (content: unknown): Block[] =>
  Array.isArray(content) ? (content as Block[]) : [];

/**
 * "Read screenshots 3 to 7" reads each in turn, one call at a time, then
 * answers. Any other message answers at once.
 */
const step = (context: {
  readonly messages: ReadonlyArray<{ role: string; content: unknown }>;
}) => {
  const messages = context.messages;
  const screenshots: number[] = [];
  let imageBytes = 0;
  let otherImages = 0;
  let omitted = 0;
  for (const message of messages)
    for (const block of blocks(message.content)) {
      if (block.type === "image") {
        const data = block.data ?? "";
        imageBytes +=
          (data.length * 3) / 4 - (data.match(/=*$/)?.[0].length ?? 0);
        const number = numbers.get(data.slice(0, PREFIX));
        if (number === undefined) otherImages += 1;
        else screenshots.push(number);
      }
      if (
        message.role === "toolResult" &&
        block.type === "text" &&
        block.text === "[image]"
      )
        omitted += 1;
    }
  const lastUserIndex = messages.findLastIndex(({ role }) => role === "user");
  const user = messages[lastUserIndex];
  const lastUser =
    typeof user?.content === "string"
      ? user.content
      : blocks(user?.content)
          .flatMap((block) => (block.type === "text" ? [block.text] : []))
          .join("");
  calls.push({ screenshots, imageBytes, otherImages, omitted, lastUser });
  const range = /screenshots (\d+) to (\d+)/.exec(lastUser);
  const read = messages
    .slice(lastUserIndex + 1)
    .filter(({ role }) => role === "toolResult").length;
  const next = Number(range?.[1] ?? 0) + read;
  if (range === null || next > Number(range[2]))
    return fauxAssistantMessage(`viewed ${read} screenshots`);
  return fauxAssistantMessage([fauxToolCall("Read", { turn: next })], {
    stopReason: "toolUse",
  });
};

// A large context window: Flue never compacts this Thread.
const faux = fauxProvider({
  provider: "dx-fixture",
  models: [{ id: "fixture-dx", contextWindow: 100_000_000 }],
});
faux.setResponses(Array.from({ length: 500 }, () => step));
setProvider(faux.provider, { selectContextAttachments: dxContextAttachments });
