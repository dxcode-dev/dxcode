import { type ErrorComponentProps, Link } from "@tanstack/react-router";
import { Headphones } from "lucide-react";
import { PageShell } from "../../shared/layout/page-shell.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import { huddleLinkFailure } from "./huddle-link-queries.js";

const home = <Link to="/">Go to dx</Link>;

/** What `/huddle/<workspace>/<code>` shows while it finds the huddle. */
export function HuddleLinkPending() {
  return (
    <PageShell title="Huddle">
      <EmptyState
        icon={<Headphones />}
        title="Opening the huddle…"
        busy
        role="status"
      />
    </PageShell>
  );
}

const refusal = (error: unknown) => {
  const code = huddleLinkFailure(error);
  if (code === "off")
    return {
      title: "Huddles are off",
      description: "This dx has no huddles. Ask your admin to turn them on.",
    };
  if (code === "HUDDLE_LINK_NOT_FOUND")
    return {
      title: "Huddle link not found",
      description:
        "No huddle has this code in that workspace. Check the link, or ask for it again.",
    };
  if (code === "HUDDLE_LINK_FORBIDDEN")
    return {
      title: "You don't have access to this huddle",
      description:
        "It's in a thread or Space that isn't shared with you. Ask whoever sent the link to share it with your workspace.",
    };
  if (code === "HUDDLE_PRIVATE")
    return {
      title: "This huddle is closed",
      description:
        "Its thread is private now. Huddles are only in shared threads and Spaces.",
    };
  return {
    title: "Couldn't open the huddle",
    description:
      error instanceof Error && error.message !== ""
        ? error.message
        : "Try the link again in a moment.",
  };
};

/** A huddle link that does not open: why, and a way back. */
export function HuddleLinkError({ error }: ErrorComponentProps) {
  const { title, description } = refusal(error);
  return (
    <PageShell title="Huddle">
      <EmptyState
        icon={<Headphones />}
        tone="error"
        title={title}
        description={description}
        action={home}
      />
    </PageShell>
  );
}
