import type { Env, MiddlewareHandler } from "hono";
import {
  currentSpan,
  observeCall,
  runInSpan,
  type SpanAttributes,
  startSpan,
} from "./tracing.js";

/**
 * Span wrappers for the boundaries the message-journey findings measure: D1
 * statements, Durable Object fetches, external services, invocations, and
 * middleware phases. Each records names, route templates, hosts, counts, and
 * status codes only: never SQL text, raw URLs, query strings, or bodies.
 */

const routeWord = /^[a-z][a-z0-9-]{0,31}$/;
const MAX_ROUTE_SEGMENTS = 4;

/** `/daemon/activate` stays; IDs and anything else become `:id`. */
export const routeTemplate = (input: RequestInfo | URL): string => {
  try {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const segments = url.pathname.split("/").filter((part) => part !== "");
    const template = segments
      .slice(0, MAX_ROUTE_SEGMENTS)
      .map((part) => (routeWord.test(part) ? part : ":id"));
    if (segments.length > MAX_ROUTE_SEGMENTS) template.push("*");
    return `/${template.join("/")}`;
  } catch {
    return "<invalid>";
  }
};

const requestMethod = (input: RequestInfo | URL, init?: RequestInit) =>
  (input instanceof Request ? input.method : init?.method) ?? "GET";

const hostOf = (input: RequestInfo | URL): string | undefined => {
  try {
    return new URL(input instanceof Request ? input.url : String(input))
      .hostname;
  } catch {
    return undefined;
  }
};

const responseStatus = (value: unknown): SpanAttributes =>
  value instanceof Response
    ? { "http.response.status_code": value.status }
    : {};

/**
 * One call to an external service (GitHub, E2B, a model provider). Records
 * the host, never the path or query.
 */
export const observeExternal = <A>(
  service: string,
  operation: string,
  target: RequestInfo | URL | undefined,
  call: () => A,
): A =>
  observeCall(
    `${service}.${operation}`,
    "external",
    {
      "dx.external.service": service,
      "dx.external.operation": operation,
      ...(target === undefined ? {} : { "server.address": hostOf(target) }),
    },
    call,
    responseStatus,
  );

/** Root span for a Durable Object fetch or alarm. */
export const traceInvocation = <A>(
  name: string,
  request: Request | undefined,
  call: () => Promise<A>,
): Promise<A> =>
  observeCall(
    name,
    "invocation",
    request === undefined
      ? {}
      : {
          "http.route": routeTemplate(request),
          "http.request.method": request.method,
        },
    call,
    responseStatus,
  );

/**
 * A middleware phase: the span covers the middleware's own work and ends
 * when it calls `next()` or returns, so downstream handlers are not counted
 * in it and parent to the enclosing span. Work the middleware does after
 * `next()` resolves is a second `<name>.after` span.
 */
export const tracedMiddleware = <E extends Env>(
  name: string,
  middleware: MiddlewareHandler<E>,
): MiddlewareHandler<E> =>
  async function traced(context, next) {
    const parent = currentSpan();
    const span = startSpan(name, "phase", {}, { inactive: true });
    if (span === undefined) return middleware(context, next);
    let continued = false;
    let after: ReturnType<typeof startSpan>;
    try {
      const result = await runInSpan(
        span,
        () =>
          middleware(context, async () => {
            continued = true;
            span.finish("ok");
            await runInSpan(parent, next, false);
            after = runInSpan(
              parent,
              () => startSpan(`${name}.after`, "phase", {}, { inactive: true }),
              false,
            );
          }),
        false,
      );
      if (!continued) span.attribute("dx.outcome", "responded");
      span.finish("ok");
      after?.finish("ok");
      return result;
    } catch (cause) {
      span.finish("error", cause);
      after?.finish("error", cause);
      throw cause;
    }
  };

// ─── D1 ─────────────────────────────────────────────────────────────────────

