import { Effect, Schema } from "effect";
import { InvalidPageCursor } from "../persistence/errors.js";
import {
  ProjectId,
  type ProjectId as ProjectIdType,
} from "../projects/project-id.js";
import {
  ThreadId,
  type ThreadId as ThreadIdType,
} from "../threads/thread-id.js";

export const MAX_PAGE_CURSOR_LENGTH = 512;

export const PageCursor = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isMaxLength(MAX_PAGE_CURSOR_LENGTH),
  Schema.isBase64Url(),
).pipe(Schema.brand("@dx/PageCursor"));

export type PageCursor = typeof PageCursor.Type;

export interface CursorPosition<Id> {
  readonly createdAt: typeof Schema.DateTimeUtc.Type;
  readonly id: Id;
}

export interface LegacyThreadCursorPosition {
  readonly ordering: "activity";
  readonly snapshotSequence: number;
  readonly lastActivityAt: typeof Schema.DateTimeUtc.Type;
  readonly id: ThreadIdType;
  readonly lifecycleState?: undefined;
}

export interface PinSnapshotThreadCursorPosition {
  readonly ordering: "pin-snapshot";
  readonly snapshotSequence: number;
  readonly snapshotPinSequence: number;
  readonly pinnedAt: typeof Schema.DateTimeUtc.Type | undefined;
  readonly lastActivityAt: typeof Schema.DateTimeUtc.Type;
  readonly id: ThreadIdType;
  readonly lifecycleState?: "active" | "archived";
}

export type ThreadCursorPosition =
  | LegacyThreadCursorPosition
  | PinSnapshotThreadCursorPosition;

const makeCursorCodec = (idSchema: typeof ProjectId | typeof ThreadId) =>
  Schema.StringFromBase64Url.pipe(
    Schema.decodeTo(
      Schema.fromJsonString(
        Schema.Struct({
          v: Schema.Literal(1),
          createdAt: Schema.DateTimeUtcFromString,
          id: idSchema,
        }),
      ),
    ),
  );

const ProjectCursorCodec = makeCursorCodec(ProjectId);
const ThreadCursorV2 = Schema.Struct({
  v: Schema.Literal(2),
  snapshotSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  lastActivityAt: Schema.DateTimeUtcFromString,
  id: ThreadId,
});
const ThreadCursorV4 = Schema.Struct({
  v: Schema.Literal(4),
  snapshotSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snapshotPinSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pinnedAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastActivityAt: Schema.DateTimeUtcFromString,
  id: ThreadId,
});
const ThreadCursorV5 = Schema.Struct({
  v: Schema.Literal(5),
  snapshotSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  snapshotPinSequence: Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)),
  pinnedAt: Schema.optional(Schema.DateTimeUtcFromString),
  lastActivityAt: Schema.DateTimeUtcFromString,
  id: ThreadId,
  lifecycleState: Schema.optional(Schema.Literals(["active", "archived"])),
});
const ThreadCursorDecoder = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(
    Schema.fromJsonString(
      Schema.Union([ThreadCursorV2, ThreadCursorV4, ThreadCursorV5]),
    ),
  ),
);
const ThreadCursorEncoder = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(ThreadCursorV5)),
);
const LegacyThreadCursorEncoder = Schema.StringFromBase64Url.pipe(
  Schema.decodeTo(Schema.fromJsonString(ThreadCursorV2)),
);

export const encodeProjectPageCursor = (
  position: CursorPosition<ProjectIdType>,
): Effect.Effect<PageCursor, Schema.SchemaError> =>
  Schema.encodeEffect(ProjectCursorCodec)({
    v: 1,
    ...position,
  }).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)));

export const decodeProjectPageCursor = (
  cursor: unknown,
): Effect.Effect<CursorPosition<ProjectIdType>, InvalidPageCursor> =>
  Schema.decodeUnknownEffect(PageCursor)(cursor).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ProjectCursorCodec)),
    Effect.map(({ createdAt, id }) => ({
      createdAt,
      id: id as ProjectIdType,
    })),
    Effect.mapError(() => new InvalidPageCursor()),
  );

export const encodeThreadPageCursor = (
  position: ThreadCursorPosition,
): Effect.Effect<PageCursor, Schema.SchemaError> =>
  (position.ordering === "activity"
    ? Schema.encodeEffect(LegacyThreadCursorEncoder)({
        v: 2,
        snapshotSequence: position.snapshotSequence,
        lastActivityAt: position.lastActivityAt,
        id: position.id,
      })
    : Schema.encodeEffect(ThreadCursorEncoder)({
        v: 5,
        snapshotSequence: position.snapshotSequence,
        snapshotPinSequence: position.snapshotPinSequence,
        pinnedAt: position.pinnedAt,
        lastActivityAt: position.lastActivityAt,
        id: position.id,
        lifecycleState: position.lifecycleState,
      })
  ).pipe(Effect.flatMap(Schema.decodeUnknownEffect(PageCursor)));

export const decodeThreadPageCursor = (
  cursor: unknown,
): Effect.Effect<ThreadCursorPosition, InvalidPageCursor> =>
  Schema.decodeUnknownEffect(PageCursor)(cursor).pipe(
    Effect.flatMap(Schema.decodeUnknownEffect(ThreadCursorDecoder)),
    Effect.map(
      (decoded): ThreadCursorPosition =>
        decoded.v === 4 || decoded.v === 5
          ? {
              ordering: "pin-snapshot",
              snapshotSequence: decoded.snapshotSequence,
              snapshotPinSequence: decoded.snapshotPinSequence,
              pinnedAt: decoded.pinnedAt,
              lastActivityAt: decoded.lastActivityAt,
              id: decoded.id as ThreadIdType,
              lifecycleState:
                decoded.v === 5 ? decoded.lifecycleState : undefined,
            }
          : {
              ordering: "activity",
              snapshotSequence: decoded.snapshotSequence,
              lastActivityAt: decoded.lastActivityAt,
              id: decoded.id as ThreadIdType,
            },
    ),
    Effect.mapError(() => new InvalidPageCursor()),
  );
