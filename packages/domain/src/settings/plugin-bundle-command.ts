import type { PluginBundleStdioMcpServer } from "./plugin-bundle.js";

// Its own module, so the Settings chunk carries it rather than every page.

const shellWord = (part: string) =>
  /^[\w@%+=:,./${}-]+$/.test(part) ? part : JSON.stringify(part);

/**
 * A local server's command line, for people reviewing it: its env
 * assignments, the command and args, and its working directory when set.
 */
export const stdioCommandLine = (server: PluginBundleStdioMcpServer) =>
  [
    ...server.env.map(({ name, value }) => `${name}=${shellWord(value)}`),
    server.command,
    ...server.args.map(shellWord),
    ...(server.cwd === undefined ? [] : [`(in ${server.cwd})`]),
  ].join(" ");