const sqlOperations = new Set([
  "select",
  "insert",
  "update",
  "delete",
  "with",
  "replace",
  "pragma",
  "create",
  "drop",
  "alter",
]);
const tablePattern =
  /\b(?:from|into|update|join)\s+["`[]?([A-Za-z_][A-Za-z0-9_]{0,63})/gi;
const notTables = new Set(["on", "set", "select", "or", "with", "values"]);

interface StatementShape {
  readonly operation: string;
  readonly table: string | undefined;
  readonly statement: string;
}

/** FNV-1a: a stable label for a statement without its text. */
const statementHash = (sql: string) => {
  let hash = 0x811c9dc5;
  for (let index = 0; index < sql.length; index += 1) {
    hash ^= sql.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
};

const shapes = new Map<string, StatementShape>();

/** Operation keyword, first table, and hash; the SQL text never leaves here. */
export const statementShape = (sql: string): StatementShape => {
  const cached = shapes.get(sql);
  if (cached !== undefined) return cached;
  const normalized = sql.replace(/\s+/g, " ").trim();
  const keyword = normalized.split(" ", 1)[0]?.toLowerCase() ?? "";
  const shape = {
    operation: sqlOperations.has(keyword) ? keyword : "other",
    table: [...normalized.matchAll(tablePattern)]
      .map((match) => match[1]?.toLowerCase())
      .find((table) => table !== undefined && !notTables.has(table)),
    statement: statementHash(normalized),
  };
  if (shapes.size >= 512) shapes.clear();
  shapes.set(sql, shape);
  return shape;
};

const instrumented = Symbol.for("dx.tracing.instrumented");
const statementSql = new WeakMap<object, string>();

type Method = (this: unknown, ...args: Array<unknown>) => unknown;

const ownMethods = (prototype: object, names: ReadonlyArray<string>) =>
  prototype !== Object.prototype &&
  names.every(
    (name) =>
      typeof Object.getOwnPropertyDescriptor(prototype, name)?.value ===
      "function",
  );

const patch = (
  prototype: object,
  name: string,
  wrap: (original: Method) => Method,
) => {
  const original = Reflect.get(prototype, name) as Method;
  Object.defineProperty(prototype, name, {
    value: wrap(original),
    configurable: true,
    writable: true,
  });
};

const d1Attributes = (sql: string | undefined): SpanAttributes => {
  if (sql === undefined) return {};
  const shape = statementShape(sql);
  return {
    "db.operation.name": shape.operation,
    "dx.d1.table": shape.table,
    "dx.d1.statement": shape.statement,
  };
};

/**
 * Wraps the D1 binding's classes once per isolate, so every statement from
 * every caller (repositories, `@effect/sql-d1`, Better Auth, Flue, Durable
 * Objects) is one `d1` span. Results and errors pass through untouched.
 */
const instrumentD1 = (db: unknown) => {
  if (typeof db !== "object" || db === null) return;
  const databasePrototype = Object.getPrototypeOf(db) as object | null;
  if (
    databasePrototype === null ||
    Object.hasOwn(databasePrototype, instrumented) ||
    !ownMethods(databasePrototype, ["prepare", "batch", "exec"])
  )
    return;
  const sample = (db as D1Database).prepare("SELECT 1");
  const statementPrototype = Object.getPrototypeOf(sample) as object | null;
  if (
    statementPrototype === null ||
    !ownMethods(statementPrototype, ["bind", "first", "run", "all", "raw"])
  )
    return;
  Object.defineProperty(databasePrototype, instrumented, { value: true });

  patch(
    databasePrototype,
    "prepare",
    (original) =>
      function prepare(this: unknown, ...args: Array<unknown>) {
        const statement = original.apply(this, args);
        if (typeof args[0] === "string" && typeof statement === "object")
          statementSql.set(statement as object, args[0]);
        return statement;
      },
  );
  patch(
    statementPrototype,
    "bind",
    (original) =>
      function bind(this: unknown, ...args: Array<unknown>) {
        const bound = original.apply(this, args);
        const sql = statementSql.get(this as object);
        if (sql !== undefined && typeof bound === "object")
          statementSql.set(bound as object, sql);
        return bound;
      },
  );
  for (const method of ["first", "run", "all", "raw"]) {
    patch(
      statementPrototype,
      method,
      (original) =>
        function execute(this: unknown, ...args: Array<unknown>) {
          return observeCall(
            `d1.${method}`,
            "d1",
            d1Attributes(statementSql.get(this as object)),
            () => original.apply(this, args),
          );
        },
    );
  }
  patch(
    databasePrototype,
    "batch",
    (original) =>
      function batch(this: unknown, ...args: Array<unknown>) {
        const statements = Array.isArray(args[0]) ? args[0] : [];
        const tables = [
          ...new Set(
            statements.flatMap((statement: object) => {
              const sql = statementSql.get(statement);
              const table =
                sql === undefined ? undefined : statementShape(sql).table;
              return table === undefined ? [] : [table];
            }),
          ),
        ];
        return observeCall(
          "d1.batch",
          "d1",
          {
            "db.operation.name": "batch",
            "dx.d1.statements": statements.length,
            "dx.d1.table": tables.slice(0, 4).join(","),
          },
          () => original.apply(this, args),
        );
      },
  );
  patch(
    databasePrototype,
    "exec",
    (original) =>
      function exec(this: unknown, ...args: Array<unknown>) {
        return observeCall(
          "d1.exec",
          "d1",
          { "db.operation.name": "exec" },
          () => original.apply(this, args),
        );
      },
  );
};

// ─── Durable Objects ────────────────────────────────────────────────────────

const namespaceNames = new WeakMap<object, string>();

/** Service bindings answer any property as RPC, so check the class, not the value. */
const namespacePrototype = (value: unknown): object | undefined => {
  if (typeof value !== "object" || value === null) return undefined;
  const prototype = Object.getPrototypeOf(value) as object | null;
  return prototype !== null &&
    ownMethods(prototype, ["get", "idFromName", "idFromString"])
    ? prototype
    : undefined;
};

const traceStubFetch = (stub: unknown, namespace: string) => {
  if (typeof stub !== "object" || stub === null) return;
  const original = Reflect.get(stub, "fetch") as Method | undefined;
  if (typeof original !== "function") return;
  Object.defineProperty(stub, "fetch", {
    value: function fetch(input: RequestInfo | URL, init?: RequestInit) {
      return observeCall(
        "durable-object.fetch",
        "durable-object",
        {
          "dx.do.namespace": namespace,
          "http.route": routeTemplate(input),
          "http.request.method": requestMethod(input, init),
        },
        () => original.call(stub, input, init),
        responseStatus,
      );
    },
    configurable: true,
    writable: true,
  });
};

/**
 * Wraps `DurableObjectNamespace#get` and `#getByName` once per isolate so
 * each stub's `fetch` is one `durable-object` span named by its binding.
 * RPC methods are untouched.
 */
const instrumentDurableObjects = (bindings: Record<string, unknown>) => {
  const prototypes = new Set<object>();
  for (const [name, value] of Object.entries(bindings)) {
    const prototype = namespacePrototype(value);
    if (prototype === undefined) continue;
    namespaceNames.set(value as object, name);
    prototypes.add(prototype);
  }
  for (const prototype of prototypes) {
    if (Object.hasOwn(prototype, instrumented)) continue;
    Object.defineProperty(prototype, instrumented, { value: true });
    for (const method of ["get", "getByName"]) {
      if (typeof Reflect.get(prototype, method) !== "function") continue;
      patch(
        prototype,
        method,
        (original) =>
          function stub(this: unknown, ...args: Array<unknown>) {
            const result = original.apply(this, args);
            try {
              traceStubFetch(
                result,
                namespaceNames.get(this as object) ?? "unknown",
              );
            } catch {
              // Passive: an untraced stub still works.
            }
            return result;
          },
      );
    }
  }
};

/** Instruments D1 and Durable Object bindings found in a Worker env. */
export const instrumentBindings = (bindings: unknown) => {
  if (typeof bindings !== "object" || bindings === null) return;
  try {
    instrumentD1(Reflect.get(bindings, "DB"));
  } catch {
    // Passive: tracing never prevents the Worker from serving.
  }
  try {
    instrumentDurableObjects(bindings as Record<string, unknown>);
  } catch {
    // As above.
  }
};
