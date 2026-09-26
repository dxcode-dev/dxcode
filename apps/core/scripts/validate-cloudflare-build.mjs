import { readFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  loadMigrationManifest,
  resolveD1MigrationsDirectory,
} from "../../../scripts/migration-manifest.mjs";

const redirectPath = resolve(".wrangler/deploy/config.json");
const redirect = JSON.parse(await readFile(redirectPath, "utf8"));
const generatedConfigPath = resolve(".wrangler/deploy", redirect.configPath);
const config = JSON.parse(await readFile(generatedConfigPath, "utf8"));
const canonicalConfigPath = resolve("wrangler.jsonc");
const canonical = JSON.parse(await readFile(canonicalConfigPath, "utf8"));
const manifest = await loadMigrationManifest();

const effectiveBindings = config.durable_objects?.bindings;
const canonicalBindings = canonical.durable_objects?.bindings;
const generatedBindings = effectiveBindings?.filter(
  (binding) => binding.name === "FLUE_DX_AGENT_AGENT",
);
const applicationBindings = effectiveBindings?.filter(
  (binding) => binding.name !== "FLUE_DX_AGENT_AGENT",
);
const effectiveMigrations = config.migrations;
const canonicalMigrations = canonical.migrations;
const manifestMigrations = manifest.durableObjects.map(
  ({ tag, newSqliteClasses }) => ({
    tag,
    new_sqlite_classes: newSqliteClasses,
  }),
);
const hasDuplicates = (values) => new Set(values).size !== values.length;

if (
  !Array.isArray(effectiveBindings) ||
  !Array.isArray(canonicalBindings) ||
  !Array.isArray(effectiveMigrations) ||
  !Array.isArray(canonicalMigrations) ||
  generatedBindings?.length !== 1 ||
  generatedBindings[0]?.class_name !== "FlueDxAgentAgent" ||
  hasDuplicates(effectiveBindings.map(({ name }) => name)) ||
  hasDuplicates(canonicalBindings.map(({ name }) => name)) ||
  hasDuplicates(effectiveMigrations.map(({ tag }) => tag)) ||
  hasDuplicates(canonicalMigrations.map(({ tag }) => tag)) ||
  JSON.stringify(canonicalMigrations) !== JSON.stringify(manifestMigrations) ||
  JSON.stringify(applicationBindings) !== JSON.stringify(canonicalBindings) ||
  JSON.stringify(effectiveMigrations) !== JSON.stringify(canonicalMigrations)
) {
  throw new Error(
    "The generated Durable Object bindings and migrations do not exactly match the canonical app config after excluding Flue's generated binding.",
  );
}

if (config.ai?.binding !== "AI") {
  throw new Error(
    "The generated deployment config did not preserve the authored Workers AI binding.",
  );
}

const d1Binding = config.d1_databases?.find(
  (binding) => binding.binding === "DB",
);
const canonicalD1Binding = canonical.d1_databases?.find(
  (binding) => binding.binding === "DB",
);
const generatedMigrationsDirectory =
  typeof d1Binding?.migrations_dir === "string"
    ? resolveD1MigrationsDirectory(
        generatedConfigPath,
        d1Binding.migrations_dir,
      )
    : undefined;
const canonicalMigrationsDirectory = resolveD1MigrationsDirectory(
  canonicalConfigPath,
  manifest.d1Directory,
);
if (
  d1Binding?.database_name !== "dx-product-store" ||
  canonicalD1Binding?.migrations_dir !== manifest.d1Directory ||
  generatedMigrationsDirectory !== canonicalMigrationsDirectory
) {
  throw new Error(
    "The generated deployment config did not preserve the authored D1 binding and migrations directory.",
  );
}

if (typeof config.main !== "string" || config.main.length === 0) {
  throw new Error("The generated deployment config has no Worker entry.");
}

const worker = await readFile(resolve("dist/dx_core/index.js"), "utf8");
for (const adapter of [
  "anthropic-messages",
  "azure-openai-responses",
  "mistral-conversations",
  "openai-completions",
  "openai-responses",
]) {
  if (worker.includes(`from "./assets/${adapter}-`))
    throw new Error(
      `The ${adapter} adapter must not run during Worker startup.`,
    );
}

console.log(
  "Cloudflare build contains exactly the canonical app Durable Object bindings and migrations plus Flue's generated binding, Workers AI, and D1.",
);
