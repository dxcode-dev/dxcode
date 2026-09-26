import type { SettingsWorkspaceData } from "@dx/api";
import type { SettingsScope, WorkspaceSlug } from "@dx/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  Link,
  type NotFoundRouteProps,
  useLocation,
  useNavigate,
} from "@tanstack/react-router";
import { AlertTriangle, Check, ChevronDown, UserRound, X } from "lucide-react";
import * as React from "react";
import { useAuthenticatedIdentity } from "../../shared/auth/auth-context.js";
import { DxLoading } from "../../shared/brand/dx-loading.js";
import { AppFrame } from "../../shared/layout/app-frame.js";
import {
  isValidSettingsReturnTo,
  settingsNavigationState,
  settingsReturnToFromState,
} from "../../shared/navigation/settings-return.js";
import { Button } from "../../shared/ui/button.js";
import { settingsManifest } from "./foundation-sections.js";
import {
  settingsContextQueryOptions,
  settingsKeys,
} from "./settings-context-queries.js";
import { settingsNavigationRegistrations } from "./settings-navigation.js";
import { SettingsBackgroundError } from "./settings-primitives.js";
import {
  type SettingsSectionRegistration,
  settingsPath,
} from "./settings-registration.js";
import { UnsavedChangesGuard } from "./unsaved-changes-guard.js";

function ScopeBar({
  scope,
  workspace,
  settingsReturnTo,
  dirty,
  onClose,
}: {
  readonly scope: SettingsScope;
  readonly workspace?: SettingsWorkspaceData;
  readonly settingsReturnTo?: string;
  readonly dirty: boolean;
  readonly onClose: () => void;
}) {
  return (
    <header className="settings-scope-bar">
      <nav className="settings-scope-tabs" aria-label="Settings scope">
        <Link
          to="/settings"
          replace
          state={settingsNavigationState(settingsReturnTo)}
          className="settings-scope-link"
          data-active={scope === "personal" || undefined}
          aria-current={scope === "personal" ? "page" : undefined}
        >
          <UserRound /> Personal Settings
        </Link>
        {workspace === undefined ? (
          <Link
            to="/workspaces"
            replace
            state={settingsNavigationState(settingsReturnTo)}
            className="settings-scope-link"
            data-active={scope === "workspace" || undefined}
            aria-current={scope === "workspace" ? "page" : undefined}
          >
            <span className="settings-workspace-mark" aria-hidden="true">
              W
            </span>
            Workspace Settings
          </Link>
        ) : (
          <Link
            to="/workspaces/$workspaceSlug"
            params={{ workspaceSlug: workspace.shortName }}
            replace
            state={settingsNavigationState(settingsReturnTo)}
            className="settings-scope-link"
            data-active={scope === "workspace" || undefined}
            aria-current={scope === "workspace" ? "page" : undefined}
          >
            <span className="settings-workspace-mark" aria-hidden="true">
              W
            </span>
            Workspace Settings
          </Link>
        )}
      </nav>
      {dirty ? (
        <span className="settings-dirty-state">Unsaved changes</span>
      ) : null}
      <button
        type="button"
        className="settings-close"
        aria-label="Close settings"
        onClick={onClose}
      >
        <X />
      </button>
    </header>
  );
}

type SettingsNavigationProps =
  | {
      readonly scope: "personal";
      readonly active: SettingsSectionRegistration;
      readonly settingsReturnTo?: string;
    }
  | {
      readonly scope: "workspace";
      readonly workspaceSlug?: WorkspaceSlug;
      readonly active: SettingsSectionRegistration;
      readonly settingsReturnTo?: string;
    };

