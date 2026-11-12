import { describe, expect, it } from "vitest";
import {
  type BoardDocument,
  type BoardElement,
  emptyBoard,
  liveBoardElements,
} from "./board.js";
import { boardFromText, boardToText } from "./board-text.js";

/*
 * How the agent's board text can go wrong, written before the codec:
 *
 * 1. Writing back exactly what was read changes something (a version bump
 *    makes every person's editor rebase for nothing).
 * 2. A freehand stroke or image, which text cannot describe, loses its points
 *    or file when the agent edits another line.
 * 3. Removing a line leaves the shape, or leaves its label behind.
 * 4. Changing a label rewrites the shape instead of its label.
 * 5. A shape written without a position lands on top of existing shapes.
 * 6. An arrow to an unknown id saves a dangling arrow.
 * 7. A malformed line saves part of the board, or errs without saying where.
 * 8. Quotes, backslashes, and line breaks in labels do not round-trip.
 * 9. The agent "creates" a freehand stroke or image it cannot draw.
 * 10. Moving a shape leaves its arrows pointing at the old place.
 * 11. A misspelled attribute is silently ignored.
 * 12. Two lines with one id silently merge.
 * 13. A model writes what it read in the tool's description: an arrow with
 *     no id (`arrow a -> b`), or a label in the brackets that mark it
 *     optional (`["yes"]`), and the board is refused.
 */

const build = (text: string, previous: BoardDocument = emptyBoard()) => {
  const result = boardFromText(text, previous);
  if (!result.ok) throw new Error(result.message);
  return result.board;
};

const byId = (board: BoardDocument, id: string) =>
  board.elements.find((element) => element.id === id) as BoardElement;

const freehand = (): BoardElement => ({
  id: "stroke1",
  type: "freedraw",
  x: 400,
  y: 400,
  width: 30,
  height: 20,
  angle: 0,
  strokeColor: "#1e1e1e",
  backgroundColor: "transparent",
  fillStyle: "solid",
  strokeWidth: 2,
  strokeStyle: "solid",
  roughness: 1,
  opacity: 100,
  groupIds: [],
  frameId: null,
  roundness: null,
  seed: 1,
  version: 7,
  versionNonce: 3,
  isDeleted: false,
  boundElements: null,
  updated: 1,
  link: null,
  locked: false,
  points: [
    [0, 0],
    [10, 5],
    [30, 20],
  ],
  pressures: [],
  simulatePressure: true,
  lastCommittedPoint: null,
});

