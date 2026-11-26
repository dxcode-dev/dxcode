import { Schema } from "effect";
import { describe, expect, it } from "vitest";
import { defineEndpoint, type Endpoint, FileAnswerSchema } from "./endpoint.js";
import { openApiProblems, toOpenApiDocument } from "./openapi.js";
import { errorResponse, successResponse } from "./response.js";

/**
 * Ways an endpoint can fail to become OpenAPI, each of which must be reported
 * with how to fix it:
 * - a `:name` in the path that params lacks, or a params field the path lacks
 * - path parameters without any params schema, or params that is not a struct
 * - two endpoints with one id (the operationId), or one route and one upload
 *   kind, or one route under other parameter names
 * - a value JSON cannot carry: a declaration such as DateTimeUtc, a bigint,
 *   or a required field that may be undefined
 * - a path or query field that does not encode to a string, number, or boolean
 * - a refusal without a status, or with one outside 4xx and 5xx
 * - a GET with a body
 */
const NotFound = errorResponse("NOT_FOUND", "Not found.");
const Busy = errorResponse("BUSY", "Busy.");
const Ok = successResponse(Schema.Struct({ ok: Schema.Boolean }));

const endpoint = (
  overrides: Partial<Parameters<typeof defineEndpoint>[0]> = {},
): Endpoint =>
  defineEndpoint({
    id: "things.get",
    method: "GET",
    path: "/v1/things/:thingId",
    params: Schema.Struct({ thingId: Schema.String }),
    success: Ok,
    ...overrides,
  } as Parameters<typeof defineEndpoint>[0]) as Endpoint;

describe("openApiProblems", () => {
  it("accepts a well-formed endpoint", () => {
    expect(openApiProblems([endpoint()])).toEqual([]);
  });

  it.each([
    [
      "a path parameter params lacks",
      endpoint({ path: "/v1/things/:thingId/parts/:partId" }),
      "things.get: path parameter :partId in /v1/things/:thingId/parts/:partId is not a field of params. Add partId to the params schema.",
    ],
    [
      "a params field the path lacks",
      endpoint({
        params: Schema.Struct({ thingId: Schema.String, extra: Schema.String }),
      }),
      "things.get: params field extra is not a :extra in /v1/things/:thingId. Remove it from params, or move it to query.",
    ],
    [
      "path parameters without params",
      endpoint({ params: undefined }),
      "things.get: /v1/things/:thingId has path parameters but no params. Add params: Schema.Struct({ thingId }).",
    ],
    [
      "params that is not a struct",
      endpoint({ params: Schema.String }),
      "things.get: params must be a Schema.Struct of named fields, one per path parameter.",
    ],
    [
      "a declaration without a JSON encoding",
      endpoint({
        success: successResponse(Schema.Struct({ at: Schema.DateTimeUtc })),
      }),
      "things.get: success has no JSON form: data.at is a value without a JSON encoding, such as Schema.DateTimeUtc; use a schema that encodes to JSON, such as Schema.DateTimeUtcFromString.",
    ],
    [
      "a bigint",
      endpoint({ body: Schema.Struct({ n: Schema.BigInt }), method: "POST" }),
      "things.get: body has no JSON form: n is a bigint; encode it as a string, such as Schema.BigIntFromString.",
    ],
    [
      "a required field that may be undefined",
      endpoint({
        method: "POST",
        body: Schema.Struct({ note: Schema.UndefinedOr(Schema.String) }),
      }),
      "things.get: body has no JSON form: note is undefined, which JSON drops; make the field Schema.optional instead.",
    ],
    [
      "a query field that is not a scalar",
      endpoint({
        query: Schema.Struct({ tags: Schema.Array(Schema.String) }),
      }),
      "things.get: query field tags does not encode to a string, number, or boolean, so it cannot go in the URL. Encode it to a string, or send it in the body.",
    ],
    [
      "a refusal status outside 4xx and 5xx",
      endpoint({ refusals: [{ status: 200, schema: NotFound }] }),
      "things.get: refusal status 200 is not a 4xx or 5xx status. Use the status Core sends the refusal with.",
    ],
    [
      "a refusal without a status",
      endpoint({
        refusals: [{ status: 404, schema: NotFound }, Busy as never],
      }),
      "things.get: refusal 2 has no status. Write it as { status: <the status Core sends it with>, schema: <its schema> }.",
    ],
    [
      "a GET with a body",
      endpoint({ body: Schema.Struct({ ok: Schema.Boolean }) }),
      "things.get: a GET endpoint cannot send a body. Move its fields to query.",
    ],
  ])("reports %s", (_, broken, problem) => {
    expect(openApiProblems([broken])).toContain(problem);
  });

  it("accepts one route once per upload kind", () => {
    expect(
      openApiProblems([
        endpoint({
          id: "things.put",
          method: "PUT",
          body: Schema.Struct({ ok: Schema.Boolean }),
        }),
        endpoint({ id: "things.putZip", method: "PUT", upload: "bytes" }),
      ]),
    ).toEqual([]);
  });

  it("reports one route under other parameter names", () => {
    expect(
      openApiProblems([
        endpoint(),
        endpoint({
          id: "things.getZip",
          upload: "bytes",
          path: "/v1/things/:otherId",
          params: Schema.Struct({ otherId: Schema.String }),
        }),
      ]),
    ).toContain(
      "things.getZip: /v1/things/:otherId is /v1/things/:thingId (things.get) with other parameter names. Name the parameters alike.",
    );
  });

  it("reports a repeated id and a repeated route", () => {
    expect(
      openApiProblems([
        endpoint(),
        endpoint({
          path: "/v1/things/:otherId",
          params: Schema.Struct({ otherId: Schema.String }),
        }),
      ]),
    ).toEqual([
      "things.get: GET /v1/things/:otherId is the same route as things.get. Define each route once, or once per upload kind.",
      "things.get: /v1/things/:otherId is /v1/things/:thingId (things.get) with other parameter names. Name the parameters alike.",
      "things.get: 2 endpoints use this id, which is the OpenAPI operationId. Give each endpoint its own id.",
    ]);
  });
});

