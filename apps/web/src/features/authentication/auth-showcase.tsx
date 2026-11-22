import { ArrowUp, ChevronRight, Paperclip } from "lucide-react";
import * as React from "react";
import { useMountEffect } from "../../shared/hooks/use-mount-effect.js";
import { REACTION_EMOJI } from "../../shared/reactions/reaction-set.js";
import "../../shared/reactions/reactions.css";
import { Avatar } from "../../shared/ui/avatar.js";
import { Chip } from "../../shared/ui/chip.js";
import { OrbIcon } from "../../shared/ui/orb-icon.js";
import "./auth-showcase.css";

/**
 * The panel beside the sign-in form on a wide screen: a small dx thread where
 * three teammates and the agent work together. Their pointers move to real
 * controls and use them (Leo reacts, Sam writes to the agent), and the
 * visitor joins as "You": their pointer gets a name tag, and they can react
 * or write a message too.
 *
 * It draws from the thread's own look (user-message bubbles, the "Worked
 * for" line, reaction chips) on the design tokens and loads nothing. Pointers
 * move by transform and every scripted change fills a place already laid
 * out, so the page never shifts. Decorative: screen readers skip it and
 * Tab never lands in it.
 */

type Person = "maya" | "leo" | "sam";
type Hover = "work" | "chip" | "composer" | "send" | undefined;
interface Posted {
  readonly who: "Sam Ortiz" | "You";
  readonly text: string;
}

const PEOPLE: ReadonlyArray<{
  readonly id: Person;
  readonly name: string;
  readonly color: "green" | "red" | "purple";
}> = [
  { id: "maya", name: "Maya", color: "green" },
  { id: "leo", name: "Leo", color: "red" },
  { id: "sam", name: "Sam", color: "purple" },
];

const SAM_MESSAGE = "@dx open a PR for this";
const LOOP_MS = 14_000;

export function AuthShowcase() {
  const stage = React.useRef<HTMLDivElement>(null);
  const [hover, setHover] = React.useState<Hover>();
  const [leoReacted, setLeoReacted] = React.useState(false);
  const [mine, setMine] = React.useState(false);
  const [samDraft, setSamDraft] = React.useState("");
  const [youDraft, setYouDraft] = React.useState("");
  const [focus, setFocus] = React.useState<"sam" | "you">();
  const [posted, setPosted] = React.useState<Posted>();
  const [present, setPresent] = React.useState(false);

  // The teammates' script, once the panel shows on a wide screen.
  useMountEffect(() =>
    playScript(stage.current, {
      setHover,
      setLeoReacted,
      setSamDraft,
      setFocus,
      setPosted,
    }),
  );

  const thumbs = 1 + (leoReacted ? 1 : 0) + (mine ? 1 : 0);
  const composerText = focus === "sam" ? samDraft : youDraft;

  return (
    <aside className="auth-panel" aria-hidden="true">
      <div
        ref={stage}
        className="auth-demo-stage"
        data-you={present ? "" : undefined}
        onPointerEnter={(event) => {
          if (event.pointerType !== "mouse") return;
          followPointer(event);
          setPresent(true);
        }}
        onPointerMove={followPointer}
        onPointerLeave={() => setPresent(false)}
      >
        <div className="auth-demo">
          <div className="auth-demo-bar">
            <OrbIcon className="auth-demo-orb" />
            <span className="auth-demo-title">Fix checkout timeout</span>
            <span className="auth-demo-people" data-target="people">
              <Avatar name="Maya Chen" seed="usr_maya" live />
              <Avatar name="Leo Park" seed="usr_leo" live />
              <Avatar name="Sam Ortiz" seed="usr_sam" live />
              <Avatar
                name="You"
                seed="you"
                live
                className="auth-demo-you-avatar"
              />
            </span>
          </div>
          <div className="auth-demo-feed">
            <Message
              who="Maya Chen"
              seed="usr_maya"
              age="12m"
              target="maya-message"
            >
              <span className="auth-demo-mention">@dx</span> checkout times out
              right after payment. Find the cause and fix it.
            </Message>
            <div
              className="auth-demo-work"
              data-target="work"
              data-hover={hover === "work" ? "" : undefined}
            >
              <span>
                Worked for 3 minutes <ChevronRight />
              </span>
            </div>
            <div className="auth-demo-reply" data-target="reply">
              <p>
                Fixed. A late provider retry overwrote completed orders.{" "}
                <code>pnpm vitest run src/checkout</code> passes (14 tests).
              </p>
              <div className="reaction-chips">
                <Chip
                  variant="outline"
                  size="sm"
                  className="reaction-chip"
                  tabIndex={-1}
                  data-target="chip"
                  data-hover={hover === "chip" ? "" : undefined}
                  aria-pressed={mine}
                  onClick={() => setMine(!mine)}
                >
                  <span>{REACTION_EMOJI.thumbs_up}</span>
                  <span className="reaction-chip-count">{thumbs}</span>
                </Chip>
              </div>
            </div>
            <Message
              who="Leo Park"
              seed="usr_leo"
              age="4m"
              target="leo-message"
            >
              <span className="auth-demo-mention">@maya</span> checked it on my
              phone. Good to push?
            </Message>
            <div
              className="auth-demo-slot"
              data-target="posted"
              data-shown={posted === undefined ? undefined : ""}
            >
              <Message
                who={posted?.who ?? "Sam Ortiz"}
                seed={posted?.who === "You" ? "you" : "usr_sam"}
                age="now"
                mine={posted?.who === "You"}
              >
                {posted === undefined ? (
                  " "
                ) : (
                  <MentionText text={posted.text} />
                )}
              </Message>
            </div>
          </div>
          <form
            className="auth-demo-composer"
            data-target="composer"
            data-focus={focus === undefined ? undefined : focus}
            onSubmit={(event) => {
              event.preventDefault();
              const text = youDraft.trim();
              if (text === "") return;
              setPosted({ who: "You", text });
              setYouDraft("");
              setFocus(undefined);
            }}
          >
            <input
              tabIndex={-1}
              value={composerText}
              placeholder="Reply…"
              maxLength={80}
              readOnly={focus === "sam"}
              onFocus={() => setFocus((current) => current ?? "you")}
              onBlur={() =>
                setFocus((current) => (current === "you" ? undefined : current))
              }
              onChange={(event) => setYouDraft(event.target.value)}
            />
            <span className="auth-demo-composer-row">
              <Paperclip />
              <button
                type="submit"
                tabIndex={-1}
                className="auth-demo-send"
                data-target="send"
                data-hover={hover === "send" ? "" : undefined}
                data-ready={composerText.trim() === "" ? undefined : ""}
              >
                <ArrowUp />
              </button>
            </span>
          </form>
        </div>
        {PEOPLE.map((person) => (
          <Pointer key={person.id} {...person} />
        ))}
        <Pointer id="you" name="You" color="blue" />
      </div>
      <div className="auth-panel-copy">
        <p className="auth-tagline">Cloud agents, on your terms.</p>
        <p className="auth-lede">
          Your team and its agents share one thread. Everyone sees each step as
          it happens, from any browser.
        </p>
      </div>
    </aside>
  );
}

