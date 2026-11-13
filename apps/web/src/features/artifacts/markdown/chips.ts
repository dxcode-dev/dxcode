/**
 * Chips: small inline values an artifact's Markdown writes as text, each read
 * into one inline atom whose source is kept as written.
 *
 * - `{{date:YYYY-MM-DD}}`, `{{time:ISO_INSTANT}}` (shown in each reader's zone)
 * - `{{dropdown:Todo|*Doing:blue|Done:green}}`, `*` marking the selection
 * - `{{toggle:key|Label}}`, which shows or hides chips tagged `#key`, as in
 *   `{{time#key:…}}`, for each reader
 * - `{{project:PROJECT_ID|Name}}` for a dx Project, which opens it
 * - `@[Name](user:USER_ID)` for a person and `@[dx](agent)` for the agent
 */

export const CHIP_COLORS = [
  "gray",
  "blue",
  "green",
  "yellow",
  "red",
  "purple",
] as const;
export type ChipColor = (typeof CHIP_COLORS)[number];

export interface DropdownOption {
  readonly label: string;
  readonly color?: ChipColor;
  readonly selected: boolean;
}

export type Chip =
  | { readonly kind: "date"; readonly tag?: string; readonly date: string }
  | { readonly kind: "time"; readonly tag?: string; readonly instant: string }
  | {
      readonly kind: "dropdown";
      readonly tag?: string;
      readonly options: ReadonlyArray<DropdownOption>;
    }
  | { readonly kind: "toggle"; readonly key: string; readonly label: string }
  | {
      readonly kind: "project";
      readonly projectId: string;
      readonly name: string;
    }
  | { readonly kind: "mention"; readonly name: string; readonly userId: string }
  | { readonly kind: "agent"; readonly name: string };

