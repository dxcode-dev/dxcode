import { readFile } from "node:fs/promises";

const packages = {
  "@dx/domain": { path: "packages/domain/package.json", allowed: new Set() },
  "@dx/api": {
    path: "packages/api/package.json",
    allowed: new Set(["@dx/domain"]),
  },
  "@dx/core": {
    path: "apps/core/package.json",
    allowed: new Set(["@dx/api", "@dx/domain"]),
  },
  "@dx/web": {
    path: "apps/web/package.json",
    allowed: new Set(["@dx/api", "@dx/domain"]),
  },
};

const internalNames = new Set(Object.keys(packages));
const dependencyFields = [
  "dependencies",
  "devDependencies",
  "peerDependencies",
  "optionalDependencies",
];
const violations = [];

for (const [packageName, definition] of Object.entries(packages)) {
  const manifest = JSON.parse(await readFile(definition.path, "utf8"));

  for (const field of dependencyFields) {
    for (const dependency of Object.keys(manifest[field] ?? {})) {
      if (
        internalNames.has(dependency) &&
        !definition.allowed.has(dependency)
      ) {
        violations.push(
          `${packageName} must not declare ${dependency} in ${field}`,
        );
      }
    }
  }
}

if (violations.length > 0) {
  console.error("Invalid workspace dependency direction:");
  for (const violation of violations) console.error(`- ${violation}`);
  process.exitCode = 1;
} else {
  console.log("Workspace dependency directions are valid.");
}
