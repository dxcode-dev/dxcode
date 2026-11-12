import {
  type BoardDocument,
  type BoardElement,
  type BoardPoint,
  liveBoardElements,
} from "@dx/domain";
import type * as React from "react";
import { useTheme } from "../../../shared/theme/theme-provider.js";

/**
 * A board drawn as plain SVG, without the editor: a document's embed, the
 * board while its flag is off, and anything else that only shows one. Clean
 * lines, not the editor's hand-drawn strokes, at a fraction of its weight.
 */

const PADDING = 24;

const FONTS: Record<number, string> = {
  1: '"Virgil", "Excalifont", system-ui, sans-serif',
  2: "Helvetica, Arial, sans-serif",
  3: '"Cascadia", ui-monospace, monospace',
  5: '"Excalifont", system-ui, sans-serif',
  6: '"Nunito", system-ui, sans-serif',
  7: '"Lilita One", system-ui, sans-serif',
  8: '"Comic Shanns", ui-monospace, monospace',
  9: '"Liberation Sans", Arial, sans-serif',
};

const DASH: Record<string, string | undefined> = {
  dashed: "8 6",
  dotted: "2 5",
};

/** The box every live element covers, in scene coordinates. */
const boardBounds = (elements: ReadonlyArray<BoardElement>) => {
  let minX = Number.POSITIVE_INFINITY;
  let minY = Number.POSITIVE_INFINITY;
  let maxX = Number.NEGATIVE_INFINITY;
  let maxY = Number.NEGATIVE_INFINITY;
  for (const element of elements) {
    const points =
      element.points !== undefined && element.points.length > 0
        ? element.points.map(
            ([px, py]) => [element.x + px, element.y + py] as const,
          )
        : [
            [element.x, element.y] as const,
            [element.x + element.width, element.y + element.height] as const,
          ];
    for (const [px, py] of points) {
      minX = Math.min(minX, px);
      minY = Math.min(minY, py);
      maxX = Math.max(maxX, px);
      maxY = Math.max(maxY, py);
    }
  }
  return Number.isFinite(minX)
    ? { minX, minY, width: maxX - minX, height: maxY - minY }
    : { minX: 0, minY: 0, width: 0, height: 0 };
};

const paint = (element: BoardElement) => ({
  stroke: element.strokeColor === "transparent" ? "none" : element.strokeColor,
  strokeWidth: element.strokeWidth ?? 2,
  strokeDasharray: DASH[element.strokeStyle ?? "solid"],
  strokeLinecap: "round" as const,
  strokeLinejoin: "round" as const,
  opacity: (element.opacity ?? 100) / 100,
});

const fill = (element: BoardElement) =>
  element.backgroundColor === undefined ||
  element.backgroundColor === "transparent"
    ? "none"
    : element.backgroundColor;

const rotate = (element: BoardElement) =>
  element.angle === undefined || element.angle === 0
    ? undefined
    : `rotate(${(element.angle * 180) / Math.PI} ${element.x + element.width / 2} ${element.y + element.height / 2})`;

const absolute = (element: BoardElement) =>
  (element.points ?? []).map(
    ([px, py]) => [element.x + px, element.y + py] as BoardPoint,
  );

/** A filled triangle at the end of a line, pointing along its last segment. */
const arrowhead = (
  tip: BoardPoint,
  from: BoardPoint,
  size: number,
  color: string,
  key: string,
) => {
  const angle = Math.atan2(tip[1] - from[1], tip[0] - from[0]);
  const spread = Math.PI / 7;
  const left: BoardPoint = [
    tip[0] - size * Math.cos(angle - spread),
    tip[1] - size * Math.sin(angle - spread),
  ];
  const right: BoardPoint = [
    tip[0] - size * Math.cos(angle + spread),
    tip[1] - size * Math.sin(angle + spread),
  ];
  return (
    <polyline
      key={key}
      points={`${left.join(",")} ${tip.join(",")} ${right.join(",")}`}
      fill="none"
      stroke={color}
      strokeWidth={2}
      strokeLinecap="round"
      strokeLinejoin="round"
    />
  );
};

const textElement = (element: BoardElement) => {
  const fontSize = element.fontSize ?? 20;
  const lineHeight = (element.lineHeight ?? 1.25) * fontSize;
  const lines = (element.text ?? "").split("\n");
  const align = element.textAlign ?? "left";
  const x =
    align === "center"
      ? element.x + element.width / 2
      : align === "right"
        ? element.x + element.width
        : element.x;
  const top =
    element.verticalAlign === "middle"
      ? element.y + element.height / 2 - (lines.length * lineHeight) / 2
      : element.y;
  return (
    <text
      key={element.id}
      x={x}
      y={top}
      fill={element.strokeColor ?? "#1e1e1e"}
      opacity={(element.opacity ?? 100) / 100}
      fontSize={fontSize}
      fontFamily={FONTS[element.fontFamily ?? 5] ?? FONTS[5]}
      textAnchor={
        align === "center" ? "middle" : align === "right" ? "end" : "start"
      }
      dominantBaseline="text-before-edge"
      transform={rotate(element)}
    >
      {lines.map((line, index) => (
        <tspan
          // Lines never reorder; their position is their identity.
          // biome-ignore lint/suspicious/noArrayIndexKey: see above
          key={index}
          x={x}
          dy={index === 0 ? 0 : lineHeight}
        >
          {line === "" ? " " : line}
        </tspan>
      ))}
    </text>
  );
};

