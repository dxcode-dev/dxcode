import type { ThreadId } from "@dx/domain";
import { useInfiniteQuery, useQuery } from "@tanstack/react-query";
import { ArrowUp, Check, Pencil, Trash2, X } from "lucide-react";
import * as React from "react";
import { createPortal } from "react-dom";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Button } from "../../../shared/ui/button.js";
import {
  ComboboxEmpty,
  ComboboxItem,
  ComboboxList,
  ComboboxRoot,
  ComboboxSearch,
} from "../../../shared/ui/combobox.js";
import { Input } from "../../../shared/ui/input.js";
import { MarkdownView } from "../../../shared/ui/markdown-view.js";
import {
  MenuItem,
  MenuPopup,
  MenuSeparator,
  MenuSubmenuRoot,
  MenuSubmenuTrigger,
} from "../../../shared/ui/menu.js";
import { PopoverContent, PopoverRoot } from "../../../shared/ui/popover.js";
import { ProjectsIcon } from "../../../shared/ui/projects-icon.js";
import { projectsQueryOptions } from "../../projects/project-queries.js";
import { threadMembersQueryOptions } from "../../threads/sharing/thread-chat-queries.js";
import {
  CHIP_COLORS,
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

type DropdownChip = Extract<Chip, { readonly kind: "dropdown" }>;

/** Why a new or renamed option can't be written, if it can't. */
const optionProblem = (
  label: string,
  options: DropdownChip["options"],
  except?: number,
) => {
  const text = label.trim();
  if (text === "") return "Type a name.";
  if (/[|{}\n]/u.test(text) || text.startsWith("*"))
    return "A name can't hold |, { or }, or start with *.";
  if (options.some((option, at) => at !== except && option.label === text))
    return "That option is already there.";
  return undefined;
};

/**
 * A dropdown's options, as the reference editor edits them (#1865): pick
 * one; rename it (the pencil, or a double click); cycle its color; move it
 * up; remove it; add one at the end; or remove the dropdown.
 */
function DropdownFields({
  chip,
  onChange,
}: {
  readonly chip: DropdownChip;
  readonly onChange: (chip: Chip, close?: boolean | "remove") => void;
}) {
  const [renaming, setRenaming] = React.useState<number>();
  const [problem, setProblem] = React.useState<string>();
  const options = chip.options;
  const write = (next: DropdownChip["options"]) => {
    setProblem(undefined);
    onChange({ ...chip, options: next });
  };
  const rename = (index: number, label: string) => {
    const issue = optionProblem(label, options, index);
    if (issue !== undefined) {
      setProblem(issue);
      return;
    }
    setRenaming(undefined);
    write(
      options.map((option, at) =>
        at === index ? { ...option, label: label.trim() } : option,
      ),
    );
  };
  return (
    <div className="artifact-chip-dropdown">
      <div
        className="artifact-chip-options"
        role="listbox"
        aria-label="Options"
      >
        {options.map((option, index) => (
          <div
            key={option.label}
            className="artifact-chip-option-row"
            data-color={option.color}
          >
            {renaming === index ? (
              <Input
                size="md"
                className="artifact-chip-rename"
                aria-label={`Name of ${option.label}`}
                defaultValue={option.label}
                ref={(node) => node?.select()}
                maxLength={60}
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    event.preventDefault();
                    rename(index, event.currentTarget.value);
                  } else if (event.key === "Escape") {
                    event.preventDefault();
                    event.stopPropagation();
                    setRenaming(undefined);
                    setProblem(undefined);
                  }
                }}
                onBlur={(event) => rename(index, event.currentTarget.value)}
              />
            ) : (
              <button
                type="button"
                role="option"
                aria-selected={option.selected}
                className="artifact-chip-option"
                onClick={() =>
                  onChange(
                    {
                      ...chip,
                      options: options.map((other, at) => ({
                        ...other,
                        selected: at === index,
                      })),
                    },
                    true,
                  )
                }
                onDoubleClick={() => setRenaming(index)}
              >
                <span className="artifact-chip-swatch" aria-hidden="true" />
                <span>{option.label}</span>
                {option.selected ? <Check aria-hidden="true" /> : null}
              </button>
            )}
            <Button
              variant="subtle"
              size="icon-xs"
              className="artifact-chip-tool"
              aria-label={`Rename ${option.label}`}
              title="Rename"
              onClick={() => setRenaming(index)}
            >
              <Pencil aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="icon-xs"
              className="artifact-chip-tool artifact-chip-color"
              aria-label={`Change Color of ${option.label}`}
              title="Change color"
              onClick={() =>
                write(
                  options.map((other, at) => {
                    if (at !== index) return other;
                    const next =
                      CHIP_COLORS[
                        (CHIP_COLORS.indexOf(other.color ?? "gray") + 1) %
                          CHIP_COLORS.length
                      ];
                    // In the parser's key order, which the chip is checked by.
                    return next === "gray"
                      ? { label: other.label, selected: other.selected }
                      : {
                          label: other.label,
                          color: next,
                          selected: other.selected,
                        };
                  }),
                )
              }
            >
              <span className="artifact-chip-swatch" aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="icon-xs"
              className="artifact-chip-tool"
              aria-label={`Move ${option.label} Up`}
              title="Move up"
              disabled={index === 0}
              onClick={() =>
                write(
                  options.toSpliced(
                    index - 1,
                    2,
                    option,
                    options[index - 1] ?? option,
                  ),
                )
              }
            >
              <ArrowUp aria-hidden="true" />
            </Button>
            <Button
              variant="subtle"
              size="icon-xs"
              className="artifact-chip-tool"
              aria-label={`Remove ${option.label}`}
              title="Remove"
              disabled={options.length === 1}
              onClick={() => write(options.toSpliced(index, 1))}
            >
              <X aria-hidden="true" />
            </Button>
          </div>
        ))}
      </div>
      <div className="artifact-chip-add">
        <Input
          size="md"
          aria-label="New option"
          placeholder="Add an option"
          maxLength={60}
          onKeyDown={(event) => {
            if (event.key !== "Enter") return;
            event.preventDefault();
            const input = event.currentTarget;
            const issue = optionProblem(input.value, options);
            if (issue !== undefined) {
              setProblem(issue);
              return;
            }
            write([...options, { label: input.value.trim(), selected: false }]);
            input.value = "";
          }}
        />
        <Button
          variant="subtle"
          size="icon-xs"
          className="artifact-chip-tool"
          aria-label="Remove Dropdown"
          title="Remove dropdown"
          onClick={() => onChange(chip, "remove")}
        >
          <Trash2 aria-hidden="true" />
        </Button>
      </div>
      {problem === undefined ? null : (
        <p className="artifact-chip-problem" role="alert">
          {problem}
        </p>
      )}
    </div>
  );
}