describe("board text", () => {
  const flow = [
    'rect login "Log in" x=0 y=0 w=180 h=80 fill=#a5d8ff',
    'diamond ok "Valid?" x=300 y=0 w=180 h=110',
    'arrow go login -> ok "submit"',
    'text note "Rate limit: 5/min" x=0 y=200',
  ].join("\n");

  it("round-trips without changing anything (1)", () => {
    const board = build(flow);
    const text = boardToText(board);
    const again = build(text, board);
    expect(again.elements).toEqual(board.elements);
    expect(boardToText(again)).toBe(text);
  });

  it("keeps freehand strokes it cannot describe (2, 9)", () => {
    const board = {
      ...build(flow),
      elements: [...build(flow).elements, freehand()],
    };
    const text = boardToText(board);
    expect(text).toMatch(/^freehand stroke1 x=400 y=400 w=30 h=20 points=3$/m);
    const edited = build(text.replace('"Log in"', '"Sign in"'), board);
    expect(byId(edited, "stroke1")).toEqual(freehand());
    const created = boardFromText("freehand f2 x=0 y=0", emptyBoard());
    expect(created.ok).toBe(false);
  });

  it("deletes a removed line's shape and its label (3)", () => {
    const board = build(flow);
    const label = byId(board, "login").boundElements?.find(
      (bound) => bound.type === "text",
    );
    const without = build(
      boardToText(board)
        .split("\n")
        .filter(
          (line) =>
            !line.startsWith("rect login") && !line.startsWith("arrow go"),
        )
        .join("\n"),
      board,
    );
    expect(byId(without, "login").isDeleted).toBe(true);
    expect(byId(without, label?.id as string).isDeleted).toBe(true);
    expect(liveBoardElements(without).some(({ id }) => id === "login")).toBe(
      false,
    );
  });

  it("changes only the label when the label changes (4)", () => {
    const board = build(flow);
    const edited = build(
      boardToText(board).replace('"Log in"', '"Sign in"'),
      board,
    );
    const label = (doc: BoardDocument) =>
      doc.elements.find(
        (element) => element.type === "text" && element.containerId === "login",
      ) as BoardElement;
    expect(label(edited).text).toBe("Sign in");
    expect(label(edited).version).toBeGreaterThan(label(board).version);
    expect(byId(edited, "ok")).toEqual(byId(board, "ok"));
  });

  it("places new shapes clear of existing ones (5)", () => {
    const board = build(flow);
    const added = build(`${boardToText(board)}\nrect extra "New step"`, board);
    const extra = byId(added, "extra");
    for (const other of liveBoardElements(board)) {
      if (other.containerId != null) continue;
      const overlaps =
        extra.x < other.x + other.width &&
        extra.x + extra.width > other.x &&
        extra.y < other.y + other.height &&
        extra.y + extra.height > other.y;
      expect(overlaps, `overlaps ${other.id}`).toBe(false);
    }
  });

  it("refuses arrows to unknown shapes, naming the line (6, 7)", () => {
    const result = boardFromText(
      'rect a "A"\narrow x a -> nowhere',
      emptyBoard(),
    );
    expect(result).toMatchObject({ ok: false });
    if (!result.ok) expect(result.message).toMatch(/line 2/);
    const malformed = boardFromText('rect a "A" x=', emptyBoard());
    expect(malformed.ok).toBe(false);
    if (!malformed.ok) expect(malformed.message).toMatch(/line 1/);
  });

  it("round-trips quotes, backslashes, and line breaks (8)", () => {
    const board = build('rect a "Say \\"hi\\"\\nC:\\\\dir"');
    const label = board.elements.find((element) => element.type === "text");
    expect(label?.text).toBe('Say "hi"\nC:\\dir');
    expect(build(boardToText(board), board).elements).toEqual(board.elements);
  });

  it("re-routes arrows when a shape moves (10)", () => {
    const board = build(flow);
    const moved = build(
      boardToText(board).replace(
        'diamond ok "Valid?" x=300 y=0',
        'diamond ok "Valid?" x=300 y=400',
      ),
      board,
    );
    const before = byId(board, "go");
    const after = byId(moved, "go");
    expect(after.version).toBeGreaterThan(before.version);
    const end = (after.points as ReadonlyArray<readonly [number, number]>).at(
      -1,
    ) as readonly [number, number];
    expect(after.y + end[1]).toBeGreaterThan(300);
  });

  it("refuses unknown attributes and duplicate ids (11, 12)", () => {
    expect(boardFromText('rect a "A" colour=red', emptyBoard()).ok).toBe(false);
    expect(boardFromText('rect a "A"\nellipse a "B"', emptyBoard()).ok).toBe(
      false,
    );
  });

  it("takes an arrow without an id and a label in brackets, and reads them back stably (13)", () => {
    const board = build(
      'rect a "A"\nrect b "B"\narrow a -> b ["go"]\narrow a -> b',
    );
    const arrows = board.elements.filter(({ type }) => type === "arrow");
    expect(arrows.map(({ id }) => id)).toEqual(["a-to-b", "a-to-b-2"]);
    expect(
      board.elements.find(({ containerId }) => containerId === "a-to-b")?.text,
    ).toBe("go");
    const text = boardToText(board);
    expect(text).toMatch(/^arrow a-to-b a -> b "go"$/m);
    expect(build(text, board).elements).toEqual(board.elements);
  });
});
