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
      const slug =
        displayName
          .normalize("NFKD")
          .replace(/[\u0300-\u036f]/g, "")
          .toLowerCase()
          .replace(/[^a-z0-9]+/g, "_")
          .replace(/^_+|_+$/g, "") || "mcp";
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
          `import { ${fn.name} } from ${JSON.stringify(module.name)}\n// ${fn.description.replace(/\r?\n/g, "\n// ")}\n${fn.name}(input: ${schemaType(fn.inputSchema)}): Promise<unknown>`,
      )
      .join("\n\n") || "No matching functions."
  );
};
