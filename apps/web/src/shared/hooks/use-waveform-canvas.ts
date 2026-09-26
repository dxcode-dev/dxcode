import * as React from "react";

export const useWaveformCanvas = ({
  data,
  barWidth,
  baseBarHeight,
  barGap,
  barRadius,
  barColor,
  fadeEdges,
  fadeWidth,
}: {
  readonly data: ReadonlyArray<number>;
  readonly barWidth: number;
  readonly baseBarHeight: number;
  readonly barGap: number;
  readonly barRadius: number;
  readonly barColor?: string;
  readonly fadeEdges: boolean;
  readonly fadeWidth: number;
}) => {
  const canvasRef = React.useRef<HTMLCanvasElement | null>(null);
  const containerRef = React.useRef<HTMLDivElement | null>(null);
  const render = React.useCallback(() => {
    const container = containerRef.current;
    const canvas = canvasRef.current;
    if (!container || !canvas) return;

    const rect = container.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;
    canvas.width = rect.width * dpr;
    canvas.height = rect.height * dpr;
    canvas.style.width = `${rect.width}px`;
    canvas.style.height = `${rect.height}px`;
    const context = canvas.getContext("2d");
    if (!context) return;
    context.scale(dpr, dpr);
    context.clearRect(0, 0, rect.width, rect.height);
    const style = getComputedStyle(canvas);
    const color =
      (barColor === "currentColor" ? style.color : barColor) ||
      style.getPropertyValue("--foreground") ||
      "#000";
    const count = Math.floor(rect.width / (barWidth + barGap));
    const center = rect.height / 2;
    const startIndex = Math.max(0, data.length - count);
    for (let index = 0; index < count; index += 1) {
      const dataIndex = startIndex + index;
      const value = data[dataIndex] || 0;
      const renderedHeight = Math.max(baseBarHeight, value * rect.height * 0.8);
      const x = index * (barWidth + barGap);
      const y = center - renderedHeight / 2;
      context.fillStyle = color;
      context.globalAlpha = 0.3 + value * 0.7;
      context.beginPath();
      context.roundRect(x, y, barWidth, renderedHeight, barRadius);
      context.fill();
    }
    if (fadeEdges && fadeWidth > 0 && rect.width > 0) {
      const gradient = context.createLinearGradient(0, 0, rect.width, 0);
      const fade = Math.min(0.2, fadeWidth / rect.width);
      gradient.addColorStop(0, "rgba(255,255,255,1)");
      gradient.addColorStop(fade, "rgba(255,255,255,0)");
      gradient.addColorStop(1 - fade, "rgba(255,255,255,0)");
      gradient.addColorStop(1, "rgba(255,255,255,1)");
      context.globalCompositeOperation = "destination-out";
      context.fillStyle = gradient;
      context.fillRect(0, 0, rect.width, rect.height);
      context.globalCompositeOperation = "source-over";
    }
    context.globalAlpha = 1;
  }, [
    data,
    barWidth,
    baseBarHeight,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
  ]);

  const renderRef = React.useRef(render);
  React.useLayoutEffect(() => {
    renderRef.current = render;
    render();
  }, [render]);

  const attachContainer = React.useCallback(
    (container: HTMLDivElement | null) => {
      containerRef.current = container;
      canvasRef.current = container?.querySelector("canvas") ?? null;
      return () => {
        containerRef.current = null;
        canvasRef.current = null;
      };
    },
    [],
  );

  React.useLayoutEffect(() => {
    const container = containerRef.current;
    if (!container) return;
    const observer = new ResizeObserver(() => renderRef.current());
    observer.observe(container);
    renderRef.current();
    return () => observer.disconnect();
  }, []);

  return { containerRef: attachContainer };
};
