import { SidebarGroupingSchema, SidebarOrderSchema } from "@dx/api";
import { Schema } from "effect";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { useSidebarArrangement } from "../../navigation/sidebar-layout-queries.js";
import {
  SettingsCard,
  SettingsRow,
  SettingsSelect,
} from "../settings-primitives.js";

const isGrouping = Schema.is(SidebarGroupingSchema);
const isOrder = Schema.is(SidebarOrderSchema);

/**
 * Sidebar Layout and Sidebar Order. Saved with the sidebar's layout, so the
 * sidebar shows a change at once and every device the person uses follows.
 */
export function SidebarSettings() {
  const { identity } = useAuthenticatedIdentity();
  const arrangement = useSidebarArrangement(identity.id);
  return (
    <SettingsCard title="Threads & Sidebar">
      <SettingsRow
        title="Sidebar Layout"
        description="Group threads by project, or show one list."
        control={
          <SettingsSelect
            label="Sidebar Layout"
            value={arrangement.grouping}
            options={[
              ["project", "By Project"],
              ["list", "One List"],
            ]}
            onValueChange={(value) => {
              if (isGrouping(value)) arrangement.setGrouping(value);
            }}
          />
        }
      />
      <SettingsRow
        title="Sidebar Order"
        description="How threads are sorted within each sidebar group."
        control={
          <SettingsSelect
            label="Sidebar Order"
            value={arrangement.order}
            options={[
              ["activity", "Recent Activity"],
              ["created", "Created"],
            ]}
            onValueChange={(value) => {
              if (isOrder(value)) arrangement.setOrder(value);
            }}
          />
        }
      />
    </SettingsCard>
  );
}
