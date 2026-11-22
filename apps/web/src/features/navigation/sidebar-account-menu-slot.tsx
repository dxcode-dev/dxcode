import type { PersonalAccountData, SettingsContextData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { bugReportAccessQueryOptions } from "../threads/bug-reports/bug-report-queries.js";
import {
  type AccountMenuItems,
  SidebarAccountMenu,
} from "./sidebar-account-menu.js";

/**
 * The account menu, with All Bug Reports for the deployment's report
 * readers: it asks once whether this person is one. A deployment's own
 * items, such as Admin, decide for themselves whether to show.
 */
export function SidebarAccountMenuSlot({
  userId,
  accountMenuItems: Items,
  ...props
}: {
  readonly userId: UserId;
  readonly accountMenuItems?: AccountMenuItems;
  readonly personalAccount?: PersonalAccountData;
  readonly settingsContext?: SettingsContextData;
  readonly onNavigate: () => void;
}) {
  const reader =
    useQuery(bugReportAccessQueryOptions(userId)).data?.reader === true;
  return (
    <SidebarAccountMenu
      {...props}
      bugReportReader={reader}
      deploymentItems={
        Items === undefined ? undefined : (
          <Items userId={userId} onNavigate={props.onNavigate} />
        )
      }
    />
  );
}
