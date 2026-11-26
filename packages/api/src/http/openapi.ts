import {
  JsonSchema,
  Predicate,
  type SchemaAST,
  SchemaRepresentation,
} from "effect";
import type { Endpoint } from "./endpoint.js";

/**
 * The OpenAPI 3.1 description of dx's endpoints, so a Swift, Kotlin, or Rust
 * client can be generated from `dxEndpoints`. Schemas describe the wire form
 * Core sends and reads: the encoded side of each endpoint schema. A schema
 * annotated with an `identifier` becomes a shared `components/schemas` entry.
 * See wiki/headless-client.md.
 */
export interface OpenApiDocument {
  readonly openapi: "3.1.0";
  readonly info: { readonly title: string; readonly version: string };
  readonly servers?: ReadonlyArray<{ readonly url: string }>;
  readonly paths: Record<string, Record<string, OpenApiOperation>>;
  readonly components: {
    readonly schemas: JsonSchema.Definitions;
    readonly securitySchemes: Record<string, JsonSchema.JsonSchema>;
  };
  readonly security: ReadonlyArray<Record<string, ReadonlyArray<string>>>;
}

export interface OpenApiOperation {
  readonly operationId: string;
  readonly summary?: string;
  readonly tags: ReadonlyArray<string>;
  readonly parameters: ReadonlyArray<OpenApiParameter>;
  readonly requestBody?: OpenApiContent & { readonly required: true };
  readonly responses: Record<string, OpenApiResponse>;
}

export interface OpenApiParameter {
  readonly name: string;
  readonly in: "path" | "query";
  readonly required: boolean;
  readonly schema: JsonSchema.JsonSchema;
  /** A rest path parameter: its value keeps its slashes, each segment encoded. */
  readonly "x-dx-rest"?: true;
}

interface OpenApiContent {
  readonly content: Record<string, { readonly schema: JsonSchema.JsonSchema }>;
}

/** A response; one with no body, such as a 204, has no `content`. */
export type OpenApiResponse = Partial<OpenApiContent> & {
  readonly description: string;
};

export interface OpenApiOptions {
  readonly title?: string;
  readonly version: string;
  /** Origins clients call, such as `https://dx.example.com`. */
  readonly servers?: ReadonlyArray<string>;
}

const securitySchemes = {
  bearerAuth: {
    type: "http",
    scheme: "bearer",
    description:
      "A personal API token from Settings, sent as `Authorization: Bearer <token>`.",
  },
};

const security = [{ bearerAuth: [] }];

type Representation = SchemaRepresentation.Representation;
type Part = "params" | "query" | "body" | "success" | "refusal";

interface Root {
  readonly endpoint: Endpoint;
  readonly part: Part;
  /** The refusal's status; undefined only for an endpoint built by hand. */
  readonly status?: number | undefined;
  /** The refusal's place in `refusals`, from 1. */
  readonly position?: number;
  readonly schema: { readonly ast: SchemaAST.AST };
}

/** `:threadId`, or a rest parameter such as `:path{.+}` that keeps slashes. */
const pathParameter = /:([A-Za-z0-9_]+)(\{[^}]*\})?/g;

const restParameterNames = (path: string) =>
  [...path.matchAll(pathParameter)]
    .filter((match) => match[2] !== undefined)
    .map((match) => match[1] as string);

const pathParameterNames = (path: string) =>
  [...path.matchAll(pathParameter)].map((match) => match[1] as string);

const openApiPath = (path: string) => path.replace(pathParameter, "{$1}");

const rootsOf = (endpoint: Endpoint): ReadonlyArray<Root> => [
  ...(endpoint.params === undefined
    ? []
    : [{ endpoint, part: "params" as const, schema: endpoint.params }]),
  ...(endpoint.query === undefined
    ? []
    : [{ endpoint, part: "query" as const, schema: endpoint.query }]),
  ...(endpoint.body === undefined
    ? []
    : [{ endpoint, part: "body" as const, schema: endpoint.body }]),
  ...(endpoint.answer !== "json"
    ? []
    : [{ endpoint, part: "success" as const, schema: endpoint.success }]),
  ...endpoint.refusals.map((refusal, index) => ({
    endpoint,
    part: "refusal" as const,
    // A bare schema in place of { status, schema }, which a cast lets in.
    status: Number.isFinite(refusal.status) ? refusal.status : undefined,
    position: index + 1,
    schema: "ast" in refusal ? (refusal as Root["schema"]) : refusal.schema,
  })),
];

