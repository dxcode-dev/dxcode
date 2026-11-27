/**
 * Agent37's Sandbox API in memory, at the HTTP boundary, for worker tests
 * of Agent37 Orbs: the control plane (api.agent37.com, bearer key) and exec
 * (sandbox.agent37.app, `X-Agent37-Key`), with an instance filesystem that
 * answers the exact scripts dx's guest sends.
 */

export interface FakeInstance {
  readonly id: string;
  readonly template: string;
  readonly name: string;
  readonly mountPath: string;
  readonly resources: { cpu: number; memory: number; disk: number };
  readonly metadata: Record<string, string>;
  status: string;
  /** When the instance's processes started (epoch seconds). */
  startedAt: number;
  /** Paths to binary strings. */
  readonly files: Map<string, string>;
  readonly execs: Array<{ readonly command: string; readonly root: boolean }>;
}

export interface Agent37World {
  /** Keys to workspace IDs. */
  readonly keys: Map<string, string>;
  /** Workspace IDs to their members, oldest first. */
  readonly members: Map<string, ReadonlyArray<string>>;
  /** Registered templates: name to image. */
  readonly templates: Map<string, string>;
  readonly instances: Map<string, FakeInstance>;
  readonly deleted: Array<FakeInstance>;
  /** Method and path of every call. */
  readonly calls: Array<string>;
  /** Every request's URL and body, without headers. */
  readonly traffic: Array<string>;
  /** Epoch seconds. */
  clock: number;
  count: number;
  /** The wallet cannot pay a day of the next instance. */
  broke: boolean;
  /** The test Orb's dx-orb-check finds no Desktop. */
  missingDesktop: boolean;
  /** Sleeps that answer 503 before one succeeds. */
  failSleeps: number;
  /** Deletes that answer 503 before one succeeds. */
  failDeletes: number;
}

export const agent37World = (): Agent37World => ({
  keys: new Map([
    ["sk_live_one", "ws_one"],
    ["sk_live_two", "ws_one"],
  ]),
  members: new Map([["ws_one", ["mem_owner", "mem_later"]]]),
  templates: new Map(),
  instances: new Map(),
  deleted: [],
  calls: [],
  traffic: [],
  clock: 1_794_800_000,
  count: 0,
  broke: false,
  missingDesktop: false,
  failSleeps: 0,
  failDeletes: 0,
});

const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });

const error = (status: number, code: string, message: string) =>
  json({ error: { code, message } }, status);

/** Splits a shell line into words: single quotes, `\` escapes, spaces. */
export const shellWords = (line: string) => {
  const words: Array<string> = [];
  let word: string | undefined;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index] as string;
    if (character === "'") {
      const end = line.indexOf("'", index + 1);
      word = (word ?? "") + line.slice(index + 1, end);
      index = end;
    } else if (character === "\\") {
      word = (word ?? "") + (line[index + 1] ?? "");
      index += 1;
    } else if (character === " " || character === "\n") {
      if (word !== undefined) words.push(word);
      word = undefined;
    } else word = (word ?? "") + character;
  }
  if (word !== undefined) words.push(word);
  return words;
};

const instanceBody = (instance: FakeInstance) => ({
  id: instance.id,
  status: instance.status,
  template: instance.template,
  mount_path: instance.mountPath,
  resources: instance.resources,
  name: instance.name,
  metadata: instance.metadata,
  url: `https://${instance.id}.agent37.app`,
  past_due: false,
});

const result = (stdout: string, exitCode = 0, stderr = "") =>
  json({ exit_code: exitCode, stdout, stderr, truncated: false });

/**
 * Linux's limit on one argument (MAX_ARG_STRLEN), with its terminating NUL.
 * Agent37 takes a longer request, but the instance's shell refuses to start
 * a program with any longer argument (checked on a live instance,
 * 2026-11-20: 131,071 bytes ran, 131,072 failed with exit 126).
 */
const MAX_ARGUMENT_BYTES = 131_072;

const tooLong = (words: ReadonlyArray<string>) =>
  words.some(
    (word) => new TextEncoder().encode(word).length + 1 > MAX_ARGUMENT_BYTES,
  );

/**
 * A script api.ts staged in a file (`throughFile`), and the line that runs
 * it; undefined for a command that is not one.
 */
