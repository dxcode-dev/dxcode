/** A skill's SKILL.md as dx writes it into the Orb. */
export const skillMarkdown = (skill: {
  readonly name: string;
  readonly description: string;
  readonly instructions: string;
}) =>
  `---\nname: ${skill.name}\ndescription: ${JSON.stringify(skill.description)}\n---\n\n${skill.instructions}\n`;

/** A skill's file paths for its tree: SKILL.md and every other file. */
export const skillTreePaths = (
  resources: ReadonlyArray<{ readonly path: string }>,
): ReadonlyArray<string> => ["SKILL.md", ...resources.map(({ path }) => path)];

export const lineCount = (content: string) =>
  `${content.replace(/\n$/, "").split("\n").length} lines`;

/** Repository the skill came from, when it came from one. */
export const skillOrigin = (source: {
  readonly type: string;
  readonly repository?: string;
}) => (source.type === "github" ? source.repository : undefined);

export const fileCount = (count: number) =>
  `${count} ${count === 1 ? "file" : "files"}`;

export const installCount = (installs: number) =>
  installs >= 1_000_000
    ? `${(installs / 1_000_000).toFixed(1)}M`
    : installs >= 1_000
      ? `${Math.round(installs / 1_000)}k`
      : String(installs);
