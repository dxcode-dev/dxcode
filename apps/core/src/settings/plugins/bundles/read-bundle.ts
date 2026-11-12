import { MAX_PLUGIN_FILE_BYTES } from "@dx/domain";
import { Effect } from "effect";
import {
  AGENT_PLUGINS_MANIFEST,
  readAgentPluginsFolder,
} from "./agent-plugins-format.js";
import {
  type BundleFolder,
  isRecord,
  openBundleFolder,
} from "./bundle-reader.js";
import { readClaudeFolder } from "./claude-format.js";
import type { ZipArchive } from "./zip.js";

export type { ParsedBundle } from "./bundle-reader.js";

/**
 * True when the folder is an Agent Plugins package: it has a root
 * `plugin.json`, and either no file only Claude Code reads
 * (`.claude-plugin/plugin.json`, `.mcp.json`), or a root manifest whose
 * `$schema` names an Agent Plugins version. A Claude Code plugin may carry
 * another tool's root `plugin.json`; that file does not make it an Agent
 * Plugins package. `skills/` belongs to both formats and decides nothing.
 */
const isAgentPluginsPackage = Effect.fn("isAgentPluginsPackage")(function* (
  folder: BundleFolder,
) {
  if (!folder.files.has(AGENT_PLUGINS_MANIFEST)) return false;
  const claudeOnly =
    folder.files.has(".claude-plugin/plugin.json") ||
    folder.files.has(".mcp.json");
  if (!claudeOnly) return true;
  const text = yield* folder.peek(
    AGENT_PLUGINS_MANIFEST,
    MAX_PLUGIN_FILE_BYTES,
  );
  if (!text.ok) return false;
  try {
    const manifest: unknown = JSON.parse(text.text);
    return (
      isRecord(manifest) &&
      typeof manifest.$schema === "string" &&
      manifest.$schema.startsWith("https://agent-plugins.org/schemas/")
    );
  } catch {
    return false;
  }
});

/**
 * Reads the plugin in a folder of an archive, as an Agent Plugins package
 * (whose root manifest no other manifest may add to) or in Claude Code's
 * format. Nothing in it runs.
 */
export const readPluginBundle = Effect.fn("readPluginBundle")(function* (
  archive: ZipArchive,
  options: {
    /** The plugin's folder inside the archive, after any wrapping folder. */
    readonly root: string;
    /** Names a Claude Code plugin that has no plugin.json. */
    readonly fallbackName: string;
  },
) {
  const folder = yield* openBundleFolder(archive, options.root);
  return (yield* isAgentPluginsPackage(folder))
    ? yield* readAgentPluginsFolder(folder)
    : yield* readClaudeFolder(folder, options);
});