/**
 * JSON has no `undefined`: `JSON.stringify` drops an optional field holding
 * it. Remove `Undefined` from optional properties so OpenAPI describes an
 * absent field rather than a `null` one, which Core would refuse.
 */
const withoutOptionalUndefined = <A>(node: A): A => {
  if (Array.isArray(node)) return node.map(withoutOptionalUndefined) as A;
  if (
    node === null ||
    typeof node !== "object" ||
    Object.getPrototypeOf(node) !== Object.prototype
  )
    return node;
  const copy: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(node))
    copy[key] = key === "annotations" ? value : withoutOptionalUndefined(value);
  if (Predicate.isTagged(node, "Objects"))
    copy.propertySignatures = (
      copy.propertySignatures as ReadonlyArray<SchemaRepresentation.PropertySignature>
    ).map((property) =>
      property.isOptional
        ? { ...property, type: withoutUndefinedMember(property.type) }
        : property,
    );
  return copy as A;
};

const withoutUndefinedMember = (type: Representation): Representation => {
  if (!Predicate.isTagged(type, "Union")) return type;
  const types = type.types.filter(
    (member) => !Predicate.isTagged(member, "Undefined"),
  );
  if (types.length === type.types.length) return type;
  if (types.length === 1 && type.checks.length === 0)
    return types[0] as Representation;
  return { ...type, types };
};

const representationsOf = (roots: ReadonlyArray<Root>) => {
  const asts = roots.map(({ schema }) => schema.ast);
  const document = SchemaRepresentation.toRepresentations(
    asts as [(typeof asts)[number], ...typeof asts],
  );
  return withoutOptionalUndefined(document);
};

/** Tags whose values JSON cannot carry, so a wire schema must not hold them. */
const nonJsonTags: Record<string, string> = {
  Declaration:
    "a value without a JSON encoding, such as Schema.DateTimeUtc; use a schema that encodes to JSON, such as Schema.DateTimeUtcFromString",
  BigInt: "a bigint; encode it as a string, such as Schema.BigIntFromString",
  Symbol: "a symbol",
  UniqueSymbol: "a symbol",
  Void: "void",
  Undefined:
    "undefined, which JSON drops; make the field Schema.optional instead",
  Never: "never",
};

/** Where `representation` holds a value JSON cannot carry, as `at.path: why`. */
const nonJsonValues = (
  representation: Representation,
  references: SchemaRepresentation.References,
): ReadonlyArray<string> => {
  const found: Array<string> = [];
  const visiting = new Set<string>();
  const visit = (node: Representation, at: string) => {
    const why = nonJsonTags[node._tag];
    if (why !== undefined) {
      found.push(`${at === "" ? "the root" : at} is ${why}`);
      return;
    }
    if (Predicate.isTagged(node, "Reference")) {
      const target = references[node.$ref];
      if (target === undefined || visiting.has(node.$ref)) return;
      visiting.add(node.$ref);
      visit(target, at);
      visiting.delete(node.$ref);
    } else if (Predicate.isTagged(node, "Suspend")) visit(node.thunk, at);
    else if (Predicate.isTagged(node, "Union"))
      for (const member of node.types) visit(member, at);
    else if (Predicate.isTagged(node, "Objects")) {
      for (const property of node.propertySignatures)
        visit(property.type, `${at}.${String(property.name)}`);
      for (const index of node.indexSignatures) visit(index.type, `${at}[*]`);
    } else if (Predicate.isTagged(node, "Arrays")) {
      for (const [position, element] of node.elements.entries())
        visit(element.type, `${at}[${position}]`);
      for (const rest of node.rest) visit(rest, `${at}[*]`);
    }
  };
  visit(representation, "");
  return found.map((entry) => entry.replace(/^\./, ""));
};

const resolve = (
  node: Representation,
  references: SchemaRepresentation.References,
): Representation => {
  let current = node;
  const seen = new Set<string>();
  while (Predicate.isTagged(current, "Reference") && !seen.has(current.$ref)) {
    seen.add(current.$ref);
    const target = references[current.$ref];
    if (target === undefined) return current;
    current = target;
  }
  return Predicate.isTagged(current, "Suspend")
    ? resolve(current.thunk, references)
    : current;
};

const scalarTags = new Set([
  "String",
  "Number",
  "Boolean",
  "Literal",
  "TemplateLiteral",
  "Enum",
]);