function ChipFields({
  chip,
  onChange,
}: {
  readonly chip: Chip;
  readonly onChange: (chip: Chip, close?: boolean | "remove") => void;
}) {
  switch (chip.kind) {
    case "date":
      return (
        <label className="artifact-chip-field">
          <span>Date</span>
          <Input
            size="md"
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
          <Input
            size="md"
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
      return <DropdownFields chip={chip} onChange={onChange} />;
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
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) session.closeChip();
      }}
    >
      <PopoverContent
        anchor={() => session.chipElement(open.pos)}
        side="bottom"
        align="start"
        className="artifact-chip-picker"
        aria-label="Edit chip"
      >
        <ChipFields
          chip={open.chip}
          onChange={(chip, close) => {
            if (close === "remove") {
              session.removeChip(open.pos);
              return;
            }
            session.setChip(open.pos, chip);
            if (close === true) session.closeChip();
          }}
        />
      </PopoverContent>
    </PopoverRoot>
  );
}

interface ProjectOption {
  readonly id: string;
  readonly name: string;
}

/** The reader's Projects to search, as the sidebar lists them. */
function ProjectOptions({ session }: { readonly session: ArtifactSession }) {
  const { identity } = useAuthenticatedIdentity();
  const projects = useInfiniteQuery(projectsQueryOptions(identity.id));
  const items: ReadonlyArray<ProjectOption> = (
    projects.data?.pages ?? []
  ).flatMap((page) =>
    page.items.map((project) => ({ id: project.id, name: project.name })),
  );
  return (
    <ComboboxRoot
      inline
      open
      autoHighlight
      items={items}
      itemToStringLabel={(project: ProjectOption) => project.name}
      onValueChange={(project: ProjectOption | null) => {
        if (project !== null) session.insertProject(project);
      }}
    >
      <ComboboxSearch
        placeholder="Search projects"
        aria-label="Search projects"
      />
      <ComboboxEmpty>
        {projects.isPending
          ? "Loading projects…"
          : projects.isError
            ? "Couldn't load your projects."
            : "No matching projects."}
      </ComboboxEmpty>
      <ComboboxList aria-label="Projects">
        {(project: ProjectOption) => (
          <ComboboxItem key={project.id} value={project} check={false}>
            <ProjectsIcon />
            <span className="dx-picker-item-label">{project.name}</span>
          </ComboboxItem>
        )}
      </ComboboxList>
    </ComboboxRoot>
  );
}

