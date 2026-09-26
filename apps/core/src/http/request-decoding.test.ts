import { Effect, Result, Schema } from "effect";
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  decodeJsonBody,
  decodeLimitedJsonBody,
  decodeRequestInput,
} from "./request-decoding.js";

class InvalidTestRequest extends Schema.TaggedError<InvalidTestRequest>()(
  "InvalidTestRequest",
  {},
) {}

const Body = Schema.Struct({ name: Schema.String });
const invalid = () => new InvalidTestRequest();

const decodeBody = async (headers: HeadersInit, body: string) => {
  const app = new Hono();
  app.post("/", async (context) => {
    const result = await Effect.runPromise(
      Effect.result(decodeJsonBody(context.req, Body, invalid)),
    );
    return Result.isSuccess(result)
      ? context.json({ status: "success", data: result.success })
      : context.json({ status: "error", tag: result.failure._tag });
  });
  return app.request("/", { method: "POST", headers, body });
};

const decodeLimitedBody = async (
  headers: HeadersInit,
  body: string,
  maxBytes: number,
) => {
  const app = new Hono();
  app.post("/", async (context) => {
    const result = await Effect.runPromise(
      Effect.result(
        decodeLimitedJsonBody(context.req, maxBytes, Body, invalid),
      ),
    );
    return Result.isSuccess(result)
      ? context.json({ status: "success", data: result.success })
      : context.json({ status: "error", tag: result.failure._tag });
  });
  return app.request("/", { method: "POST", headers, body });
};

describe("request decoding", () => {
  it("accepts the supported JSON media type forms", async () => {
    for (const contentType of [
      "application/json",
      "APPLICATION/JSON",
      "application/json; charset=utf-8",
      "application/json ; charset=utf-8",
    ]) {
      const response = await decodeBody(
        { "content-type": contentType },
        JSON.stringify({ name: "dx" }),
      );
      expect(await response.json()).toMatchObject({
        status: "success",
        data: { name: "dx" },
      });
    }
  });

  it("maps missing media, wrong media, malformed JSON, and excess fields", async () => {
    for (const [headers, body] of [
      [{}, JSON.stringify({ name: "dx" })],
      [{ "content-type": "text/plain" }, JSON.stringify({ name: "dx" })],
      [{ "content-type": "application/json" }, "{"],
      [
        { "content-type": "application/json" },
        JSON.stringify({ name: "dx", owner: "hidden" }),
      ],
    ] as const) {
      const response = await decodeBody(headers, body);
      expect(await response.json()).toMatchObject({
        status: "error",
        tag: "InvalidTestRequest",
      });
    }
  });

  it("rejects an oversized JSON body before schema decoding", async () => {
    const body = JSON.stringify({ name: "dx" });
    const response = await decodeLimitedBody(
      { "content-type": "application/json" },
      body,
      body.length - 1,
    );
    expect(await response.json()).toMatchObject({
      status: "error",
      tag: "InvalidTestRequest",
    });
  });

  it("strictly decodes non-body request input with the supplied error", async () => {
    const failure = await Effect.runPromise(
      Effect.result(
        decodeRequestInput(Body, { name: "dx", unknown: true }, invalid),
      ),
    );
    expect(failure).toMatchObject({
      _tag: "Failure",
      failure: { _tag: "InvalidTestRequest" },
    });
  });
});
