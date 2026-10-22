import "./security.css";
import type {
  BrowserSessionData,
  PersonalApiTokenData,
  PersonalApiTokenSecretData,
} from "@dx/api";
import { type PersonalApiTokenScope, personalApiTokenScopes } from "@dx/domain";
import {
  useInfiniteQuery,
  useMutation,
  useQuery,
  useQueryClient,
} from "@tanstack/react-query";
import { DateTime } from "effect";
import {
  ClipboardCopy,
  KeyRound,
  Monitor,
  Plus,
  Smartphone,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { DxLoading } from "../../../shared/brand/dx-loading.js";
import { useTimeText } from "../../../shared/hooks/use-clock.js";
import { settle } from "../../../shared/settle.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import { TimeText } from "../../../shared/ui/time-text.js";
import { formatRelativeTime } from "../../../shared/utils.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
} from "../settings-primitives.js";
import {
  browserSessionsQueryOptions,
  createPersonalApiTokenMutationOptions,
  personalApiTokensQueryOptions,
  revokeBrowserSessionMutationOptions,
  revokeOtherBrowserSessionsMutationOptions,
  revokePersonalApiTokenMutationOptions,
  rotatePersonalApiTokenMutationOptions,
  securityErrorMessage,
} from "./security-queries.js";

const scopeLabels: Record<PersonalApiTokenScope, string> = {
  "projects:read": "Read projects",
  "projects:write": "Create and update projects",
  "threads:read": "Read threads",
  "threads:write": "Create and update threads",
  "agents:access": "Access agent streams",
  "settings:read": "Read personal settings",
  "settings:write": "Update personal settings",
};

const ago = (value: DateTime.Utc, now: number) =>
  formatRelativeTime({ epochMilliseconds: DateTime.toEpochMillis(value) }, now);

const tokenUse = (token: PersonalApiTokenData, now: number) =>
  token.lastUsedAt === undefined
    ? "Never used"
    : `Last used ${ago(token.lastUsedAt, now)}`;

const signedInFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "medium",
});

const isPhone = (device: string) => / on (?:iOS|Android)$/.test(device);

