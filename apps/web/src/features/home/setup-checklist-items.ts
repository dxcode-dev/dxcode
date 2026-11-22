/** A new account's setup checklist: each item's key, label, and button. */
export const CHECKLIST = [
  { key: "model", label: "Connect a model", action: "Connect" },
  { key: "code", label: "Connect your code", action: "Connect" },
  { key: "thread", label: "Start a thread", action: "Start" },
  { key: "tour", label: "Take the thread tour", action: "Start" },
] as const;

export type ChecklistKey = (typeof CHECKLIST)[number]["key"];
