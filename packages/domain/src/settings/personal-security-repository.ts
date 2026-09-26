import { Context, type Effect, type Option, type Schema } from "effect";
import type { PersistenceUnavailable } from "../persistence/errors.js";
import type { UserId } from "../users/user-id.js";
import type {
  BrowserSession,
  BrowserSessionId,
  SecurityPageOffset,
} from "./personal-security.js";

export interface BrowserSessionPage {
  readonly items: ReadonlyArray<BrowserSession>;
  readonly nextOffset?: SecurityPageOffset;
}

export interface OwnedBrowserSession {
  readonly id: BrowserSessionId;
  readonly token: string;
  readonly isCurrent: boolean;
}

export type PersonalSecurityRepositoryError =
  | PersistenceUnavailable
  | Schema.SchemaError;

export interface PersonalSecurityRepositoryShape {
  readonly listSessions: (
    userId: UserId,
    currentSessionId: BrowserSessionId,
    limit: number,
    offset: SecurityPageOffset,
    now: number,
  ) => Effect.Effect<BrowserSessionPage, PersonalSecurityRepositoryError>;
  readonly findOwnedSession: (
    userId: UserId,
    sessionId: BrowserSessionId,
    currentSessionId: BrowserSessionId,
  ) => Effect.Effect<
    Option.Option<OwnedBrowserSession>,
    PersonalSecurityRepositoryError
  >;
}

export class PersonalSecurityRepository extends Context.Service<
  PersonalSecurityRepository,
  PersonalSecurityRepositoryShape
>()("@dx/domain/settings/PersonalSecurityRepository") {}
