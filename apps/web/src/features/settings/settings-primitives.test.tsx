import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { SettingsFormActions } from "./settings-primitives.js";

describe("settings form primitives", () => {
  it("keeps errors visible when routine status copy is hidden", () => {
    const markup = renderToStaticMarkup(
      <SettingsFormActions
        dirty
        saving={false}
        error="Project could not be saved."
        showStatus={false}
        showReset={false}
        onSave={() => undefined}
        onReset={() => undefined}
      />,
    );

    expect(markup).toContain('class="settings-form-error"');
    expect(markup).toContain("Project could not be saved.");
    expect(markup).not.toContain("No changes");
  });
});