const KEY = /^[A-Za-z0-9_-]{1,40}$/;
const BRACED = /^\{\{([a-z]+)(?:#([A-Za-z0-9_-]{1,40}))?:([^\n]*)\}\}$/;
/** A Project's ID, as `@dx/domain`'s `ProjectId` writes it. */
const PROJECT_ID =
  /^prj_[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const MENTION = /^@\[([^\]\n]+)\]\((?:user:([A-Za-z0-9_-]+)|(agent))\)$/;

/**
 * A real calendar day from 1000 to 9999, written `YYYY-MM-DD`. An earlier
 * year is what a date field holds while someone is still typing it.
 */
const validDate = (value: string) => {
  const match = /^([1-9]\d{3})-(\d{2})-(\d{2})$/.exec(value);
  if (match === null) return false;
  const [year, month, day] = [
    Number(match[1]),
    Number(match[2]),
    Number(match[3]),
  ];
  const date = new Date(0);
  date.setUTCFullYear(year, month - 1, day);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
};

const validInstant = (value: string) =>
  /^[1-9]\d{3}-\d{2}-\d{2}T\d{2}:\d{2}(?::\d{2}(?:\.\d{1,3})?)?(?:Z|[+-]\d{2}:\d{2})$/.test(
    value,
  ) && !Number.isNaN(Date.parse(value));

/** Text a label may hold without ending its chip or its option. */
const validLabel = (label: string) =>
  label.trim() !== "" &&
  !label.includes("}") &&
  !label.includes("{{") &&
  !/[|\n]/.test(label) &&
  !label.startsWith("*");

const parseOptions = (body: string): DropdownOption[] | undefined => {
  if (body === "") return undefined;
  const options: DropdownOption[] = [];
  for (const part of body.split("|")) {
    const selected = part.startsWith("*");
    const text = selected ? part.slice(1) : part;
    const colon = text.lastIndexOf(":");
    const named = colon === -1 ? undefined : text.slice(colon + 1);
    const color = CHIP_COLORS.find((candidate) => candidate === named);
    if (named !== undefined && color === undefined) return undefined;
    const label = color === undefined ? text : text.slice(0, colon);
    if (!validLabel(label)) return undefined;
    options.push({
      label,
      ...(color === undefined ? {} : { color }),
      selected,
    });
  }
  // One selection at most, and no two options alike.
  return options.filter((option) => option.selected).length <= 1 &&
    new Set(options.map((option) => option.label)).size === options.length
    ? options
    : undefined;
};

/** The chip `source` writes, or undefined when it is not one. */
export const parseChip = (source: string): Chip | undefined => {
  const mention = MENTION.exec(source);
  if (mention !== null) {
    const name = mention[1] ?? "";
    if (mention[3] === "agent") return { kind: "agent", name };
    return { kind: "mention", name, userId: mention[2] ?? "" };
  }
  const braced = BRACED.exec(source);
  if (braced === null) return undefined;
  const [, kind, tag, body = ""] = braced;
  const tagged = tag === undefined ? {} : { tag };
  switch (kind) {
    case "date":
      return validDate(body)
        ? { kind: "date", ...tagged, date: body }
        : undefined;
    case "time":
      return validInstant(body)
        ? { kind: "time", ...tagged, instant: body }
        : undefined;
    case "dropdown": {
      const options = parseOptions(body);
      return options === undefined
        ? undefined
        : { kind: "dropdown", ...tagged, options };
    }
    case "toggle": {
      if (tag !== undefined) return undefined;
      const bar = body.indexOf("|");
      const key = body.slice(0, bar);
      const label = body.slice(bar + 1);
      return bar > 0 && KEY.test(key) && validLabel(label)
        ? { kind: "toggle", key, label }
        : undefined;
    }
    case "project": {
      if (tag !== undefined) return undefined;
      const bar = body.indexOf("|");
      const projectId = body.slice(0, bar);
      const name = body.slice(bar + 1);
      return bar > 0 && PROJECT_ID.test(projectId) && validLabel(name)
        ? { kind: "project", projectId, name }
        : undefined;
    }
    default:
      return undefined;
  }
};

/** The Markdown for `chip`, unchecked. */
const writeChip = (chip: Chip): string => {
  const prefix = (kind: string, tag?: string) =>
    `{{${kind}${tag === undefined ? "" : `#${tag}`}:`;
  let source: string;
  switch (chip.kind) {
    case "date":
      source = `${prefix("date", chip.tag)}${chip.date}}}`;
      break;
    case "time":
      source = `${prefix("time", chip.tag)}${chip.instant}}}`;
      break;
    case "dropdown":
      source = `${prefix("dropdown", chip.tag)}${chip.options
        .map(
          (option) =>
            `${option.selected ? "*" : ""}${option.label}${
              option.color === undefined ? "" : `:${option.color}`
            }`,
        )
        .join("|")}}}`;
      break;
    case "toggle":
      source = `{{toggle:${chip.key}|${chip.label}}}`;
      break;
    case "project":
      source = `{{project:${chip.projectId}|${chip.name}}}`;
      break;
    case "mention":
      source = `@[${chip.name}](user:${chip.userId})`;
      break;
    case "agent":
      source = `@[${chip.name}](agent)`;
      break;
  }
  return source;
};

/** The Markdown for `chip`, or undefined for a value that would not read back. */
export const tryChipSource = (chip: Chip): string | undefined => {
  const source = writeChip(chip);
  const back = parseChip(source);
  return back !== undefined && JSON.stringify(back) === JSON.stringify(chip)
    ? source
    : undefined;
};

/** The Markdown for `chip`; throws for a value that would not read back. */
export const chipSource = (chip: Chip): string => {
  const source = tryChipSource(chip);
  if (source === undefined) throw new RangeError("Not a chip.");
  return source;
};

/** The tag a chip carries, if a toggle can hide it. */
export const chipTag = (chip: Chip) =>
  chip.kind === "date" || chip.kind === "time" || chip.kind === "dropdown"
    ? chip.tag
    : undefined;

/**
 * The tags whose chips are hidden: those of a toggle in the document that
 * this reader has not turned on. A tag no toggle names stays shown.
 */
export const hiddenChipTags = (
  sources: Iterable<string>,
  shown: ReadonlySet<string>,
): Set<string> => {
  const hidden = new Set<string>();
  for (const source of sources) {
    const chip = parseChip(source);
    if (chip?.kind === "toggle" && !shown.has(chip.key)) hidden.add(chip.key);
  }
  return hidden;
};

/** Today in the reader's zone, as a date chip writes it. */
export const localDate = (now = new Date()) =>
  `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, "0")}-${String(now.getDate()).padStart(2, "0")}`;

/** An instant as a time chip writes it: UTC, to the second. */
export const instantOf = (date: Date) =>
  date.toISOString().replace(/\.\d{3}Z$/, "Z");

/** A new chip of `kind`, as the Insert and `/` menus add it. */
export const newChipSource = (
  kind: "date" | "time" | "dropdown" | "toggle",
  now = new Date(),
) => {
  switch (kind) {
    case "date":
      return chipSource({ kind: "date", date: localDate(now) });
    case "time":
      return chipSource({ kind: "time", instant: instantOf(now) });
    case "dropdown":
      return chipSource({
        kind: "dropdown",
        options: [
          { label: "Todo", selected: true },
          { label: "Doing", color: "blue", selected: false },
          { label: "Done", color: "green", selected: false },
        ],
      });
    case "toggle":
      return chipSource({
        kind: "toggle",
        key: "details",
        label: "Show details",
      });
  }
};

/**
 * A Project's chip, its name made one line a chip can hold, or undefined
 * when it still can't be written.
 */
export const projectSource = (project: {
  readonly id: string;
  readonly name: string;
}) =>
  tryChipSource({
    kind: "project",
    projectId: project.id,
    name: project.name
      .replace(/[|{}\n]+/g, " ")
      .replace(/^[\s*]+/, "")
      .replace(/\s+/g, " ")
      .trim(),
  });

/** A person's mention, when their name and ID can be written as one. */
export const mentionSource = (person: {
  readonly name: string;
  readonly userId: string;
}) => {
  const source = `@[${person.name.replace(/[\][\n]/g, "").trim()}](user:${person.userId})`;
  return parseChip(source)?.kind === "mention" ? source : undefined;
};
