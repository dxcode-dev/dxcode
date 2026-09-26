import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import {
  SettingsCard,
  SettingsFormActions,
  SettingsHeading,
  SettingsSectionIntro,
  SettingsSelect,
  SettingsToggle,
} from "./settings-primitives.js";

describe("settings form primitives", () => {
  it("does not make the page heading programmatically focusable", () => {
    const markup = renderToStaticMarkup(
      <SettingsHeading title="Account" description="Manage your account." />,
    );

    expect(markup).toContain("<h1>Account</h1>");
    expect(markup).not.toContain("tabindex");
  });

  it("composes reusable section intros and outlined cards", () => {
    const markup = renderToStaticMarkup(
      <>
        <SettingsSectionIntro
          title="Orb"
          description="Choose the Orb size for this project."
        />
        <SettingsCard
          title="Setup"
          description="Prepare the project."
          actions={<span>Checked on main</span>}
          variant="outline"
        >
          <p>Detected</p>
        </SettingsCard>
      </>,
    );

    expect(markup).toContain('class="settings-section-intro"');
    expect(markup).toContain('data-variant="outline"');
    expect(markup).toContain("Prepare the project.");
    expect(markup).toContain("Checked on main");
  });

  it("renders accessible controls and saving feedback deterministically", () => {
    const markup = renderToStaticMarkup(
      <>
        <SettingsToggle
          checked
          label="Enable feature"
          onCheckedChange={() => undefined}
        />
        <SettingsSelect
          value="standard"
          label="Mode"
          options={[["standard", "Standard"]]}
          onValueChange={() => undefined}
        />
        <SettingsFormActions
          dirty
          saving
          message="Saving settings."
          onSave={() => undefined}
          onReset={() => undefined}
        />
      </>,
    );

    expect(markup).toContain('aria-label="Enable feature"');
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain('aria-label="Mode"');
    expect(markup).toContain("Saving settings.");
    expect(markup).toContain("Saving…");
    expect(markup.match(/disabled=""/g)).toHaveLength(2);
  });

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
