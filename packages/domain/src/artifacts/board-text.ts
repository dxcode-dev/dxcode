import {
  type BoardDocument,
  type BoardElement,
  type BoardPoint,
  liveBoardElements,
} from "./board.js";

/**
 * The agent reads and writes a board as text, one shape per line:
 *
 *     board background=#ffffff
 *     rect login "Log in" x=0 y=0 w=180 h=80 fill=#a5d8ff
 *     diamond ok "Valid?" x=300 y=0 w=180 h=110
 *     arrow go login -> ok "submit"
 *     text note "Rate limit: 5/min" x=0 y=200
 *     freehand stroke1 x=400 y=400 w=30 h=20 points=3
 *
 * `<kind> <id> ["label"] [key=value …]`. Writing back a board means: lines
 * name its elements; a changed attribute changes that element; a line left
 * out deletes it; a new id creates it. An attribute left off is its
 * default, and a line written back exactly as read changes nothing, so the
 * agent can edit lines with old_str/new_str like a document. Positions are
 * optional for new shapes: dx lays them out below what is there. Text
 * cannot draw a freehand stroke or an image, so those lines only move or
 * resize what people drew.
 */

export type BoardTextResult =
  | { readonly ok: true; readonly board: BoardDocument }
  | { readonly ok: false; readonly message: string };

type Kind =
  | "rect"
  | "ellipse"
  | "diamond"
  | "text"
  | "arrow"
  | "line"
  | "frame"
  | "freehand"
  | "image";

const KIND_TYPE: Record<Kind, string> = {
  rect: "rectangle",
  ellipse: "ellipse",
  diamond: "diamond",
  text: "text",
  arrow: "arrow",
  line: "line",
  frame: "frame",
  freehand: "freedraw",
  image: "image",
};

const TYPE_KIND: Record<string, Kind> = Object.fromEntries(
  Object.entries(KIND_TYPE).map(([kind, type]) => [type, kind as Kind]),
);

