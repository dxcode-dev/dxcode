import { createContext, type ReactNode } from "react";
import type { Components } from "react-markdown";

/**
 * How Markdown shows the dx Threads it links, provided by the feature that
 * knows them, such as a Space's chat showing the threads it started as live
 * cards and chips. Without it, a link to a Thread stays a link.
 */
export interface ThreadReferences {
  /** A Thread on its own: a block card. */
  readonly card: (threadId: string) => ReactNode;
  /** A Thread named in running text: an inline chip. */
  readonly chip: (threadId: string, label: ReactNode) => ReactNode;
  /**
   * Markdown elements that show links to Threads alone, such as a
   * paragraph of them, as cards.
   */
  readonly markdownComponents: Components;
}

export const ThreadReferenceContext = createContext<
  ThreadReferences | undefined
>(undefined);

const THREAD_PATH =
  /^\/threads\/(thr_[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12})\/?(?:[?#].*)?$/;

/**
 * The Thread a link opens: `/threads/thr_…`, on this origin or any dx
 * origin the agent wrote. Undefined for every other link.
 */
export const threadIdOfHref = (href: string | undefined) => {
  if (href === undefined || href === "") return undefined;
  if (href.startsWith("/")) return THREAD_PATH.exec(href)?.[1];
  try {
    const url = new URL(href);
    if (url.protocol !== "https:" && url.protocol !== "http:") return undefined;
    return THREAD_PATH.exec(`${url.pathname}${url.search}${url.hash}`)?.[1];
  } catch {
    return undefined;
  }
};
