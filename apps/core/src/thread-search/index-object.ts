import { DurableObject } from "cloudflare:workers";
import type { UserId } from "@dx/domain";
import type { Bindings } from "../http/types.js";
import { threadPersistenceLogger } from "../logging.js";
import {
  type IndexableMessage,
  indexableMessages,
  readHistory,
} from "./history.js";
import { auxTerms, excerptAround, ftsTerm, snippetTerm } from "./terms.js";

/**
 * One per Thread owner: the searchable text of that owner's Threads, in
 * SQLite FTS5 inside this object, never in D1.
 *
 * Cloudflare bills a SQLite row read for every FTS5 posting a query steps
 * over (measured: a term in 1,860 documents reads 1,860 rows, and a rowid
 * range seek still steps over the postings before the range). So matching
 * cost is the number of documents holding a term, and the layout keeps that
 * small:
 *
 * - A document is a chunk of up to `CHUNK_MAX_CHARS` of one Thread's
 *   messages joined by blank lines, not one message. New messages
 *   append to the Thread's open chunk, which is rewritten in place.
 * - FTS5 `detail=none` stores no positions, which only phrases would need.
 * - A chunk's rowid encodes its Thread (`ord * 2^21 + seq`), so a match
 *   names its Thread without reading anything else. Seq 0 is the title.
 * - Each term is matched with one scan; the newest matching chunk per Thread
 *   is remembered, and a snippet reads only that one chunk's text.
 */

const SEQ_SPAN = 2 ** 21;
const SCHEMA_VERSION = "2";
/** Chunks grow to about this size before a new one starts. */
const CHUNK_MAX_CHARS = 16_000;
/** A settled turn is indexed shortly after; bursts share one pass. */
const INDEX_DELAY_MS = 2_000;
const BUSY_RETRY_MS = 15_000;
const PENDING_BATCH = 20;
const MAX_ATTEMPTS = 5;

export interface ThreadMatch {
  readonly threadIds: ReadonlyArray<string>;
  /** Per matched Thread, the newest chunk holding the snippet term. */
  readonly snippetChunks: Readonly<Record<string, number>>;
  readonly rowsRead: number;
}

export interface IndexResult {
  readonly inserted: number;
  readonly rowsRead: number;
  readonly rowsWritten: number;
}

type SqlValue = string | number | null;

interface Counter {
  rowsRead: number;
  rowsWritten: number;
}