const staged = (command: string) => {
  const match =
    /^f=\$\(mktemp [^\n]*\ncat >"\$f" <<'(\w+)'[^\n]*\nrm -f -- "\$0"\n([\s\S]*)\n\1\n([^\n]*)$/.exec(
      command,
    );
  return match === null
    ? undefined
    : { script: match[2] as string, run: match[3] as string };
};

/** Runs one exec in `instance`, as the scripts dx sends would. */
const run = (world: Agent37World, instance: FakeInstance, command: string) => {
  // api.ts wraps every command: `exec timeout -k 5 N sh -c '<command>'`, or
  // runs a long one from a file with `exec timeout -k 5 N sh "$f"`.
  const file = staged(command);
  const wrapped = shellWords(file?.run ?? command);
  if (wrapped[0] !== "exec" || wrapped[1] !== "timeout")
    return result("", 2, "unwrapped command");
  if (tooLong(wrapped))
    return result("", 126, "sh: 1: exec: timeout: Argument list too long\n");
  const inner = file === undefined ? (wrapped[7] as string) : file.script;
  if (file !== undefined && !/^exec timeout -k 5 \d+ sh "\$f"$/.test(file.run))
    return result("", 127, "staged script not run by sh");
  if (inner.includes("dx-orb-check"))
    return world.missingDesktop
      ? result("FAIL desktop.start      no display\n", 1)
      : result('{"dxOrbCheck":{"ok":true,"failures":0}}\n');
  if (inner.includes("supervisor.pid") && inner.includes("etimes"))
    return result(`${instance.startedAt}\n`);
  if (inner.includes("supervisor.pid")) return result("");
  // A guest command: `exec bash -l -c '<lines>'`, or from a file.
  const guest = staged(inner);
  if (guest !== undefined)
    return guest.run === 'exec bash -l "$f"'
      ? result(guest.script.includes("whoami") ? "user\n" : "ran as user")
      : result("", 127, "staged guest script not run by bash -l");
  // A written piece: base64 in a heredoc, into its staging file.
  const piece =
    /^base64 -d (>>?) ('(?:[^']|'\\'')*') <<'DX_BASE64'\n([A-Za-z0-9+/=\n]*)\nDX_BASE64$/.exec(
      inner,
    );
  if (piece !== null) {
    const path = shellWords(piece[2] as string)[0] as string;
    const content = atob((piece[3] as string).replaceAll("\n", ""));
    instance.files.set(
      path,
      (piece[1] === ">>" ? (instance.files.get(path) ?? "") : "") + content,
    );
    return result("");
  }
  const words = shellWords(inner);
  if (tooLong(words))
    return result(
      "",
      126,
      `sh: 1: exec: ${words[0] === "exec" ? words[1] : words[0]}: Argument list too long\n`,
    );
  if (words[0] === "exec" && words[1] === "bash")
    // A guest command: `exec bash -l -c '<lines>'`.
    return result(
      (words[4] as string).includes("whoami") ? "user\n" : "ran as user",
    );
  if (words[0] !== "sh" || words[1] !== "-c")
    return result("", 127, "unknown command");
  const body = words[2] as string;
  const args = words.slice(4);
  const [first = "", second = "", third = ""] = args;
  const { files } = instance;
  if (body.includes("stat -L -c %s"))
    return files.has(first)
      ? result(`${(files.get(first) as string).length}\n`)
      : result("", 1, "No such file");
  if (body.includes("tail -c +"))
    return result(
      btoa(
        (files.get(first) ?? "").slice(
          Number(second) - 1,
          Number(second) - 1 + Number(third),
        ),
      ),
    );
  if (body.includes('cat -- "$1" >"$2"')) {
    if (!files.has(first)) return result("", 1, "No such file");
    files.set(second, files.get(first) as string);
    return result("");
  }
  if (body.includes("rm -f --")) {
    files.delete(first);
    return result("");
  }
  if (body.includes("stat -L -c %F"))
    return files.has(first)
      ? result("0\nregular file")
      : result("", 1, "No such file");
  if (body.includes("test -e")) return result("", files.has(first) ? 0 : 1);
  if (body.includes("mkdir -p")) return result("");
  return result("", 127, "unknown script");
};