const draw = (element: BoardElement, board: BoardDocument): React.ReactNode => {
  const style = paint(element);
  const transform = rotate(element);
  switch (element.type) {
    case "rectangle": {
      const radius =
        element.roundness == null
          ? 0
          : Math.min(element.width, element.height) * 0.12;
      return (
        <rect
          key={element.id}
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          rx={radius}
          fill={fill(element)}
          transform={transform}
          {...style}
        />
      );
    }
    case "ellipse":
      return (
        <ellipse
          key={element.id}
          cx={element.x + element.width / 2}
          cy={element.y + element.height / 2}
          rx={element.width / 2}
          ry={element.height / 2}
          fill={fill(element)}
          transform={transform}
          {...style}
        />
      );
    case "diamond": {
      const { x, y, width: w, height: h } = element;
      return (
        <polygon
          key={element.id}
          points={`${x + w / 2},${y} ${x + w},${y + h / 2} ${x + w / 2},${y + h} ${x},${y + h / 2}`}
          fill={fill(element)}
          transform={transform}
          {...style}
        />
      );
    }
    case "line":
    case "arrow":
    case "freedraw": {
      const points = absolute(element);
      if (points.length < 2) return null;
      const path = (
        <polyline
          key={element.id}
          points={points.map((point) => point.join(",")).join(" ")}
          fill={
            element.type === "line" &&
            points.length > 2 &&
            points[0]?.join() === points.at(-1)?.join()
              ? fill(element)
              : "none"
          }
          transform={transform}
          {...style}
          strokeWidth={
            element.type === "freedraw"
              ? (element.strokeWidth ?? 2) * 1.6
              : style.strokeWidth
          }
        />
      );
      const color = element.strokeColor ?? "#1e1e1e";
      const size = 10 + (element.strokeWidth ?? 2) * 2;
      return [
        path,
        element.endArrowhead == null
          ? null
          : arrowhead(
              points.at(-1) as BoardPoint,
              points.at(-2) as BoardPoint,
              size,
              color,
              `${element.id}:end`,
            ),
        element.startArrowhead == null
          ? null
          : arrowhead(
              points[0] as BoardPoint,
              points[1] as BoardPoint,
              size,
              color,
              `${element.id}:start`,
            ),
      ];
    }
    case "text":
      return textElement(element);
    case "image": {
      const file =
        element.fileId == null ? undefined : board.files[element.fileId];
      return file === undefined ? (
        <rect
          key={element.id}
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          fill="#f1f3f5"
          stroke="#ced4da"
        />
      ) : (
        <image
          key={element.id}
          href={file.url}
          x={element.x}
          y={element.y}
          width={element.width}
          height={element.height}
          preserveAspectRatio="none"
          transform={transform}
        />
      );
    }
    case "frame":
    case "magicframe":
      return (
        <g key={element.id}>
          <rect
            x={element.x}
            y={element.y}
            width={element.width}
            height={element.height}
            rx={8}
            fill="none"
            stroke="#adb5bd"
            strokeWidth={1}
          />
          {element.name == null || element.name === "" ? null : (
            <text
              x={element.x}
              y={element.y - 6}
              fontSize={14}
              fill="#868e96"
              fontFamily="system-ui, sans-serif"
            >
              {element.name}
            </text>
          )}
        </g>
      );
    default:
      return null;
  }
};

/**
 * The board as an SVG image that scales to its box, in the app's appearance:
 * on the default white canvas it shows dx's surface, and in dark it takes the
 * editor's own dark transform (inverted, hue kept; images left as they are).
 */
export function BoardPreview({
  board,
  label,
  className,
}: {
  readonly board: BoardDocument;
  readonly label: string;
  readonly className?: string;
}) {
  const { resolvedAppearance } = useTheme();
  const elements = liveBoardElements(board);
  const bounds = boardBounds(elements);
  const plain = board.background.toLowerCase() === "#ffffff";
  const width = Math.max(bounds.width, 1) + PADDING * 2;
  const height = Math.max(bounds.height, 1) + PADDING * 2;
  return (
    <svg
      className={className}
      role="img"
      aria-label={label}
      viewBox={`${bounds.minX - PADDING} ${bounds.minY - PADDING} ${width} ${height}`}
      preserveAspectRatio="xMidYMid meet"
      data-appearance={resolvedAppearance}
      style={{ background: plain ? "transparent" : board.background }}
    >
      {elements.map((element) => draw(element, board))}
    </svg>
  );
}