export class ThreadSearchIndexObject extends DurableObject<Bindings> {
  constructor(ctx: DurableObjectState, env: Bindings) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => this.#migrate());
  }

  #migrate() {
    const sql = this.ctx.storage.sql;
    sql.exec(
      "CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL)",
    );
    const version = sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'schema'")
      .toArray()[0]?.value;
    if (version === SCHEMA_VERSION) return;
    sql.exec(`
      CREATE TABLE IF NOT EXISTS indexed_thread (
        ord INTEGER PRIMARY KEY,
        thread_id TEXT NOT NULL UNIQUE,
        next_seq INTEGER NOT NULL DEFAULT 1,
        open_seq INTEGER,
        last_message_id TEXT,
        title TEXT
      );
      CREATE TABLE IF NOT EXISTS indexed_message (
        ord INTEGER NOT NULL,
        message_id TEXT NOT NULL,
        PRIMARY KEY (ord, message_id)
      ) WITHOUT ROWID;
      CREATE VIRTUAL TABLE IF NOT EXISTS search_fts USING fts5(
        text, aux, tokenize = 'porter unicode61', detail = none
      );
      CREATE TABLE IF NOT EXISTS pending (
        thread_id TEXT PRIMARY KEY,
        title TEXT NOT NULL,
        attempts INTEGER NOT NULL DEFAULT 0
      );
      INSERT INTO meta (key, value) VALUES ('schema', '${SCHEMA_VERSION}')
        ON CONFLICT (key) DO UPDATE SET value = excluded.value;
    `);
  }

  /** Runs one statement, adding its rows read and written to `counter`. */
  #run<T extends Record<string, SqlValue>>(
    counter: Counter,
    query: string,
    ...bindings: SqlValue[]
  ): T[] {
    const cursor = this.ctx.storage.sql.exec<T>(query, ...bindings);
    const rows = cursor.toArray();
    counter.rowsRead += cursor.rowsRead;
    counter.rowsWritten += cursor.rowsWritten;
    return rows;
  }

  #owner() {
    return this.ctx.storage.sql
      .exec<{ value: string }>("SELECT value FROM meta WHERE key = 'owner'")
      .toArray()[0]?.value as UserId | undefined;
  }

  /** Queues a Thread whose turn settled; the alarm indexes it. */
  async enqueue(input: {
    readonly ownerUserId: string;
    readonly threadId: string;
    readonly title: string;
  }): Promise<void> {
    const owner = this.#owner();
    if (owner !== undefined && owner !== input.ownerUserId)
      throw new Error("This search index belongs to another owner.");
    const sql = this.ctx.storage.sql;
    if (owner === undefined)
      sql.exec(
        "INSERT INTO meta (key, value) VALUES ('owner', ?)",
        input.ownerUserId,
      );
    sql.exec(
      `INSERT INTO pending (thread_id, title) VALUES (?, ?)
         ON CONFLICT (thread_id) DO UPDATE SET title = excluded.title`,
      input.threadId,
      input.title,
    );
    if ((await this.ctx.storage.getAlarm()) === null)
      await this.ctx.storage.setAlarm(Date.now() + INDEX_DELAY_MS);
  }

  override async alarm(): Promise<void> {
    const owner = this.#owner();
    const pending = this.ctx.storage.sql
      .exec<{ thread_id: string; title: string; attempts: number }>(
        "SELECT thread_id, title, attempts FROM pending ORDER BY rowid LIMIT ?",
        PENDING_BATCH,
      )
      .toArray();
    if (owner === undefined || pending.length === 0) return;
    let busy = false;
    for (const row of pending) {
      let outcome: "done" | "busy" | "failed";
      try {
        outcome = await this.#catchUp(owner, row.thread_id, row.title);
      } catch (error) {
        outcome = "failed";
        threadPersistenceLogger.warn("Thread search indexing failed.", {
          event: "thread_search_index_failed",
          threadId: row.thread_id,
          code: error instanceof Error ? error.name : "UNKNOWN",
        });
      }
      if (outcome === "done" || row.attempts + 1 >= MAX_ATTEMPTS)
        this.ctx.storage.sql.exec(
          "DELETE FROM pending WHERE thread_id = ?",
          row.thread_id,
        );
      else {
        busy ||= outcome === "busy";
        this.ctx.storage.sql.exec(
          "UPDATE pending SET attempts = attempts + 1 WHERE thread_id = ?",
          row.thread_id,
        );
      }
    }
    const remaining = this.ctx.storage.sql
      .exec<{ n: number }>("SELECT count(*) AS n FROM pending")
      .one().n;
    if (remaining > 0)
      await this.ctx.storage.setAlarm(
        Date.now() + (busy ? BUSY_RETRY_MS : INDEX_DELAY_MS),
      );
  }

  /**
   * Indexes what the Thread gained since its last indexed message. A known
   * Thread reads only its latest prompts, widening until the last indexed
   * message is in view; an unknown one reads its whole history once.
   */
  async #catchUp(
    owner: UserId,
    threadId: string,
    title: string,
  ): Promise<"done" | "busy"> {
    const known = this.ctx.storage.sql
      .exec<{ last_message_id: string | null }>(
        "SELECT last_message_id FROM indexed_thread WHERE thread_id = ?",
        threadId,
      )
      .toArray()[0]?.last_message_id;
    let promptLimit: number | undefined =
      known === undefined || known === null ? undefined : 2;
    for (;;) {
      const read = await readHistory(this.env, owner, threadId, promptLimit);
      if (read.kind === "busy") return "busy";
      if (read.kind === "empty") {
        this.indexMessages(threadId, title, []);
        return "done";
      }
      if (read.kind === "unavailable") {
        threadPersistenceLogger.warn(
          "Thread history was unavailable to index.",
          {
            event: "thread_search_history_unavailable",
            threadId,
            status: read.status,
          },
        );
        return "done";
      }
      const { page } = read;
      if (
        promptLimit !== undefined &&
        page.hasOlder &&
        !page.messages.some(({ id }) => id === known)
      ) {
        promptLimit = promptLimit >= 128 ? undefined : promptLimit * 8;
        continue;
      }
      this.indexMessages(threadId, title, indexableMessages(page));
      return "done";
    }
  }

  /**
   * Appends messages not yet indexed to the Thread's open chunk and
   * refreshes the title. Idempotent: an indexed message is skipped by ID.
   */
  indexMessages(
    threadId: string,
    title: string,
    messages: ReadonlyArray<IndexableMessage>,
  ): IndexResult {
    const counter: Counter = { rowsRead: 0, rowsWritten: 0 };
    let inserted = 0;
    this.ctx.storage.transactionSync(() => {
      this.#run(
        counter,
        "INSERT INTO indexed_thread (thread_id) VALUES (?) ON CONFLICT (thread_id) DO NOTHING",
        threadId,
      );
      const thread = this.#run<{
        ord: number;
        next_seq: number;
        open_seq: number | null;
        title: string | null;
      }>(
        counter,
        "SELECT ord, next_seq, open_seq, title FROM indexed_thread WHERE thread_id = ?",
        threadId,
      )[0];
      if (thread === undefined) return;
      const base = thread.ord * SEQ_SPAN;
      if (thread.title !== title) {
        if (thread.title !== null)
          this.#run(counter, "DELETE FROM search_fts WHERE rowid = ?", base);
        this.#run(
          counter,
          "INSERT INTO search_fts (rowid, text, aux) VALUES (?, ?, ?)",
          base,
          title,
          auxTerms(title),
        );
      }
      const fresh: string[] = [];
      for (const message of messages) {
        const before = counter.rowsWritten;
        this.#run(
          counter,
          `INSERT INTO indexed_message (ord, message_id) VALUES (?, ?)
             ON CONFLICT (ord, message_id) DO NOTHING`,
          thread.ord,
          message.messageId,
        );
        if (counter.rowsWritten > before) fresh.push(message.text);
      }
      let nextSeq = thread.next_seq;
      let openSeq = thread.open_seq;
      if (fresh.length > 0) {
        let existed = openSeq !== null;
        let text =
          openSeq === null
            ? ""
            : (this.#run<{ text: string }>(
                counter,
                "SELECT text FROM search_fts WHERE rowid = ?",
                base + openSeq,
              )[0]?.text ?? "");
        const flush = () => {
          if (openSeq === null || text === "") return;
          if (existed)
            this.#run(
              counter,
              "DELETE FROM search_fts WHERE rowid = ?",
              base + openSeq,
            );
          this.#run(
            counter,
            "INSERT INTO search_fts (rowid, text, aux) VALUES (?, ?, ?)",
            base + openSeq,
            text,
            auxTerms(text),
          );
        };
        for (const message of fresh) {
          if (
            openSeq !== null &&
            text !== "" &&
            text.length + message.length > CHUNK_MAX_CHARS
          ) {
            flush();
            openSeq = null;
          }
          if (openSeq === null) {
            if (nextSeq >= SEQ_SPAN) break;
            openSeq = nextSeq;
            nextSeq += 1;
            text = "";
            existed = false;
          }
          text = text === "" ? message : `${text}\n\n${message}`;
          inserted += 1;
        }
        flush();
      }
      this.#run(
        counter,
        `UPDATE indexed_thread SET next_seq = ?, open_seq = ?, title = ?,
           last_message_id = COALESCE(?, last_message_id) WHERE ord = ?`,
        nextSeq,
        openSeq,
        title,
        messages.at(-1)?.messageId ?? null,
        thread.ord,
      );
    });
    return { inserted, ...counter };
  }

  /**
   * The Threads holding every term somewhere in their messages or title,
   * optionally only among `candidates`. One scan per term.
   */
  matchThreads(
    terms: ReadonlyArray<string>,
    candidates?: ReadonlyArray<string>,
  ): ThreadMatch {
    const counter: Counter = { rowsRead: 0, rowsWritten: 0 };
    const snippetSource = snippetTerm(terms);
    let ords: Map<number, number> | undefined;
    for (const term of terms) {
      // Rowids ascend, so the last chunk seen per Thread is its newest.
      const newest = new Map<number, number>();
      for (const { rowid } of this.#run<{ rowid: number }>(
        counter,
        "SELECT rowid FROM search_fts WHERE search_fts MATCH ?",
        ftsTerm(term),
      ))
        newest.set(Math.floor(rowid / SEQ_SPAN), rowid);
      if (ords === undefined) ords = new Map(newest);
      else
        for (const ord of [...ords.keys()])
          if (!newest.has(ord)) ords.delete(ord);
      if (term === snippetSource)
        for (const [ord, rowid] of newest)
          if (ords.has(ord)) ords.set(ord, rowid);
      if (ords.size === 0) break;
    }
    if (ords === undefined || ords.size === 0)
      return { threadIds: [], snippetChunks: {}, rowsRead: counter.rowsRead };
    const rows = this.#run<{ ord: number; thread_id: string }>(
      counter,
      `SELECT ord, thread_id FROM indexed_thread
        WHERE ord IN (SELECT value FROM json_each(?))`,
      JSON.stringify([...ords.keys()]),
    );
    const allowed = candidates === undefined ? undefined : new Set(candidates);
    const snippetChunks: Record<string, number> = {};
    const threadIds: string[] = [];
    for (const { ord, thread_id } of rows) {
      if (allowed !== undefined && !allowed.has(thread_id)) continue;
      threadIds.push(thread_id);
      const chunk = ords.get(ord);
      if (chunk !== undefined) snippetChunks[thread_id] = chunk;
    }
    return { threadIds, snippetChunks, rowsRead: counter.rowsRead };
  }

  /** An excerpt around `term` from each named chunk: one row read each. */
  snippets(
    chunks: Readonly<Record<string, number>>,
    term: string,
  ): { readonly snippets: Record<string, string>; readonly rowsRead: number } {
    const counter: Counter = { rowsRead: 0, rowsWritten: 0 };
    const snippets: Record<string, string> = {};
    for (const [threadId, rowid] of Object.entries(chunks)) {
      const text = this.#run<{ text: string }>(
        counter,
        "SELECT text FROM search_fts WHERE rowid = ?",
        rowid,
      )[0]?.text;
      const excerpt = text === undefined ? "" : excerptAround(text, term);
      if (excerpt !== "") snippets[threadId] = excerpt;
    }
    return { snippets, rowsRead: counter.rowsRead };
  }

  /** Removes a Thread's text from the index. */
  dropThread(threadId: string): void {
    const counter: Counter = { rowsRead: 0, rowsWritten: 0 };
    this.ctx.storage.transactionSync(() => {
      this.#run(counter, "DELETE FROM pending WHERE thread_id = ?", threadId);
      const ord = this.#run<{ ord: number }>(
        counter,
        "SELECT ord FROM indexed_thread WHERE thread_id = ?",
        threadId,
      )[0]?.ord;
      if (ord === undefined) return;
      this.#run(
        counter,
        "DELETE FROM search_fts WHERE rowid BETWEEN ? AND ?",
        ord * SEQ_SPAN,
        ord * SEQ_SPAN + SEQ_SPAN - 1,
      );
      this.#run(counter, "DELETE FROM indexed_message WHERE ord = ?", ord);
      this.#run(counter, "DELETE FROM indexed_thread WHERE ord = ?", ord);
    });
  }
}
