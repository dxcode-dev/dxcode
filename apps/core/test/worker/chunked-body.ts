/**
 * A request body sent chunked, with no Content-Length, that counts how many
 * chunks the server pulled. A server that reads the whole body before checking
 * its size pulls every chunk; one that stops at its cap pulls a few.
 */
export const chunkedBody = ({
  totalBytes,
  chunkBytes = 16 * 1_024,
  fill = 0x20,
}: {
  totalBytes: number;
  chunkBytes?: number;
  fill?: number;
}) => {
  const chunk = new Uint8Array(chunkBytes).fill(fill);
  const chunks = Math.ceil(totalBytes / chunkBytes);
  const read = { chunks: 0 };
  const stream = new ReadableStream<Uint8Array>(
    {
      pull(controller) {
        if (read.chunks >= chunks) {
          controller.close();
          return;
        }
        read.chunks += 1;
        controller.enqueue(chunk);
      },
    },
    // No read-ahead: a chunk is pulled only when the server reads one.
    { highWaterMark: 0 },
  );
  return { stream, read, chunks };
};
