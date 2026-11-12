import { WorkerEntrypoint } from "cloudflare:workers";
import type { Bindings } from "../http/types.js";
import type {
  PortalFeedbackSend,
  PortalFeedbackService,
} from "../portals/feedback.js";
import { portalFeedbackService } from "./portal-feedback.js";

/**
 * Core's Feedback Widget service for the Portal Worker, which reaches it
 * through a service binding (PORTAL_FEEDBACK). A named entrypoint is not
 * reachable from the Internet, only from Workers bound to it.
 */
export class PortalFeedback
  extends WorkerEntrypoint<Bindings>
  implements PortalFeedbackService
{
  #service() {
    return portalFeedbackService(this.env, (promise) =>
      this.ctx.waitUntil(promise),
    );
  }

  enabled(userId: string) {
    return this.#service().enabled(userId);
  }

  script(userId: string) {
    return this.#service().script(userId);
  }

  send(input: PortalFeedbackSend) {
    return this.#service().send(input);
  }
}
