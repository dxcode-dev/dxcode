import { Popover } from "@base-ui/react/popover";
import { SmilePlus } from "lucide-react";
import * as React from "react";
import {
  REACTION_EMOJI,
  REACTION_NAME,
  REACTIONS,
  type Reaction,
  type ReactionCount,
} from "./reaction-set.js";
import "./reactions.css";

/**
 * The five reactions people give a Space's posts and a shared Thread's
 * messages: a row of chips under the message and a picker beside it.
 */

export type ToggleReaction = (reaction: Reaction, on: boolean) => void;

/** One reaction's chip: its emoji and count, pressed when it is the viewer's. */
function ReactionChip({
  reaction,
  enabled,
  onToggle,
}: {
  readonly reaction: ReactionCount;
  readonly enabled: boolean;
  readonly onToggle: ToggleReaction;
}) {
  const who = [
    ...(reaction.mine ? ["You"] : []),
    ...(reaction.agent ? ["dx"] : []),
  ];
  const others = reaction.count - who.length;
  const label = `${REACTION_NAME[reaction.reaction]}: ${[
    ...who,
    ...(others > 0 ? [`${others} more`] : []),
  ].join(", ")}`;
  return (
    <button
      type="button"
      className="reaction-chip"
      data-reaction={reaction.reaction}
      data-agent={reaction.agent ? "" : undefined}
      aria-pressed={reaction.mine}
      aria-label={label}
      title={label}
      disabled={!enabled}
      onClick={() => onToggle(reaction.reaction, !reaction.mine)}
    >
      <span aria-hidden="true">{REACTION_EMOJI[reaction.reaction]}</span>
      <span className="reaction-chip-count">{reaction.count}</span>
    </button>
  );
}

/** A message's reactions that anyone gave, as chips; nothing when none. */
export function ReactionChips({
  reactions,
  enabled,
  onToggle,
}: {
  readonly reactions: ReadonlyArray<ReactionCount>;
  readonly enabled: boolean;
  readonly onToggle: ToggleReaction;
}) {
  const given = reactions.filter(({ count }) => count > 0);
  if (given.length === 0) return null;
  return (
    <div className="reaction-chips">
      {given.map((reaction) => (
        <ReactionChip
          key={reaction.reaction}
          reaction={reaction}
          enabled={enabled}
          onToggle={onToggle}
        />
      ))}
    </div>
  );
}

/** The five reactions, from a message's Add Reaction button. */
export function ReactionPicker({
  reactions,
  onToggle,
  triggerClassName,
}: {
  readonly reactions: ReadonlyArray<ReactionCount>;
  readonly onToggle: ToggleReaction;
  readonly triggerClassName: string;
}) {
  const [open, setOpen] = React.useState(false);
  return (
    <Popover.Root open={open} onOpenChange={setOpen}>
      <Popover.Trigger
        className={triggerClassName}
        aria-label="Add Reaction"
        title="Add Reaction"
      >
        <SmilePlus aria-hidden="true" />
      </Popover.Trigger>
      <Popover.Portal>
        <Popover.Positioner side="top" align="end" sideOffset={6}>
          <Popover.Popup className="reaction-picker">
            {REACTIONS.map((reaction) => {
              const mine =
                reactions.find((item) => item.reaction === reaction)?.mine ===
                true;
              return (
                <button
                  key={reaction}
                  type="button"
                  aria-label={REACTION_NAME[reaction]}
                  title={REACTION_NAME[reaction]}
                  aria-pressed={mine}
                  onClick={() => {
                    setOpen(false);
                    onToggle(reaction, !mine);
                  }}
                >
                  {REACTION_EMOJI[reaction]}
                </button>
              );
            })}
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}
