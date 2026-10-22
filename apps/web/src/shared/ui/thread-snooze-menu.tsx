import { Menu } from "@base-ui/react/menu";
import type { ThreadId } from "@dx/domain";
import { useNowMinute } from "../hooks/use-clock.js";
import type { ThreadSnoozeController } from "../thread-snooze.js";
import { snoozePresets } from "../thread-snooze-presets.js";

/**
 * The wake times a Snooze menu offers, then Custom…. Mounted while the menu
 * is open, so its times are current when it opens.
 */
export function SnoozeMenuItems({
  threadId,
  snooze,
  itemClassName,
}: {
  readonly threadId: ThreadId;
  readonly snooze: ThreadSnoozeController;
  readonly itemClassName: string;
}) {
  const now = useNowMinute();
  return (
    <>
      {snoozePresets(now).map((preset) => (
        <Menu.Item
          key={preset.id}
          className={itemClassName}
          onClick={() => snooze.snooze(threadId, preset.wakeAt(Date.now()))}
        >
          <span>{preset.label}</span>
          <small className="thread-snooze-when">{preset.when}</small>
        </Menu.Item>
      ))}
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className={itemClassName}
        onClick={() => snooze.snoozeCustom(threadId)}
      >
        <span>Custom…</span>
      </Menu.Item>
    </>
  );
}
