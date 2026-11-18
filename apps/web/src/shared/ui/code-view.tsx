// Every code view dx draws with the diff library goes through these two
// parts: tool call files and patches, edit diffs, Changes, Files, and the
// file editor. They add the one code theme (code-theme.ts); code.css gives
// every view the code tokens' font, size, and line height. Import them only
// from modules that load lazily, as the diff library does.
import {
  File,
  FileDiff,
  type FileDiffProps,
  type FileProps,
} from "@pierre/diffs/react";
import { useTheme } from "../theme/theme-provider.js";
import { codeViewTheme } from "./code-theme.js";

/** A file's code, highlighted with dx's code theme. */
export function CodeFile(props: FileProps<undefined, undefined>) {
  const { resolvedAppearance } = useTheme();
  return (
    <File
      {...props}
      options={{ ...props.options, ...codeViewTheme(resolvedAppearance) }}
    />
  );
}

/** A file's diff, highlighted with dx's code theme. */
export function CodeDiff(props: FileDiffProps<undefined, undefined>) {
  const { resolvedAppearance } = useTheme();
  return (
    <FileDiff
      {...props}
      options={{ ...props.options, ...codeViewTheme(resolvedAppearance) }}
    />
  );
}
