import type { ChoicesData } from "@dx/api";
import type * as React from "react";

/**
 * The New Thread composer's Claude plan list and its limits ("Auto",
 * "Plan 1", "Plan 2", with the info button), for a surface outside the
 * composer, such as Create Space. The application hands it over, so the
 * surface shows the same control without importing the composer's code.
 * `plan` undefined is Auto, or the first plan without the automatic pick.
 */
export type ClaudePlanPickerSlot = React.ComponentType<{
  readonly choices: ChoicesData | undefined;
  readonly model: string;
  readonly plan: string | undefined;
  readonly locked: boolean;
  readonly onPlanChange: (connectionId: string | undefined) => void;
}>;