function CardState({
  loading,
  label,
  error,
  retry,
}: {
  readonly loading: boolean;
  readonly label: string;
  readonly error: unknown;
  readonly retry: () => void;
}) {
  if (loading) {
    return (
      <div className="security-state">
        <DxLoading label={label} />
      </div>
    );
  }
  return (
    <div className="security-state security-error" role="alert">
      <span>
        {error instanceof Error ? error.message : "Something went wrong."}
      </span>
      <Button size="xs" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

function SecretDialog({
  secret,
  close,
}: {
  readonly secret?: PersonalApiTokenSecretData;
  readonly close: () => void;
}) {
  const [copyStatus, setCopyStatus] = React.useState("");
  const closeDialog = () => {
    setCopyStatus("");
    close();
  };
  const copy = async () => {
    if (secret === undefined) return;
    const outcome = await settle(() =>
      navigator.clipboard.writeText(secret.plaintext),
    );
    setCopyStatus(
      outcome.ok ? "Token copied." : "Select and copy the token manually.",
    );
  };
  return (
    <DialogRoot
      open={secret !== undefined}
      onOpenChange={(open) => !open && closeDialog()}
    >
      {secret === undefined ? null : (
        <DialogContent className="security-dialog">
          <DialogTitle>Copy {secret.token.name} now</DialogTitle>
          <DialogDescription>
            dx shows this token once and stores only its hash.
          </DialogDescription>
          <div className="security-secret">
            <Input
              aria-label="Personal API token"
              value={secret.plaintext}
              readOnly
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button size="sm" onClick={() => void copy()}>
              <ClipboardCopy aria-hidden="true" /> Copy
            </Button>
          </div>
          <div className="security-dialog-actions">
            <span className="security-live-status" aria-live="polite">
              {copyStatus}
            </span>
            <Button size="sm" variant="outline" onClick={closeDialog}>
              Done
            </Button>
          </div>
        </DialogContent>
      )}
    </DialogRoot>
  );
}

function CreateTokenDialog({
  open,
  setOpen,
  created,
}: {
  readonly open: boolean;
  readonly setOpen: (open: boolean) => void;
  readonly created: (secret: PersonalApiTokenSecretData) => void;
}) {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const createToken = useMutation(
    createPersonalApiTokenMutationOptions(queryClient, identity.id, created),
  );
  const [name, setName] = React.useState("");
  const [scopes, setScopes] = React.useState<
    ReadonlyArray<PersonalApiTokenScope>
  >([]);
  const selectedScopes = new Set(scopes);
  const [error, setError] = React.useState<string>();
  const close = () => {
    setName("");
    setScopes([]);
    setError(undefined);
    setOpen(false);
  };
  const toggle = (scope: PersonalApiTokenScope) =>
    setScopes((current) =>
      current.includes(scope)
        ? current.filter((candidate) => candidate !== scope)
        : [...current, scope],
    );
  const create = async () => {
    if (createToken.isPending) return;
    setError(undefined);
    const outcome = await settle(async () => {
      await createToken.mutateAsync({ name, scopes });
      close();
    });
    if (!outcome.ok) {
      setError(
        securityErrorMessage(outcome.error, "The token could not be created."),
      );
    }
    createToken.reset();
  };
  return (
    <DialogRoot
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
    >
      {open ? (
        <DialogContent className="security-dialog">
          <DialogTitle>New access token</DialogTitle>
          <form
            className="security-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label htmlFor="security-token-name">
              Name
              <Input
                id="security-token-name"
                autoFocus
                required
                maxLength={64}
                placeholder="Local CLI"
                value={name}
                onChange={(event) => setName(event.target.value)}
              />
            </label>
            <fieldset className="security-scopes">
              <legend>Scopes</legend>
              <div>
                {personalApiTokenScopes.map((scope) => (
                  <label key={scope}>
                    <input
                      type="checkbox"
                      checked={selectedScopes.has(scope)}
                      onChange={() => toggle(scope)}
                    />
                    <span>{scopeLabels[scope]}</span>
                    <code>{scope}</code>
                  </label>
                ))}
              </div>
            </fieldset>
            {error === undefined ? null : (
              <p className="security-error" role="alert">
                {error}
              </p>
            )}
            <footer className="security-dialog-actions">
              <Button size="sm" variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
                size="sm"
                type="submit"
                disabled={createToken.isPending || scopes.length === 0}
              >
                {createToken.isPending ? "Creating…" : "Create token"}
              </Button>
            </footer>
          </form>
        </DialogContent>
      ) : null}
    </DialogRoot>
  );
}

function TokenRow({
  token,
  act,
}: {
  readonly token: PersonalApiTokenData;
  readonly act: (kind: "rotate" | "revoke") => void;
}) {
  return (
    <div className="security-row security-token-row">
      <KeyRound className="security-row-icon" aria-hidden="true" />
      <div className="security-row-copy">
        <div>
          <strong>{token.name}</strong>
          <code>{token.identifier}…</code>
        </div>
        <span>
          {token.scopes.map((scope) => scopeLabels[scope]).join(", ")} ·{" "}
          <TimeText text={(now) => tokenUse(token, now)} />
        </span>
      </div>
      <div className="security-row-actions">
        <Button
          size="xs"
          variant="outline"
          aria-label={`Rotate ${token.name} (${token.identifier}…)`}
          onClick={() => act("rotate")}
        >
          Rotate
        </Button>
        <Button
          size="xs"
          variant="outline"
          aria-label={`Revoke ${token.name} (${token.identifier}…)`}
          onClick={() => act("revoke")}
        >
          Revoke
        </Button>
      </div>
    </div>
  );
}

function TokenList() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const tokens = useQuery(personalApiTokensQueryOptions(identity.id));
  const [createOpen, setCreateOpen] = React.useState(false);
  const [secret, setSecret] = React.useState<PersonalApiTokenSecretData>();
  const rotateToken = useMutation(
    rotatePersonalApiTokenMutationOptions(queryClient, identity.id, setSecret),
  );
  const revokeToken = useMutation(
    revokePersonalApiTokenMutationOptions(queryClient, identity.id),
  );
  const [action, setAction] = React.useState<{
    readonly kind: "rotate" | "revoke";
    readonly token: PersonalApiTokenData;
  }>();
  const [error, setError] = React.useState<string>();
  const busy = rotateToken.isPending || revokeToken.isPending;
  const closeAction = () => {
    setError(undefined);
    setAction(undefined);
  };
  const mutate = async () => {
    if (action === undefined || busy) return;
    setError(undefined);
    const outcome = await settle(async () => {
      if (action.kind === "rotate") {
        await rotateToken.mutateAsync(action.token.id);
      } else {
        await revokeToken.mutateAsync(action.token.id);
      }
      setAction(undefined);
    });
    if (!outcome.ok) {
      setError(
        securityErrorMessage(outcome.error, "The token could not be updated."),
      );
    }
    if (action.kind === "rotate") rotateToken.reset();
  };
  return (
    <SettingsCard
      className="security-card"
      title="Access tokens"
      description="Scoped tokens for scripts and tools that call the dx API."
      actions={
        <Button size="xs" variant="outline" onClick={() => setCreateOpen(true)}>
          <Plus aria-hidden="true" /> New token
        </Button>
      }
    >
      {tokens.data !== undefined && tokens.isRefetchError ? (
        <SettingsBackgroundError onRetry={() => void tokens.refetch()}>
          Tokens could not be refreshed. Showing the last loaded list.
        </SettingsBackgroundError>
      ) : null}
      {tokens.data === undefined ? (
        <CardState
          loading={tokens.isPending}
          label="Loading tokens…"
          error={tokens.error}
          retry={() => void tokens.refetch()}
        />
      ) : tokens.data.length === 0 ? (
        <p className="security-empty">No access tokens.</p>
      ) : (
        tokens.data.map((token) => (
          <TokenRow
            key={token.id}
            token={token}
            act={(kind) => setAction({ kind, token })}
          />
        ))
      )}
      <CreateTokenDialog
        open={createOpen}
        setOpen={setCreateOpen}
        created={setSecret}
      />
      <SecretDialog secret={secret} close={() => setSecret(undefined)} />
      <DialogRoot
        open={action !== undefined}
        onOpenChange={(open) => !open && closeAction()}
      >
        {action === undefined ? null : (
          <DialogContent className="security-dialog">
            <DialogTitle>
              {action.kind === "rotate" ? "Rotate" : "Revoke"}{" "}
              {action.token.name}?
            </DialogTitle>
            <DialogDescription>
              {action.kind === "rotate"
                ? "The current token stops working now. dx shows its replacement once."
                : "This token stops working now and cannot be restored."}
            </DialogDescription>
            {error === undefined ? null : (
              <p className="security-error" role="alert">
                {error}
              </p>
            )}
            <div className="security-dialog-actions">
              <Button size="sm" variant="ghost" onClick={closeAction}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant={action.kind === "revoke" ? "destructive" : "default"}
                disabled={busy}
                onClick={() => void mutate()}
              >
                {busy
                  ? "Working…"
                  : action.kind === "rotate"
                    ? "Rotate token"
                    : "Revoke token"}
              </Button>
            </div>
          </DialogContent>
        )}
      </DialogRoot>
    </SettingsCard>
  );
}

function SessionRow({
  session,
  signOut,
}: {
  readonly session: BrowserSessionData;
  readonly signOut: () => void;
}) {
  const DeviceIcon = isPhone(session.device) ? Smartphone : Monitor;
  const active = useTimeText((now) => ago(session.lastActiveAt, now));
  // Rows can share a browser name, so the button names the session fully.
  const signOutLabel = `Sign out ${session.device}, ${session.network}, active ${active}, signed in ${signedInFormatter.format(DateTime.toEpochMillis(session.createdAt))}`;
  return (
    <div className="security-row" data-session-id={session.id}>
      <DeviceIcon className="security-row-icon" aria-hidden="true" />
      <div className="security-row-copy">
        <div>
          <strong>{session.device}</strong>
          {session.isCurrent ? (
            <span className="security-tag">This device</span>
          ) : null}
        </div>
        <span>
          {session.network} · Active {active}
        </span>
      </div>
      {session.isCurrent ? null : (
        <div className="security-row-actions">
          <Button
            size="xs"
            variant="outline"
            aria-label={signOutLabel}
            onClick={signOut}
          >
            Sign out
          </Button>
        </div>
      )}
    </div>
  );
}

function SessionList() {
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const sessions = useInfiniteQuery(browserSessionsQueryOptions(identity.id));
  const revokeSession = useMutation(
    revokeBrowserSessionMutationOptions(queryClient, identity.id),
  );
  const revokeOthers = useMutation(
    revokeOtherBrowserSessionsMutationOptions(queryClient, identity.id),
  );
  const items = sessions.data?.pages.flatMap((page) => page.items) ?? [];
  const hasOthers =
    items.some((session) => !session.isCurrent) || sessions.hasNextPage;
  const [target, setTarget] = React.useState<BrowserSessionData | "others">();
  const [error, setError] = React.useState<string>();
  const busy = revokeSession.isPending || revokeOthers.isPending;
  const closeTarget = () => {
    setError(undefined);
    setTarget(undefined);
  };
  const mutate = async () => {
    if (target === undefined || busy) return;
    setError(undefined);
    const outcome = await settle(async () => {
      if (target === "others") await revokeOthers.mutateAsync();
      else await revokeSession.mutateAsync(target.id);
      setTarget(undefined);
    });
    if (!outcome.ok) {
      setError(
        securityErrorMessage(outcome.error, "The session could not be ended."),
      );
    }
  };
  return (
    <SettingsCard
      className="security-card"
      title="Active sessions"
      description="Browsers signed in to your dx account."
      actions={
        hasOthers ? (
          <Button
            size="xs"
            variant="outline"
            onClick={() => setTarget("others")}
          >
            Sign out other sessions
          </Button>
        ) : undefined
      }
    >
      {sessions.data !== undefined && sessions.isRefetchError ? (
        <SettingsBackgroundError onRetry={() => void sessions.refetch()}>
          Sessions could not be refreshed. Showing the last loaded list.
        </SettingsBackgroundError>
      ) : null}
      {sessions.data === undefined ? (
        <CardState
          loading={sessions.isPending}
          label="Loading sessions…"
          error={sessions.error}
          retry={() => void sessions.refetch()}
        />
      ) : items.length === 0 ? (
        <p className="security-empty">No active sessions.</p>
      ) : (
        <>
          {items.map((session) => (
            <SessionRow
              key={session.id}
              session={session}
              signOut={() => setTarget(session)}
            />
          ))}
          {sessions.isFetchNextPageError ? (
            <p className="security-error" role="alert">
              {securityErrorMessage(
                sessions.error,
                "More sessions could not be loaded.",
              )}
            </p>
          ) : null}
          {sessions.hasNextPage ? (
            <div className="security-load-more">
              <Button
                size="xs"
                variant="ghost"
                disabled={sessions.isFetchingNextPage}
                onClick={() => void sessions.fetchNextPage()}
              >
                {sessions.isFetchingNextPage
                  ? "Loading…"
                  : sessions.isFetchNextPageError
                    ? "Retry"
                    : "Show more"}
              </Button>
            </div>
          ) : null}
        </>
      )}
      <DialogRoot
        open={target !== undefined}
        onOpenChange={(open) => !open && closeTarget()}
      >
        {target === undefined ? null : (
          <DialogContent className="security-dialog">
            <DialogTitle>
              {target === "others"
                ? "Sign out other sessions?"
                : `Sign out ${target.device}?`}
            </DialogTitle>
            <DialogDescription>
              {target === "others"
                ? "Ends every other browser session. This device stays signed in."
                : "Ends that browser session. This device stays signed in."}
            </DialogDescription>
            {error === undefined ? null : (
              <p className="security-error" role="alert">
                {error}
              </p>
            )}
            <div className="security-dialog-actions">
              <Button size="sm" variant="ghost" onClick={closeTarget}>
                Cancel
              </Button>
              <Button
                size="sm"
                variant="destructive"
                disabled={busy}
                onClick={() => void mutate()}
              >
                {busy ? "Signing out…" : "Sign out"}
              </Button>
            </div>
          </DialogContent>
        )}
      </DialogRoot>
    </SettingsCard>
  );
}

export function PersonalSecuritySettings() {
  return (
    <div className="security-settings">
      <SettingsHeading
        title="Security"
        description="Manage access tokens and browser sessions."
      />
      <TokenList />
      <SessionList />
    </div>
  );
}