/**
 * `/` Project's picker at the caret: type to search the reader's Projects,
 * arrows and Enter (or a click) insert one's chip, Escape goes back.
 */
export function ProjectChipPicker({
  session,
  open,
}: {
  readonly session: ArtifactSession;
  readonly open: ArtifactSessionSnapshot["project"];
}) {
  if (open === undefined) return null;
  return (
    <PopoverRoot
      open
      onOpenChange={(next) => {
        if (!next) session.closeProjectPicker();
      }}
    >
      <PopoverContent
        anchor={session.caretAnchor(open.pos)}
        side="bottom"
        align="start"
        className="artifact-project-picker"
        aria-label="Insert project"
      >
        <ProjectOptions session={session} />
      </PopoverContent>
    </PopoverRoot>
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
  agent,
  onInsert,
}: {
  readonly threadId: ThreadId;
  /** The Thread has an agent to mention; a standalone artifact's has none. */
  readonly agent: boolean;
  readonly onInsert: (source: string) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const members = useQuery(threadMembersQueryOptions(identity.id, threadId));
  const people = (members.data ?? []).filter(
    (member) => member.userId !== identity.id,
  );
  return (
    <>
      <MenuSeparator />
      <MenuItem
        onClick={() =>
          onInsert(chipSource({ kind: "date", date: localDate() }))
        }
      >
        Date
      </MenuItem>
      <MenuItem
        onClick={() =>
          onInsert(chipSource({ kind: "time", instant: instantOf(new Date()) }))
        }
      >
        Time
      </MenuItem>
      <MenuItem
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
      </MenuItem>
      <MenuItem
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
      </MenuItem>
      <MenuSubmenuRoot>
        <MenuSubmenuTrigger>
          <span>Mention</span>
        </MenuSubmenuTrigger>
        <MenuPopup alignOffset={-5} aria-label="Mention">
          {agent ? (
            <MenuItem
              onClick={() =>
                onInsert(chipSource({ kind: "agent", name: "dx" }))
              }
            >
              @dx (the agent)
            </MenuItem>
          ) : null}
          {people.map((member) => (
            <MenuItem
              key={member.userId}
              disabled={mentionOf(member) === undefined}
              onClick={() => {
                const source = mentionOf(member);
                if (source !== undefined) onInsert(source);
              }}
            >
              @{member.name}
            </MenuItem>
          ))}
        </MenuPopup>
      </MenuSubmenuRoot>
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
