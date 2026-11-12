import { type Context, createContext } from "react";
import type { Options } from "react-markdown";

/** One remark plugin, as react-markdown takes them. */
export type MarkdownRemarkPlugin = NonNullable<
  Options["remarkPlugins"]
>[number];

/**
 * One more remark plugin for the Markdown below, from a feature that loads
 * it lazily, such as an installed plugin's link patterns in a Thread.
 */
export const MarkdownRemarkContext: Context<MarkdownRemarkPlugin | undefined> =
  createContext<MarkdownRemarkPlugin | undefined>(undefined);
