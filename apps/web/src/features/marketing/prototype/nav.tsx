import { useContext } from "react";
import { DxWordmark } from "../../../shared/brand/dx-wordmark.js";
import { ArrowIcon } from "./arrow-icon.js";
import { LiveAccessContext } from "./live-access-context.js";

export function Nav({
  earlyAccessInputId,
  tagline = "YOUR CLOUD. YOUR AGENTS.",
}: {
  readonly earlyAccessInputId?: string;
  readonly tagline?: string;
}) {
  const live = useContext(LiveAccessContext);
  return (
    <header className="nav">
      <DxWordmark href="#" />
      <span className="nav-note">{tagline}</span>
      <nav>
        {live && <a href="/new">Sign in</a>}
        <a className="nav-section-link" href="#work">
          How it works
        </a>
        <a className="nav-section-link" href="#beyond">
          What's next
        </a>
        {earlyAccessInputId ? (
          <button
            type="button"
            onClick={() => document.getElementById(earlyAccessInputId)?.focus()}
          >
            Early access <ArrowIcon direction="up-right" />
          </button>
        ) : (
          <a href="#access">
            Early access <ArrowIcon direction="up-right" />
          </a>
        )}
      </nav>
    </header>
  );
}
