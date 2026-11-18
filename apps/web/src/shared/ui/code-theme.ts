// The one syntax theme for every code view the diff library draws: tool
// call files and patches, edit diffs, Changes, Files, and the file editor.
// Its colors are the palette's code tokens (tokens.css), the same ones
// shared/ui/code.css gives highlight.js in reply code blocks, so a keyword is
// one color everywhere and follows the palette and Light or Dark at once.
// Import it only where the diff library is already loaded.
import { registerCustomTheme, type ThemeRegistration } from "@pierre/diffs";
import type { ResolvedAppearance } from "../theme/theme-store.js";

/**
 * One theme in a light and a dark variant. Their colors are the same tokens;
 * the diff library sets a view's color scheme from its theme's type.
 */
export const codeThemeNames = {
  light: "dx-code-light",
  dark: "dx-code-dark",
} as const;

const token = (name: string) => `var(--code-${name})`;

const theme = (type: ResolvedAppearance): ThemeRegistration => ({
  name: codeThemeNames[type],
  type,
  colors: {
    "editor.background": token("surface"),
    "editor.foreground": token("foreground"),
    "editorLineNumber.foreground": token("comment"),
    "gitDecoration.addedResourceForeground": token("addition"),
    "gitDecoration.deletedResourceForeground": token("deletion"),
    "gitDecoration.modifiedResourceForeground": token("modified"),
  },
  // Each group matches a highlight.js class group in code.css.
  tokenColors: [
    { settings: { foreground: token("foreground") } },
    {
      scope: [
        "comment",
        "punctuation.definition.comment",
        "string.quoted.docstring",
        "meta.preprocessor",
        "meta.decorator",
        "punctuation.decorator",
        "meta.diff.range",
        "meta.diff.header",
      ],
      settings: { foreground: token("comment") },
    },
    {
      scope: [
        "keyword",
        "storage",
        "keyword.operator.new",
        "keyword.operator.expression",
        "entity.name.tag",
        "markup.heading",
      ],
      settings: { foreground: token("keyword") },
    },
    // Operators and accessors stay plain, as highlight.js leaves them.
    {
      scope: ["keyword.operator", "punctuation.accessor"],
      settings: { foreground: token("foreground") },
    },
    {
      scope: [
        "string",
        "string.regexp",
        "markup.inline.raw",
        "markup.fenced_code",
      ],
      settings: { foreground: token("string") },
    },
    // A regular expression is one string, quantifiers and classes included.
    {
      scope: [
        "string.regexp keyword.operator",
        "string.regexp constant",
        "string.regexp punctuation",
      ],
      settings: { foreground: token("string") },
    },
    // Template substitutions are code again.
    {
      scope: ["meta.template.expression"],
      settings: { foreground: token("foreground") },
    },
    {
      scope: [
        "punctuation.definition.template-expression",
        "punctuation.section.embedded",
      ],
      settings: { foreground: token("keyword") },
    },
    {
      scope: [
        "constant.numeric",
        "constant.language",
        "constant.character",
        "constant.other.color",
        "support.constant",
        "variable.language",
      ],
      settings: { foreground: token("number") },
    },
    {
      scope: [
        "entity.name.function",
        "support.function",
        "entity.name.type",
        "entity.name.class",
        "entity.other.inherited-class",
        "support.class",
        "support.type",
        "entity.other.attribute-name.class",
        "entity.other.attribute-name.id",
      ],
      settings: { foreground: token("title") },
    },
    {
      scope: [
        "variable.other.property",
        "support.variable.property",
        "meta.object-literal.key",
        "support.type.property-name",
        "entity.other.attribute-name",
        "markup.underline.link",
      ],
      settings: { foreground: token("property") },
    },
    {
      scope: ["markup.inserted", "punctuation.definition.inserted"],
      settings: { foreground: token("addition") },
    },
    {
      scope: ["markup.deleted", "punctuation.definition.deleted"],
      settings: { foreground: token("deletion") },
    },
    {
      scope: ["markup.changed"],
      settings: { foreground: token("modified") },
    },
    { scope: ["markup.bold"], settings: { fontStyle: "bold" } },
    { scope: ["markup.italic"], settings: { fontStyle: "italic" } },
  ],
});

for (const type of ["light", "dark"] as const)
  registerCustomTheme(codeThemeNames[type], () => Promise.resolve(theme(type)));

/** The theme options every code view passes to the diff library. */
export const codeViewTheme = (appearance: ResolvedAppearance) =>
  ({ theme: codeThemeNames[appearance], themeType: appearance }) as const;

/** How dx draws a diff in a thread. */
export const codeDiffOptions = {
  lineDiffType: "word-alt",
  hunkSeparators: "line-info-basic",
} as const;