/** Whether every value of `node` is a string, number, or boolean. */
const isScalar = (
  node: Representation,
  references: SchemaRepresentation.References,
): boolean => {
  const resolved = resolve(node, references);
  if (Predicate.isTagged(resolved, "Union"))
    return resolved.types.every((member) => isScalar(member, references));
  return scalarTags.has(resolved._tag);
};

const fieldProblems = (
  root: Root,
  representation: Representation,
  references: SchemaRepresentation.References,
): ReadonlyArray<string> => {
  const { endpoint, part } = root;
  const resolved = resolve(representation, references);
  if (!Predicate.isTagged(resolved, "Objects"))
    return [
      `${endpoint.id}: ${part} must be a Schema.Struct of named fields, one per ${part === "params" ? "path parameter" : "query field"}.`,
    ];
  const problems: Array<string> = [];
  const fields = resolved.propertySignatures.map(({ name }) => String(name));
  if (part === "params") {
    const names = pathParameterNames(endpoint.path);
    for (const name of names)
      if (!fields.includes(name))
        problems.push(
          `${endpoint.id}: path parameter :${name} in ${endpoint.path} is not a field of params. Add ${name} to the params schema.`,
        );
    for (const name of fields)
      if (!names.includes(name))
        problems.push(
          `${endpoint.id}: params field ${name} is not a :${name} in ${endpoint.path}. Remove it from params, or move it to query.`,
        );
  }
  for (const property of resolved.propertySignatures) {
    const name = String(property.name);
    if (part === "params" && property.isOptional)
      problems.push(
        `${endpoint.id}: path parameter ${name} is optional. A path parameter is always required.`,
      );
    if (!isScalar(property.type, references))
      problems.push(
        `${endpoint.id}: ${part} field ${name} does not encode to a string, number, or boolean, so it cannot go in the URL. Encode it to a string, or send it in the body.`,
      );
  }
  return problems;
};

const rootProblems = (
  root: Root,
  representation: Representation,
  references: SchemaRepresentation.References,
): ReadonlyArray<string> => [
  ...nonJsonValues(representation, references).map(
    (where) =>
      `${root.endpoint.id}: ${root.part}${root.status === undefined ? "" : ` ${root.status}`} has no JSON form: ${where}.`,
  ),
  ...(root.part === "params" || root.part === "query"
    ? fieldProblems(root, representation, references)
    : []),
  ...(root.part === "refusal" && root.status === undefined
    ? [
        `${root.endpoint.id}: refusal ${root.position} has no status. Write it as { status: <the status Core sends it with>, schema: <its schema> }.`,
      ]
    : []),
  ...(root.part === "refusal" &&
  root.status !== undefined &&
  !(Number.isInteger(root.status) && root.status >= 400 && root.status < 600)
    ? [
        `${root.endpoint.id}: refusal status ${root.status} is not a 4xx or 5xx status. Use the status Core sends the refusal with.`,
      ]
    : []),
];

const compile = (roots: ReadonlyArray<Root>) => {
  const document = representationsOf(roots);
  const compiled = JsonSchema.toMultiDocumentOpenApi3_1(
    SchemaRepresentation.toJsonSchemaMultiDocument(document),
  );
  return { document, compiled };
};

const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error);

/**
 * Every reason `endpoints` cannot become an OpenAPI document, each with how
 * to fix it; empty when it can. Core's contract test fails on any of them.
 */