const personalAdvancedChildIds = new Set([
  "personal-appearance",
  "personal-experimental-features",
  "personal-keyboard-shortcuts",
  "personal-signing-keys",
  "personal-project-defaults",
]);
function SettingsNavigation(props: SettingsNavigationProps) {
  const allRegistrations =
    props.scope === "personal"
      ? settingsManifest.personal
      : props.workspaceSlug === undefined
        ? settingsManifest.workspace.filter(
            (registration) => registration.slug === undefined,
          )
        : settingsManifest.workspace;
  const visibleRegistrations = settingsNavigationRegistrations(
    props.scope,
    allRegistrations,
  );
  const advancedChildren =
    props.scope === "personal"
      ? visibleRegistrations.filter((registration) =>
          personalAdvancedChildIds.has(registration.id),
        )
      : [];
  const registrations = visibleRegistrations.filter(
    (registration) => !personalAdvancedChildIds.has(registration.id),
  );
  const activeIsAdvancedChild = personalAdvancedChildIds.has(props.active.id);
  const [advancedExpanded, setAdvancedExpanded] = React.useState(
    props.active.id === "personal-advanced" || activeIsAdvancedChild,
  );

  const navigationLink = (
    registration: SettingsSectionRegistration,
    kind: "standard" | "advanced" | "advanced-child",
  ) => {
    const Icon = registration.icon;
    const path =
      props.scope === "personal"
        ? settingsPath({
            scope: props.scope,
            section: registration.slug,
          })
        : props.workspaceSlug === undefined
          ? "/workspaces"
          : settingsPath({
              scope: props.scope,
              workspaceSlug: props.workspaceSlug,
              section: registration.slug,
            });
    const active = props.active.id === registration.id;
    return (
      <Link
        key={registration.id}
        to={path}
        replace
        state={settingsNavigationState(props.settingsReturnTo)}
        activeOptions={{ exact: true }}
        className={`settings-navigation-link${kind === "advanced-child" ? " settings-navigation-child" : ""}`}
        data-active={active || undefined}
        aria-label={registration.label}
        aria-current={active ? "page" : undefined}
        aria-expanded={kind === "advanced" ? advancedExpanded : undefined}
        onClick={() => {
          if (kind === "advanced") {
            setAdvancedExpanded((expanded) => !expanded);
          } else if (kind === "advanced-child") {
            setAdvancedExpanded(true);
          } else {
            setAdvancedExpanded(false);
          }
        }}
      >
        <Icon />
        <span>{registration.label}</span>
        {kind === "advanced" ? (
          <ChevronDown className="settings-navigation-chevron" />
        ) : null}
      </Link>
    );
  };

  return (
    <aside className="settings-sidebar">
      <nav
        className="settings-navigation"
        aria-label={`${props.scope} settings`}
      >
        {registrations.map((registration) => {
          if (registration.id !== "personal-advanced") {
            return navigationLink(registration, "standard");
          }
          return (
            <div
              className="settings-navigation-group"
              data-expanded={advancedExpanded || undefined}
              key={registration.id}
            >
              {navigationLink(registration, "advanced")}
              {advancedExpanded ? (
                <div className="settings-navigation-submenu">
                  {advancedChildren.map((child) =>
                    navigationLink(child, "advanced-child"),
                  )}
                </div>
              ) : null}
            </div>
          );
        })}
      </nav>
    </aside>
  );
}

function SettingsErrorState({
  error,
  retry,
}: {
  readonly error: string;
  readonly retry: () => void;
}) {
  return (
    <div className="settings-route-state" role="alert">
      <AlertTriangle />
      <strong>{error}</strong>
      <span>The requested settings could not be loaded.</span>
      <Button size="sm" variant="outline" onClick={retry}>
        Try again
      </Button>
    </div>
  );
}

type SettingsPageProps =
  | {
      readonly scope: "personal";
      readonly registration: SettingsSectionRegistration;
    }
  | {
      readonly scope: "workspace";
      readonly workspaceSlug?: WorkspaceSlug;
      readonly registration: SettingsSectionRegistration;
    };

const settingsEscapeSnapshot = () => 0;

const useCloseSettingsOnEscape = (closeSettings: () => void) => {
  const subscribe = React.useCallback(
    (_onStoreChange: () => void) => {
      const close = (event: KeyboardEvent) => {
        if (
          event.key !== "Escape" ||
          event.defaultPrevented ||
          document.querySelector(
            "[role='dialog'], [role='menu'], .shortcut-recording",
          ) !== null
        )
          return;
        closeSettings();
      };
      window.addEventListener("keydown", close);
      return () => window.removeEventListener("keydown", close);
    },
    [closeSettings],
  );
  React.useSyncExternalStore(
    subscribe,
    settingsEscapeSnapshot,
    settingsEscapeSnapshot,
  );
};

