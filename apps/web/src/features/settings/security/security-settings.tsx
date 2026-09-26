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
  Check,
  ClipboardCopy,
  KeyRound,
  Laptop,
  RefreshCw,
  ShieldAlert,
  Trash2,
} from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../../shared/auth/auth-context.js";
import { Badge } from "../../../shared/ui/badge.js";
import { Button } from "../../../shared/ui/button.js";
import {
  DialogContent,
  DialogDescription,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { Input } from "../../../shared/ui/input.js";
import {
  SettingsBackgroundError,
  SettingsCard,
  SettingsHeading,
  SettingsRow,
} from "../settings-primitives.js";
import {
  browserSessionsQueryOptions,
  createPersonalApiTokenMutationOptions,
  personalApiTokensQueryOptions,
  personalSecurityQueryOptions,
  revokeBrowserSessionMutationOptions,
  revokeOtherBrowserSessionsMutationOptions,
  revokePersonalApiTokenMutationOptions,
  rotatePersonalApiTokenMutationOptions,
  securityErrorMessage,
} from "./security-queries.js";

const dateTimeFormatter = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});
const formatDateTime = (value: DateTime.Utc): string =>
  dateTimeFormatter.format(new Date(DateTime.formatIso(value)));
const scopeLabels: Record<PersonalApiTokenScope, string> = {
  "projects:read": "Read projects",
  "projects:write": "Create and update projects",
  "threads:read": "Read threads",
  "threads:write": "Create and update threads",
  "agents:access": "Access agent streams",
  "settings:read": "Read personal settings",
  "settings:write": "Update personal settings",
};

