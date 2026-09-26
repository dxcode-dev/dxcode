import { resolve } from "node:path";
import { resetLocalState } from "./local-runtime.mjs";

const workspaceRoot = resolve(import.meta.dirname, "..");
const removed = resetLocalState(workspaceRoot);
console.log(`Removed local dx state for this checkout: ${removed}`);
