import * as React from "react";
import { createRoot } from "react-dom/client";
import { afterEach, describe, expect, it } from "vitest";
import { page, userEvent } from "vitest/browser";
import "../../styles.css";
import { AdditionalRepositoriesPicker } from "./new-project-dialog.js";
import type { RepositoryOption } from "./repository-options.js";

// #1383: in Project Settings, the Add Repository list opened only as wide as
// its button, so its search field read "Search repositories o" and a pasted
// URL could not be read or checked before adding it.

Object.assign(globalThis, { IS_REACT_ACT_ENVIRONMENT: true });

const pasted = "https://github.com/octocat/Spoon-Knife";

function Settings() {
  const [value, setValue] = React.useState<ReadonlyArray<RepositoryOption>>([]);
  return (
    <div className="project-additional-repositories">
      <AdditionalRepositoriesPicker
        addTrigger
        options={[]}
        value={value}
        onValueChange={setValue}
      />
      <ul aria-label="Additional repositories">
        {value.map((option) => (
          <li key={option.value}>{option.webUrl}</li>
        ))}
      </ul>
    </div>
  );
}

const clipped = (element: Element) => element.scrollWidth > element.clientWidth;

afterEach(() => {
  document.body.replaceChildren();
});

describe("Project Settings → Add Repository list", () => {
  for (const [width, height] of [
    [1440, 900],
    [390, 844],
  ] as const) {
    it(`shows its search and a pasted URL in full, on screen, at ${width}px`, async () => {
      await page.viewport(width, height);
      const container = document.createElement("div");
      container.style.padding = "24px";
      document.body.append(container);
      const root = createRoot(container);
      await React.act(() => root.render(<Settings />));

      const trigger = container.querySelector<HTMLElement>(
        "#project-additional-repositories",
      );
      expect(trigger).not.toBeNull();
      if (trigger === null) return;
      await userEvent.click(trigger);
      const popup = document.querySelector<HTMLElement>(
        ".additional-repositories-popup",
      );
      const search = document.querySelector<HTMLInputElement>(
        ".additional-repositories-search",
      );
      expect(popup).not.toBeNull();
      expect(search).not.toBeNull();
      if (popup === null || search === null) return;

      // The placeholder fits: the field is wide enough to read and type in.
      search.value = search.placeholder;
      expect(clipped(search)).toBe(false);
      search.value = "";
      await userEvent.type(search, pasted);
      expect(clipped(search)).toBe(false);

      const box = popup.getBoundingClientRect();
      expect(box.left).toBeGreaterThanOrEqual(0);
      expect(box.right).toBeLessThanOrEqual(width);

      const option = document.querySelector<HTMLElement>('[role="option"]');
      expect(option?.textContent).toBe(pasted);
      const label = option?.querySelector("span:not([aria-hidden])");
      expect(
        label === null || label === undefined ? true : clipped(label),
      ).toBe(false);

      // Enter adds the pasted URL, from the keyboard alone.
      await userEvent.keyboard("{Enter}");
      expect(
        container.querySelector('[aria-label="Additional repositories"]')
          ?.textContent,
      ).toBe(pasted);
      await React.act(() => root.unmount());
    });
  }
});
