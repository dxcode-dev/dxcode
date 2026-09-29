import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const styles = readFileSync(
  new URL("../../styles.css", import.meta.url),
  "utf8",
);

describe("thread composer layout", () => {
  it("caps the editor at five visible lines before scrolling", () => {
    expect(styles).toMatch(
      /\.agent-composer textarea\s*\{[^}]*max-height:\s*104px;[^}]*overflow-y:\s*auto;/s,
    );
    expect(styles).toMatch(
      /\.mobile-pane-content \.agent-composer textarea\s*\{[^}]*max-height:\s*124px;[^}]*line-height:\s*20px;/s,
    );
  });

  it("keeps the portaled attachment menu above the new-thread dialog", () => {
    expect(styles).toMatch(
      /\.attachment-menu-positioner\s*\{[^}]*z-index:\s*112;/s,
    );
  });

  it("clears the measured dock while aligning controls with the error row", () => {
    expect(styles).toMatch(
      /\.agent-transcript\s*\{[^}]*padding:[^;]*var\(--agent-composer-dock-height/s,
    );
    expect(styles).toMatch(
      /\.transcript-controls\s*\{[^}]*bottom:\s*calc\(var\(--agent-composer-height/s,
    );
  });
});
