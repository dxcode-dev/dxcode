import { Menu } from "@base-ui/react/menu";
import { Popover } from "@base-ui/react/popover";
import type { ThreadId } from "@dx/domain";
import { useQuery } from "@tanstack/react-query";
import { Check, ChevronRight } from "lucide-react";
import { createPortal } from "react-dom";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { MarkdownView } from "../../../shared/ui/markdown-view.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import {
  type Chip,
  chipSource,
  instantOf,
  localDate,
  parseChip,
} from "../markdown/chips.js";
import type {
  ArtifactSession,
  ArtifactSessionSnapshot,
} from "./artifact-session.js";

/** `YYYY-MM-DDTHH:MM` in the reader's zone, as a datetime-local input wants. */
const localInput = (instant: string) => {
  const date = new Date(instant);
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}T${pad(date.getHours())}:${pad(date.getMinutes())}`;
};

function ChipFields({
  chip,
  onChange,
}: {
  readonly chip: Chip;
  readonly onChange: (chip: Chip) => void;
}) {
  switch (chip.kind) {
    case "date":
      return (
        <label className="artifact-chip-field">
          <span>Date</span>
          <input
            type="date"
            value={chip.date}
            onChange={(event) => {
              const date = event.currentTarget.value;
              if (date !== "") onChange({ ...chip, date });
            }}
          />
        </label>
      );
    case "time":
      return (
        <label className="artifact-chip-field">
          <span>Time</span>
          <input
            type="datetime-local"
            value={localInput(chip.instant)}
            onChange={(event) => {
              const value = event.currentTarget.value;
              if (value !== "")
                onChange({ ...chip, instant: instantOf(new Date(value)) });
            }}
          />
        </label>
      );
    case "dropdown":
      return (
        <div
          className="artifact-chip-options"
          role="listbox"
          aria-label="Options"
        >
          {chip.options.map((option, index) => (
            <button
              key={option.label}
              type="button"
              role="option"
              aria-selected={option.selected}
              className="artifact-chip-option"
              data-color={option.color}
              onClick={() =>
                onChange({
                  ...chip,
                  options: chip.options.map((other, at) => ({
                    ...other,
                    selected: at === index,
                  })),
                })
              }
            >
              <span className="artifact-chip-swatch" aria-hidden="true" />
              <span>{option.label}</span>
              {option.selected ? <Check aria-hidden="true" /> : null}
            </button>
          ))}
        </div>
      );
    default:
      return null;
  }
}

/** The open chip's picker, placed against the chip. */
export function ChipPicker({
  session,
  open,
}: {
  readonly session: ArtifactSession;
  readonly open: ArtifactSessionSnapshot["chip"];
}) {
  if (open === undefined) return null;
  return (
    <Popover.Root
      open
      onOpenChange={(next) => {
        if (!next) session.closeChip();
      }}
    >
      <Popover.Portal>
        <Popover.Positioner
          className="thread-menu-positioner"
          anchor={() => session.chipElement(open.pos)}
          side="bottom"
          align="start"
          sideOffset={6}
        >
          <Popover.Popup
            className="thread-menu-popup artifact-chip-picker"
            aria-label="Edit chip"
          >
            <ChipFields
              chip={open.chip}
              onChange={(chip) => {
                session.setChip(open.pos, chip);
                if (chip.kind === "dropdown") session.closeChip();
              }}
            />
          </Popover.Popup>
        </Popover.Positioner>
      </Popover.Portal>
    </Popover.Root>
  );
}

/** A member's mention, when their name and ID can be written as one. */
const mentionOf = (member: {
  readonly name: string;
  readonly userId: string;
}) => {
  const source = `@[${member.name.replace(/[\][\n]/g, "").trim()}](user:${member.userId})`;
  return parseChip(source)?.kind === "mention" ? source : undefined;
};

/** Insert ▸ Date, Time, Dropdown, Toggle, and Mention. */
export function ChipInsertItems({
  threadId,
  onInsert,
}: {
  readonly threadId: ThreadId;
  readonly onInsert: (source: string) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const members = useQuery(threadMembersQueryOptions(identity.id, threadId));
  const people = (members.data ?? []).filter(
    (member) => member.userId !== identity.id,
  );
  return (
    <>
      <Menu.Separator className="thread-menu-separator" />
      <Menu.Item
        className="thread-menu-item"
        onClick={() =>
          onInsert(chipSource({ kind: "date", date: localDate() }))
        }
      >
        Date
      </Menu.Item>
      <Menu.Item
        className="thread-menu-item"
        onClick={() =>
          onInsert(chipSource({ kind: "time", instant: instantOf(new Date()) }))
        }
      >
        Time
      </Menu.Item>
      <Menu.Item
        className="thread-menu-item"
        onClick={() =>
          onInsert(
            chipSource({
              kind: "dropdown",
              options: [
                { label: "Todo", selected: true },
                { label: "Doing", color: "blue", selected: false },
                { label: "Done", color: "green", selected: false },
              ],
            }),
          )
        }
      >
        Dropdown
      </Menu.Item>
      <Menu.Item
        className="thread-menu-item"
        onClick={() =>
          onInsert(
            chipSource({
              kind: "toggle",
              key: "details",
              label: "Show details",
            }),
          )
        }
      >
        Toggle
      </Menu.Item>
      <Menu.SubmenuRoot>
        <Menu.SubmenuTrigger className="thread-menu-item">
          Mention
          <ChevronRight aria-hidden="true" />
        </Menu.SubmenuTrigger>
        <Menu.Portal>
          <Menu.Positioner
            className="thread-menu-positioner"
            alignOffset={-5}
            sideOffset={4}
          >
            <Menu.Popup
              className="thread-menu-popup thread-actions-menu thread-actions-submenu"
              aria-label="Mention"
            >
              <Menu.Item
                className="thread-menu-item"
                onClick={() =>
                  onInsert(chipSource({ kind: "agent", name: "dx" }))
                }
              >
                @dx (the agent)
              </Menu.Item>
              {people.map((member) => (
                <Menu.Item
                  key={member.userId}
                  className="thread-menu-item"
                  disabled={mentionOf(member) === undefined}
                  onClick={() => {
                    const source = mentionOf(member);
                    if (source !== undefined) onInsert(source);
                  }}
                >
                  @{member.name}
                </Menu.Item>
              ))}
            </Menu.Popup>
          </Menu.Positioner>
        </Menu.Portal>
      </Menu.SubmenuRoot>
    </>
  );
}

/** Each `dx-view` block's view, framed into its block. */
export function ViewFrames({
  views,
}: {
  readonly views: ArtifactSessionSnapshot["views"];
}) {
  return (
    <>
      {views.map((frame) =>
        createPortal(
          <MarkdownView
            source={frame.source}
            actions={null}
            fallback={
              <pre className="artifact-view-fallback">{frame.source}</pre>
            }
          />,
          frame.container,
          String(frame.id),
        ),
      )}
    </>
  );
}
