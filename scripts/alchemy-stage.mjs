import { createHash } from "node:crypto";

export const alchemyStage = (branch) => {
  const source = branch.trim();
  if (source === "") {
    throw new Error("Branch deployment requires a named Git branch.");
  }

  const readable =
    source
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 40) || "feature";
  const identity = createHash("sha256")
    .update(source)
    .digest("hex")
    .slice(0, 12);
  return `branch-${readable}-${identity}`;
};
