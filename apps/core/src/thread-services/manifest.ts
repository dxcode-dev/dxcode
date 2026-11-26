import { Option, Schema } from "effect";
import { parse } from "yaml";
import { INTERNAL_GUEST_PORTS } from "../portals/host.js";

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
 * ports: [8080]            # optional: more Portals, with no command
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

// Record keys are checked by hand: a refined key schema drops keys that
// fail it instead of rejecting the manifest.
const SERVICE_NAME = /^[a-z0-9][a-z0-9-]{0,31}$/;
const ENVIRONMENT_NAME = /^[A-Za-z_][A-Za-z0-9_]{0,127}$/;

const ServicePort = Schema.Int.check(
  Schema.isBetween({ minimum: 1, maximum: 65_535 }),
  Schema.makeFilter((port) => !INTERNAL_GUEST_PORTS.has(port)),
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
  services: Schema.optional(Schema.Record(Schema.String, DeclaredServiceBody)),
  // Ports to list as Portals without a command dx runs, such as a server
  // the setup script or another service starts.
  ports: Schema.optional(Schema.Array(ServicePort)),
});

export interface DeclaredService {
  readonly name: string;
  readonly command: string;
  readonly port: number;
  readonly cwd?: string;
  readonly env: Readonly<Record<string, string>>;
}

export interface ServicesManifestDocument {
  readonly services: ReadonlyArray<DeclaredService>;
  /** `ports:` entries no service declares, ascending. */
  readonly ports: ReadonlyArray<number>;
}

/**
 * The declared services, or `undefined` when the manifest is not valid YAML,
 * breaks a rule, declares more than `MAX_SERVICES`, or reuses a port.
 */
export const parseServicesManifest = (
  text: string,
): ReadonlyArray<DeclaredService> | undefined =>
  parseServicesManifestDocument(text)?.services;

/**
 * The declared services and extra Portal ports, or `undefined` when the
 * manifest is refused (see `parseServicesManifest`), or lists more than
 * `MAX_SERVICES` extra ports.
 */
export const parseServicesManifestDocument = (
  text: string,
): ServicesManifestDocument | undefined => {
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
  const declared = manifest.value.services ?? {};
  for (const [name, body] of Object.entries(declared)) {
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
  const services = Object.entries(declared).map(
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
  const servicePorts = new Set(services.map((service) => service.port));
  const ports = [...new Set(manifest.value.ports ?? [])]
    .filter((port) => !servicePorts.has(port))
    .sort((left, right) => left - right);
  if (ports.length > MAX_SERVICES) return undefined;
  return { services, ports };
};

/** A declared service, and the checkout whose manifest declares it. */
export interface CheckoutService extends DeclaredService {
  /** A repository under `~/workspace/repos`; absent for the primary. */
  readonly checkout?: string;
}

/** Every checkout's declared services and extra Portal ports, merged. */
export interface ThreadServices {
  readonly services: ReadonlyArray<CheckoutService>;
  readonly ports: ReadonlyArray<number>;
  /** `invalid` when dx refuses any checkout's manifest. */
  readonly file: "valid" | "missing" | "invalid";
}

/**
 * The manifests of the primary checkout and of the repositories under
 * `~/workspace/repos`, merged in that order: a port the primary (or an
 * earlier checkout) declares is not declared again. A refused manifest
 * contributes nothing.
 */
export const mergeServicesManifests = (
  manifests: ReadonlyArray<{
    readonly checkout?: string | undefined;
    readonly content: string;
  }>,
): ThreadServices => {
  const services: CheckoutService[] = [];
  const ports = new Set<number>();
  const taken = new Set<number>();
  let invalid = false;
  for (const manifest of manifests) {
    const document = parseServicesManifestDocument(manifest.content);
    if (document === undefined) {
      invalid = true;
      continue;
    }
    for (const service of document.services) {
      if (taken.has(service.port)) continue;
      taken.add(service.port);
      services.push(
        manifest.checkout === undefined
          ? service
          : { ...service, checkout: manifest.checkout },
      );
    }
    for (const port of document.ports) ports.add(port);
  }
  return {
    services: services.slice(0, MAX_SERVICES * 4),
    ports: [...ports]
      .filter((port) => !taken.has(port))
      .sort((left, right) => left - right),
    file: invalid ? "invalid" : manifests.length === 0 ? "missing" : "valid",
  };
};
