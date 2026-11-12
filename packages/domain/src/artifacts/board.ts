/**
 * A drawing board: an artifact whose body is a scene of shapes, arrows,
 * text, freehand strokes, and images. The body is JSON in Excalidraw's
 * element format, without view state (zoom, scroll, selection), so the
 * editor loads it as is and a merge can compare shapes one by one: every
 * element carries `version`, raised on each change, and `versionNonce`,
 * which breaks a tie between two people's changes the same way everywhere.
 *
 * The server never runs the editor. It checks a body's shape and size, and
 * reads and writes boards for the agent through `board-text.ts`.
 */

export const BOARD_BODY_TYPE = "dx-board";
export const BOARD_BODY_VERSION = 1;
/** The most elements a board holds, deleted ones (tombstones) included. */
export const BOARD_MAX_ELEMENTS = 20_000;

/** Element types the editor draws. */
export const BOARD_ELEMENT_TYPES = [
  "rectangle",
  "ellipse",
  "diamond",
  "text",
  "arrow",
  "line",
  "freedraw",
  "image",
  "frame",
  "magicframe",
  "embeddable",
  "iframe",
  "selection",
] as const;

export type BoardElementType = (typeof BOARD_ELEMENT_TYPES)[number];

export type BoardPoint = readonly [number, number];

export interface BoardBinding {
  readonly elementId: string;
  readonly focus: number;
  readonly gap: number;
  readonly [key: string]: unknown;
}

/**
 * One element. Only the fields dx reads are typed; the editor's other fields
 * are kept as they are.
 */
export interface BoardElement {
  readonly id: string;
  readonly type: string;
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  readonly angle?: number;
  readonly version: number;
  readonly versionNonce: number;
  readonly isDeleted: boolean;
  readonly index?: string | null;
  readonly strokeColor?: string;
  readonly backgroundColor?: string;
  readonly strokeStyle?: string;
  readonly strokeWidth?: number;
  readonly fillStyle?: string;
  readonly roughness?: number;
  readonly opacity?: number;
  readonly groupIds?: ReadonlyArray<string>;
  readonly frameId?: string | null;
  readonly boundElements?: ReadonlyArray<{
    readonly id: string;
    readonly type: "text" | "arrow";
  }> | null;
  readonly containerId?: string | null;
  readonly text?: string;
  readonly originalText?: string;
  readonly fontSize?: number;
  readonly fontFamily?: number;
  readonly textAlign?: string;
  readonly verticalAlign?: string;
  readonly lineHeight?: number;
  readonly points?: ReadonlyArray<BoardPoint>;
  readonly startBinding?: BoardBinding | null;
  readonly endBinding?: BoardBinding | null;
  readonly startArrowhead?: string | null;
  readonly endArrowhead?: string | null;
  readonly fileId?: string | null;
  readonly name?: string | null;
  readonly link?: string | null;
  readonly [key: string]: unknown;
}

/** An image a board shows, stored with the Thread like a document's images. */
export interface BoardFile {
  readonly mimeType: string;
  readonly url: string;
}

export interface BoardDocument {
  readonly type: typeof BOARD_BODY_TYPE;
  readonly version: typeof BOARD_BODY_VERSION;
  readonly elements: ReadonlyArray<BoardElement>;
  /** Images by the editor's file id. */
  readonly files: Readonly<Record<string, BoardFile>>;
  /** The canvas color. */
  readonly background: string;
}

export const emptyBoard = (): BoardDocument => ({
  type: BOARD_BODY_TYPE,
  version: BOARD_BODY_VERSION,
  elements: [],
  files: {},
  background: "#ffffff",
});

/** Elements a person sees: not deleted. */
export const liveBoardElements = (board: BoardDocument) =>
  board.elements.filter((element) => !element.isDeleted);

/** The body as stored: compact JSON. */
export const serializeBoard = (board: BoardDocument) => JSON.stringify(board);

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const finite = (value: unknown) =>
  typeof value === "number" && Number.isFinite(value);

const ID = /^[A-Za-z0-9_-]{1,128}$/;
const KNOWN_TYPES = new Set<string>(BOARD_ELEMENT_TYPES);

export type BoardParseResult =
  | { readonly ok: true; readonly board: BoardDocument }
  | { readonly ok: false; readonly message: string };

