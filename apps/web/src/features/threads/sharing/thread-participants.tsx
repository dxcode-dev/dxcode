import { Menu } from "@base-ui/react/menu";
import type {
  ThreadContributeDuration,
  ThreadDetailData,
  ThreadParticipantData,
} from "@dx/api";
import type { UserId } from "@dx/domain";
import { ChevronRight, Settings2, UserRoundX, UsersRound } from "lucide-react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Avatar, ParticipantStack } from "../../../shared/ui/avatar.js";
import { useThreadPresentUsers } from "../realtime/realtime-provider.js";
import { formatRemaining } from "./sharing-format.js";
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
  const { identity } = useAuthenticatedIdentity();
  const presentUsers = useThreadPresentUsers(thread.id);
  const present = new Set<string>(presentUsers ?? []);
  const mutation = useUpdateThreadSharing(identity.id, thread.id);
  const participants = orderedParticipants(thread.participants ?? [], present);
  if (participants.length === 0 && thread.sharing === undefined) return null;
  const own = thread.access === undefined || thread.access === "owner";
  const multiplayer = thread.sharing?.workspaceAccess === "contribute";
  const liveCount = participants.filter(({ userId }) =>
    present.has(userId),
  ).length;
  return (
    <Menu.Root>
      <Menu.Trigger
        className="thread-participants-trigger"
        aria-label={`${participants.length} ${participants.length === 1 ? "person" : "people"} in this thread${liveCount > 0 ? `, ${liveCount} here now` : ""}`}
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
      </Menu.Trigger>
      <Menu.Portal>
        <Menu.Positioner
          className="thread-menu-positioner"
          align="end"
          sideOffset={4}
        >
          <Menu.Popup className="thread-menu-popup thread-participants-menu">
            <Menu.Group>
              <Menu.GroupLabel className="thread-menu-label">
                {multiplayer ? "Multiplayer" : "Shared with workspace"}
              </Menu.GroupLabel>
              {participants.map((participant) => (
                <div
                  className="thread-participant-row"
                  key={participant.userId}
                >
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
                  {participant.owner ? (
                    <span className="thread-participant-badge">Owner</span>
                  ) : null}
                  {present.has(participant.userId) ? (
                    <span
                      className="thread-participant-live"
                      role="img"
                      aria-label="Here now"
                    />
                  ) : null}
                </div>
              ))}
            </Menu.Group>
            {own ? <Menu.Separator className="thread-menu-separator" /> : null}
            {own && multiplayer && thread.sharing?.contributeUntil ? (
              <Menu.SubmenuRoot>
                <Menu.SubmenuTrigger className="thread-menu-item">
                  Remaining: {formatRemaining(thread.sharing.contributeUntil)}
                  <ChevronRight />
                </Menu.SubmenuTrigger>
                <Menu.Portal>
                  <Menu.Positioner
                    className="thread-menu-positioner"
                    sideOffset={2}
                  >
                    <Menu.Popup className="thread-menu-popup">
                      <Menu.Group>
                        <Menu.GroupLabel className="thread-menu-label">
                          Keep On For
                        </Menu.GroupLabel>
                        {durations.map((duration) => (
                          <Menu.Item
                            key={duration.value}
                            className="thread-menu-item"
                            disabled={mutation.isPending}
                            onClick={() =>
                              mutation.mutate({
                                workspaceAccess: "contribute",
                                contributeFor: duration.value,
                              })
                            }
                          >
                            {duration.label}
                          </Menu.Item>
                        ))}
                      </Menu.Group>
                      <Menu.Separator className="thread-menu-separator" />
                      <Menu.Item
                        className="thread-menu-item"
                        disabled={mutation.isPending}
                        onClick={() =>
                          mutation.mutate({ workspaceAccess: "view" })
                        }
                      >
                        <UserRoundX />
                        <span>Disable Multiplayer</span>
                      </Menu.Item>
                    </Menu.Popup>
                  </Menu.Positioner>
                </Menu.Portal>
              </Menu.SubmenuRoot>
            ) : null}
            {own && !multiplayer && onEnableMultiplayer !== undefined ? (
              <Menu.Item
                className="thread-menu-item"
                onClick={onEnableMultiplayer}
              >
                <UsersRound />
                <span>Enable Multiplayer…</span>
              </Menu.Item>
            ) : null}
            {own && onOpenShare !== undefined ? (
              <Menu.Item className="thread-menu-item" onClick={onOpenShare}>
                <Settings2 />
                <span>Sharing settings…</span>
              </Menu.Item>
            ) : null}
          </Menu.Popup>
        </Menu.Positioner>
      </Menu.Portal>
    </Menu.Root>
  );
}
