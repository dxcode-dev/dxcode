import {
  BrowserSession,
  type BrowserSessionId,
  PersistenceUnavailable,
  PersonalSecurityRepository,
  type SecurityPageOffset,
} from "@dx/domain";
import { Effect, Layer, Option, Schema } from "effect";

const SessionRow = Schema.Struct({
  id: Schema.String,
  token: Schema.String,
  ip_address: Schema.NullOr(Schema.String),
  user_agent: Schema.NullOr(Schema.String),
  created_at: Schema.Number,
  updated_at: Schema.Number,
  expires_at: Schema.Number,
});

const epochMilliseconds = (column: string) =>
  `CASE
     WHEN typeof(${column}) IN ('integer', 'real') THEN ${column}
     ELSE unixepoch(${column}) * 1000
   END`;

const sessionSelect = `
  SELECT
    id,
    token,
    ipAddress AS ip_address,
    userAgent AS user_agent,
    ${epochMilliseconds("createdAt")} AS created_at,
    ${epochMilliseconds("updatedAt")} AS updated_at,
    ${epochMilliseconds("expiresAt")} AS expires_at
  FROM session
`;

const iso = (value: number): string => new Date(value).toISOString();

export const redactSessionNetwork = (value: string | null): string => {
  if (value === null) return "Unknown network";
  const ipv4 = value.split(".");
  if (
    ipv4.length === 4 &&
    ipv4.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255)
  ) {
    return `${ipv4[0]}.${ipv4[1]}.${ipv4[2]}.x`;
  }
  const address = value.toLowerCase().split("%", 1)[0] ?? "";
  if (/^[a-f0-9:]+$/.test(address) && address.includes(":")) {
    const halves = address.split("::");
    const left = (halves[0] ?? "").split(":").filter(Boolean);
    const right = (halves[1] ?? "").split(":").filter(Boolean);
    const compressed = halves.length === 2;
    const missing = 8 - left.length - right.length;
    if (
      halves.length <= 2 &&
      left.every((part) => part.length <= 4) &&
      right.every((part) => part.length <= 4) &&
      ((!compressed && missing === 0) || (compressed && missing > 0))
    ) {
      const parts = [...left, ...Array<string>(missing).fill("0"), ...right];
      return `${parts.slice(0, 4).join(":")}::/64`;
    }
  }
  return "Unknown network";
};

export const coarseSessionDevice = (value: string | null): string => {
  if (value === null) return "Unknown browser/device";
  const browser = /Edg\//.test(value)
    ? "Edge"
    : /(?:Chrome|CriOS)\//.test(value)
      ? "Chrome"
      : /(?:Firefox|FxiOS)\//.test(value)
        ? "Firefox"
        : /Safari\//.test(value)
          ? "Safari"
          : "Unknown browser";
  const device = /Android/.test(value)
    ? "Android"
    : /(?:iPhone|iPad|iPod)/.test(value)
      ? "iOS"
      : /Windows/.test(value)
        ? "Windows"
        : /Mac OS X/.test(value)
          ? "macOS"
          : /Linux/.test(value)
            ? "Linux"
            : "unknown device";
  return `${browser} on ${device}`;
};

const sessionFrom = (row: typeof SessionRow.Type, currentSessionId: string) =>
  Schema.decodeUnknownEffect(BrowserSession)({
    id: row.id,
    device: coarseSessionDevice(row.user_agent),
    network: redactSessionNetwork(row.ip_address),
    isCurrent: row.id === currentSessionId,
    createdAt: iso(row.created_at),
    lastActiveAt: iso(row.updated_at),
    expiresAt: iso(row.expires_at),
  });

export const PersonalSecurityRepositoryD1 = (db: D1Database) =>
  Layer.succeed(
    PersonalSecurityRepository,
    PersonalSecurityRepository.of({
      listSessions: Effect.fn("PersonalSecurityRepository.listSessions")(
        function* (userId, currentSessionId, limit, offset, now) {
          const result = yield* Effect.tryPromise({
            try: () =>
              db
                .prepare(
                  `${sessionSelect}
                   WHERE userId = ? AND ${epochMilliseconds("expiresAt")} > ?
                   ORDER BY ${epochMilliseconds("updatedAt")} DESC, id DESC
                   LIMIT ? OFFSET ?`,
                )
                .bind(userId, now, limit + 1, offset)
                .all(),
            catch: (cause) =>
              PersistenceUnavailable.new(
                { operation: "settings.security.listSessions" },
                cause,
              ),
          });
          const rows = yield* Schema.decodeUnknownEffect(
            Schema.Array(SessionRow),
          )(result.results);
          const sessions = yield* Effect.all(
            rows
              .slice(0, limit)
              .map((row) => sessionFrom(row, currentSessionId)),
          );
          return {
            items: sessions,
            ...(rows.length > limit
              ? { nextOffset: (offset + limit) as SecurityPageOffset }
              : {}),
          };
        },
      ),
      findOwnedSession: Effect.fn(
        "PersonalSecurityRepository.findOwnedSession",
      )(function* (userId, sessionId, currentSessionId) {
        const result = yield* Effect.tryPromise({
          try: () =>
            db
              .prepare(
                "SELECT id, token FROM session WHERE id = ? AND userId = ? LIMIT 1",
              )
              .bind(sessionId, userId)
              .first<{ id: string; token: string }>(),
          catch: (cause) =>
            PersistenceUnavailable.new(
              { operation: "settings.security.findOwnedSession" },
              cause,
            ),
        });
        return result === null
          ? Option.none()
          : Option.some({
              id: result.id as BrowserSessionId,
              token: result.token,
              isCurrent: result.id === currentSessionId,
            });
      }),
    }),
  );
