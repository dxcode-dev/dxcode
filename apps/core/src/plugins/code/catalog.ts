import { mcpModuleIdFor } from "@dx/domain";
import type { McpAgentConnectionData } from "../../settings/mcp-servers/execution.js";

export interface CodeFunction {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: unknown;
}

export interface CodeModule {
  readonly name: string;
  readonly description: string;
  readonly connection: McpAgentConnectionData;
  readonly functions: ReadonlyArray<CodeFunction>;
}

/** Sorting by server ID makes collision suffixes independent of listing order. */
export const codeModules = (
  connections: ReadonlyArray<McpAgentConnectionData>,
): ReadonlyArray<CodeModule> => {
  const used = new Set<string>();
  return [...connections]
    .sort((a, b) => a.id.localeCompare(b.id))
    .filter((connection) => connection.tools.length > 0)
    .map((connection) => {
      const displayName = connection.displayName ?? connection.name;
      const slug = connection.moduleId ?? mcpModuleIdFor(displayName);
      let name = slug;
      let suffix = 2;
      while (used.has(name)) name = `${slug}_${suffix++}`;
      used.add(name);
      return {
        name,
        description: `${displayName} MCP server`,
        connection,
        functions: connection.tools.map((toolName) => {
          const definition = connection.toolDefinitions?.find(
            (tool) => tool.name === toolName,
          );
          return {
            name: toolName,
            description: definition?.description ?? "Reviewed MCP tool",
            inputSchema: definition
              ? JSON.parse(definition.inputSchemaJson)
              : {},
          };
        }),
      };
    });
};

export const moduleList = (modules: ReadonlyArray<CodeModule>) =>
  modules
    .map(
      (module) =>
        `${module.name} — ${module.description}: ${module.functions.map((fn) => fn.name).join(", ")}`,
    )
    .join("\n");

/** Small, conservative JSON Schema printer. Unsupported or recursive types stay unknown. */
export const schemaType = (
  value: unknown,
  root: unknown = value,
  depth = 0,
): string => {
  if (depth > 12 || value === true) return "unknown";
  if (value === false) return "never";
  if (typeof value !== "object" || value === null) return "unknown";
  const schema = value as Record<string, unknown>;
  const convert = (child: unknown) => schemaType(child, root, depth + 1);
  if (typeof schema.$ref === "string" && schema.$ref.startsWith("#/")) {
    let target = root;
    for (const key of schema.$ref.slice(2).split("/"))
      target =
        typeof target === "object" && target !== null
          ? (target as Record<string, unknown>)[
              key.replace(/~1/g, "/").replace(/~0/g, "~")
            ]
          : undefined;
    return convert(target);
  }
  if ("const" in schema) return JSON.stringify(schema.const);
  if (Array.isArray(schema.enum))
    return (
      schema.enum.map((item) => JSON.stringify(item)).join(" | ") || "never"
    );
  for (const key of ["anyOf", "oneOf", "allOf"])
    if (Array.isArray(schema[key]))
      return (schema[key] as unknown[])
        .map(convert)
        .map((type) => `(${type})`)
        .join(key === "allOf" ? " & " : " | ");
  if (Array.isArray(schema.type))
    return schema.type.map((type) => convert({ ...schema, type })).join(" | ");
  switch (schema.type) {
    case "string":
      return "string";
    case "integer":
    case "number":
      return "number";
    case "boolean":
      return "boolean";
    case "null":
      return "null";
    case "array":
      return `Array<${convert(schema.items)}>`;
    case "object": {
      const required = Array.isArray(schema.required) ? schema.required : [];
      const entries = Object.entries(
        (schema.properties ?? {}) as Record<string, unknown>,
      ).map(
        ([key, child]) =>
          `${JSON.stringify(key)}${required.includes(key) ? "" : "?"}: ${convert(child)}`,
      );
      if (schema.additionalProperties !== false)
        entries.push(
          `[key: string]: ${typeof schema.additionalProperties === "object" ? convert(schema.additionalProperties) : "unknown"}`,
        );
      return `{ ${entries.join("; ")} }`;
    }
    default:
      return "unknown";
  }
};

const IDENTIFIER = /^[A-Za-z_$][A-Za-z0-9_$]*$/;

const identifierFor = (name: string) =>
  name.replace(/[^A-Za-z0-9_$]/g, "_").replace(/^(?=[0-9])/, "_");

/**
 * The identifier a tool whose name is not one (`resolve-library-id`) is
 * also exported as, unless it would collide with another tool's name.
 */
export const codeAlias = (
  module: CodeModule,
  name: string,
): string | undefined => {
  if (IDENTIFIER.test(name)) return undefined;
  const alias = identifierFor(name);
  const taken = module.functions.filter(
    (fn) => fn.name === alias || identifierFor(fn.name) === alias,
  );
  return taken.length === 1 ? alias : undefined;
};

/** A runnable import for the tool, preferring a plain identifier. */
const importLine = (module: CodeModule, name: string) => {
  const local = IDENTIFIER.test(name) ? name : codeAlias(module, name);
  return local !== undefined
    ? `import { ${local} } from ${JSON.stringify(module.name)}`
    : `import { ${JSON.stringify(name)} as ${identifierFor(name)} } from ${JSON.stringify(module.name)}`;
};

const localName = (module: CodeModule, name: string) =>
  IDENTIFIER.test(name)
    ? name
    : (codeAlias(module, name) ?? identifierFor(name));

export const searchTools = (
  modules: ReadonlyArray<CodeModule>,
  query: string,
): string => {
  const normalized = query.trim().toLowerCase();
  const words = normalized.split(/\W+/).filter(Boolean);
  const functions = modules.flatMap((module) =>
    module.functions.map((fn) => ({
      module,
      fn,
      exact: `${module.name}.${fn.name}`.toLowerCase() === normalized,
      score: words.reduce(
        (score, word) =>
          score +
          (fn.name.toLowerCase().includes(word) ? 3 : 0) +
          (fn.description.toLowerCase().includes(word) ? 1 : 0),
        0,
      ),
    })),
  );
  const exact = functions.filter((entry) => entry.exact);
  const selected = exact.length
    ? exact
    : normalized === ""
      ? functions
      : functions
          .filter((entry) => entry.score > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, 20);
  return (
    selected
      .map(
        ({ module, fn }) =>
          `${importLine(module, fn.name)}\n// ${fn.description.replace(/\r?\n/g, "\n// ")}\n${localName(module, fn.name)}(input: ${schemaType(fn.inputSchema)}): Promise<unknown>`,
      )
      .join("\n\n") || "No matching functions."
  );
};
