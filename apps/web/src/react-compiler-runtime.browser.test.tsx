// The browser project exists so React tests exercise the compiled code that
// ships. If the compiler stops running here, a subtree with no changing inputs
// renders again with its parent and this fails.

import { act, Profiler, useState } from "react";
import { createRoot } from "react-dom/client";
import { expect, it } from "vitest";

const phases: string[] = [];
const recordPhase = (_id: string, phase: string) => {
  phases.push(phase);
};

const Counter = () => {
  const [count, setCount] = useState(0);
  return (
    <div>
      <button type="button" onClick={() => setCount(count + 1)}>
        {count}
      </button>
      <Profiler id="static" onRender={recordPhase}>
        <span>static</span>
      </Profiler>
    </div>
  );
};

it("runs components through the React Compiler", async () => {
  const container = document.createElement("div");
  document.body.append(container);
  const root = createRoot(container);
  await act(async () => root.render(<Counter />));
  const button = container.querySelector("button");
  await act(async () => button?.click());
  await act(async () => button?.click());

  expect(button?.textContent).toBe("2");
  expect(phases).toEqual(["mount"]);
  await act(async () => root.unmount());
  container.remove();
});
