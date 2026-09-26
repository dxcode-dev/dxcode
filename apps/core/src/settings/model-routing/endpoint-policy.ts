export type ModelEndpointValidation =
  | { readonly endpoint: string }
  | { readonly error: "invalid" | "not-allowlisted" };

const parseIpv4 = (input: string): ReadonlyArray<number> | undefined => {
  const parts = input.split(".");
  if (parts.length !== 4) return undefined;
  const values = parts.map(Number);
  return values.every(
    (value, index) =>
      Number.isInteger(value) &&
      value >= 0 &&
      value <= 255 &&
      String(value) === parts[index],
  )
    ? values
    : undefined;
};

const isPublicIpv4 = (input: string): boolean => {
  const values = parseIpv4(input);
  if (values === undefined) return false;
  const [a = 0, b = 0, c = 0] = values;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && (c === 0 || c === 2)) ||
    (a === 192 && b === 168) ||
    (a === 198 && (b === 18 || b === 19)) ||
    (a === 198 && b === 51 && c === 100) ||
    (a === 203 && b === 0 && c === 113) ||
    a >= 224
  );
};

const expandIpv6 = (input: string): ReadonlyArray<number> | undefined => {
  const unwrapped = input.replace(/^\[|\]$/g, "").toLowerCase();
  if (!unwrapped.includes(":")) return undefined;
  const pieces = unwrapped.split("::");
  if (pieces.length > 2) return undefined;
  const parseSide = (side: string): Array<number> | undefined => {
    if (side === "") return [];
    const output: Array<number> = [];
    for (const part of side.split(":")) {
      if (part.includes(".")) {
        const ipv4 = parseIpv4(part);
        if (ipv4 === undefined) return undefined;
        output.push((ipv4[0] << 8) | ipv4[1], (ipv4[2] << 8) | ipv4[3]);
      } else if (!/^[a-f0-9]{1,4}$/.test(part)) return undefined;
      else output.push(Number.parseInt(part, 16));
    }
    return output;
  };
  const left = parseSide(pieces[0] ?? "");
  const right = parseSide(pieces[1] ?? "");
  if (left === undefined || right === undefined) return undefined;
  if (pieces.length === 1) return left.length === 8 ? left : undefined;
  const zeroes = 8 - left.length - right.length;
  return zeroes >= 1
    ? [...left, ...Array.from({ length: zeroes }, () => 0), ...right]
    : undefined;
};

const isPublicIpv6 = (input: string): boolean => {
  const groups = expandIpv6(input);
  if (groups === undefined) return false;
  if (
    groups.slice(0, 5).every((group) => group === 0) &&
    groups[5] === 0xffff
  ) {
    return isPublicIpv4(
      `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`,
    );
  }
  const first = groups[0] ?? 0;
  return (
    first >= 0x2000 &&
    first <= 0x3fff &&
    !(first === 0x2001 && groups[1] === 0x0db8)
  );
};

const hasBlockedHostname = (hostname: string): boolean => {
  const normalized = hostname
    .replace(/^\[|\]$/g, "")
    .replace(/\.+$/, "")
    .toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  );
};

const isPublicLiteralAddress = (hostname: string): boolean => {
  const address = hostname.replace(/^\[|\]$/g, "");
  if (parseIpv4(address) !== undefined) return isPublicIpv4(address);
  return !address.includes(":") || isPublicIpv6(address);
};

const allowlistedOrigins = (
  allowlist: string | undefined,
): { readonly configured: boolean; readonly origins: ReadonlySet<string> } => {
  const entries = (allowlist ?? "")
    .split(",")
    .map((entry) => entry.trim())
    .filter(Boolean);
  return {
    configured: entries.length > 0,
    origins: new Set(
      entries.flatMap((entry) => {
        try {
          return [new URL(entry).origin];
        } catch {
          return [];
        }
      }),
    ),
  };
};

/**
 * Static admission for a model endpoint. Transport owners must also resolve
 * DNS and reject redirects before connecting.
 */
export const validateAllowedModelEndpoint = (
  raw: string,
  allowlist?: string,
): ModelEndpointValidation => {
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    return { error: "invalid" };
  }
  if (
    endpoint.protocol !== "https:" ||
    endpoint.username !== "" ||
    endpoint.password !== "" ||
    endpoint.search !== "" ||
    endpoint.hash !== "" ||
    hasBlockedHostname(endpoint.hostname) ||
    !isPublicLiteralAddress(endpoint.hostname)
  ) {
    return { error: "invalid" };
  }
  const allowlisted = allowlistedOrigins(allowlist);
  if (allowlisted.configured && !allowlisted.origins.has(endpoint.origin)) {
    return { error: "not-allowlisted" };
  }
  return { endpoint: endpoint.toString().replace(/\/$/, "") };
};