function SecurityState({
  loading,
  error,
  empty,
  retry,
}: {
  readonly loading?: boolean;
  readonly error?: string;
  readonly empty?: string;
  readonly retry?: () => void;
}) {
  if (loading) {
    return (
      <div className="security-state" aria-busy="true">
        <span className="tool-spinner" /> Loading…
      </div>
    );
  }
  if (error !== undefined) {
    return (
      <div className="security-state" role="alert">
        <ShieldAlert aria-hidden="true" />
        <span>{error}</span>
        {retry === undefined ? null : (
          <Button size="xs" variant="outline" onClick={retry}>
            Try again
          </Button>
        )}
      </div>
    );
  }
  return empty === undefined ? null : (
    <div className="security-state">{empty}</div>
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
    try {
      await navigator.clipboard.writeText(secret.plaintext);
      setCopyStatus("Token copied.");
    } catch {
      setCopyStatus("Select and copy the token manually.");
    }
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
            This plaintext is shown once. dx stores only its hash and cannot
            display it again.
          </DialogDescription>
          <div className="security-secret">
            <Input
              aria-label="Personal API token"
              value={secret.plaintext}
              readOnly
              autoFocus
              onFocus={(event) => event.currentTarget.select()}
            />
            <Button onClick={() => void copy()}>
              <ClipboardCopy aria-hidden="true" /> Copy token
            </Button>
          </div>
          <p className="security-live-status" aria-live="polite">
            {copyStatus}
          </p>
          <div className="security-dialog-actions">
            <Button onClick={closeDialog}>I’ve saved it</Button>
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
  const selectedScopes = React.useMemo(() => new Set(scopes), [scopes]);
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
    try {
      await createToken.mutateAsync({ name, scopes });
      close();
    } catch (cause) {
      setError(securityErrorMessage(cause, "The token could not be created."));
    } finally {
      createToken.reset();
    }
  };
  return (
    <DialogRoot
      open={open}
      onOpenChange={(nextOpen) => (nextOpen ? setOpen(true) : close())}
    >
      {open ? (
        <DialogContent className="security-dialog security-token-dialog">
          <DialogTitle>Create a personal API token</DialogTitle>
          <DialogDescription>
            Choose only the dx capabilities this account-owned token needs.
          </DialogDescription>
          <form
            className="security-dialog-form"
            onSubmit={(event) => {
              event.preventDefault();
              void create();
            }}
          >
            <label htmlFor="security-token-name">
              Token name
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
              <legend>dx scopes</legend>
              {personalApiTokenScopes.map((scope) => (
                <label key={scope}>
                  <input
                    type="checkbox"
                    checked={selectedScopes.has(scope)}
                    onChange={() => toggle(scope)}
                  />
                  <span>
                    <strong>{scopeLabels[scope]}</strong>
                    <code>{scope}</code>
                  </span>
                </label>
              ))}
            </fieldset>
            {error === undefined ? null : <p role="alert">{error}</p>}
            <footer>
              <Button variant="ghost" onClick={close}>
                Cancel
              </Button>
              <Button
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
  const mutate = async () => {
    if (action === undefined || busy) return;
    setError(undefined);
    try {
      if (action.kind === "rotate") {
        await rotateToken.mutateAsync(action.token.id);
      } else {
        await revokeToken.mutateAsync(action.token.id);
      }
      setAction(undefined);
    } catch (cause) {
      setError(securityErrorMessage(cause, "The token could not be updated."));
    } finally {
      if (action.kind === "rotate") rotateToken.reset();
    }
  };
  return (
    <SettingsCard title="Personal API tokens">
      <div className="security-card-toolbar">
        <div>
          <strong>Named, scoped access</strong>
          <p>Plaintext is shown once. Rotation revokes the previous token.</p>
        </div>
        <Button size="sm" onClick={() => setCreateOpen(true)}>
          <KeyRound aria-hidden="true" /> Create token
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="security-error" role="alert">
          {error}
        </p>
      )}
      {tokens.isPending || tokens.error !== null ? (
        <SecurityState
          loading={tokens.isPending}
          error={
            tokens.error instanceof Error ? tokens.error.message : undefined
          }
          retry={() => void tokens.refetch()}
        />
      ) : tokens.data?.length === 0 ? (
        <SecurityState empty="No personal API tokens have been created." />
      ) : (
        <div className="security-token-list">
          {tokens.data?.map((token) => (
            <article key={token.id}>
              <span className="security-item-icon" aria-hidden="true">
                <KeyRound />
              </span>
              <div className="security-item-copy">
                <strong>{token.name}</strong>
                <code>{token.identifier}…</code>
                <small>
                  Created {formatDateTime(token.createdAt)} ·{" "}
                  {token.lastUsedAt === undefined
                    ? "Never used"
                    : `Last used ${formatDateTime(token.lastUsedAt)}`}
                </small>
                <div className="security-scope-badges">
                  {token.scopes.map((scope) => (
                    <Badge key={scope}>{scope}</Badge>
                  ))}
                </div>
              </div>
              <div className="security-item-actions">
                <Button
                  size="xs"
                  variant="outline"
                  onClick={() => setAction({ kind: "rotate", token })}
                >
                  <RefreshCw aria-hidden="true" /> Rotate
                </Button>
                <Button
                  size="xs"
                  variant="ghost"
                  onClick={() => setAction({ kind: "revoke", token })}
                >
                  <Trash2 aria-hidden="true" /> Revoke
                </Button>
              </div>
            </article>
          ))}
        </div>
      )}
      <CreateTokenDialog
        open={createOpen}
        setOpen={setCreateOpen}
        created={setSecret}
      />
      <SecretDialog secret={secret} close={() => setSecret(undefined)} />
      <DialogRoot
        open={action !== undefined}
        onOpenChange={(open) => !open && setAction(undefined)}
      >
        {action === undefined ? null : (
          <DialogContent className="security-dialog">
            <DialogTitle>
              {action.kind === "rotate" ? "Rotate" : "Revoke"}{" "}
              {action.token.name}?
            </DialogTitle>
            <DialogDescription>
              {action.kind === "rotate"
                ? "The current token stops working immediately. Its replacement plaintext is shown once."
                : "This token stops working immediately and cannot be restored."}
            </DialogDescription>
            <div className="security-dialog-actions">
              <Button variant="ghost" onClick={() => setAction(undefined)}>
                Cancel
              </Button>
              <Button
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
  const [target, setTarget] = React.useState<BrowserSessionData | "others">();
  const [error, setError] = React.useState<string>();
  const busy = revokeSession.isPending || revokeOthers.isPending;
  const mutate = async () => {
    if (target === undefined || busy) return;
    setError(undefined);
    try {
      if (target === "others") await revokeOthers.mutateAsync();
      else await revokeSession.mutateAsync(target.id);
      setTarget(undefined);
    } catch (cause) {
      setError(
        securityErrorMessage(
          cause,
          "The browser session could not be revoked.",
        ),
      );
    }
  };
  return (
    <SettingsCard title="Browser sessions">
      <div className="security-card-toolbar">
        <div>
          <strong>Signed-in browsers</strong>
          <p>Network and device details are intentionally coarse.</p>
        </div>
        <Button
          size="sm"
          variant="outline"
          disabled={
            sessions.isPending ||
            sessions.data === undefined ||
            items.every((session) => session.isCurrent)
          }
          onClick={() => setTarget("others")}
        >
          Sign out other sessions
        </Button>
      </div>
      {error === undefined ? null : (
        <p className="security-error" role="alert">
          {error}
        </p>
      )}
      {sessions.isPending ||
      (sessions.error !== null && !sessions.isFetchNextPageError) ? (
        <SecurityState
          loading={sessions.isPending}
          error={
            sessions.error instanceof Error ? sessions.error.message : undefined
          }
          retry={() => void sessions.refetch()}
        />
      ) : items.length === 0 ? (
        <SecurityState empty="No active browser sessions were found." />
      ) : (
        <div className="security-session-list">
          {items.map((session) => (
            <article key={session.id}>
              <span className="security-item-icon" aria-hidden="true">
                <Laptop />
              </span>
              <div className="security-item-copy">
                <div>
                  <strong>{session.device}</strong>
                  {session.isCurrent ? <Badge>Current session</Badge> : null}
                </div>
                <span>{session.network}</span>
                <small>
                  Last active {formatDateTime(session.lastActiveAt)} · expires{" "}
                  {formatDateTime(session.expiresAt)}
                </small>
              </div>
              <div className="security-item-actions">
                {session.isCurrent ? (
                  <span className="security-current-protected">
                    <Check aria-hidden="true" /> Protected
                  </span>
                ) : (
                  <Button size="xs" onClick={() => setTarget(session)}>
                    Sign out
                  </Button>
                )}
              </div>
            </article>
          ))}
          {sessions.isFetchNextPageError ? (
            <p className="security-error" role="alert">
              {securityErrorMessage(
                sessions.error,
                "More browser sessions could not be loaded.",
              )}
            </p>
          ) : null}
          {!sessions.hasNextPage ? null : (
            <div className="security-load-more">
              <Button
                size="sm"
                variant="outline"
                disabled={sessions.isFetchingNextPage}
                onClick={() => void sessions.fetchNextPage()}
              >
                {sessions.isFetchingNextPage
                  ? "Loading…"
                  : sessions.isFetchNextPageError
                    ? "Retry"
                    : "Load more"}
              </Button>
            </div>
          )}
        </div>
      )}
      <DialogRoot
        open={target !== undefined}
        onOpenChange={(open) => !open && setTarget(undefined)}
      >
        {target === undefined ? null : (
          <DialogContent className="security-dialog">
            <DialogTitle>
              {target === "others"
                ? "Sign out every other browser?"
                : `Sign out ${target.device}?`}
            </DialogTitle>
            <DialogDescription>
              {target === "others"
                ? "Every other session is revoked immediately. This current session is always protected."
                : "That session is revoked immediately. This current session is not affected."}
            </DialogDescription>
            <div className="security-dialog-actions">
              <Button variant="ghost" onClick={() => setTarget(undefined)}>
                Cancel
              </Button>
              <Button
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
  const { identity } = useAuthenticatedIdentity();
  const security = useQuery(personalSecurityQueryOptions(identity.id));
  const data = security.data;
  return (
    <div className="personal-security-settings">
      <SettingsHeading
        title="Security"
        description="Control personal API access and the browser sessions signed in to your account."
      />
      {data === undefined ? (
        <SettingsCard>
          <SecurityState
            loading={security.isPending}
            error={
              security.error instanceof Error
                ? security.error.message
                : undefined
            }
            retry={() => void security.refetch()}
          />
        </SettingsCard>
      ) : (
        <>
          {security.error === null ? null : (
            <SettingsBackgroundError onRetry={() => void security.refetch()}>
              Security settings could not be refreshed. Showing the last loaded
              settings.
            </SettingsBackgroundError>
          )}
          <TokenList />
          <SessionList />
          <SettingsCard title="Passkeys">
            <SettingsRow
              title="WebAuthn passkeys"
              description={data.passkeys.reason}
              badge={<Badge>Unavailable</Badge>}
            />
          </SettingsCard>
        </>
      )}
    </div>
  );
}
