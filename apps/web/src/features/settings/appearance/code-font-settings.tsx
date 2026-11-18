import {
  PersonalCodeFontFamily,
  PersonalCodeFontSize,
  PersonalCodeLineHeight,
} from "@dx/domain";
import { Option, Schema } from "effect";
import * as React from "react";
import { useTheme } from "../../../shared/theme/theme-provider.js";
import { codeFontScopeStyle } from "../../../shared/theme/theme-store.js";
import { Button } from "../../../shared/ui/button.js";
import { CodeSamples } from "../../../shared/ui/code-samples.js";
import { Input } from "../../../shared/ui/input.js";
import { SettingsCard, SettingsRow } from "../settings-primitives.js";

const fields = [
  {
    key: "codeFontFamily",
    title: "Font Family",
    label: "Code Font Family",
    description:
      "Fonts installed on this device, in order of preference. dx falls back to the system monospace font.",
    placeholder: "SF Mono, Consolas",
    schema: PersonalCodeFontFamily,
    error: "Use font names separated by commas.",
  },
  {
    key: "codeFontSize",
    title: "Size",
    label: "Code Font Size",
    description: "A number in pixels, or a CSS length in px, rem, or pt.",
    placeholder: "Default",
    schema: PersonalCodeFontSize,
    error: "Enter a size such as 13 or 13px.",
  },
  {
    key: "codeLineHeight",
    title: "Line Height",
    label: "Code Line Height",
    description:
      "A multiple of the font size, a percentage, or a CSS length in px, rem, or em.",
    placeholder: "Default",
    schema: PersonalCodeLineHeight,
    error: "Enter a line height such as 1.5, 150%, or 20px.",
  },
] as const;

type CodeFontField = (typeof fields)[number]["key"];
type CodeFontValues = Readonly<Record<CodeFontField, string | null>>;

const isValid = (field: (typeof fields)[number], value: string) =>
  value === "" ||
  Option.isSome(Schema.decodeUnknownOption(field.schema)(value));

/** The Code Font fields, a live preview, and Save. Blank uses the default. */
export function CodeFontSettings() {
  const theme = useTheme();
  const saved: CodeFontValues = {
    codeFontFamily: theme.codeFontFamily,
    codeFontSize: theme.codeFontSize,
    codeLineHeight: theme.codeLineHeight,
  };
  // A new saved value (from Save, or another device) restarts the form.
  return (
    <CodeFontForm
      key={JSON.stringify(saved)}
      saved={saved}
      onSave={theme.update}
    />
  );
}

function CodeFontForm({
  saved,
  onSave,
}: {
  readonly saved: CodeFontValues;
  readonly onSave: (change: Partial<CodeFontValues>) => void;
}) {
  const errorId = React.useId();
  const [values, setValues] = React.useState(() => ({
    codeFontFamily: saved.codeFontFamily ?? "",
    codeFontSize: saved.codeFontSize ?? "",
    codeLineHeight: saved.codeLineHeight ?? "",
  }));
  const trimmed = {
    codeFontFamily: values.codeFontFamily.trim(),
    codeFontSize: values.codeFontSize.trim(),
    codeLineHeight: values.codeLineHeight.trim(),
  };
  const invalid = fields.filter((field) => !isValid(field, trimmed[field.key]));
  const dirty = fields.some(({ key }) => (trimmed[key] || null) !== saved[key]);
  // A field being typed applies to the preview at once; blank shows the
  // default, and an invalid entry keeps the saved value.
  const draft = (key: CodeFontField) =>
    invalid.some((field) => field.key === key) ? undefined : trimmed[key];
  const family = draft("codeFontFamily");
  const size = draft("codeFontSize");
  const lineHeight = draft("codeLineHeight");
  const preview = codeFontScopeStyle({ family, size, lineHeight });

  return (
    <SettingsCard
      title="Code Font"
      description="Leave a field blank to use the default."
      className="code-font-settings"
    >
      {fields.map((field) => {
        const error = invalid.includes(field) ? errorId : undefined;
        return (
          <SettingsRow
            key={field.key}
            title={field.title}
            description={field.description}
            control={
              <Input
                aria-label={field.label}
                aria-invalid={error === undefined ? undefined : true}
                aria-describedby={error}
                autoCapitalize="none"
                autoComplete="off"
                spellCheck={false}
                placeholder={field.placeholder}
                value={values[field.key]}
                onChange={(event) =>
                  setValues({ ...values, [field.key]: event.target.value })
                }
              />
            }
          />
        );
      })}
      <figure
        className="code-font-preview code-font-scope"
        aria-label="Code Font preview"
        style={preview}
      >
        <CodeSamples />
      </figure>
      <footer className="settings-form-actions" aria-live="polite">
        {invalid.length === 0 ? null : (
          <span id={errorId} className="settings-form-error">
            {invalid.map((field) => field.error).join(" ")}
          </span>
        )}
        <Button
          size="xs"
          variant="ghost"
          disabled={!dirty}
          onClick={() =>
            setValues({
              codeFontFamily: saved.codeFontFamily ?? "",
              codeFontSize: saved.codeFontSize ?? "",
              codeLineHeight: saved.codeLineHeight ?? "",
            })
          }
        >
          Reset
        </Button>
        <Button
          size="xs"
          disabled={!dirty || invalid.length > 0}
          onClick={() =>
            onSave({
              codeFontFamily: trimmed.codeFontFamily || null,
              codeFontSize: trimmed.codeFontSize || null,
              codeLineHeight: trimmed.codeLineHeight || null,
            })
          }
        >
          Save
        </Button>
      </footer>
    </SettingsCard>
  );
}
