import { DurableObject } from "cloudflare:workers";
import type { Bindings } from "../../http/types.js";
import { sourceControlLogger } from "../../logging.js";
import type {
  BitbucketRenewer,
  RenewalJournal,
  RenewalJournalEntry,
  RenewalOutcome,
  RenewalRequest,
} from "./token-renewal.js";
import { renewalFor } from "./token-renewer.js";

const JOURNAL_KEY = "renewal-journal";

/**
 * One object per Bitbucket connection. It renews that connection's tokens
 * one at a time, journals each answer in its own storage the moment it
 * arrives, and keeps working when the request that asked disconnects: an
 * outbound fetch keeps a Durable Object running, where a cancelled Worker
 * request would drop the rotated refresh token.
 */
export class BitbucketTokenCoordinatorObject extends DurableObject<Bindings> {
  #chain: Promise<unknown> = Promise.resolve();

  renew(request: RenewalRequest): Promise<RenewalOutcome> {
    const run = this.#chain
      .catch(() => undefined)
      .then(() => this.#renew(request));
    this.#chain = run.catch(() => undefined);
    this.ctx.waitUntil(this.#chain);
    return run;
  }

  async #renew(request: RenewalRequest): Promise<RenewalOutcome> {
    const db = this.env.DB;
    if (db === undefined) return { outcome: "unavailable" };
    const storage = this.ctx.storage;
    const journal: RenewalJournal = {
      read: () => storage.get<RenewalJournalEntry>(JOURNAL_KEY),
      write: (entry) => storage.put(JOURNAL_KEY, entry),
      clear: async () => {
        await storage.delete(JOURNAL_KEY);
      },
    };
    let renewal: BitbucketRenewer;
    try {
      renewal = await renewalFor(this.env, db, () => journal);
    } catch {
      sourceControlLogger.warn("Bitbucket token refresh settled.", {
        event: "bitbucket_token_refresh",
        connectionId: request.connectionId,
        trigger: request.trigger,
        outcome: "retryable",
        reason: "configuration",
      });
      return { outcome: "unavailable" };
    }
    return renewal.renew(request);
  }
}
