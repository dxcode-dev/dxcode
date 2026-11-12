import type { Bindings } from "../http/types.js";
import { observeExternal } from "../observability/boundaries.js";

/**
 * The RealtimeKit REST calls Huddle makes, with the RealtimeKit-only token
 * the deploy mints (`DX_REALTIMEKIT`, `{ accountId, token }`). Without it
 * huddles are unavailable, as in local `pnpm dev`, which makes no billable
 * calls.
 *
 * Every deployment on an account shares one RealtimeKit app, "dx huddle",
 * found or created on first use: apps cannot be deleted, so an app per
 * preview would pile up. Meetings belong to a deployment's own Threads
 * (`thread_huddles`), so deployments never meet each other. People join
 * with the app's built-in `group_call_participant` preset.
 */

const CLOUDFLARE_API = "https://api.cloudflare.com/client/v4";
const TIMEOUT_MS = 10_000;
export const HUDDLE_APP_NAME = "dx huddle";
export const HUDDLE_PRESET = "group_call_participant";

export interface RealtimeKitAccess {
  readonly accountId: string;
  readonly token: string;
}

export class RealtimeKitFailed extends Error {
  override readonly name = "RealtimeKitFailed";
}

export const realtimeKitAccess = (
  bindings: Bindings,
): RealtimeKitAccess | undefined => {
  try {
    const value = JSON.parse(
      bindings.DX_REALTIMEKIT ?? "",
    ) as Partial<RealtimeKitAccess>;
    return typeof value.accountId === "string" &&
      /^[a-f0-9]{32}$/.test(value.accountId) &&
      typeof value.token === "string" &&
      value.token !== ""
      ? { accountId: value.accountId, token: value.token }
      : undefined;
  } catch {
    return undefined;
  }
};

const request = async <T>(
  access: RealtimeKitAccess,
  operation: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
): Promise<T | undefined> => {
  const url = `${CLOUDFLARE_API}/accounts/${access.accountId}/realtime/kit${path}`;
  const response = await observeExternal("realtimekit", operation, url, () =>
    fetch(url, {
      method,
      headers: {
        authorization: `Bearer ${access.token}`,
        ...(body === undefined ? {} : { "content-type": "application/json" }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    }),
  );
  // No active session answers 404.
  if (response.status === 404 && method === "GET") return undefined;
  if (!response.ok)
    throw new RealtimeKitFailed(
      `RealtimeKit ${operation} answered ${response.status}`,
    );
  const json = (await response.json()) as { data?: T | null };
  return json.data ?? undefined;
};

/** The shared app's id, per account, for this isolate's life. */
const apps = new Map<string, Promise<string>>();

const findOrCreateApp = async (access: RealtimeKitAccess) => {
  const listed =
    (await request<
      ReadonlyArray<{
        id?: string;
        name?: string;
        created_at?: string;
      }>
    >(access, "list-apps", "GET", "/apps?per_page=100")) ?? [];
  // Two deployments creating it at once leave two; everyone picks the oldest.
  const existing = listed
    .filter((app) => app.name === HUDDLE_APP_NAME && typeof app.id === "string")
    .sort((a, b) => (a.created_at ?? "").localeCompare(b.created_at ?? ""))[0];
  if (existing?.id !== undefined) return existing.id;
  const created = await request<{ app?: { id?: string } }>(
    access,
    "create-app",
    "POST",
    "/apps",
    { name: HUDDLE_APP_NAME },
  );
  const id = created?.app?.id;
  if (typeof id !== "string" || id === "")
    throw new RealtimeKitFailed("RealtimeKit created no app");
  return id;
};

const appOf = (access: RealtimeKitAccess) => {
  let app = apps.get(access.accountId);
  if (app === undefined) {
    app = findOrCreateApp(access);
    // A failure is not remembered; the next request tries again.
    app.catch(() => apps.delete(access.accountId));
    apps.set(access.accountId, app);
  }
  return app;
};

const call = async <T>(
  access: RealtimeKitAccess,
  operation: string,
  method: "GET" | "POST",
  path: string,
  body?: unknown,
) =>
  request<T>(access, operation, method, `/${await appOf(access)}${path}`, body);

/** A new meeting for one Thread's huddle. */
export const createMeeting = async (
  access: RealtimeKitAccess,
  title: string,
): Promise<string> => {
  const data = await call<{ id?: string }>(
    access,
    "create-meeting",
    "POST",
    "/meetings",
    { title: title.slice(0, 200) || "Huddle" },
  );
  if (typeof data?.id !== "string" || data.id === "")
    throw new RealtimeKitFailed("RealtimeKit created no meeting");
  return data.id;
};

/**
 * Adds a person to a meeting and returns the token their browser joins
 * with. RealtimeKit bills only minutes spent in a session, so adding
 * someone who never joins costs nothing.
 */
export const addParticipant = async (
  access: RealtimeKitAccess,
  meetingId: string,
  person: { readonly userId: string; readonly name: string },
): Promise<string> => {
  const data = await call<{ token?: string }>(
    access,
    "add-participant",
    "POST",
    `/meetings/${encodeURIComponent(meetingId)}/participants`,
    {
      name: person.name.slice(0, 100) || "Member",
      preset_name: HUDDLE_PRESET,
      custom_participant_id: person.userId,
    },
  );
  if (typeof data?.token !== "string" || data.token === "")
    throw new RealtimeKitFailed("RealtimeKit returned no participant token");
  return data.token;
};

export interface LiveHuddle {
  readonly startedAt: string;
  /** dx user ids of the people in the session now, in joining order. */
  readonly userIds: ReadonlyArray<string>;
}

/** Who is in a meeting's session now; undefined when nobody is. */
export const liveHuddle = async (
  access: RealtimeKitAccess,
  meetingId: string,
): Promise<LiveHuddle | undefined> => {
  const session = await call<{
    id?: string;
    status?: string;
    started_at?: string;
    live_participants?: number;
  }>(
    access,
    "active-session",
    "GET",
    `/meetings/${encodeURIComponent(meetingId)}/active-session`,
  );
  if (
    session === undefined ||
    session.status !== "LIVE" ||
    typeof session.id !== "string" ||
    (session.live_participants ?? 0) <= 0
  )
    return undefined;
  const list = await call<{
    participants?: ReadonlyArray<{
      custom_participant_id?: string | null;
      left_at?: string | null;
    }> | null;
  }>(
    access,
    "session-participants",
    "GET",
    `/sessions/${encodeURIComponent(session.id)}/participants?per_page=100&sort_by=joinedAt&sort_order=ASC`,
  );
  const userIds: string[] = [];
  for (const participant of list?.participants ?? []) {
    const id = participant.custom_participant_id;
    // A rejoin is a new row; the earlier one has left_at.
    if (
      typeof id === "string" &&
      id !== "" &&
      (participant.left_at ?? null) === null &&
      !userIds.includes(id)
    )
      userIds.push(id);
  }
  return { startedAt: session.started_at ?? "", userIds };
};
