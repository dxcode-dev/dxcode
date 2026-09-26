export const createHiddenPrompt =
  ({ input, output, pause, resume }) =>
  async (label) => {
    if (!input.isTTY || typeof input.setRawMode !== "function")
      throw new Error(
        `${label} must be supplied through the matching environment variable in a non-TTY.`,
      );
    pause();
    input.setRawMode(true);
    output.write(`${label}: `);
    let value = "";
    try {
      await new Promise((resolve, reject) => {
        const cleanup = () => {
          input.off("data", onData);
          input.off("end", onEnd);
          input.off("error", onError);
        };
        const finish = () => {
          cleanup();
          resolve();
        };
        const cancel = () => {
          cleanup();
          reject(new Error("Deployment cancelled."));
        };
        const onData = (chunk) => {
          const text = chunk.toString("utf8");
          for (const character of text) {
            if (character === "\u0003") return cancel();
            if (character === "\r" || character === "\n") return finish();
            if (character === "\u007f") value = value.slice(0, -1);
            else value += character;
          }
        };
        const onEnd = () => finish();
        const onError = (error) => {
          cleanup();
          reject(error);
        };
        input.on("data", onData);
        input.once("end", onEnd);
        input.once("error", onError);
        input.resume();
      });
    } finally {
      input.setRawMode(false);
      input.pause();
      output.write("\n");
      resume();
    }
    return value;
  };