export const openApiProblems = (
  endpoints: ReadonlyArray<Endpoint>,
): ReadonlyArray<string> => {
  const problems: Array<string> = [];
  const ids = new Map<string, number>();
  const routes = new Map<string, Endpoint>();
  for (const [position, endpoint] of endpoints.entries()) {
    ids.set(endpoint.id, (ids.get(endpoint.id) ?? 0) + 1);
    const route = `${endpoint.method} ${endpoint.path.replace(pathParameter, ":")} (${endpoint.upload})`;
    const other = routes.get(route);
    if (other !== undefined)
      problems.push(
        `${endpoint.id}: ${endpoint.method} ${endpoint.path} is the same route as ${other.id}. Define each route once, or once per upload kind.`,
      );
    else routes.set(route, endpoint);
    const variant = endpoints
      .slice(0, position)
      .find(
        (candidate) =>
          candidate.method === endpoint.method &&
          candidate.path !== endpoint.path &&
          candidate.path.replace(pathParameter, ":") ===
            endpoint.path.replace(pathParameter, ":"),
      );
    if (variant !== undefined)
      problems.push(
        `${endpoint.id}: ${endpoint.path} is ${variant.path} (${variant.id}) with other parameter names. Name the parameters alike.`,
      );
    if (
      endpoint.params === undefined &&
      pathParameterNames(endpoint.path).length > 0
    )
      problems.push(
        `${endpoint.id}: ${endpoint.path} has path parameters but no params. Add params: Schema.Struct({ ${pathParameterNames(endpoint.path).join(", ")} }).`,
      );
    if (endpoint.method === "GET" && endpoint.body !== undefined)
      problems.push(
        `${endpoint.id}: a GET endpoint cannot send a body. Move its fields to query.`,
      );
    const roots = rootsOf(endpoint);
    let compiled: ReturnType<typeof compile>;
    try {
      compiled = compile(roots);
    } catch (error) {
      problems.push(
        `${endpoint.id}: its schemas do not convert to JSON Schema: ${describeError(error)}`,
      );
      continue;
    }
    const { representations, references } = compiled.document;
    for (const [index, root] of roots.entries())
      problems.push(
        ...rootProblems(
          root,
          representations[index] as Representation,
          references,
        ),
      );
  }
  for (const [id, count] of ids)
    if (count > 1)
      problems.push(
        `${id}: ${count} endpoints use this id, which is the OpenAPI operationId. Give each endpoint its own id.`,
      );
  return problems;
};

const deref = (
  schema: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
): JsonSchema.JsonSchema => {
  const ref = schema.$ref;
  if (typeof ref !== "string" || !ref.startsWith("#/components/schemas/"))
    return schema;
  return definitions[ref.slice("#/components/schemas/".length)] ?? schema;
};

/** The `data.code` constant of an error answer, for its description. */
const refusalCode = (
  schema: JsonSchema.JsonSchema,
  definitions: JsonSchema.Definitions,
): string | undefined => {
  const properties = deref(schema, definitions).properties as
    | Record<string, JsonSchema.JsonSchema>
    | undefined;
  const data = properties?.data;
  if (data === undefined) return undefined;
  const fields = deref(data, definitions).properties as
    | Record<string, JsonSchema.JsonSchema>
    | undefined;
  const code = fields?.code;
  const value =
    Array.isArray(code?.enum) && code.enum.length === 1
      ? code.enum[0]
      : code?.const;
  return typeof value === "string" ? value : undefined;
};

const binary = { type: "string", format: "binary" };

const jsonContent = (schema: JsonSchema.JsonSchema): OpenApiContent => ({
  content: { "application/json": { schema } },
});

/** One schema, or `oneOf` the distinct ones. */
const oneOf = (
  schemas: ReadonlyArray<JsonSchema.JsonSchema>,
): JsonSchema.JsonSchema => {
  const distinct = [
    ...new Map(
      schemas.map((schema) => [JSON.stringify(schema), schema]),
    ).values(),
  ];
  return distinct.length === 1
    ? (distinct[0] as JsonSchema.JsonSchema)
    : { oneOf: distinct };
};

/** The request body each upload kind sends, by content type. */
const requestContent = (
  endpoint: Endpoint,
  body: JsonSchema.JsonSchema | undefined,
): OpenApiContent["content"] => {
  if (endpoint.upload === "multipart")
    return { "multipart/form-data": { schema: { type: "object" } } };
  if (endpoint.upload === "bytes")
    return { "application/octet-stream": { schema: binary } };
  return body === undefined ? {} : { "application/json": { schema: body } };
};

const parametersOf = (
  schema: JsonSchema.JsonSchema,
  location: "path" | "query",
  definitions: JsonSchema.Definitions,
  rest: ReadonlyArray<string> = [],
): ReadonlyArray<OpenApiParameter> => {
  const object = deref(schema, definitions);
  const properties = (object.properties ?? {}) as Record<
    string,
    JsonSchema.JsonSchema
  >;
  const required = new Set((object.required ?? []) as ReadonlyArray<string>);
  return Object.entries(properties).map(([name, property]) => ({
    name,
    in: location,
    required: location === "path" || required.has(name),
    schema: property,
    ...(rest.includes(name) ? { "x-dx-rest": true as const } : {}),
  }));
};

/**
 * The OpenAPI 3.1 document for `endpoints`. Each operation's `operationId`
 * is its endpoint id and its tag the id's feature; each refusal is listed
 * under the status Core sends it with.
 *
 * @throws Error listing every problem `openApiProblems` finds.
 */
