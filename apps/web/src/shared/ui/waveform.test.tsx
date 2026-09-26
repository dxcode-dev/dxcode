// @vitest-environment happy-dom

import * as React from "react";
import { createRoot } from "react-dom/client";
import { expect, it, vi } from "vitest";
import { Waveform } from "./waveform.js";

const observe = vi.fn();
const disconnect = vi.fn();
const createObserver = vi.fn();
Object.assign(globalThis, {
  IS_REACT_ACT_ENVIRONMENT: true,
  ResizeObserver: class {
    constructor(private readonly callback: () => void) {
      createObserver();
    }
    observe() {
      observe();
      this.callback();
    }
    disconnect() {
      disconnect();
    }
  },
});

it("draws the newest history sample in a narrow live waveform", async () => {
  const heights: number[] = [];
  const context = {
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fill: vi.fn(),
    fillRect: vi.fn(),
    roundRect: vi.fn((_x: number, _y: number, _width: number, height: number) =>
      heights.push(height),
    ),
    scale: vi.fn(),
    fillStyle: "",
    globalAlpha: 1,
    globalCompositeOperation: "source-over",
  };
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue(
    context as unknown as CanvasRenderingContext2D,
  );
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 40,
    height: 24,
  } as DOMRect);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  const history = [...Array<number>(95).fill(0), 1];

  await React.act(() =>
    root.render(
      <Waveform data={history} fadeEdges={false} style={{ width: "12px" }} />,
    ),
  );

  expect(Math.max(...heights)).toBeGreaterThan(10);
  const waveform = container.firstElementChild as HTMLElement;
  expect(waveform.style.width).toBe("12px");
  expect(waveform.style.height).toBe("24px");
  await React.act(() => root.unmount());
});

it("keeps one resize observer while waveform data changes", async () => {
  createObserver.mockClear();
  observe.mockClear();
  disconnect.mockClear();
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    beginPath: vi.fn(),
    clearRect: vi.fn(),
    createLinearGradient: vi.fn(() => ({ addColorStop: vi.fn() })),
    fill: vi.fn(),
    fillRect: vi.fn(),
    roundRect: vi.fn(),
    scale: vi.fn(),
  } as unknown as CanvasRenderingContext2D);
  vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockReturnValue({
    width: 40,
    height: 24,
  } as DOMRect);
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);

  await React.act(() => root.render(<Waveform data={[0]} />));
  await React.act(() => root.render(<Waveform data={[0, 1]} />));

  expect(createObserver).toHaveBeenCalledOnce();
  expect(observe).toHaveBeenCalledOnce();
  expect(disconnect).not.toHaveBeenCalled();
  await React.act(() => root.unmount());
  expect(disconnect).toHaveBeenCalledOnce();
});
