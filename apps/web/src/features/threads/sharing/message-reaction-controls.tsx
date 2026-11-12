import {
  ReactionChips,
  ReactionPicker,
} from "../../../shared/reactions/reactions.js";
import type { RowReactions } from "./message-reactions.js";

/**
 * The reaction picker and chips of a shared Thread's messages, loaded on
 * first use so the Thread page's first load carries none of them.
 */
export default function MessageReactionControls(
  props:
    | { readonly part: "action"; readonly reactions: RowReactions }
    | {
        readonly part: "chips";
        readonly side: "left" | "right";
        readonly reactions: RowReactions;
      },
) {
  const { reactions } = props;
  return props.part === "action" ? (
    <ReactionPicker
      reactions={reactions.reactions}
      onToggle={reactions.toggle}
      triggerClassName="message-actions-button message-reaction-action"
    />
  ) : (
    <div className="message-reactions" data-side={props.side}>
      <ReactionChips
        reactions={reactions.reactions}
        enabled={reactions.canReact}
        onToggle={reactions.toggle}
      />
    </div>
  );
}