describe("toOpenApiDocument", () => {
  const Shared = Schema.Struct({ name: Schema.String }).annotate({
    identifier: "Shared",
  });
  const document = toOpenApiDocument(
    [
      endpoint({
        id: "things.update",
        summary: "Update a thing",
        method: "PATCH",
        query: Schema.Struct({
          dryRun: Schema.Literals(["true", "false"]),
          note: Schema.optional(Schema.String),
        }),
        body: Schema.Struct({
          name: Schema.optional(Schema.String),
          clear: Schema.optional(Schema.NullOr(Schema.String)),
        }),
        success: successResponse(Shared),
        successStatus: 201,
        refusals: [
          { status: 404, schema: NotFound },
          { status: 503, schema: Busy },
          { status: 503, schema: NotFound },
        ],
      }),
      endpoint({
        id: "things.list",
        path: "/v1/things",
        params: undefined,
        success: successResponse(Schema.Array(Shared)),
      }),
    ],
    { version: "1.2.3", servers: ["https://dx.example.com"] },
  );
  const update = document.paths["/v1/things/{thingId}"]?.patch;

  it("names each operation by its endpoint id and feature", () => {
    expect(update?.operationId).toBe("things.update");
    expect(update?.summary).toBe("Update a thing");
    expect(document.paths["/v1/things"]?.get).not.toHaveProperty("summary");
    expect(update?.tags).toEqual(["things"]);
    expect(document.paths["/v1/things"]?.get?.operationId).toBe("things.list");
    expect(document.servers).toEqual([{ url: "https://dx.example.com" }]);
    expect(document.info.version).toBe("1.2.3");
  });

  it("lists path and query parameters, an optional field as absent rather than null", () => {
    expect(update?.parameters).toEqual([
      {
        name: "thingId",
        in: "path",
        required: true,
        schema: { type: "string" },
      },
      {
        name: "dryRun",
        in: "query",
        required: true,
        schema: { type: "string", enum: ["true", "false"] },
      },
      {
        name: "note",
        in: "query",
        required: false,
        schema: { type: "string" },
      },
    ]);
    const body = update?.requestBody?.content["application/json"].schema;
    expect(body?.properties).toEqual({
      name: { type: "string" },
      clear: { anyOf: [{ type: "string" }, { type: "null" }] },
    });
    expect(body?.required).toBeUndefined();
  });

  it("answers success with its status and each refusal under its status", () => {
    expect(Object.keys(update?.responses ?? {})).toEqual(["201", "404", "503"]);
    expect(update?.responses["404"]?.description).toBe("NOT_FOUND");
    expect(update?.responses["503"]?.description).toBe("BUSY, NOT_FOUND");
    expect(
      update?.responses["503"]?.content?.["application/json"]?.schema.oneOf,
    ).toHaveLength(2);
  });

  it("shares a schema with an identifier as a component", () => {
    expect(Object.keys(document.components.schemas)).toEqual(["Shared"]);
    expect(
      update?.responses["201"]?.content?.["application/json"]?.schema
        .properties,
    ).toMatchObject({ data: { $ref: "#/components/schemas/Shared" } });
  });

  it("throws every problem at once", () => {
    expect(() =>
      toOpenApiDocument(
        [endpoint({ refusals: [{ status: 99, schema: Busy }] })],
        {
          version: "1",
        },
      ),
    ).toThrow(
      "dx endpoints cannot become an OpenAPI document:\n- things.get: refusal status 99",
    );
  });
});

