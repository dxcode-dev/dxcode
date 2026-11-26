/**
 * Prints dx's OpenAPI 3.1 document, generated from `dxEndpoints`, to stdout:
 *
 *   pnpm -s openapi > openapi.json
 *   pnpm -s openapi --server https://dx.example.com > openapi.json
 *
 * Generated on demand and never committed. See wiki/headless-client.md.
 */
import { parseArgs } from "node:util";
import { dxEndpoints, toOpenApiDocument } from "@dx/api";
import packageJson from "../package.json" with { type: "json" };

const { values } = parseArgs({
  options: { server: { type: "string", multiple: true } },
});

process.stdout.write(
  `${JSON.stringify(
    toOpenApiDocument(dxEndpoints, {
      version: packageJson.version,
      ...(values.server === undefined ? {} : { servers: values.server }),
    }),
    null,
    2,
  )}\n`,
);
