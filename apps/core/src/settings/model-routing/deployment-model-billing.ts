/**
 * What a deployment charges for the dx models it provides
 * (deployment-models.ts). Core asks `admit` before a submission's route is
 * pinned and reports each recorded request's price to `charge`. Public dx
 * ships `noDeploymentModelBilling`, which charges nothing; a deployment
 * registers its own policy in `deployment-models-registration.ts`,
 * which the public export replaces with the no-op.
 */
export interface DeploymentModelBilling {
  /**
   * Whether `userId` may start a submission or a call on a dx model. A
   * refusal's reason is what the Thread shows. Must read only the
   * deployment's state. With `hold`, an admitted call also holds
   * `model.reserveMicros` of the balance until `release`, in the same
   * statement as the check, so parallel calls can't all pass one read.
   */
  readonly admit: (
    db: D1Database,
    userId: string,
    model: {
      /** The model's floor: admit only while the balance is above it. */
      readonly minBalanceMicros: number;
      /** The most one call of the model can cost. */
      readonly reserveMicros?: number;
      /** The model's dx name, such as "dx Flash", for the refusal. */
      readonly name?: string;
    },
    hold?: { readonly id: string },
  ) => Promise<
    | { readonly admitted: true }
    | {
        readonly reason: string;
        /**
         * The balance is above zero and only the model's floor stopped it:
         * a cheaper model, or a little more credit, would start.
         */
        readonly belowFloor?: true;
        /**
         * Only the person's other running calls stopped it: it can start
         * once one of them ends.
         */
        readonly busy?: true;
      }
  >;
  /** Ends a call's hold from `admit`: the call has ended. */
  readonly release: (
    db: D1Database,
    userId: string,
    hold: { readonly id: string },
  ) => Promise<void>;
  /**
   * Charges one recorded dx model request, once per `reference`. Failures
   * are logged by the caller, never retried by it.
   */
  readonly charge: (
    db: D1Database,
    charge: {
      readonly reference: string;
      readonly userId: string;
      readonly threadId: string;
      readonly micros: number;
    },
  ) => Promise<void>;
}

export const noDeploymentModelBilling: DeploymentModelBilling = {
  admit: async () => ({ admitted: true }),
  release: async () => undefined,
  charge: async () => undefined,
};
