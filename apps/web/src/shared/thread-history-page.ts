/**
 * Each page of a Thread's history holds the newest prompts that fit in 1 MiB
 * of encoded JSON, at most five and always at least one whole prompt, so a
 * Thread with large tool outputs does not paint megabytes. Older pages load
 * as the reader scrolls up. The Thread session asks for its pages with it,
 * and the boot read asks for the first page with the same query.
 */
export const THREAD_HISTORY_PAGE = { promptLimit: 5, maxBytes: 1_048_576 };