interface ScriptActions {
  readonly setHover: (hover: Hover) => void;
  readonly setLeoReacted: (reacted: boolean) => void;
  readonly setSamDraft: (draft: string) => void;
  readonly setFocus: React.Dispatch<
    React.SetStateAction<"sam" | "you" | undefined>
  >;
  readonly setPosted: React.Dispatch<React.SetStateAction<Posted | undefined>>;
}

/**
 * Plays the teammates' loop over the panel: pointers move by writing their
 * transforms directly, and the thread changes through the panel's state, on
 * timers the returned cleanup clears. Nothing plays when the panel is hidden
 * (a narrow screen) or the person prefers reduced motion.
 */
function playScript(
  root: HTMLDivElement | null,
  { setHover, setLeoReacted, setSamDraft, setFocus, setPosted }: ScriptActions,
) {
  if (
    root === null ||
    root.offsetParent === null ||
    matchMedia("(prefers-reduced-motion: reduce)").matches
  )
    return;
  const timers = new Set<number>();
  const at = (ms: number, run: () => void) => {
    const id = window.setTimeout(() => {
      timers.delete(id);
      run();
    }, ms);
    timers.add(id);
  };
  const pointer = (person: Person) =>
    root.querySelector<HTMLElement>(`[data-person="${person}"]`);
  const target = (name: string) =>
    root.querySelector<HTMLElement>(`[data-target="${name}"]`);
  /** Glides a pointer to a point inside a target, as fractions of its box. */
  const move = (person: Person, to: string, fx = 0.5, fy = 0.5) => {
    const cursor = pointer(person);
    const element = target(to);
    if (cursor === null || element === null) return;
    const box = element.getBoundingClientRect();
    const origin = root.getBoundingClientRect();
    const x = box.left - origin.left + box.width * fx - cursor.offsetLeft;
    const y = box.top - origin.top + box.height * fy - cursor.offsetTop;
    cursor.style.transform = `translate(${x}px, ${y}px)`;
  };
  const click = (person: Person) => {
    const cursor = pointer(person);
    cursor?.querySelector(".auth-cursor-ripple")?.animate(
      [
        { transform: "scale(0.2)", opacity: 0.7 },
        { transform: "scale(1)", opacity: 0 },
      ],
      { duration: 500, easing: "ease-out" },
    );
    cursor
      ?.querySelector("svg")
      ?.animate(
        [
          { transform: "scale(1)" },
          { transform: "scale(0.82)" },
          { transform: "scale(1)" },
        ],
        { duration: 220 },
      );
  };
  const loop = () => {
    at(500, () => {
      move("maya", "work", 0.55, 0.6);
      setHover("work");
    });
    at(1900, () => move("leo", "chip", 0.4, 0.6));
    at(2500, () => {
      move("maya", "reply", 0.62, 0.35);
      setHover("chip");
    });
    at(3000, () => {
      click("leo");
      setLeoReacted(true);
    });
    at(3700, () => {
      move("leo", "leo-message", 0.8, 0.7);
      setHover(undefined);
    });
    at(4400, () => move("sam", "composer", 0.3, 0.55));
    at(5300, () => {
      click("sam");
      setHover("composer");
      setFocus((current) => current ?? "sam");
    });
    for (let index = 1; index <= SAM_MESSAGE.length; index++)
      at(5530 + index * 70, () => setSamDraft(SAM_MESSAGE.slice(0, index)));
    at(7400, () => {
      move("sam", "send", 0.5, 0.55);
      setHover("send");
    });
    at(8200, () => {
      click("sam");
      setHover(undefined);
      setSamDraft("");
      setFocus((current) => (current === "sam" ? undefined : current));
      setPosted(
        (current) => current ?? { who: "Sam Ortiz", text: SAM_MESSAGE },
      );
    });
    at(9000, () => {
      move("sam", "people", 0.9, 1.6);
      move("maya", "posted", 0.7, 0.5);
    });
    at(10200, () => move("leo", "posted", 0.35, 0.9));
    at(12600, () => {
      setPosted(undefined);
      setLeoReacted(false);
      move("maya", "maya-message", 0.75, 0.4);
      move("leo", "leo-message", 0.85, 0.5);
    });
    at(LOOP_MS, loop);
  };
  loop();
  return () => {
    for (const id of timers) window.clearTimeout(id);
  };
}

