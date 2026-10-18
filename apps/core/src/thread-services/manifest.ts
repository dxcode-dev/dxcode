import { Option, Schema } from "effect";
import { parse } from "yaml";

/**
 * A Thread's declared services: long-running processes (dev servers) that a
 * Portal starts on demand. The repository commits them at
 * `.dx/services.yaml`:
 *
 * ```yaml
 * services:
 *   web:
 *     command: pnpm dev --host 127.0.0.1 --port $PORT
 *     port: 5173
 *     cwd: apps/web        # optional, relative to the repository
 *     env: { FOO: bar }    # optional; PORT is always the service's port
 * ```
 *
 * Core validates the file; the resident daemon only starts what is not
 * already listening.
 */
export const SERVICES_MANIFEST_PATH = ".dx/services.yaml";
// dxd's `services.rs` checks the same bounds, in UTF-8 bytes, and fails a
// service that breaks one; Core refuses the manifest before sending it.
export const MAX_SERVICES = 16;
export const MAX_SERVICE_COMMAND_BYTES = 4_096;
export const MAX_SERVICE_CWD_BYTES = 256;
export const MAX_SERVICE_ENV = 64;
export const MAX_SERVICE_ENV_VALUE_BYTES = 4_096;
/** dx's own guest ports: the Desktop gateway and Chromium's DevTools. */
const RESERVED_PORTS = new Set([5900, 9222]);

// Record keys are checked by hand: a refined key schema drops keys that
// fail it instead of rejecting the manifest.
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ServicePort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
  Schema.makeFilter((port) => !RESERVED_PORTS.has(port)),
);

const utf8Bytes = (value: string) => new TextEncoder().encode(value).byteLength;

/**
 * Text dxd accepts: within `maxBytes` UTF-8 bytes, without NUL, and with no
 * lone surrogate (it has no UTF-8 form).
 */
const daemonText = (value: string, maxBytes: number) =>
  utf8Bytes(value) <= maxBytes &&
  !value.includes("\0") &&
  !/[\ud800-\udfff]/u.test(value);

const RelativeDirectory = Schema.String.check(
  Schema.isMinLength(1),
  Schema.makeFilter((path) => daemonText(path, MAX_SERVICE_CWD_BYTES)),
  Schema.makeFilter(
    (path) =>
      !path.startsWith("/") &&
      path.split("/").every((segment) => segment !== ".."),
  ),
);

const DeclaredServiceBody = Schema.Struct({
  command: Schema.String.check(
    Schema.isMinLength(1),
    Schema.makeFilter((command) =>
      daemonText(command, MAX_SERVICE_COMMAND_BYTES),
    ),
    // Rust's `trim` also strips U+0085.
    Schema.makeFilter((command) => !/^[\s\u0085]*$/.test(command)),
  ),
  port: ServicePort,
  cwd: Schema.optional(RelativeDirectory),
  env: Schema.optional(
    Schema.Record(
      Schema.String,
      Schema.Union([Schema.String, Schema.Number, Schema.Boolean]),
    ),
  ),
});

const ServicesManifest = Schema.Struct({
  services: Schema.Record(Schema.String, DeclaredServiceBody),
});

export interface DeclaredService {
  readonly name: string;
  readonly command: string;
  readonly port: number;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

/**
 * The declared services, or `undefined` when the manifest is not valid YAML,
 * breaks a rule, declares more than `MAX_SERVICES`, or reuses a port.
 */
export const parseServicesManifest = (
  text: string,
): ReadonlyArray<DeclaredService> | undefined => {
  let document: unknown;
  try {
    document = parse(text, { maxAliasCount: 0 });
  } catch {
    return undefined;
  }
  const manifest = Schema.decodeUnknownOption(ServicesManifest)(document, {
    onExcessProperty: "error",
  });
  if (Option.isNone(manifest)) return undefined;
  for (const [name, body] of Object.entries(manifest.value.services)) {
    const env = Object.entries(body.env ?? {});
    if (
      !SERVICE_NAME.test(name) ||
      env.length > MAX_SERVICE_ENV ||
      env.some(
        ([key, value]) =>
          !ENVIRONMENT_NAME.test(key) ||
          key === "PORT" ||
          !daemonText(String(value), MAX_SERVICE_ENV_VALUE_BYTES),
      )
    )
      return undefined;
  }
  const services = Object.entries(manifest.value.services).map(
    ([name, body]): DeclaredService => ({
      name,
      command: body.command,
      port: body.port,
      ...(body.cwd === undefined ? {} : { cwd: body.cwd }),
      env: Object.fromEntries(
        Object.entries(body.env ?? {}).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    }),
  );
  if (
    services.length > MAX_SERVICES ||
    new Set(services.map((service) => service.port)).size !== services.length
  )
    return undefined;
  return services;
};
