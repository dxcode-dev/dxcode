// Every Web source file must compile under the React Compiler. A file the
// compiler skips still builds and runs, just without memoization, so the build
// cannot catch it; this test compiles each file with the production options
// and reads the compiler's own diagnostics, which also cover bailouts lint
// misses (try/finally, throw inside try).
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { transformSync } from "oxc-transform-react";
import { describe, expect, it } from "vitest";

const sourceRoot = import.meta.dirname;

// Files the compiler skips today, with the reason. The list only shrinks: the
// test fails when a listed file starts compiling, so delete its entry in the
// same change.
const KNOWN_BAILOUTS: Record<string, string> = {
  "features/threads/use-transcript-virtualizer.ts":
    "TanStack Virtual's useVirtualizer is an incompatible library; this adapter stays uncompiled so its compiled caller receives fresh render values.",
};

const sourceFiles = readdirSync(sourceRoot, { recursive: true })
  .map((file) => String(file).split("\\").join("/"))
  .filter(
    (file) =>
      /\.tsx?$/.test(file) &&
      !/\.test\.tsx?$/.test(file) &&
      !file.endsWith(".d.ts"),
  )
  .sort();

const compilerDiagnostics = (file: string) => {
  const path = join(sourceRoot, file);
  const result = transformSync(path, readFileSync(path, "utf8"), {
    jsx: { runtime: "automatic", development: false, refresh: false },
    reactCompiler: { reportDiagnostics: true },
  });
  return result.errors.map((error) => error.codeframe ?? error.message);
};

describe("React Compiler coverage", () => {
  it.each(sourceFiles)("compiles %s", (file) => {
    const diagnostics = compilerDiagnostics(file);
    if (file in KNOWN_BAILOUTS)
      expect(
        diagnostics,
        `${file} compiles now; remove it from KNOWN_BAILOUTS`,
      ).not.toEqual([]);
    else expect(diagnostics).toEqual([]);
  });

  it("lists only existing files", () => {
    expect(
      Object.keys(KNOWN_BAILOUTS).filter((file) => !sourceFiles.includes(file)),
    ).toEqual([]);
  });

  it("emits compiler cache code", () => {
    const path = join(sourceRoot, "shared/ui/button.tsx");
    const { code } = transformSync(path, readFileSync(path, "utf8"), {
      jsx: { runtime: "automatic", development: false, refresh: false },
      reactCompiler: true,
    });
    expect(code).toContain("react/compiler-runtime");
  });
});