/** Agent37's two planes over `world`. */
export const fakeAgent37 =
  (world: Agent37World) =>
  async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const headers = new Headers(init?.headers);
    const rawBody = typeof init?.body === "string" ? init.body : "";
    world.calls.push(`${method} ${url.host}${url.pathname}`);
    world.traffic.push(`${method} ${url.href} ${rawBody}`);
    const body = rawBody === "" ? {} : JSON.parse(rawBody);
    const path = url.pathname;

    if (url.host === "sandbox.agent37.app") {
      const workspace = world.keys.get(headers.get("x-agent37-key") ?? "");
      if (workspace === undefined) return json({ error: "unauthorized" }, 401);
      const exec = /^\/v1\/instances\/([^/]+)\/exec$/.exec(path);
      const instance = world.instances.get(exec?.[1] ?? "");
      if (method !== "POST" || instance === undefined)
        return json({ error: "not_found" }, 404);
      // Exec wakes a sleeping instance, with its processes.
      if (instance.status === "sleeping") instance.status = "running";
      if (instance.status !== "running")
        return error(
          400,
          "invalid_request",
          "Only running instances can execute commands.",
        );
      instance.execs.push({
        command: body.command,
        root: body.user === "root",
      });
      return run(world, instance, body.command);
    }

    if (url.host !== "api.agent37.com")
      return error(404, "not_found", "Unknown host.");
    const auth = /^Bearer (.+)$/.exec(headers.get("authorization") ?? "");
    const workspace = world.keys.get(auth?.[1] ?? "");
    if (workspace === undefined)
      return error(
        401,
        "invalid_api_key",
        "Missing, malformed, or revoked API key.",
      );

    if (method === "GET" && path === "/v1/members")
      return json({
        members: (world.members.get(workspace) ?? []).map((id, index) => ({
          id,
          email: `${id}@example.com`,
          role: "admin",
          created: 1_794_000_000_000 + index,
        })),
        invitations: [],
      });

    const template = /^\/v1\/templates\/([^/]+)$/.exec(path);
    if (method === "GET" && template !== null) {
      const name = decodeURIComponent(template[1] as string);
      const image = world.templates.get(name);
      return image === undefined
        ? error(404, "not_found", "Template not found.")
        : json({ name, scope: "workspace", image_ref: image });
    }
    if (method === "POST" && path === "/v1/templates") {
      if (world.templates.has(body.name))
        return error(409, "template_conflict", "Template exists.");
      world.templates.set(body.name, body.image_ref);
      return json(
        {
          name: body.name,
          scope: "workspace",
          revision: 1,
          image_ref: body.image_ref,
          image_digest: String(body.image_ref).split("@")[1] ?? null,
          description: body.description,
        },
        201,
      );
    }

    if (method === "GET" && path === "/v1/instances")
      return json({ data: [...world.instances.values()].map(instanceBody) });
    if (method === "POST" && path === "/v1/instances") {
      if (!world.templates.has(body.template))
        return error(400, "invalid_request", "Unknown template.");
      if (world.broke)
        return error(
          402,
          "insufficient_balance",
          "Creating it requires at least one day of balance.",
        );
      world.count += 1;
      const instance: FakeInstance = {
        id: `inst${String(world.count).padStart(6, "0")}`,
        template: body.template,
        name: body.name,
        mountPath: body.mount_path,
        resources: body.resources,
        metadata: body.metadata ?? {},
        status: "running",
        startedAt: world.clock,
        files: new Map(),
        execs: [],
      };
      world.instances.set(instance.id, instance);
      return json(instanceBody(instance), 201);
    }

    const action = /^\/v1\/instances\/([^/]+)(?:\/(sleep|start|stop))?$/.exec(
      path,
    );
    const instance = world.instances.get(action?.[1] ?? "");
    if (action === null || instance === undefined)
      return error(404, "not_found", "Instance not found.");
    if (method === "GET" && action[2] === undefined)
      return json(instanceBody(instance));
    if (method === "DELETE" && action[2] === undefined) {
      if (world.failDeletes > 0) {
        world.failDeletes -= 1;
        return error(503, "try_again", "Busy.");
      }
      world.instances.delete(instance.id);
      world.deleted.push(instance);
      instance.status = "deleted";
      return json({ id: instance.id, deleted: true });
    }
    if (method === "POST" && action[2] === "sleep") {
      if (world.failSleeps > 0) {
        world.failSleeps -= 1;
        return error(503, "try_again", "Busy.");
      }
      instance.status = "sleeping";
      return json({ id: instance.id, status: "sleeping" });
    }
    if (method === "POST" && action[2] === "stop") {
      instance.status = "stopped";
      return json({ id: instance.id, status: "stopped" });
    }
    if (method === "POST" && action[2] === "start") {
      // A stopped instance boots fresh; a sleeping one wakes in place.
      if (instance.status === "stopped") instance.startedAt = world.clock;
      instance.status = "running";
      return json({ id: instance.id, status: "running" });
    }
    return error(404, "not_found", "Unknown route.");
  };
