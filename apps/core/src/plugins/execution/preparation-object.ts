import { DurableObject } from "cloudflare:workers";
import { Effect } from "effect";
import { orbProviderConnectors } from "../../execution/connectors.js";
import type { Bindings } from "../../http/types.js";
import { orbProvidersLogger } from "../../logging.js";
import { decodeD1Binding } from "../../persistence/d1-binding.js";
import type { OrbConnectionKey } from "./connections-d1.js";
import {
  advanceConnection,
  type PreparationStepOutcome,
  TRANSIENT_RETRY_MS,
} from "./preparation.js";

/**
 * One connection's preparation: its alarm runs the next step until the
 * connection is ready or failed. Preparation outlives the save request,
 * because it takes minutes and some steps (copying an image) are long.
 */
export class OrbProviderPreparationObject extends DurableObject<Bindings> {
  async prepare(key: OrbConnectionKey) {
    await this.ctx.storage.put({ key, transientFailures: 0 });
    const alarm = await this.ctx.storage.getAlarm();
    if (alarm === null || alarm > Date.now() + 1_000)
      await this.ctx.storage.setAlarm(Date.now());
  }

  override async alarm() {
    const key = await this.ctx.storage.get<OrbConnectionKey>("key");
    if (key === undefined) return;
    const failures =
      (await this.ctx.storage.get<number>("transientFailures")) ?? 0;
    const db = await Effect.runPromise(decodeD1Binding(this.env.DB));
    const outcome = await advanceConnection(
      this.env,
      db,
      key,
      orbProviderConnectors,
      failures,
    ).catch((cause: unknown): PreparationStepOutcome => {
      orbProvidersLogger.error("Orb provider preparation failed to run.", {
        event: "orb_preparation_failed",
        provider: key.providerId,
        error: cause instanceof Error ? cause.message.slice(0, 200) : "unknown",
      });
      return { nextStepInMs: TRANSIENT_RETRY_MS, transient: true };
    });
    await this.ctx.storage.put(
      "transientFailures",
      outcome.transient ? failures + 1 : 0,
    );
    if (outcome.nextStepInMs !== undefined)
      await this.ctx.storage.setAlarm(Date.now() + outcome.nextStepInMs);
  }
}
