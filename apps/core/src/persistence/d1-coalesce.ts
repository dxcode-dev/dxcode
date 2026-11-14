/**
 * A D1 binding that sends reads issued together as one round trip. Every
 * `all` and `first` a request makes in the same turn of the event loop is
 * queued, and the queue goes to D1 as one `db.batch` when that turn ends;
 * each caller gets its own statement's result. One read alone is sent as it
 * was. Writes (`run`), `raw`, `exec`, and a caller's own `batch` go straight
 * through at once, so a write never shares a transaction with unrelated
 * reads.
 *
 * Ordering: a queued read is sent only when the turn ends, so a write
 * issued in the same turn reaches D1 first, even one issued after the read.
 * Such a read sees the write's result. A caller whose read must come before
 * a write, or whose step depends on a write, awaits each step in turn; only
 * reads issued together and independent of each other may share a turn.
 *
 * Not for general use: it is scoped to the plugin settings routes
 * (settings/plugins/bundles), whose reads run concurrently and none depends
 * on another's result. A batch is one transaction: if one read fails, every
 * read in that batch fails.
 */

const statementKey = Symbol("dx.d1.statement");

interface Pending {
  readonly statement: D1PreparedStatement;
  readonly settle: (result: D1Result) => void;
  readonly fail: (error: unknown) => void;
}

export const coalescingD1 = (db: D1Database): D1Database => {
  let queue: Array<Pending> = [];
  let scheduled = false;

  const flush = () => {
    scheduled = false;
    const sending = queue;
    queue = [];
    if (sending.length === 0) return;
    const [only] = sending;
    const results =
      sending.length === 1 && only !== undefined
        ? only.statement.all().then((result) => [result])
        : db.batch(sending.map(({ statement }) => statement));
    results.then(
      (all) =>
        sending.forEach((pending, index) => {
          const result = all[index];
          if (result === undefined)
            pending.fail(new Error("D1 batch returned too few results."));
          else pending.settle(result);
        }),
      (error: unknown) => {
        for (const pending of sending) pending.fail(error);
      },
    );
  };

  const enqueue = (statement: D1PreparedStatement) =>
    new Promise<D1Result>((settle, fail) => {
      queue.push({ statement, settle, fail });
      if (!scheduled) {
        scheduled = true;
        setTimeout(flush, 0);
      }
    });

  const wrap = (statement: D1PreparedStatement): D1PreparedStatement =>
    new Proxy(statement, {
      get(target, property) {
        if (property === statementKey) return target;
        if (property === "bind")
          return (...values: Array<unknown>) => wrap(target.bind(...values));
        if (property === "all") return () => enqueue(target);
        if (property === "first")
          return async (column?: string) => {
            const row = (await enqueue(target)).results[0] as
              | Record<string, unknown>
              | undefined;
            if (row === undefined) return null;
            return column === undefined ? row : (row[column] ?? null);
          };
        const value = Reflect.get(target, property);
        return typeof value === "function" ? value.bind(target) : value;
      },
    });

  return new Proxy(db, {
    get(target, property) {
      if (property === "prepare")
        return (query: string) => wrap(target.prepare(query));
      // A caller's own batch takes the unwrapped statements it was given.
      if (property === "batch")
        return (statements: Array<D1PreparedStatement>) =>
          target.batch(statements.map(unwrapped));
      const value = Reflect.get(target, property);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
};

/** The real statement behind a wrapped one, for `db.batch`. */
const unwrapped = (statement: D1PreparedStatement): D1PreparedStatement =>
  (statement as { [statementKey]?: D1PreparedStatement })[statementKey] ??
  statement;