/** Moves the visitor's "You" pointer to their own. */
function followPointer(event: React.PointerEvent<HTMLDivElement>) {
  const cursor = event.currentTarget.querySelector<HTMLElement>(
    "[data-person='you']",
  );
  if (cursor === null) return;
  const origin = event.currentTarget.getBoundingClientRect();
  cursor.style.transform = `translate(${event.clientX - origin.left}px, ${
    event.clientY - origin.top
  }px)`;
}

/** A person's pointer: an arrow in their color and a name tag. */
function Pointer({
  id,
  name,
  color,
}: {
  readonly id: Person | "you";
  readonly name: string;
  readonly color: "green" | "red" | "purple" | "blue";
}) {
  return (
    <span className="auth-cursor" data-person={id} data-color={color}>
      <span className="auth-cursor-ripple" />
      <svg viewBox="0 0 16 20" aria-hidden="true">
        <path d="M1 1 L1 16.5 L5.2 12.6 L8 19 L10.6 17.9 L7.9 11.6 L13.6 11.4 Z" />
      </svg>
      <span className="auth-cursor-name">{name}</span>
    </span>
  );
}

/** A person's message as a shared thread shows it: name line, then bubble. */
function Message({
  who,
  seed,
  age,
  mine = false,
  target,
  children,
}: {
  readonly who: string;
  readonly seed: string;
  readonly age: string;
  readonly mine?: boolean;
  readonly target?: string;
  readonly children: React.ReactNode;
}) {
  return (
    <div
      className="auth-demo-message"
      data-author={mine ? "mine" : "other"}
      data-target={target}
    >
      <div className="auth-demo-author">
        <Avatar name={who} seed={seed} />
        <span>{mine ? "You" : who}</span>
        <time>{age}</time>
      </div>
      <div className="auth-demo-bubble">{children}</div>
    </div>
  );
}

/** Text with a leading @mention drawn as a mention chip. */
function MentionText({ text }: { readonly text: string }) {
  const match = /^(@\w+)(.*)$/s.exec(text);
  return match === null ? (
    text
  ) : (
    <>
      <span className="auth-demo-mention">{match[1]}</span>
      {match[2]}
    </>
  );
}
