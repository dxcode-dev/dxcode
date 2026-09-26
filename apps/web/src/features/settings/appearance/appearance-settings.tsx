import { useTheme } from "../../../shared/theme/theme-provider.js";
import {
  appearanceOptions,
  paletteOptions,
  terminalThemeOptions,
} from "../../../shared/theme/theme-store.js";
import {
  SettingsCard,
  SettingsHeading,
  SettingsRow,
  SettingsSelect,
  type SettingsSelectOption,
} from "../settings-primitives.js";
import type { SettingsSectionProps } from "../settings-registration.js";

const appearanceSelectOptions: ReadonlyArray<SettingsSelectOption> =
  appearanceOptions.map(({ value, label }) => [value, label]);
const paletteSelectOptions: ReadonlyArray<SettingsSelectOption> =
  paletteOptions.map(({ value, label }) => [value, label]);
const terminalThemeSelectOptions: ReadonlyArray<SettingsSelectOption> =
  terminalThemeOptions.map(({ value, label }) => [value, label]);

export function AppearanceSettings(_props: SettingsSectionProps) {
  const theme = useTheme();

  return (
    <div className="appearance-settings">
      <SettingsHeading
        title="Appearance"
        description="Choose how dx looks across your signed-in sessions."
      />

      <SettingsCard title="Display">
        <SettingsRow
          title="Theme"
          description="Follow your system appearance or keep dx light or dark."
          control={
            <SettingsSelect
              value={theme.appearance}
              label="Theme"
              options={appearanceSelectOptions}
              onValueChange={(value) => {
                const option = appearanceOptions.find(
                  (candidate) => candidate.value === value,
                );
                if (option !== undefined) theme.setAppearance(option.value);
              }}
            />
          }
        />
        <SettingsRow
          title="Color palette"
          description="Daydream adds a faint green cast; Deadpan uses greys."
          control={
            <SettingsSelect
              value={theme.palette}
              label="Color palette"
              options={paletteSelectOptions}
              onValueChange={(value) => {
                const option = paletteOptions.find(
                  (candidate) => candidate.value === value,
                );
                if (option !== undefined) theme.setPalette(option.value);
              }}
            />
          }
        />
      </SettingsCard>

      <SettingsCard title="Terminal">
        <SettingsRow
          title="Terminal theme"
          description="Use the matching light or dark Ghostty variant for your appearance."
          control={
            <SettingsSelect
              value={theme.terminalTheme}
              label="Terminal theme"
              options={terminalThemeSelectOptions}
              onValueChange={(value) => {
                const option = terminalThemeOptions.find(
                  (candidate) => candidate.value === value,
                );
                if (option !== undefined) theme.setTerminalTheme(option.value);
              }}
            />
          }
        />
      </SettingsCard>
    </div>
  );
}