export const toOpenApiDocument = (
  endpoints: ReadonlyArray<Endpoint>,
  options: OpenApiOptions,
): OpenApiDocument => {
  const problems = openApiProblems(endpoints);
  if (problems.length > 0)
    throw new Error(
      `dx endpoints cannot become an OpenAPI document:\n- ${problems.join("\n- ")}`,
    );
  const roots = endpoints.flatMap(rootsOf);
  const paths: Record<string, Record<string, OpenApiOperation>> = {};
  if (roots.length === 0)
    return {
      openapi: "3.1.0",
      info: { title: options.title ?? "dx", version: options.version },
      paths,
      components: { schemas: {}, securitySchemes },
      security,
    };
  const { compiled } = compile(roots);
  const definitions = compiled.definitions;
  let next = 0;
  const compiledRoots = endpoints.map((endpoint) =>
    rootsOf(endpoint).map((root) => ({
      root,
      schema: compiled.schemas[next++] as JsonSchema.JsonSchema,
    })),
  );
  // Endpoints that share a method and path differ only in `upload`: one
  // operation, one request content type each.
  const operations = new Map<string, Array<number>>();
  for (const [index, endpoint] of endpoints.entries()) {
    const key = `${endpoint.method} ${endpoint.path}`;
    operations.set(key, [...(operations.get(key) ?? []), index]);
  }
  for (const indexes of operations.values()) {
    const variants = indexes.map((index) => ({
      endpoint: endpoints[index] as Endpoint,
      own: compiledRoots[index] ?? [],
    }));
    const first =
      variants.find(({ endpoint }) => endpoint.upload === "json") ??
      (variants[0] as (typeof variants)[number]);
    const parameters = new Map<string, OpenApiParameter>();
    const content: Record<string, { schema: JsonSchema.JsonSchema }> = {};
    const answers = new Map<string, Array<JsonSchema.JsonSchema>>();
    const answer = (status: string, schema: JsonSchema.JsonSchema) =>
      answers.set(status, [...(answers.get(status) ?? []), schema]);
    let fileAnswer: string | undefined;
    let noContent: string | undefined;
    for (const { endpoint, own } of variants) {
      const of = (part: Part) => own.find(({ root }) => root.part === part);
      for (const [part, location] of [
        ["params", "path"],
        ["query", "query"],
      ] as const) {
        const schema = of(part)?.schema;
        if (schema !== undefined)
          for (const parameter of parametersOf(
            schema,
            location,
            definitions,
            restParameterNames(endpoint.path),
          ))
            parameters.set(`${location} ${parameter.name}`, parameter);
      }
      Object.assign(content, requestContent(endpoint, of("body")?.schema));
      const success = of("success")?.schema;
      if (endpoint.answer === "none")
        noContent = String(endpoint.successStatus);
      else if (success === undefined)
        fileAnswer = String(endpoint.successStatus);
      else answer(String(endpoint.successStatus), success);
      for (const { root, schema } of own)
        if (root.part === "refusal") answer(String(root.status), schema);
    }
    const responses: Record<string, OpenApiResponse> = {};
    if (fileAnswer !== undefined)
      responses[fileAnswer] = {
        description: "Success",
        content: { "application/octet-stream": { schema: binary } },
      };
    if (noContent !== undefined)
      responses[noContent] = { description: "Success, with no content" };
    for (const [status, schemas] of answers) {
      const codes = [
        ...new Set(schemas.map((schema) => refusalCode(schema, definitions))),
      ];
      responses[status] = {
        description: codes.every((code) => code === undefined)
          ? "Success"
          : codes.map((code) => code ?? "Success").join(", "),
        ...jsonContent(oneOf(schemas)),
      };
    }
    const path = openApiPath(first.endpoint.path);
    paths[path] ??= {};
    (paths[path] as Record<string, OpenApiOperation>)[
      first.endpoint.method.toLowerCase()
    ] = {
      operationId: first.endpoint.id,
      ...(first.endpoint.summary === undefined
        ? {}
        : { summary: first.endpoint.summary }),
      tags: [first.endpoint.id.split(".")[0] as string],
      parameters: [...parameters.values()],
      ...(Object.keys(content).length === 0
        ? {}
        : { requestBody: { required: true, content } }),
      responses,
    };
  }
  return {
    openapi: "3.1.0",
    info: { title: options.title ?? "dx", version: options.version },
    ...(options.servers === undefined
      ? {}
      : { servers: options.servers.map((url) => ({ url })) }),
    paths,
    components: { schemas: definitions, securitySchemes },
    security,
  };
};
