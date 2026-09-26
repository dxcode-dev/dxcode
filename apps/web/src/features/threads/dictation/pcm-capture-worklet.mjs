// Loaded as a standalone module because deployed CSP blocks inlined data URLs.
class DxPcmCaptureProcessor extends AudioWorkletProcessor {
  constructor(options) {
    super();
    const inputRate = options.processorOptions.inputSampleRate;
    this.ratio = inputRate / 16000;
    this.position = 0;
    this.samples = 0;
    this.limit = 14400000;
    this.source = [];
    this.limitSent = false;
    this.pending = [];
    this.stopped = false;
    this.port.onmessage = ({ data }) => {
      if (data?.type === "stop" && !this.stopped) {
        this.stopped = true;
        this.emit(true);
        this.port.postMessage({ type: "stopped" });
      }
    };
  }

  emit(flush = false) {
    const output = this.pending;
    this.pending = [];
    if (output.length > 0) {
      const pcm = Int16Array.from(output);
      let peak = 0;
      for (const value of pcm) peak = Math.max(peak, Math.abs(value) / 32768);
      this.port.postMessage({ type: "samples", pcm, peak }, [pcm.buffer]);
    }
    if (flush && this.source.length && this.samples < this.limit) {
      const value =
        this.source[
          Math.min(Math.floor(this.position), this.source.length - 1)
        ];
      const pcm = Int16Array.of(
        Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767),
      );
      this.samples += 1;
      this.port.postMessage({ type: "samples", pcm, peak: Math.abs(value) }, [
        pcm.buffer,
      ]);
    }
  }

  process(inputs) {
    const channel = inputs[0]?.[0];
    if (this.stopped || !channel || this.samples >= this.limit) return true;
    for (let index = 0; index < channel.length; index += 1)
      this.source.push(channel[index]);
    while (
      this.position + 1 < this.source.length &&
      this.samples < this.limit
    ) {
      const left = Math.floor(this.position);
      const fraction = this.position - left;
      const value =
        this.source[left] * (1 - fraction) + this.source[left + 1] * fraction;
      this.pending.push(
        Math.max(-1, Math.min(1, value)) * (value < 0 ? 32768 : 32767),
      );
      this.samples += 1;
      this.position += this.ratio;
    }
    const consumed = Math.min(this.source.length, Math.floor(this.position));
    if (consumed > 0) {
      this.source.splice(0, consumed);
      this.position -= consumed;
    }
    if (this.pending.length >= 800) this.emit();
    if (this.samples >= this.limit && !this.limitSent) {
      this.limitSent = true;
      this.emit();
      this.port.postMessage({ type: "limit" });
    }
    return true;
  }
}

registerProcessor("dx-pcm-capture", DxPcmCaptureProcessor);
