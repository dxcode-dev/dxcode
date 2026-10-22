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
        description="These are saved to your account and sync across your devices."
      />

      <SettingsCard title="Theme">
        <SettingsRow
          title="Light or Dark"
          description="Follow your system, or always use light or dark."
          control={
            <SettingsSelect
              value={theme.appearance}
              label="Light or Dark"
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
          title="Color Palette"
          description="The colors dx uses. Daydream adds a faint green cast; Deadpan uses greys."
          control={
            <SettingsSelect
              value={theme.palette}
              label="Color Palette"
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
          title="Color Scheme"
          description="The terminal's colors, in the light or dark version that matches your theme."
          control={
            <SettingsSelect
              value={theme.terminalTheme}
              label="Terminal Color Scheme"
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
