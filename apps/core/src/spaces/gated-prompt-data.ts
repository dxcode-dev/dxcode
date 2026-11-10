import type { Bindings } from "../http/types.js";
import { readSpaceAgentPromptData } from "./agent/prompt-data.js";
import type { SpaceSystemPromptInput } from "./agent/system-prompt.js";
import { readStartingSpace } from "./agent-prompt.js";
import { spacesEnabledFor, threadOwner } from "./gate.js";

/**
 * Whether Spaces is on for the owner of this Thread (spaces/gate.ts).
 */
const ownerHasSpaces = async (
  bindings: Bindings,
  db: D1Database,
  threadId: string,
) => {
  const owner = await threadOwner(db, threadId);
  return owner !== undefined && (await spacesEnabledFor(bindings, owner));
};

/**
 * The Space this Thread is, for its agent's prompt and tools; undefined for
 * any other Thread, and for a Space whose owner's `spaces` flag is off. A
 * Space's turn without it loads no Space prompt or tools and still starts
 * no Orb (agents/orb-free.ts), so it fails as unavailable.
 */
export const readGatedSpacePromptData = async (
  bindings: Bindings,
  threadId: string,
): Promise<SpaceSystemPromptInput | undefined> => {
  const db = bindings.DB;
  if (db === undefined) return undefined;
  const space = await readSpaceAgentPromptData(db, bindings, threadId);
  if (space === undefined) return undefined;
  return (await ownerHasSpaces(bindings, db, threadId)) ? space : undefined;
};

/**
 * The Space that started this Thread, for the child's prompt; undefined
 * when no Space did, or when Spaces is off for the Thread's owner.
 */
export const readGatedStartingSpace = async (
  bindings: Bindings,
  threadId: string,
): Promise<{ readonly name: string } | undefined> => {
  const db = bindings.DB;
  if (db === undefined) return undefined;
  const space = await readStartingSpace(db, threadId);
  if (space === undefined) return undefined;
  return (await ownerHasSpaces(bindings, db, threadId)) ? space : undefined;
};
