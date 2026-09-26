import type * as React from "react";
import { useWaveformCanvas } from "../hooks/use-waveform-canvas.js";
import { cn } from "../utils.js";

export type WaveformProps = React.HTMLAttributes<HTMLDivElement> & {
  readonly data?: ReadonlyArray<number>;
  readonly barWidth?: number;
  readonly barHeight?: number;
  readonly barGap?: number;
  readonly barRadius?: number;
  readonly barColor?: string;
  readonly fadeEdges?: boolean;
  readonly fadeWidth?: number;
  readonly height?: string | number;
};

// Adapted from ElevenLabs UI's MIT-licensed Waveform component.
export function Waveform({
  data = [],
  barWidth = 3,
  barHeight = 3,
  barGap = 2,
  barRadius = 2,
  barColor,
  fadeEdges = true,
  fadeWidth = 24,
  height = 24,
  className,
  style,
  ...props
}: WaveformProps) {
  const { containerRef } = useWaveformCanvas({
    data,
    barWidth,
    baseBarHeight: barHeight,
    barGap,
    barRadius,
    barColor,
    fadeEdges,
    fadeWidth,
  });
  return (
    <div
      className={cn("waveform", className)}
      ref={containerRef}
      style={{
        ...style,
        height: typeof height === "number" ? `${height}px` : height,
      }}
      {...props}
    >
      <canvas />
    </div>
  );
}
