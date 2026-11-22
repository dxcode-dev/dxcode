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
   * Whether `userId` may start a submission on a dx model. A refusal's
   * reason is what the Thread shows. Must read only the deployment's state.
   */
  readonly admit: (
    db: D1Database,
    userId: string,
    model: {
      /** The model's floor: admit only while the balance is above it. */
      readonly minBalanceMicros: number;
      /** The model's dx name, such as "dx Flash", for the refusal. */
      readonly name?: string;
    },
  ) => Promise<
    | { readonly admitted: true }
    | {
        readonly reason: string;
        /**
         * The balance is above zero and only the model's floor stopped it:
         * a cheaper model, or a little more credit, would start.
         */
        readonly belowFloor?: true;
      }
  >;
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
  charge: async () => undefined,
};
