import type {
  ThreadContributeDuration,
  ThreadDetailData,
  ThreadParticipantData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { ChevronRight, Settings2, UserRoundX, UsersRound } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Avatar, ParticipantStack } from "../../../shared/ui/avatar.js";
import { Badge } from "../../../shared/ui/badge.js";
import {
  MenuGroup,
  MenuItem,
  MenuLabel,
  MenuPopup,
  MenuRoot,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
  MenuTrigger,
} from "../../../shared/ui/menu.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { useThreadPresentUsers } from "../realtime/realtime-provider.js";
import { formatRemaining, participantsLabel } from "./sharing-format.js";
import { useUpdateThreadSharing } from "./sharing-mutations.js";

const durations: ReadonlyArray<{
  readonly value: ThreadContributeDuration;
  readonly label: string;
}> = [
  { value: "1h", label: "1 Hour" },
  { value: "3h", label: "3 Hours" },
  { value: "3d", label: "3 Days" },
  { value: "7d", label: "7 Days" },
];

/** People shown for a Thread: participants, live ones first. */
const orderedParticipants = (
  participants: ReadonlyArray<ThreadParticipantData>,
  present: ReadonlySet<string>,
) =>
  participants.toSorted(
    (left, right) =>
      Number(present.has(right.userId)) - Number(present.has(left.userId)),
  );

/** Who is in the Thread, who is live, and the owner's Multiplayer controls. */
const useParticipantsState = (thread: ThreadDetailData) => {
  const { identity } = useAuthenticatedIdentity();
  const presentUsers = useThreadPresentUsers(thread.id);
  const present = new Set<string>(presentUsers ?? []);
  const mutation = useUpdateThreadSharing(identity.id, thread.id);
  const participants = orderedParticipants(thread.participants ?? [], present);
  const own = thread.access === undefined || thread.access === "owner";
  const multiplayer = thread.sharing?.workspaceAccess === "contribute";
  return { identity, present, mutation, participants, own, multiplayer };
};

/**
 * Header avatars of everyone in a shared Thread. Opens the Multiplayer menu:
 * who is here, and for the owner how long Contribute stays on.
 */
export function ThreadParticipants({
  thread,
  onOpenShare,
  onEnableMultiplayer,
}: {
  readonly thread: ThreadDetailData;
  readonly onOpenShare?: () => void;
  readonly onEnableMultiplayer?: () => void;
}) {
  const { identity, present, participants, multiplayer } =
    useParticipantsState(thread);
  if (participants.length === 0 && thread.sharing === undefined) return null;
  const liveCount = participants.filter(({ userId }) =>
    present.has(userId),
  ).length;
  return (
    <MenuRoot>
      <MenuTrigger
        className="thread-participants-trigger"
        aria-label={participantsLabel(participants.length, liveCount)}
        title={participants
          .map(
            (participant) =>
              `${participant.userId === identity.id ? "You" : participant.name}${participant.owner ? " (Owner)" : ""}${present.has(participant.userId) ? " · live" : ""}`,
          )
          .join("\n")}
      >
        {multiplayer ? (
          <UsersRound className="thread-multiplayer-icon" aria-hidden="true" />
        ) : null}
        <ParticipantStack participants={participants} present={present} />
      </MenuTrigger>
      <MenuPopup align="end" className="thread-participants-menu">
        <ThreadParticipantsMenuContent
          thread={thread}
          onOpenShare={onOpenShare}
          onEnableMultiplayer={onEnableMultiplayer}
        />
      </MenuPopup>
    </MenuRoot>
  );
}

/**
 * The Multiplayer menu's rows: everyone in the Thread, then the owner's
 * controls. Also the body of the Thread menu's People submenu when a narrow
 * title bar has no room for the avatars.
 */
export function ThreadParticipantsMenuContent({
  thread,
  onOpenShare,
  onEnableMultiplayer,
}: {
  readonly thread: ThreadDetailData;
  readonly onOpenShare?: () => void;
  readonly onEnableMultiplayer?: () => void;
}) {
  const { identity, present, mutation, participants, own, multiplayer } =
    useParticipantsState(thread);
  const contributeUntil = thread.sharing?.contributeUntil;
  return (
    <>
      <MenuGroup>
        <MenuLabel>
          {multiplayer ? "Multiplayer" : "Shared with workspace"}
        </MenuLabel>
        {participants.map((participant) => (
          <div className="thread-participant-row" key={participant.userId}>
            <Avatar
              name={participant.name}
              image={participant.image}
              seed={participant.userId}
            />
            <span className="thread-participant-name">
              {participant.userId === (identity.id as UserId)
                ? "You"
                : participant.name}
            </span>
            {participant.owner ? <Badge>Owner</Badge> : null}
            {present.has(participant.userId) ? (
              <span
                className="thread-participant-live"
                role="img"
                aria-label="Here now"
              />
            ) : null}
          </div>
        ))}
      </MenuGroup>
      {own ? <MenuSeparator /> : null}
      {own && multiplayer && contributeUntil ? (
        <MenuSubmenuRoot>
          <MenuSubmenuTrigger>
            <span>
              Remaining:{" "}
              <TimeText text={(now) => formatRemaining(contributeUntil, now)} />
            </span>
            <ChevronRight />
          </MenuSubmenuTrigger>
          <MenuPopup sideOffset={2}>
            <MenuGroup>
              <MenuLabel>Keep On For</MenuLabel>
              {durations.map((duration) => (
                <MenuItem
                  key={duration.value}
                  disabled={mutation.isPending}
                  onClick={() =>
                    mutation.mutate({
                      workspaceAccess: "contribute",
                      contributeFor: duration.value,
                    })
                  }
                >
                  {duration.label}
                </MenuItem>
              ))}
            </MenuGroup>
            <MenuSeparator />
            <MenuItem
              disabled={mutation.isPending}
              onClick={() => mutation.mutate({ workspaceAccess: "view" })}
            >
              <UserRoundX />
              <span>Disable Multiplayer</span>
            </MenuItem>
          </MenuPopup>
        </MenuSubmenuRoot>
      ) : null}
      {own && !multiplayer && onEnableMultiplayer !== undefined ? (
        <MenuItem onClick={onEnableMultiplayer}>
          <UsersRound />
          <span>Enable Multiplayer…</span>
        </MenuItem>
      ) : null}
      {own && onOpenShare !== undefined ? (
        <MenuItem onClick={onOpenShare}>
          <Settings2 />
          <span>Sharing settings…</span>
        </MenuItem>
      ) : null}
    </>
  );
}
