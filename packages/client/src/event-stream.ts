/** One server-sent event: its name (`message` when it has none) and data. */
export interface ServerSentEvent {
  readonly event: string;
  readonly data: string;
}

/**
 * Reads a `text/event-stream` answer, such as an `answer: "sse"`
 * endpoint's, event by event until it ends or `signal` aborts. Comments
 * (`: heartbeat`) and ids are skipped; multi-line data is joined with `\n`.
 *
 * @example
 * const response = await client.call(TranscriptUpdatesEndpoint, { params });
 * for await (const { event, data } of readEventStream(response))
 *   if (event === "items") apply(JSON.parse(data));
 */
export async function* readEventStream(
  response: Response,
  signal?: AbortSignal,
): AsyncGenerator<ServerSentEvent> {
  const body = response.body;
  if (body === null) return;
  const reader = body.getReader();
  const decoder = new TextDecoder();
  const cancel = () => {
    reader.cancel().catch(() => undefined);
  };
  signal?.addEventListener("abort", cancel, { once: true });
  let buffer = "";
  let event = "message";
  let data: string[] = [];
  try {
    for (;;) {
      const { value, done } = await reader.read();
      if (done) return;
      buffer += decoder.decode(value, { stream: true });
      let newline = buffer.indexOf("\n");
      while (newline !== -1) {
        const line = buffer.slice(0, newline).replace(/\r$/u, "");
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf("\n");
        if (line === "") {
          if (data.length > 0) yield { event, data: data.join("\n") };
          event = "message";
          data = [];
        } else if (line.startsWith("event:")) {
          event = line.slice(6).trim();
        } else if (line.startsWith("data:")) {
          data.push(line.slice(5).replace(/^ /u, ""));
        }
      }
    }
  } finally {
    signal?.removeEventListener("abort", cancel);
    cancel();
  }
}
