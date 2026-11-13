import {
  type AppearanceChange,
  useTheme,
} from "../../../shared/theme/theme-provider.js";
import {
  type AppearancePreferences,
  appearanceOptions,
  paletteOptions,
  terminalAppearanceOptions,
  terminalThemeOptions,
  textSizeOptions,
  threadWidthOptions,
} from "../../../shared/theme/theme-store.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  SettingsToggle,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";
import { CodeFontSettings } from "./code-font-settings.js";
import { SidebarSettings } from "./sidebar-settings.js";

/** One row that chooses one stored appearance value from its options. */
type ChoiceField = {
  readonly [Field in keyof AppearancePreferences]: AppearancePreferences[Field] extends string
    ? Field
    : never;
}[keyof AppearancePreferences];

function PreferenceRow<Field extends ChoiceField>({
  field,
  title,
  label = title,
  description,
  options,
}: {
  readonly field: Field;
  readonly title: string;
  readonly label?: string;
  readonly description: string;
  readonly options: ReadonlyArray<{
    readonly value: AppearancePreferences[Field];
    readonly label: string;
  }>;
}) {
  const theme = useTheme();
  return (
    <SettingsRow
      title={title}
      description={description}
      control={
        <SettingsSelect
          value={theme[field]}
          label={label}
          options={options.map(({ value, label }) => [value, label])}
          onValueChange={(value) => {
            const option = options.find(
              (candidate) => candidate.value === value,
            );
            if (option !== undefined)
              theme.update({ [field]: option.value } as AppearanceChange);
          }}
        />
      }
    />
  );
}

export function AppearanceSettings(_props: SettingsSectionProps) {
  const theme = useTheme();
  return (
    <div className="appearance-settings">
      <SettingsHeading
        title="Appearance"
        description="These are saved to your account and sync across your devices."
      />

      <SettingsCard title="Theme">
        <PreferenceRow
          field="appearance"
          title="Light or Dark"
          description="Follow your system, or always use light or dark."
          options={appearanceOptions}
        />
        <PreferenceRow
          field="palette"
          title="Color Palette"
          description="The colors dx uses. Daydream adds a faint green cast; Deadpan uses greys."
          options={paletteOptions}
        />
      </SettingsCard>

      <SettingsCard title="Text & Layout">
        <PreferenceRow
          field="textSize"
          title="Text Size"
          description="Scale text across dx."
          options={textSizeOptions}
        />
        <PreferenceRow
          field="threadWidth"
          title="Thread Width"
          description="How wide transcripts and the composer are."
          options={threadWidthOptions}
        />
      </SettingsCard>

      <SidebarSettings />

      <SettingsCard title="Terminal">
        <PreferenceRow
          field="terminalAppearance"
          title="Light or Dark"
          label="Terminal Light or Dark"
          description="Match dx's theme, or always use light or dark."
          options={terminalAppearanceOptions}
        />
        <PreferenceRow
          field="terminalTheme"
          title="Color Scheme"
          label="Terminal Color Scheme"
          description="The terminal's colors, in the light or dark version chosen above."
          options={terminalThemeOptions}
        />
      </SettingsCard>

      <CodeFontSettings />

      <SettingsCard title="Motion & Sound">
        <SettingsRow
          title="Logo Animation"
          description="Animate the dx logo on the home page. It stays still when your system reduces motion."
          control={
            <SettingsToggle
              label="Logo Animation"
              checked={theme.logoAnimation}
              onCheckedChange={(logoAnimation) =>
                theme.update({ logoAnimation })
              }
            />
          }
        />
        <SettingsRow
          title="UI Sounds"
          description="Short sounds for dictation and other interactions."
          control={
            <SettingsToggle
              label="UI Sounds"
              checked={theme.uiSounds}
              onCheckedChange={(uiSounds) => theme.update({ uiSounds })}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