describe("toOpenApiDocument with uploads and file answers", () => {
  const document = toOpenApiDocument(
    [
      endpoint({
        id: "things.install",
        method: "POST",
        path: "/v1/things",
        params: undefined,
        body: Schema.Struct({ url: Schema.String }),
        refusals: [{ status: 400, schema: NotFound }],
      }),
      endpoint({
        id: "things.installZip",
        method: "POST",
        path: "/v1/things",
        params: undefined,
        upload: "bytes",
        refusals: [
          { status: 400, schema: NotFound },
          { status: 413, schema: Busy },
        ],
      }),
      endpoint({ id: "things.report", method: "POST", upload: "multipart" }),
      endpoint({
        id: "things.download",
        success: FileAnswerSchema,
        answer: "file",
        refusals: [{ status: 404, schema: NotFound }],
      }),
    ],
    { version: "1" },
  );
  const install = document.paths["/v1/things"]?.post;

  it("merges a JSON body and a bytes upload of one route into one operation", () => {
    expect(install?.operationId).toBe("things.install");
    expect(Object.keys(install?.requestBody?.content ?? {})).toEqual([
      "application/json",
      "application/octet-stream",
    ]);
    expect(
      install?.requestBody?.content["application/octet-stream"]?.schema,
    ).toEqual({
      type: "string",
      format: "binary",
    });
    expect(Object.keys(install?.responses ?? {})).toEqual([
      "200",
      "400",
      "413",
    ]);
    expect(install?.responses["400"]?.description).toBe("NOT_FOUND");
  });

  it("names a rest path parameter without its pattern", () => {
    const files = toOpenApiDocument(
      [
        endpoint({
          id: "things.file",
          path: "/v1/things/:thingId/files/:path{.+}",
          params: Schema.Struct({
            thingId: Schema.String,
            path: Schema.String,
          }),
        }),
      ],
      { version: "1" },
    );
    const read = files.paths["/v1/things/{thingId}/files/{path}"]?.get;
    expect(
      read?.parameters.map(({ name, ...rest }) => [name, rest["x-dx-rest"]]),
    ).toEqual([
      ["thingId", undefined],
      ["path", true],
    ]);
  });

  it("sends a multipart upload as form data", () => {
    expect(
      Object.keys(
        document.paths["/v1/things/{thingId}"]?.post?.requestBody?.content ??
          {},
      ),
    ).toEqual(["multipart/form-data"]);
  });

  it("answers a file as bytes", () => {
    const download = document.paths["/v1/things/{thingId}"]?.get;
    expect(download?.responses["200"]).toEqual({
      description: "Success",
      content: {
        "application/octet-stream": {
          schema: { type: "string", format: "binary" },
        },
      },
    });
    expect(download?.responses["404"]?.description).toBe("NOT_FOUND");
  });
});
