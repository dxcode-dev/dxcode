import type { ThreadId } from "@dx/domain";
import { useNowMinute } from "../hooks/use-clock.js";
import type { ThreadSnoozeController } from "../thread-snooze.js";
import { snoozePresets } from "../thread-snooze-presets.js";
import { MenuItem, MenuSeparator } from "./menu.js";

/**
 * The wake times a Snooze menu offers, then Custom…. Mounted while the menu
 * is open, so its times are current when it opens.
 */
export function SnoozeMenuItems({
  threadId,
  snooze,
}: {
  readonly threadId: ThreadId;
  readonly snooze: ThreadSnoozeController;
}) {
  const now = useNowMinute();
  return (
    <>
      {snoozePresets(now).map((preset) => (
        <MenuItem
          key={preset.id}
          onClick={() => snooze.snooze(threadId, preset.wakeAt(Date.now()))}
        >
          <span>{preset.label}</span>
          <small className="dx-menu-hint">{preset.when}</small>
        </MenuItem>
      ))}
      <MenuSeparator />
      <MenuItem onClick={() => snooze.snoozeCustom(threadId)}>
        <span>Custom…</span>
      </MenuItem>
    </>
  );
}