export function SettingsPage(props: SettingsPageProps) {
  const { scope, registration } = props;
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const location = useLocation();
  const navigate = useNavigate();
  const routeReturnTo = settingsReturnToFromState(location.state);
  const callbackSearch = new URLSearchParams(location.searchStr);
  const callbackReturnTo =
    callbackSearch.get("github") === "installed"
      ? callbackSearch.get("return_to")
      : undefined;
  const settingsReturnTo =
    routeReturnTo ??
    (isValidSettingsReturnTo(callbackReturnTo) ? callbackReturnTo : undefined);
  const workspaceSlug =
    props.scope === "workspace" ? props.workspaceSlug : undefined;
  const contextRequest = React.useMemo(
    () =>
      workspaceSlug === undefined
        ? ({ scope: "personal" } as const)
        : ({ scope: "workspace", workspaceSlug } as const),
    [workspaceSlug],
  );
  const contextQuery = useQuery(
    settingsContextQueryOptions(identity.id, contextRequest),
  );
  const Section = registration.component;
  const workspace = contextQuery.data?.workspace;
  const effectiveWorkspaceSlug =
    scope === "workspace"
      ? (workspaceSlug ?? (workspace?.shortName as WorkspaceSlug | undefined))
      : undefined;
  const sectionKey = `${registration.id}:${effectiveWorkspaceSlug ?? "personal"}`;
  const [dirtyState, setDirtyState] = React.useState({
    sectionKey,
    generation: 0,
    dirty: false,
  });
  if (dirtyState.sectionKey !== sectionKey) {
    setDirtyState({
      sectionKey,
      generation: dirtyState.generation + 1,
      dirty: false,
    });
  }
  const dirty = dirtyState.sectionKey === sectionKey && dirtyState.dirty;
  const dirtyGeneration = dirtyState.generation;
  const setDirty = (nextDirty: boolean) =>
    setDirtyState((current) =>
      current.sectionKey === sectionKey &&
      current.generation === dirtyGeneration
        ? { ...current, dirty: nextDirty }
        : current,
    );
  const error =
    contextQuery.error === null
      ? undefined
      : typeof contextQuery.error === "object" &&
          contextQuery.error !== null &&
          "status" in contextQuery.error &&
          contextQuery.error.status === 403
        ? "You are not authorized to administer this workspace."
        : contextQuery.error instanceof Error
          ? contextQuery.error.message
          : "The requested settings could not be loaded.";
  const workspaceChanged = React.useCallback(
    (nextWorkspace: SettingsWorkspaceData) => {
      queryClient.setQueryData(
        settingsKeys.context(identity.id, contextRequest),
        {
          activeScope: scope,
          workspace: nextWorkspace,
        },
      );
    },
    [contextRequest, identity.id, queryClient, scope],
  );
  const closeSettings = React.useCallback(() => {
    const destination = settingsReturnTo ?? "/";
    void navigate({ href: destination, replace: true });
  }, [navigate, settingsReturnTo]);
  useCloseSettingsOnEscape(closeSettings);

  return (
    <AppFrame className="settings-stage" onBackdropClick={closeSettings}>
      <main className="settings-shell" aria-label="Settings">
        <ScopeBar
          scope={scope}
          workspace={workspace}
          settingsReturnTo={settingsReturnTo}
          dirty={dirty}
          onClose={closeSettings}
        />
        <div className="settings-shell-body">
          {props.scope === "personal" ? (
            <SettingsNavigation
              key={registration.id}
              scope={props.scope}
              active={registration}
              settingsReturnTo={settingsReturnTo}
            />
          ) : (
            <SettingsNavigation
              key={registration.id}
              scope={props.scope}
              workspaceSlug={effectiveWorkspaceSlug}
              active={registration}
              settingsReturnTo={settingsReturnTo}
            />
          )}
          <section
            className="settings-content"
            aria-busy={contextQuery.isFetching}
            aria-live="polite"
          >
            {contextQuery.data === undefined && contextQuery.isPending ? (
              <DxLoading label="Loading settings…" />
            ) : contextQuery.data === undefined ? (
              <SettingsErrorState
                error={error ?? "The requested settings could not be loaded."}
                retry={() => void contextQuery.refetch()}
              />
            ) : (
              <>
                {error === undefined ? null : (
                  <SettingsBackgroundError
                    onRetry={() => void contextQuery.refetch()}
                  >
                    {error} Showing the last loaded settings.
                  </SettingsBackgroundError>
                )}
                <Section
                  key={sectionKey}
                  onDirtyChange={setDirty}
                  settingsReturnTo={settingsReturnTo}
                  workspace={workspace}
                  workspaceSlug={effectiveWorkspaceSlug}
                  onWorkspaceChanged={workspaceChanged}
                />
              </>
            )}
          </section>
        </div>
      </main>
      <UnsavedChangesGuard
        dirty={dirty}
        allowModeChanges={registration.id === "personal-mode-dial"}
        onDiscard={() => setDirty(false)}
      />
    </AppFrame>
  );
}

const isInvalidSettingsScope = (data: unknown) =>
  typeof data === "object" &&
  data !== null &&
  "code" in data &&
  data.code === "INVALID_SETTINGS_SCOPE";

export function SettingsRouteNotFound({ data }: NotFoundRouteProps) {
  const invalidScope = isInvalidSettingsScope(data);
  const focusHeading = React.useCallback((node: HTMLHeadingElement | null) => {
    node?.focus();
  }, []);
  return (
    <AppFrame className="settings-stage">
      <main className="settings-shell settings-failure-shell">
        <div className="settings-route-state">
          <AlertTriangle />
          <h1 ref={focusHeading} tabIndex={-1}>
            {invalidScope
              ? "Invalid workspace settings URL"
              : "Settings section not found"}
          </h1>
          <span>
            {invalidScope
              ? "The workspace slug in this URL is malformed. No workspace data was requested."
              : "The URL does not match a registered settings section. No fallback section was opened."}
          </span>
          <code>
            {invalidScope
              ? "INVALID_SETTINGS_SCOPE"
              : "SETTINGS_SECTION_NOT_FOUND"}
          </code>
          <Link to="/settings" state={true} className="settings-return-link">
            <Check /> Return to Personal settings
          </Link>
        </div>
      </main>
    </AppFrame>
  );
}
