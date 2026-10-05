export type ShellOperation =
  | { kind: "read"; path: string; range?: string }
  | { kind: "search"; pattern?: string; path?: string }
  | { kind: "list"; path?: string };

// Tokenize without evaluating expansions or executing any shell syntax.
const words = (command: string): string[][][] | undefined => {
  const segments: string[][][] = [];
  let stages: string[][] = [];
  let tokens: string[] = [];
  let word = "";
  let started = false;
  let quote = "";
  let needsSegment = false;
  const flush = () => {
    if (started) tokens.push(word);
    word = "";
    started = false;
  };
  const stage = () => {
    flush();
    if (!tokens.length) return false;
    stages.push(tokens);
    tokens = [];
    return true;
  };
  const segment = () => {
    if (!stage()) return false;
    segments.push(stages);
    stages = [];
    return true;
  };
  for (let i = 0; i < command.length; i++) {
    const c = command[i] ?? "";
    if (c === "\\" && quote !== "'") {
      const next = command[++i];
      if (next === undefined) return;
      word +=
        quote === '"' && !/[\\"$`\n]/.test(next)
          ? `\\${next}`
          : next === "\n"
            ? ""
            : next;
      started = true;
      continue;
    }
    if (quote) {
      if (c === quote) quote = "";
      else {
        if (quote === '"' && (c === "`" || c === "$")) return;
        word += c;
      }
      continue;
    }
    if (c === "'" || c === '"') {
      quote = c;
      started = true;
      continue;
    }
    if (/[<>`$(){}#]/.test(c)) return;
    if (c === "&" && command[i + 1] !== "&") return;
    if (
      c === ";" ||
      c === "\n" ||
      (c === "&" && command[i + 1] === "&") ||
      (c === "|" && command[i + 1] === "|")
    ) {
      if (!segment()) return;
      needsSegment = c === "&" || c === "|";
      if (c === "&" || c === "|") i++;
      continue;
    }
    if (c === "|") {
      if (!stage()) return;
      continue;
    }
    if (/\s/.test(c)) flush();
    else {
      needsSegment = false;
      word += c;
      started = true;
    }
  }
  if (quote || needsSegment) return;
  if (started || tokens.length || stages.length) {
    if (!segment()) return;
  }
  return segments.length ? segments : undefined;
};

const valueFlags = new Set([
  "-g",
  "--glob",
  "-t",
  "--type",
  "-T",
  "-e",
  "-f",
  "-A",
  "-B",
  "-C",
  "-m",
  "--max-count",
  "-M",
  "--type-add",
  "--include",
  "--exclude",
]);
const classify = (tokens: string[]): ShellOperation[] | undefined => {
  let [name, ...args] = tokens;
  if (
    args.some((arg) =>
      /^(?:--pre(?:=|$)|--pre-glob(?:=|$)|--pager(?:=|$)|-exec|-execdir|-ok|-okdir|-delete|-fprint|-fprintf)/.test(
        arg,
      ),
    )
  )
    return;
  if (name === "git") {
    name = `git ${args.shift()}`;
  }
  if (name === "cat") {
    const paths = args.filter((x) => x !== "-n");
    return paths.length && paths.every((x) => !x.startsWith("-"))
      ? paths.map((path) => ({ kind: "read", path }))
      : undefined;
  }
  if (name === "sed") {
    const match = /^(\d+)(?:,(\d+))?p$/.exec(args[1] ?? "");
    return args.length === 3 && args[0] === "-n" && match && args[2]
      ? [
          {
            kind: "read",
            path: args[2],
            range: `L${match[1]}-${match[2] ?? match[1]}`,
          },
        ]
      : undefined;
  }
  if (["head", "tail", "nl", "bat", "batcat"].includes(name ?? "")) {
    let count = 10;
    if (args[0] === "-n" && /^\d+$/.test(args[1] ?? "")) {
      count = Number(args[1]);
      args = args.slice(2);
    } else if (/^-\d+$/.test(args[0] ?? "")) {
      count = Number(args[0]?.slice(1));
      args = args.slice(1);
    } else if (name === "nl" && args[0] === "-ba") args = args.slice(1);
    const path = args[0];
    return args.length === 1 && path && !path.startsWith("-")
      ? [
          {
            kind: "read",
            path,
            ...(name === "head" ? { range: `L1-${count}` } : {}),
          },
        ]
      : undefined;
  }
  if (["rg", "grep", "egrep", "git grep", "ag", "ack"].includes(name ?? "")) {
    const positional: string[] = [];
    let pattern: string | undefined;
    let list = false;
    for (let i = 0; i < args.length; i++) {
      const arg = args[i] ?? "";
      if (arg === "--files") {
        list = true;
        continue;
      }
      if (arg === "--") {
        positional.push(...args.slice(i + 1));
        break;
      }
      if (valueFlags.has(arg)) {
        const value = args[++i];
        if (value === undefined) return;
        if (arg === "-e") pattern = value;
        continue;
      }
      const attached = /^(-[gtTefABCMm])(.+)$/.exec(arg);
      if (attached) {
        if (attached[1] === "-e") pattern = attached[2];
        continue;
      }
      if (arg.startsWith("-")) continue;
      positional.push(arg);
    }
    if (list && name === "rg")
      return [
        { kind: "list", ...(positional[0] ? { path: positional[0] } : {}) },
      ];
    pattern ??= positional.shift();
    return pattern === undefined
      ? undefined
      : [
          {
            kind: "search",
            pattern,
            ...(positional[0] ? { path: positional[0] } : {}),
          },
        ];
  }
  if (["ls", "find", "tree", "fd", "git ls-files"].includes(name ?? "")) {
    if (
      args.some(
        (arg) =>
          (name === "tree" && arg === "-o") ||
          (name === "fd" && (arg === "-x" || arg === "-X")) ||
          arg.startsWith("--exec") ||
          arg.startsWith("--output"),
      )
    )
      return;
    const positional = args.filter((x) => !x.startsWith("-"));
    const path =
      name === "fd"
        ? positional[1]
        : name === "git ls-files"
          ? undefined
          : positional[0];
    return [{ kind: "list", ...(path ? { path } : {}) }];
  }
  return undefined;
};

/** Commands that only filter or count a read's output later in a pipe. */
const PIPE_FILTERS = new Set([
  "head",
  "tail",
  "sort",
  "uniq",
  "wc",
  "cut",
  "tr",
  "grep",
  "rg",
  "column",
  "nl",
]);

export const shellCommandOperations = (
  command: string,
): ShellOperation[] | undefined => {
  const segments = words(command);
  if (!segments) return;
  const result: ShellOperation[] = [];
  for (const stages of segments) {
    if (
      stages
        .slice(1)
        .some((stage) =>
          stage.some(
            (arg) =>
              arg === "-o" ||
              arg.startsWith("--output") ||
              arg.startsWith("--pre"),
          ),
        )
    )
      return;
    if (stages.slice(1).some((stage) => !PIPE_FILTERS.has(stage[0] ?? "")))
      return;
    const operations = classify(stages[0] ?? []);
    if (!operations?.length) return;
    result.push(...operations);
  }
  return result;
};

export const parseShellResult = (
  text: string,
): { output: string; exitCode?: number; running?: boolean; pid?: number } => {
  const match =
    /^(?:<output>([\s\S]*)<\/output>\s*)?((?:<(?:exitCode|running|pid)>[^<]+<\/(?:exitCode|running|pid)>\s*)+)$/.exec(
      text,
    );
  if (!match) return { output: text };
  const result: ReturnType<typeof parseShellResult> = {
    output: match[1] ?? "",
  };
  const exit = /<exitCode>(-?\d+)<\/exitCode>/.exec(match[2] ?? "");
  const pid = /<pid>(\d+)<\/pid>/.exec(match[2] ?? "");
  const running = /<running>(true|false)<\/running>/.exec(match[2] ?? "");
  if (exit) result.exitCode = Number(exit[1]);
  if (pid) result.pid = Number(pid[1]);
  if (running) result.running = running[1] === "true";
  return result;
};