const SHAPES = new Set<Kind>(["rect", "ellipse", "diamond"]);
/** Kinds text can only move or resize. */
const DRAWN = new Set<Kind>(["freehand", "image"]);
const ID = /^[A-Za-z0-9_-]{1,64}$/;
const COLOR = /^(#[0-9a-fA-F]{3,8}|transparent)$/;

const DEFAULT_STROKE = "#1e1e1e";
const DEFAULT_FONT_SIZE = 20;
const FONT_FAMILY = { hand: 5, normal: 6, code: 8 } as const;
const fontName = (family: number | undefined) =>
  family === 3 || family === 8
    ? "code"
    : family === 2 || family === 6 || family === 7 || family === 9
      ? "normal"
      : "hand";

// ---------------------------------------------------------------- writing

const quote = (text: string) =>
  `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n")}"`;

const value = (text: string) => (/^[^\s"=]+$/.test(text) ? text : quote(text));

const round = (number: number) => String(Math.round(number));

const labelOf = (board: BoardDocument, element: BoardElement) =>
  board.elements.find(
    (candidate) =>
      candidate.containerId === element.id &&
      !candidate.isDeleted &&
      candidate.type === "text",
  );

interface Attribute {
  readonly key: string;
  /** The value as text; undefined when it is the default and not printed. */
  readonly read: (
    element: BoardElement,
    board: BoardDocument,
  ) => string | undefined;
  readonly check: (text: string) => boolean;
}

const number = (text: string) =>
  text.trim() !== "" && Number.isFinite(Number(text));

const ATTRIBUTES: Record<string, Attribute> = {
  x: { key: "x", read: (element) => round(element.x), check: number },
  y: { key: "y", read: (element) => round(element.y), check: number },
  w: {
    key: "w",
    read: (element) => round(element.width),
    check: (text) => number(text) && Number(text) > 0,
  },
  h: {
    key: "h",
    read: (element) => round(element.height),
    check: (text) => number(text) && Number(text) > 0,
  },
  angle: {
    key: "angle",
    read: (element) => {
      const degrees = Math.round(((element.angle ?? 0) * 180) / Math.PI) % 360;
      return degrees === 0 ? undefined : String(degrees);
    },
    check: number,
  },
  fill: {
    key: "fill",
    read: (element) =>
      element.backgroundColor === undefined ||
      element.backgroundColor === "transparent"
        ? undefined
        : element.backgroundColor,
    check: (text) => COLOR.test(text) || text === "none",
  },
  stroke: {
    key: "stroke",
    read: (element) =>
      element.strokeColor === undefined ||
      element.strokeColor === DEFAULT_STROKE
        ? undefined
        : element.strokeColor,
    check: (text) => COLOR.test(text),
  },
  width: {
    key: "width",
    read: (element) =>
      element.strokeWidth === undefined || element.strokeWidth === 2
        ? undefined
        : String(element.strokeWidth),
    check: (text) => number(text) && Number(text) > 0 && Number(text) <= 16,
  },
  dash: {
    key: "dash",
    read: (element) =>
      element.strokeStyle === undefined || element.strokeStyle === "solid"
        ? undefined
        : element.strokeStyle,
    check: (text) => ["solid", "dashed", "dotted"].includes(text),
  },
  rough: {
    key: "rough",
    read: (element) =>
      element.roughness === undefined || element.roughness === 1
        ? undefined
        : String(element.roughness),
    check: (text) => ["0", "1", "2"].includes(text),
  },
  opacity: {
    key: "opacity",
    read: (element) =>
      element.opacity === undefined || element.opacity === 100
        ? undefined
        : String(element.opacity),
    check: (text) => number(text) && Number(text) >= 0 && Number(text) <= 100,
  },
  font: {
    key: "font",
    read: (element, board) => {
      const text = element.type === "text" ? element : labelOf(board, element);
      if (text === undefined) return undefined;
      const name = fontName(text.fontFamily);
      return name === "hand" ? undefined : name;
    },
    check: (text) => text in FONT_FAMILY,
  },
  size: {
    key: "size",
    read: (element, board) => {
      const text = element.type === "text" ? element : labelOf(board, element);
      return text?.fontSize === undefined ||
        Math.round(text.fontSize) === DEFAULT_FONT_SIZE
        ? undefined
        : round(text.fontSize);
    },
    check: (text) => number(text) && Number(text) >= 6 && Number(text) <= 200,
  },
  align: {
    key: "align",
    read: (element) =>
      element.textAlign === undefined || element.textAlign === "left"
        ? undefined
        : element.textAlign,
    check: (text) => ["left", "center", "right"].includes(text),
  },
  head: {
    key: "head",
    read: (element) =>
      element.type === "arrow"
        ? element.endArrowhead === "arrow"
          ? undefined
          : (element.endArrowhead ?? "none")
        : element.endArrowhead == null
          ? undefined
          : element.endArrowhead,
    check: (text) =>
      ["arrow", "triangle", "dot", "bar", "circle", "diamond", "none"].includes(
        text,
      ),
  },
  tail: {
    key: "tail",
    read: (element) => element.startArrowhead ?? undefined,
    check: (text) =>
      ["arrow", "triangle", "dot", "bar", "circle", "diamond", "none"].includes(
        text,
      ),
  },
  points: {
    key: "points",
    read: (element) =>
      element.type === "freedraw"
        ? String(element.points?.length ?? 0)
        : (element.points ?? [])
            .map(([px, py]) => `${round(px)},${round(py)}`)
            .join(";"),
    check: (text) =>
      /^\d+$/.test(text) ||
      /^-?\d+(\.\d+)?,-?\d+(\.\d+)?(;-?\d+(\.\d+)?,-?\d+(\.\d+)?)+$/.test(text),
  },
  frame: {
    key: "frame",
    read: (element) => element.frameId ?? undefined,
    check: (text) => ID.test(text),
  },
  link: {
    key: "link",
    read: (element) => element.link ?? undefined,
    check: (text) => /^(https?:\/\/|\/)\S{0,2000}$/.test(text),
  },
};

const STYLE = ["stroke", "width", "dash", "rough", "opacity"];

/** The attributes each kind prints, in order. */
const KIND_ATTRIBUTES: Record<Kind, ReadonlyArray<string>> = {
  rect: [
    "x",
    "y",
    "w",
    "h",
    "angle",
    "fill",
    ...STYLE,
    "font",
    "size",
    "frame",
    "link",
  ],
  ellipse: [
    "x",
    "y",
    "w",
    "h",
    "angle",
    "fill",
    ...STYLE,
    "font",
    "size",
    "frame",
    "link",
  ],
  diamond: [
    "x",
    "y",
    "w",
    "h",
    "angle",
    "fill",
    ...STYLE,
    "font",
    "size",
    "frame",
    "link",
  ],
  text: [
    "x",
    "y",
    "angle",
    "stroke",
    "opacity",
    "font",
    "size",
    "align",
    "frame",
    "link",
  ],
  arrow: [
    "x",
    "y",
    "points",
    ...STYLE,
    "head",
    "tail",
    "font",
    "size",
    "frame",
    "link",
  ],
  line: ["x", "y", "points", ...STYLE, "head", "tail", "frame", "link"],
  frame: ["x", "y", "w", "h"],
  freehand: [
    "x",
    "y",
    "w",
    "h",
    "angle",
    "stroke",
    "width",
    "opacity",
    "points",
    "frame",
    "link",
  ],
  image: ["x", "y", "w", "h", "angle", "opacity", "frame", "link"],
};

/** Attributes a bound arrow leaves out: its ends decide them. */
const BOUND_ARROW_SKIPS = new Set(["x", "y", "points"]);

const isBound = (element: BoardElement) =>
  element.type === "arrow" &&
  element.startBinding != null &&
  element.endBinding != null;

const kindOf = (element: BoardElement): Kind | undefined =>
  TYPE_KIND[element.type];

const shownAttributes = (element: BoardElement, kind: Kind) =>
  KIND_ATTRIBUTES[kind].filter(
    (key) => !(isBound(element) && BOUND_ARROW_SKIPS.has(key)),
  );

/** One element's line; undefined for an element text does not show. */
const lineFor = (board: BoardDocument, element: BoardElement) => {
  const kind = kindOf(element);
  if (kind === undefined) return undefined;
  const parts: string[] = [kind, element.id];
  if (isBound(element))
    parts.push(
      element.startBinding?.elementId ?? "",
      "->",
      element.endBinding?.elementId ?? "",
    );
  const label =
    kind === "text"
      ? element.text
      : kind === "frame"
        ? (element.name ?? undefined)
        : SHAPES.has(kind) || kind === "arrow"
          ? labelOf(board, element)?.text
          : undefined;
  if (
    label !== undefined &&
    label !== null &&
    (label !== "" || kind === "text")
  )
    parts.push(quote(label));
  for (const key of shownAttributes(element, kind)) {
    const text = ATTRIBUTES[key]?.read(element, board);
    if (text !== undefined) parts.push(`${key}=${value(text)}`);
  }
  return parts.join(" ");
};

/** Whether text shows this element on a line of its own. */
const listed = (board: BoardDocument, element: BoardElement) => {
  if (element.isDeleted || kindOf(element) === undefined) return false;
  if (element.type !== "text" || element.containerId == null) return true;
  // A label shows on its container's line.
  return !board.elements.some(
    (container) => container.id === element.containerId && !container.isDeleted,
  );
};

/** The board as text, for the agent. */
export const boardToText = (board: BoardDocument) => {
  const lines = board.elements
    .filter((element) => listed(board, element))
    .flatMap((element) => lineFor(board, element) ?? []);
  const header =
    board.background === "#ffffff"
      ? []
      : [`board background=${board.background}`];
  return [...header, ...lines].join("\n");
};

// ---------------------------------------------------------------- reading

interface ParsedLine {
  readonly line: number;
  readonly kind: Kind;
  readonly id: string;
  readonly from?: string;
  readonly to?: string;
  readonly label?: string;
  readonly attributes: ReadonlyMap<string, string>;
  readonly text: string;
  /** An arrow written without an id: the id comes from its ends. */
  readonly autoId?: true;
}

type Token = { readonly kind: "word" | "string"; readonly text: string };

const tokenize = (line: string): Token[] | string => {
  const tokens: Token[] = [];
  let index = 0;
  while (index < line.length) {
    const char = line[index] as string;
    if (/\s/.test(char)) {
      index += 1;
      continue;
    }
    if (char === '"') {
      let text = "";
      index += 1;
      let closed = false;
      while (index < line.length) {
        const next = line[index] as string;
        if (next === "\\") {
          const escaped = line[index + 1];
          if (escaped === "n") text += "\n";
          else if (escaped === '"' || escaped === "\\") text += escaped;
          else return `unknown escape \\${escaped ?? ""}`;
          index += 2;
          continue;
        }
        if (next === '"') {
          closed = true;
          index += 1;
          break;
        }
        text += next;
        index += 1;
      }
      if (!closed) return "a quote is not closed";
      tokens.push({ kind: "string", text });
      continue;
    }
    let word = "";
    while (index < line.length && !/\s/.test(line[index] as string)) {
      const next = line[index] as string;
      // key="quoted value"
      if (next === '"' && word.endsWith("=")) break;
      word += next;
      index += 1;
    }
    if (line[index] === '"' && word.endsWith("=")) {
      const rest = tokenize(line.slice(index));
      if (typeof rest === "string") return rest;
      const [first, ...others] = rest;
      if (first?.kind !== "string") return "a quote is not closed";
      tokens.push({ kind: "word", text: `${word}${first.text}` });
      return [...tokens, ...others];
    }
    tokens.push({ kind: "word", text: word });
  }
  return tokens;
};

const parseLine = (
  source: string,
  line: number,
): ParsedLine | { readonly error: string } | undefined => {
  // A label in the brackets that mark it optional, as models copy it.
  const trimmed = source.trim().replace(/\[\s*("(?:[^"\\]|\\.)*")\s*\]/g, "$1");
  if (trimmed === "" || trimmed.startsWith("//")) return undefined;
  const written = tokenize(trimmed);
  if (typeof written === "string") return { error: written };
  // `arrow a -> b`, without an id: named after its ends.
  const autoId =
    written[0]?.text === "arrow" &&
    written[2]?.kind === "word" &&
    written[2].text === "->" &&
    written[1]?.kind === "word" &&
    written[3]?.kind === "word";
  const tokens: Token[] = autoId
    ? [
        written[0] as Token,
        {
          kind: "word",
          text: `${written[1]?.text}-to-${written[3]?.text}`.slice(0, 60),
        },
        ...written.slice(1),
      ]
    : written;
  const [kindToken, idToken, ...rest] = tokens;
  if (kindToken === undefined || !(kindToken.text in KIND_TYPE))
    return {
      error: `starts with "${kindToken?.text ?? ""}"; a line starts with one of ${Object.keys(KIND_TYPE).join(", ")}`,
    };
  const kind = kindToken.text as Kind;
  if (idToken?.kind !== "word" || !ID.test(idToken.text))
    return {
      error: "needs an id after the kind: letters, digits, _ and -, at most 64",
    };
  let from: string | undefined;
  let to: string | undefined;
  let label: string | undefined;
  const attributes = new Map<string, string>();
  let position = 0;
  if (
    kind === "arrow" &&
    rest[1]?.kind === "word" &&
    rest[1].text === "->" &&
    rest[0]?.kind === "word" &&
    rest[2]?.kind === "word"
  ) {
    from = rest[0].text;
    to = rest[2].text;
    position = 3;
  }
  for (const token of rest.slice(position)) {
    if (token.kind === "string") {
      if (label !== undefined) return { error: "has two quoted labels" };
      label = token.text;
      continue;
    }
    const equals = token.text.indexOf("=");
    if (equals <= 0)
      return {
        error: `has "${token.text}" where a key=value or a "quoted label" goes`,
      };
    const key = token.text.slice(0, equals);
    const text = token.text.slice(equals + 1);
    if (key === "from" || key === "to") {
      if (kind !== "arrow") return { error: `${key}= is for arrows` };
      if (!ID.test(text)) return { error: `${key}= needs a shape id` };
      if (key === "from") from = text;
      else to = text;
      continue;
    }
    const attribute = ATTRIBUTES[key];
    if (attribute === undefined || !KIND_ATTRIBUTES[kind].includes(key))
      return {
        error: `${kind} has no attribute "${key}"; it takes ${KIND_ATTRIBUTES[kind].join(", ")}${kind === "arrow" ? ", from, to" : ""}`,
      };
    if (attributes.has(key)) return { error: `sets ${key} twice` };
    if (
      !attribute.check(text) ||
      (key === "points" && (kind === "freehand") !== /^\d+$/.test(text))
    )
      return { error: `has an invalid ${key}: "${text}"` };
    attributes.set(key, text);
  }
  if (kind === "text" && label === undefined)
    return { error: 'text needs its words in quotes, as text note "Hello"' };
  return {
    line,
    kind,
    id: idToken.text,
    ...(from === undefined ? {} : { from }),
    ...(to === undefined ? {} : { to }),
    ...(label === undefined ? {} : { label }),
    attributes,
    text: trimmed,
    ...(autoId ? { autoId: true } : {}),
  };
};

// ------------------------------------------------------------ building

const randomInt = () => {
  const values = new Uint32Array(1);
  crypto.getRandomValues(values);
  return (values[0] as number) >>> 1;
};

const ALPHABET =
  "0123456789ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz";
const randomId = () => {
  const bytes = new Uint8Array(20);
  crypto.getRandomValues(bytes);
  return [...bytes].map((byte) => ALPHABET[byte % 62]).join("");
};

const touched = (element: BoardElement, changes: Partial<BoardElement>) =>
  ({
    ...element,
    ...changes,
    version: element.version + 1,
    versionNonce: randomInt(),
    updated: Date.now(),
  }) as BoardElement;

const base = (id: string, type: string): BoardElement => ({
  id,
  type,
  x: 0,
  y: 0,
  width: 1,
  height: 1,
  angle: 0,
  strokeColor: DEFAULT_STROKE,
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  index: null,
  roundness:
    type === "rectangle" || type === "diamond"
      ? { type: 3 }
      : type === "arrow" || type === "line"
        ? { type: 2 }
        : null,
  seed: randomInt(),
  version: 1,
  versionNonce: randomInt(),
  isDeleted: false,
  boundElements: null,
  updated: Date.now(),
  link: null,
  locked: false,
});

const LINE_HEIGHT = 1.25;
/** About how wide a text is; the editor measures it exactly when it opens. */
const measure = (text: string, fontSize: number) => {
  const lines = text.split("\n");
  const longest = Math.max(1, ...lines.map((line) => [...line].length));
  return {
    width: Math.ceil(longest * fontSize * 0.55) + 4,
    height: Math.ceil(lines.length * fontSize * LINE_HEIGHT),
  };
};

const newText = (
  id: string,
  text: string,
  options: {
    readonly fontSize: number;
    readonly fontFamily: number;
    readonly containerId: string | null;
    readonly textAlign: string;
  },
): BoardElement => {
  const size = measure(text, options.fontSize);
  return {
    ...base(id, "text"),
    width: size.width,
    height: size.height,
    text,
    originalText: text,
    fontSize: options.fontSize,
    fontFamily: options.fontFamily,
    textAlign: options.textAlign,
    verticalAlign: options.containerId === null ? "top" : "middle",
    containerId: options.containerId,
    autoResize: true,
    lineHeight: LINE_HEIGHT,
  };
};

const center = (element: BoardElement) => ({
  x: element.x + element.width / 2,
  y: element.y + element.height / 2,
});

/** Where a ray from the shape's center toward (dx, dy) leaves its outline. */
const edge = (element: BoardElement, dx: number, dy: number) => {
  const half = { w: element.width / 2, h: element.height / 2 };
  const middle = center(element);
  if (dx === 0 && dy === 0) return middle;
  const t =
    element.type === "ellipse"
      ? 1 / Math.sqrt((dx / half.w) ** 2 + (dy / half.h) ** 2)
      : element.type === "diamond"
        ? 1 / (Math.abs(dx) / half.w + Math.abs(dy) / half.h)
        : Math.min(
            dx === 0 ? Number.POSITIVE_INFINITY : half.w / Math.abs(dx),
            dy === 0 ? Number.POSITIVE_INFINITY : half.h / Math.abs(dy),
          );
  return { x: middle.x + dx * t, y: middle.y + dy * t };
};

const ARROW_GAP = 8;

/** A straight arrow from one shape's outline to another's. */
const route = (from: BoardElement, to: BoardElement) => {
  const a = center(from);
  const b = center(to);
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const length = Math.hypot(dx, dy) || 1;
  const ux = dx / length;
  const uy = dy / length;
  const start = edge(from, dx, dy);
  const end = edge(to, -dx, -dy);
  const sx = start.x + ux * ARROW_GAP;
  const sy = start.y + uy * ARROW_GAP;
  const ex = end.x - ux * ARROW_GAP;
  const ey = end.y - uy * ARROW_GAP;
  return {
    x: sx,
    y: sy,
    width: Math.abs(ex - sx),
    height: Math.abs(ey - sy),
    points: [
      [0, 0],
      [ex - sx, ey - sy],
    ] as ReadonlyArray<BoardPoint>,
  };
};

const parsePoints = (text: string): ReadonlyArray<BoardPoint> =>
  text.split(";").map((pair) => {
    const [px, py] = pair.split(",");
    return [Number(px), Number(py)] as const;
  });

const pointsBox = (points: ReadonlyArray<BoardPoint>) => {
  const xs = points.map(([px]) => px);
  const ys = points.map(([, py]) => py);
  return {
    width: Math.max(...xs) - Math.min(...xs),
    height: Math.max(...ys) - Math.min(...ys),
  };
};

const ARROWHEADS = new Set([
  "arrow",
  "triangle",
  "dot",
  "bar",
  "circle",
  "diamond",
]);

/** The element's own fields an attribute sets. */
const applyAttribute = (
  key: string,
  text: string | undefined,
  element: BoardElement,
): Partial<BoardElement> => {
  switch (key) {
    case "x":
      return { x: Number(text ?? 0) };
    case "y":
      return { y: Number(text ?? 0) };
    case "w":
      return text === undefined ? {} : { width: Number(text) };
    case "h":
      return text === undefined ? {} : { height: Number(text) };
    case "angle":
      return { angle: (Number(text ?? 0) * Math.PI) / 180 };
    case "fill":
      return {
        backgroundColor:
          text === undefined || text === "none" ? "transparent" : text,
      };
    case "stroke":
      return { strokeColor: text ?? DEFAULT_STROKE };
    case "width":
      return { strokeWidth: Number(text ?? 2) };
    case "dash":
      return { strokeStyle: text ?? "solid" };
    case "rough":
      return { roughness: Number(text ?? 1) };
    case "opacity":
      return { opacity: Number(text ?? 100) };
    case "align":
      return { textAlign: text ?? "left" };
    case "head":
      return {
        endArrowhead:
          text === undefined
            ? element.type === "arrow"
              ? "arrow"
              : null
            : ARROWHEADS.has(text)
              ? text
              : null,
      };
    case "tail":
      return {
        startArrowhead:
          text !== undefined && ARROWHEADS.has(text) ? text : null,
      };
    case "points": {
      if (element.type === "freedraw" || text === undefined) return {};
      const points = parsePoints(text);
      return { points, ...pointsBox(points) };
    }
    case "frame":
      return { frameId: text ?? null };
    case "link":
      return { link: text ?? null };
    default:
      return {};
  }
};

/** Text attributes, which a container passes to its label. */
const TEXT_KEYS = new Set(["font", "size"]);

const textFields = (
  attributes: ReadonlyMap<string, string>,
  current?: BoardElement,
) => ({
  fontFamily: attributes.has("font")
    ? FONT_FAMILY[attributes.get("font") as keyof typeof FONT_FAMILY]
    : current !== undefined && fontName(current.fontFamily) === "hand"
      ? (current.fontFamily ?? FONT_FAMILY.hand)
      : FONT_FAMILY.hand,
  fontSize: attributes.has("size")
    ? Number(attributes.get("size"))
    : current?.fontSize !== undefined &&
        Math.round(current.fontSize) === DEFAULT_FONT_SIZE
      ? current.fontSize
      : DEFAULT_FONT_SIZE,
});

const DEFAULT_SIZE: Record<
  "rect" | "ellipse" | "diamond" | "frame",
  { w: number; h: number }
> = {
  rect: { w: 180, h: 80 },
  ellipse: { w: 170, h: 90 },
  diamond: { w: 190, h: 120 },
  frame: { w: 480, h: 320 },
};

/** A shape large enough for its label. */
const fitLabel = (kind: Kind, label: string | undefined, fontSize: number) => {
  const size = DEFAULT_SIZE[kind as keyof typeof DEFAULT_SIZE] ?? {
    w: 180,
    h: 80,
  };
  if (label === undefined || label === "" || kind === "frame") return size;
  const text = measure(label, fontSize);
  const grow = kind === "diamond" ? 1.8 : kind === "ellipse" ? 1.45 : 1;
  return {
    w: Math.max(size.w, Math.ceil(text.width * grow + 40)),
    h: Math.max(size.h, Math.ceil(text.height * grow + 32)),
  };
};

/**
 * Applies the agent's board text to `previous`: the elements it names, as
 * described, and everything else deleted. Untouched elements keep their
 * version, so people's editors see only what changed.
 */
export const boardFromText = (
  text: string,
  previous: BoardDocument,
): BoardTextResult => {
  const fail = (line: number, message: string): BoardTextResult => ({
    ok: false,
    message: `Board text line ${line} ${message}. Nothing was saved.`,
  });
  let background = previous.background;
  const parsed: ParsedLine[] = [];
  const seen = new Set<string>();
  for (const [index, source] of text.split(/\r\n|\r|\n/).entries()) {
    const line = index + 1;
    const trimmed = source.trim();
    if (/^board(\s|$)/.test(trimmed)) {
      const match = /^board(?:\s+background=(\S+))?\s*$/.exec(trimmed);
      if (match === null || (match[1] !== undefined && !COLOR.test(match[1])))
        return fail(line, "is a board line; it takes only background=#rrggbb");
      background = match[1] ?? "#ffffff";
      continue;
    }
    const result = parseLine(source, line);
    if (result === undefined) continue;
    if ("error" in result) return fail(line, result.error);
    let id = result.id;
    for (let copy = 2; result.autoId === true && seen.has(id); copy++)
      id = `${result.id}-${copy}`;
    if (id !== result.id) {
      seen.add(id);
      parsed.push({ ...result, id });
      continue;
    }
    if (seen.has(result.id))
      return fail(line, `reuses the id ${result.id}; each line needs its own`);
    seen.add(result.id);
    parsed.push(result);
  }

  const elements = new Map(
    previous.elements.map((element) => [element.id, element]),
  );
  const order = previous.elements.map(({ id }) => id);
  const labelIds = new Set(
    previous.elements.flatMap((element) =>
      element.type === "text" && element.containerId != null
        ? [element.id]
        : [],
    ),
  );
  for (const line of parsed) {
    const existing = elements.get(line.id);
    if (existing !== undefined && !existing.isDeleted) {
      const kind = kindOf(existing);
      const swappable =
        kind !== undefined && SHAPES.has(kind) && SHAPES.has(line.kind);
      if (kind !== line.kind && !swappable)
        return fail(
          line.line,
          `names ${line.id}, which is a ${kind ?? existing.type}, as a ${line.kind}`,
        );
      if (labelIds.has(line.id))
        return fail(line.line, `names ${line.id}, which is a shape's label`);
    } else if (DRAWN.has(line.kind))
      return fail(
        line.line,
        `creates a ${line.kind}; text cannot draw one. Lines for ${[...DRAWN].join(" and ")} only move or resize what people drew`,
      );
  }
  const named = new Map(parsed.map((line) => [line.id, line]));
  for (const line of parsed) {
    for (const end of [line.from, line.to]) {
      if (end === undefined) continue;
      const target = named.get(end);
      if (target === undefined)
        return fail(
          line.line,
          `points at ${end}, which no line names; name a shape or text on its own line`,
        );
      if (target.kind === "arrow" || target.kind === "line")
        return fail(line.line, `points at ${end}, which is a ${target.kind}`);
    }
    const frame = line.attributes.get("frame");
    if (frame !== undefined && named.get(frame)?.kind !== "frame")
      return fail(
        line.line,
        `puts it in frame ${frame}, which no frame line names`,
      );
  }

  const changed = new Set<string>();
  const set = (element: BoardElement) => {
    if (!elements.has(element.id)) order.push(element.id);
    elements.set(element.id, element);
    changed.add(element.id);
  };
  const remove = (id: string) => {
    const element = elements.get(id);
    if (element === undefined || element.isDeleted) return;
    set(touched(element, { isDeleted: true }));
  };

  // Deleted: every live listed element no line names, and its label.
  for (const element of previous.elements)
    if (listed(previous, element) && !named.has(element.id)) {
      remove(element.id);
      const label = labelOf(previous, element);
      if (label !== undefined) remove(label.id);
    }

  const unplaced: ParsedLine[] = [];
  const geometryChanged = new Set<string>();
  for (const line of parsed) {
    const existing = elements.get(line.id);
    const type = KIND_TYPE[line.kind];
    if (existing === undefined || existing.isDeleted) {
      // A new element: every given attribute, then the rest by default.
      const fresh = base(line.id, type);
      let element = fresh;
      for (const key of KIND_ATTRIBUTES[line.kind])
        if (!TEXT_KEYS.has(key))
          element = {
            ...element,
            ...applyAttribute(key, line.attributes.get(key), element),
          };
      const fields = textFields(line.attributes);
      if (line.kind === "text") {
        const size = measure(line.label ?? "", fields.fontSize);
        element = {
          ...newText(line.id, line.label ?? "", {
            ...fields,
            containerId: null,
            textAlign: line.attributes.get("align") ?? "left",
          }),
          ...element,
          type: "text",
          width: size.width,
          height: size.height,
          text: line.label ?? "",
          originalText: line.label ?? "",
          fontSize: fields.fontSize,
          fontFamily: fields.fontFamily,
          textAlign: line.attributes.get("align") ?? "left",
          verticalAlign: "top",
          containerId: null,
          autoResize: true,
          lineHeight: LINE_HEIGHT,
          roundness: null,
        };
      } else if (SHAPES.has(line.kind) || line.kind === "frame") {
        const size = fitLabel(line.kind, line.label, fields.fontSize);
        element = {
          ...element,
          width: line.attributes.has("w") ? element.width : size.w,
          height: line.attributes.has("h") ? element.height : size.h,
          ...(line.kind === "frame"
            ? { name: line.label ?? null, roughness: 0 }
            : {}),
        };
      } else if (line.kind === "arrow" || line.kind === "line") {
        element = {
          ...element,
          points: element.points ?? [
            [0, 0],
            [160, 0],
          ],
          ...(element.points === undefined ? { width: 160, height: 0 } : {}),
          lastCommittedPoint: null,
          startBinding: null,
          endBinding: null,
          startArrowhead: element.startArrowhead ?? null,
          endArrowhead:
            line.attributes.has("head") || line.kind === "line"
              ? (element.endArrowhead ?? null)
              : "arrow",
          ...(line.kind === "arrow" ? { elbowed: false } : {}),
        };
      }
      if (
        (SHAPES.has(line.kind) ||
          line.kind === "text" ||
          line.kind === "frame") &&
        !line.attributes.has("x") &&
        !line.attributes.has("y")
      )
        unplaced.push(line);
      set(element);
      geometryChanged.add(line.id);
      continue;
    }
    // An existing element: only the attributes whose text differs.
    const kind = kindOf(existing) as Kind;
    let changes: Partial<BoardElement> = kind !== line.kind ? { type } : {};
    for (const key of shownAttributes(existing, kind)) {
      if (TEXT_KEYS.has(key) && existing.type !== "text") continue;
      const now = ATTRIBUTES[key]?.read(existing, previous);
      const wanted = line.attributes.get(key);
      if (now === wanted) continue;
      if (key === "points" && kind === "freehand") continue;
      changes = { ...changes, ...applyAttribute(key, wanted, existing) };
      if (["x", "y", "w", "h", "angle", "points"].includes(key))
        geometryChanged.add(line.id);
    }
    if (line.kind === "text") {
      const fields = textFields(line.attributes, existing);
      const textChanged =
        line.label !== existing.text ||
        fields.fontFamily !== existing.fontFamily ||
        fields.fontSize !== existing.fontSize;
      if (textChanged) {
        const size = measure(line.label ?? "", fields.fontSize);
        changes = {
          ...changes,
          text: line.label ?? "",
          originalText: line.label ?? "",
          ...fields,
          width: size.width,
          height: size.height,
        };
      }
    }
    if (
      line.kind === "frame" &&
      (line.label ?? null) !== (existing.name ?? null)
    )
      changes = { ...changes, name: line.label ?? null };
    if (line.kind === "arrow") {
      const from = existing.startBinding?.elementId;
      const to = existing.endBinding?.elementId;
      if (line.from !== from || line.to !== to) geometryChanged.add(line.id);
    }
    if (Object.keys(changes).length > 0) set(touched(existing, changes));
  }

  // Lay out new shapes that came without a position: in rows below
  // everything else, each row one step further along the arrows.
  if (unplaced.length > 0) {
    const placedBoxes = [...elements.values()].filter(
      (element) =>
        !element.isDeleted &&
        element.containerId == null &&
        !unplaced.some((line) => line.id === element.id),
    );
    const left =
      placedBoxes.length === 0 ? 0 : Math.min(...placedBoxes.map(({ x }) => x));
    let top =
      placedBoxes.length === 0
        ? 0
        : Math.max(...placedBoxes.map(({ y, height }) => y + height)) + 100;
    const ids = new Set(unplaced.map(({ id }) => id));
    const rank = new Map<string, number>(unplaced.map(({ id }) => [id, 0]));
    const edges = parsed.flatMap((line) =>
      line.from !== undefined &&
      line.to !== undefined &&
      ids.has(line.from) &&
      ids.has(line.to)
        ? [[line.from, line.to] as const]
        : [],
    );
    // Longest path, bounded so a cycle cannot loop.
    for (let pass = 0; pass < unplaced.length; pass++)
      for (const [from, to] of edges)
        rank.set(
          to,
          Math.max(
            rank.get(to) ?? 0,
            Math.min((rank.get(from) ?? 0) + 1, unplaced.length),
          ),
        );
    const rows = new Map<number, ParsedLine[]>();
    for (const line of unplaced) {
      const row = rows.get(rank.get(line.id) ?? 0) ?? [];
      row.push(line);
      rows.set(rank.get(line.id) ?? 0, row);
    }
    for (const index of [...rows.keys()].sort((a, b) => a - b)) {
      const row = rows.get(index) ?? [];
      let x = left;
      let height = 0;
      for (const line of row) {
        const element = elements.get(line.id) as BoardElement;
        const placed = { ...element, x, y: top };
        elements.set(line.id, placed);
        x += element.width + 80;
        height = Math.max(height, element.height);
      }
      top += height + 90;
    }
  }

  // Labels: one bound text per labelled shape or arrow, centered on it.
  for (const line of parsed) {
    if (!(SHAPES.has(line.kind) || line.kind === "arrow")) continue;
    const container = elements.get(line.id) as BoardElement;
    const current = labelOf(
      { ...previous, elements: [...elements.values()] },
      container,
    );
    const wanted = line.label ?? "";
    if (wanted === "") {
      if (current !== undefined) remove(current.id);
      continue;
    }
    const fields = textFields(line.attributes, current);
    if (current === undefined) {
      const id = elements.has(`${line.id}-label`)
        ? randomId()
        : `${line.id}-label`;
      set(
        newText(id, wanted, {
          ...fields,
          containerId: line.id,
          textAlign: "center",
        }),
      );
      geometryChanged.add(line.id);
    } else if (
      current.text !== wanted ||
      current.fontFamily !== fields.fontFamily ||
      current.fontSize !== fields.fontSize
    ) {
      const size = measure(wanted, fields.fontSize);
      set(
        touched(current, {
          text: wanted,
          originalText: wanted,
          ...fields,
          width: size.width,
          height: size.height,
        }),
      );
      geometryChanged.add(line.id);
    }
  }

  // Arrows: bind each to its ends and re-route those whose ends moved.
  const live = () => [...elements.values()];
  for (const line of parsed) {
    if (line.kind !== "arrow") continue;
    const arrow = elements.get(line.id) as BoardElement;
    if (line.from === undefined && line.to === undefined) {
      if (arrow.startBinding != null || arrow.endBinding != null)
        set(touched(arrow, { startBinding: null, endBinding: null }));
      continue;
    }
    const from = line.from === undefined ? undefined : elements.get(line.from);
    const to = line.to === undefined ? undefined : elements.get(line.to);
    const moved =
      geometryChanged.has(line.id) ||
      (line.from !== undefined && geometryChanged.has(line.from)) ||
      (line.to !== undefined && geometryChanged.has(line.to));
    if (!moved) continue;
    const binding = (target: BoardElement | undefined) =>
      target === undefined
        ? null
        : { elementId: target.id, focus: 0, gap: ARROW_GAP };
    const path = from !== undefined && to !== undefined ? route(from, to) : {};
    set(
      touched(arrow, {
        ...path,
        startBinding: binding(from),
        endBinding: binding(to),
        elbowed: false,
      }),
    );
  }

  // Each label sits centered in its container.
  for (const element of live()) {
    if (element.isDeleted || element.containerId == null) continue;
    const container = elements.get(element.containerId);
    if (container === undefined || container.isDeleted) continue;
    if (!geometryChanged.has(container.id) && !changed.has(element.id))
      continue;
    const middle =
      container.type === "arrow" && (container.points?.length ?? 0) >= 2
        ? (() => {
            const points = container.points as ReadonlyArray<BoardPoint>;
            const [sx, sy] = points[0] as BoardPoint;
            const [ex, ey] = points.at(-1) as BoardPoint;
            return {
              x: container.x + (sx + ex) / 2,
              y: container.y + (sy + ey) / 2,
            };
          })()
        : center(container);
    const x = middle.x - element.width / 2;
    const y = middle.y - element.height / 2;
    if (Math.abs(x - element.x) > 0.5 || Math.abs(y - element.y) > 0.5)
      set(
        changed.has(element.id)
          ? { ...element, x, y }
          : touched(element, { x, y }),
      );
  }

  // Each shape lists its label and the arrows bound to it.
  for (const element of live()) {
    if (
      element.isDeleted ||
      (element.type === "text" && element.containerId != null)
    )
      continue;
    const wanted = live()
      .filter(
        (other) =>
          !other.isDeleted &&
          ((other.type === "text" && other.containerId === element.id) ||
            (other.type === "arrow" &&
              (other.startBinding?.elementId === element.id ||
                other.endBinding?.elementId === element.id))),
      )
      .map((other) => ({
        id: other.id,
        type: other.type === "text" ? ("text" as const) : ("arrow" as const),
      }));
    const key = (list: ReadonlyArray<{ id: string; type: string }>) =>
      list
        .map(({ id, type }) => `${type}:${id}`)
        .sort()
        .join(",");
    if (key(element.boundElements ?? []) === key(wanted)) continue;
    const next = { boundElements: wanted.length === 0 ? null : wanted };
    set(
      changed.has(element.id)
        ? { ...element, ...next }
        : touched(element, next),
    );
  }

  return {
    ok: true,
    board: {
      ...previous,
      background,
      elements: order.map((id) => elements.get(id) as BoardElement),
    },
  };
};

/** The elements text shows, so callers can count them. */
export const boardTextElementCount = (board: BoardDocument) =>
  liveBoardElements(board).filter((element) => listed(board, element)).length;
