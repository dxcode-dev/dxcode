import { readFileSync } from "node:fs";
import vm from "node:vm";
import { describe, expect, it } from "vitest";

describe("PCM capture worklet", () => {
  const createProcessor = () => {
    let Processor!: new (
      options: unknown,
    ) => {
      port: { onmessage?: (event: { data: unknown }) => void };
      process(inputs: Float32Array[][]): boolean;
      samples: number;
      limit: number;
    };
    const messages: Array<{ type: string; pcm?: Int16Array }> = [];
    class AudioWorkletProcessor {
      port = {
        onmessage: undefined as
          | ((event: { data: unknown }) => void)
          | undefined,
        postMessage: (message: { type: string; pcm?: Int16Array }) =>
          messages.push(message),
      };
    }
    vm.runInNewContext(
      readFileSync(
        new URL("./pcm-capture-worklet.mjs", import.meta.url),
        "utf8",
      ),
      {
        AudioWorkletProcessor,
        Int16Array,
        Math,
        registerProcessor: (_name: string, value: typeof Processor) => {
          Processor = value;
        },
      },
    );
    const processor = new Processor({
      processorOptions: { inputSampleRate: 48_000 },
    });
    return { messages, processor };
  };

  it("resamples continuously and flushes before acknowledging stop", () => {
    const { messages, processor } = createProcessor();
    for (let batch = 0; batch < 8; batch += 1)
      processor.process([
        [
          Float32Array.from(
            { length: 128 },
            (_, index) => (batch * 128 + index) / 1024,
          ),
        ],
      ]);
    processor.port.onmessage?.({ data: { type: "stop" } });

    expect(messages.at(-1)?.type).toBe("stopped");
    const actual = messages
      .filter(({ type }) => type === "samples")
      .flatMap(({ pcm }) => [...(pcm ?? [])]);
    // 48kHz -> 16kHz samples at source indices 0,3,...1023, including
    // crossings of 128-sample worklet blocks and the final held sample.
    expect(actual).toEqual(
      Array.from({ length: 342 }, (_, index) =>
        Math.trunc(((index * 3) / 1024) * 32767),
      ),
    );
    const count = messages.length;
    processor.process([[Float32Array.of(1, 1, 1, 1)]]);
    processor.port.onmessage?.({ data: { type: "stop" } });
    expect(messages).toHaveLength(count);
  });

  it("flushes one final silent sample before acknowledging stop", () => {
    const { messages, processor } = createProcessor();
    processor.process([[Float32Array.of(0)]]);
    processor.port.onmessage?.({ data: { type: "stop" } });

    expect(messages.map(({ type }) => type)).toEqual(["samples", "stopped"]);
    expect(messages[0]?.pcm).toEqual(Int16Array.of(0));
  });

  it("caps output at the actual 14.4 million sample maximum", () => {
    const { messages, processor } = createProcessor();
    expect(processor.limit).toBe(14_400_000);
    processor.samples = 14_399_999;
    processor.process([[Float32Array.of(0.25, 0.25, 0.25, 0.25)]]);
    processor.process([[Float32Array.of(0.25, 0.25, 0.25, 0.25)]]);

    const samples = messages
      .filter(({ type }) => type === "samples")
      .reduce((count, { pcm }) => count + (pcm?.length ?? 0), 0);
    expect(processor.samples).toBe(14_400_000);
    expect(samples).toBe(1);
    expect(messages.filter(({ type }) => type === "limit")).toHaveLength(1);
  });
});
