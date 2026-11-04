import type { PersonalAccountData, SettingsContextData } from "@dx/api";
import type { UserId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { bugReportAccessQueryOptions } from "../threads/bug-reports/bug-report-queries.js";
import { SidebarAccountMenu } from "./sidebar-account-menu.js";

/**
 * The account menu, with All Bug Reports for the deployment's report
 * readers: it asks once whether this person is one.
 */
export function SidebarAccountMenuSlot({
  userId,
  ...props
}: {
  readonly userId: UserId;
  readonly personalAccount?: PersonalAccountData;
  readonly settingsContext?: SettingsContextData;
  readonly onNavigate: () => void;
}) {
  const reader = useQuery(bugReportAccessQueryOptions(userId)).data === true;
  return <SidebarAccountMenu {...props} bugReportReader={reader} />;
}