/**
 * Reads a stored or submitted body. An empty body is an empty board, so a
 * board created without content opens blank. Checks the structure dx relies
 * on, never the editor's styling fields.
 */
export const parseBoard = (body: string): BoardParseResult => {
  if (body.trim() === "") return { ok: true, board: emptyBoard() };
  let input: unknown;
  try {
    input = JSON.parse(body);
  } catch {
    return { ok: false, message: "A board body is JSON." };
  }
  if (
    !isRecord(input) ||
    input.type !== BOARD_BODY_TYPE ||
    input.version !== BOARD_BODY_VERSION ||
    !Array.isArray(input.elements)
  )
    return {
      ok: false,
      message: `A board body is {"type":"${BOARD_BODY_TYPE}","version":${BOARD_BODY_VERSION},"elements":[…]}.`,
    };
  if (input.elements.length > BOARD_MAX_ELEMENTS)
    return {
      ok: false,
      message: `A board holds at most ${BOARD_MAX_ELEMENTS} elements.`,
    };
  const ids = new Set<string>();
  for (const [index, element] of input.elements.entries()) {
    if (
      !isRecord(element) ||
      typeof element.id !== "string" ||
      !ID.test(element.id) ||
      typeof element.type !== "string" ||
      !KNOWN_TYPES.has(element.type) ||
      !finite(element.x) ||
      !finite(element.y) ||
      !finite(element.width) ||
      !finite(element.height) ||
      !Number.isSafeInteger(element.version) ||
      !Number.isSafeInteger(element.versionNonce) ||
      typeof element.isDeleted !== "boolean"
    )
      return { ok: false, message: `Board element ${index} is malformed.` };
    if (ids.has(element.id))
      return {
        ok: false,
        message: `Board element id ${element.id} appears twice.`,
      };
    ids.add(element.id);
  }
  const files: Record<string, BoardFile> = {};
  if (input.files !== undefined) {
    if (!isRecord(input.files))
      return { ok: false, message: "Board files are an object." };
    for (const [id, file] of Object.entries(input.files)) {
      if (
        !ID.test(id) ||
        !isRecord(file) ||
        typeof file.mimeType !== "string" ||
        typeof file.url !== "string" ||
        file.url.length > 2048 ||
        // Images are stored with the Thread; a board never carries a
        // data URL, which would bloat every revision.
        !(file.url.startsWith("/") || file.url.startsWith("https://"))
      )
        return { ok: false, message: `Board file ${id} is malformed.` };
      files[id] = { mimeType: file.mimeType, url: file.url };
    }
  }
  const background =
    typeof input.background === "string" &&
    /^(#[0-9a-fA-F]{3,8}|transparent)$/.test(input.background)
      ? input.background
      : "#ffffff";
  return {
    ok: true,
    board: {
      type: BOARD_BODY_TYPE,
      version: BOARD_BODY_VERSION,
      elements: input.elements as ReadonlyArray<BoardElement>,
      files,
      background,
    },
  };
};

/**
 * What a board says in words: its labels and text, in drawing order. Search,
 * notifications, and anything that reads an artifact as text use this.
 */
export const boardPlainText = (board: BoardDocument) =>
  liveBoardElements(board)
    .flatMap((element) =>
      typeof element.text === "string" && element.text.trim() !== ""
        ? [element.text]
        : [],
    )
    .join("\n");

/** A short name for a shape, as a comment shows what it sits on. */
export const boardElementLabel = (
  board: BoardDocument,
  elementId: string,
): string | undefined => {
  const element = board.elements.find(({ id }) => id === elementId);
  if (element === undefined || element.isDeleted) return undefined;
  const label =
    element.type === "text"
      ? element.text
      : board.elements.find(
          (candidate) =>
            candidate.containerId === element.id && !candidate.isDeleted,
        )?.text;
  const kind = BOARD_ELEMENT_NAMES[element.type] ?? "Shape";
  const text = label?.replace(/\s+/g, " ").trim();
  return text === undefined || text === ""
    ? kind
    : `${kind}: ${text.length > 80 ? `${text.slice(0, 79)}…` : text}`;
};

const BOARD_ELEMENT_NAMES: Record<string, string> = {
  rectangle: "Rectangle",
  ellipse: "Ellipse",
  diamond: "Diamond",
  text: "Text",
  arrow: "Arrow",
  line: "Line",
  freedraw: "Drawing",
  image: "Image",
  frame: "Frame",
};
