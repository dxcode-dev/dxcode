export const parseIpv4 = (input: string): ReadonlyArray<number> | undefined => {
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
  const [a = 0, b = 0, c = 0, d = 0] = values;
  return !(
    a === 0 ||
    a === 10 ||
    a === 127 ||
    (a === 100 && b >= 64 && b <= 127) ||
    (a === 169 && b === 254) ||
    (a === 172 && b >= 16 && b <= 31) ||
    (a === 192 && b === 0 && c === 0 && d !== 9 && d !== 10) ||
    (a === 192 && b === 0 && c === 2) ||
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
    const raw = side.split(":");
    const output: Array<number> = [];
    for (const part of raw) {
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
    const mapped = `${groups[6] >> 8}.${groups[6] & 255}.${groups[7] >> 8}.${groups[7] & 255}`;
    return isPublicIpv4(mapped);
  }
  const first = groups[0] ?? 0;
  const globalUnicast = first >= 0x2000 && first <= 0x3fff;
  const documentation = first === 0x2001 && groups[1] === 0x0db8;
  return globalUnicast && !documentation;
};

export const isPublicIpAddress = (input: string): boolean =>
  input.includes(":") ? isPublicIpv6(input) : isPublicIpv4(input);

export const blockedHostname = (hostname: string): boolean => {
  const normalized = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  return (
    normalized === "localhost" ||
    normalized.endsWith(".localhost") ||
    normalized.endsWith(".local") ||
    normalized.endsWith(".internal") ||
    normalized.endsWith(".home.arpa")
  );
};

export type PublicDnsResolver = (
  hostname: string,
) => Promise<ReadonlyArray<string>>;

const dnsQuery = async (hostname: string, type: "A" | "AAAA") => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 2_000);
  try {
    const response = await fetch(
      `https://1.1.1.1/dns-query?name=${encodeURIComponent(hostname)}&type=${type}`,
      {
        headers: { accept: "application/dns-json" },
        redirect: "manual",
        signal: controller.signal,
      },
    );
    if (!response.ok) throw new Error("DNS lookup failed");
    const body = (await response.json()) as {
      readonly Status?: unknown;
      readonly Answer?: ReadonlyArray<{
        readonly type?: unknown;
        readonly data?: unknown;
      }>;
    };
    if (body.Status !== 0) throw new Error("DNS lookup failed");
    const expected = type === "A" ? 1 : 28;
    return (body.Answer ?? []).flatMap((answer) =>
      answer.type === expected && typeof answer.data === "string"
        ? [answer.data]
        : [],
    );
  } finally {
    clearTimeout(timer);
  }
};

export const resolvePublicDns: PublicDnsResolver = async (hostname) =>
  (
    await Promise.all([dnsQuery(hostname, "A"), dnsQuery(hostname, "AAAA")])
  ).flat();

export const contentLengthExceeds = (
  response: Response,
  limit: number,
): boolean => {
  const length = Number(response.headers.get("content-length"));
  return Number.isFinite(length) && length > limit;
};

export const readBounded = async (
  response: Response,
  limit: number,
  tooLarge: () => unknown,
): Promise<Uint8Array> => {
  if (contentLengthExceeds(response, limit)) {
    await response.body?.cancel().catch(() => undefined);
    throw tooLarge();
  }
  if (response.body === null) return new Uint8Array();
  const reader = response.body.getReader();
  const chunks: Array<Uint8Array> = [];
  let size = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) {
        await reader.cancel().catch(() => undefined);
        throw tooLarge();
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return body;
};
