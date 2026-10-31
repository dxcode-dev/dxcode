import type { SettingsWorkspaceData } from "@dx/api";
import type { SettingsScope, WorkspaceRole, WorkspaceSlug } from "@dx/domain";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Link, useLocation, useNavigate } from "@tanstack/react-router";
import { AlertTriangle, ArrowLeft, Bug, UserRound } from "lucide-react";
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
import { UnsavedChangesGuard } from "../../shared/ui/unsaved-changes-guard.js";
import { personalAccountQueryOptions } from "./account/personal-account-queries.js";
import { settingsManifest } from "./foundation-sections.js";
import { isModeOnlyNavigation } from "./mode-search-navigation.js";
import {
  settingsContextQueryOptions,
  settingsKeys,
} from "./settings-context-queries.js";
import {
  isWorkspaceAdmin,
  settingsNavigationSections,
} from "./settings-navigation.js";
import { SettingsBackgroundError } from "./settings-primitives.js";
import {
  type SettingsSectionRegistration,
  settingsPath,
} from "./settings-registration.js";

/** Public links in the rail's footer card. */
const railLinks = [
  {
    label: "GitHub",
    href: "https://github.com/dxcode-dev/dxcode",
    Icon: GitHubMark,
  },
  { label: "@dxcode_dev", href: "https://x.com/dxcode_dev", Icon: XMark },
  {
    label: "Report a Bug",
    href: "https://github.com/dxcode-dev/dxcode/issues/new",
    Icon: Bug,
  },
] as const;

function GitHubMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M8 0C3.58 0 0 3.58 0 8c0 3.54 2.29 6.53 5.47 7.59.4.07.55-.17.55-.38 0-.19-.01-.82-.01-1.49-2.01.37-2.53-.49-2.69-.94-.09-.23-.48-.94-.82-1.13-.28-.15-.68-.52-.01-.53.63-.01 1.08.58 1.23.82.72 1.21 1.87.87 2.33.66.07-.52.28-.87.51-1.07-1.78-.2-3.64-.89-3.64-3.95 0-.87.31-1.59.82-2.15-.08-.2-.36-1.02.08-2.12 0 0 .67-.21 2.2.82.64-.18 1.32-.27 2-.27s1.36.09 2 .27c1.53-1.04 2.2-.82 2.2-.82.44 1.1.16 1.92.08 2.12.51.56.82 1.27.82 2.15 0 3.07-1.87 3.75-3.65 3.95.29.25.54.73.54 1.48 0 1.07-.01 1.93-.01 2.2 0 .21.15.46.55.38A8.01 8.01 0 0 0 16 8c0-4.42-3.58-8-8-8Z" />
    </svg>
  );
}

function XMark(props: React.SVGProps<SVGSVGElement>) {
  return (
    <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true" {...props}>
      <path d="M12.6.75h2.45L9.7 6.86 16 15.25h-4.93L7.2 10.18 2.79 15.25H.33l5.73-6.55L0 .75h5.06l3.49 4.63L12.6.75Zm-.86 13.03h1.36L4.32 2.15H2.86l8.88 11.63Z" />
    </svg>
  );
}

/** A finger drag down this far on the phone sheet's handle closes settings. */
const sheetDismissDistance = 96;

const sheetOf = (handle: HTMLElement) =>
  handle.closest<HTMLElement>(".dx-app-frame");

/**
 * The phone sheet's grab handle. Dragging it down moves the sheet with the
 * finger and closes settings past `sheetDismissDistance`; a tap closes too.
 */
function SettingsSheetHandle({ onClose }: { readonly onClose: () => void }) {
  const drag = React.useRef<{ pointerId: number; startY: number } | null>(null);
  const release = (event: React.PointerEvent<HTMLButtonElement>) => {
    const current = drag.current;
    if (current === null || current.pointerId !== event.pointerId) return;
    drag.current = null;
    const sheet = sheetOf(event.currentTarget);
    if (sheet !== null) {
      delete sheet.dataset.sheetDrag;
      sheet.style.transform = "";
    }
    return event.clientY - current.startY;
  };
  return (
    <button
      type="button"
      className="settings-sheet-handle"
      aria-label="Close settings"
      onClick={onClose}
      onPointerDown={(event) => {
        if (event.pointerType === "mouse") return;
        event.currentTarget.setPointerCapture(event.pointerId);
        drag.current = { pointerId: event.pointerId, startY: event.clientY };
      }}
      onPointerMove={(event) => {
        const current = drag.current;
        if (current === null || current.pointerId !== event.pointerId) return;
        const sheet = sheetOf(event.currentTarget);
        if (sheet === null) return;
        const offset = Math.max(0, event.clientY - current.startY);
        sheet.dataset.sheetDrag = "";
        sheet.style.transform = `translateY(${offset}px)`;
      }}
      onPointerUp={(event) => {
        const distance = release(event);
        if (distance !== undefined && distance > sheetDismissDistance)
          onClose();
      }}
      onPointerCancel={release}
    >
      <span aria-hidden="true" />
    </button>
  );
}

function SettingsTopBar({
  scope,
  workspace,
  avatarUrl,
  settingsReturnTo,
  dirty,
  onClose,
}: {
  readonly scope: SettingsScope;
  readonly workspace?: SettingsWorkspaceData;
  readonly avatarUrl?: string;
  readonly settingsReturnTo?: string;
  readonly dirty: boolean;
  readonly onClose: () => void;
}) {
  return (
    <header className="settings-top-bar">
      <SettingsSheetHandle onClose={onClose} />
      <div className="settings-top-bar-row">
        <button type="button" className="settings-back" onClick={onClose}>
          <ArrowLeft aria-hidden="true" />
          <span>Back to dx</span>
        </button>
        <nav className="settings-scope-tabs" aria-label="Settings scope">
          <Link
            to="/settings"
            replace
            state={settingsNavigationState(settingsReturnTo)}
            className="settings-scope-link"
            data-active={scope === "personal" || undefined}
            aria-current={scope === "personal" ? "page" : undefined}
            aria-label="Personal Settings"
          >
            {avatarUrl === undefined ? (
              <UserRound />
            ) : (
              <span className="settings-personal-mark" aria-hidden="true">
                <img src={avatarUrl} alt="" />
              </span>
            )}
            <span>
              Personal<span className="settings-scope-suffix"> Settings</span>
            </span>
          </Link>
          {workspace === undefined ? (
            <Link
              to="/workspaces"
              replace
              state={settingsNavigationState(settingsReturnTo)}
              className="settings-scope-link"
              data-active={scope === "workspace" || undefined}
              aria-current={scope === "workspace" ? "page" : undefined}
              aria-label="Workspace Settings"
            >
              <span className="settings-workspace-mark" aria-hidden="true">
                W
              </span>
              <span>
                Workspace
                <span className="settings-scope-suffix"> Settings</span>
              </span>
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
              aria-label="Workspace Settings"
            >
              <span className="settings-workspace-mark" aria-hidden="true">
                {workspace.avatarUrl === undefined ? (
                  "W"
                ) : (
                  <img src={workspace.avatarUrl} alt="" />
                )}
              </span>
              <span>
                Workspace
                <span className="settings-scope-suffix"> Settings</span>
              </span>
            </Link>
          )}
        </nav>
        {dirty ? (
          <span className="settings-dirty-state">Unsaved changes</span>
        ) : null}
      </div>
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
      readonly workspaceRole?: WorkspaceRole;
      readonly active: SettingsSectionRegistration;
      readonly settingsReturnTo?: string;
    };

function SettingsNavigation(props: SettingsNavigationProps) {
  const allRegistrations =
    props.scope === "personal"
      ? settingsManifest.personal
      : props.workspaceSlug === undefined
        ? settingsManifest.workspace.filter(
            (registration) => registration.slug === undefined,
          )
        : settingsManifest.workspace;
  const sections = settingsNavigationSections(
    props.scope,
    allRegistrations,
    props.scope === "workspace" ? props.workspaceRole : undefined,
  );
  const headingId = React.useId();

  const navigationLink = (registration: SettingsSectionRegistration) => {
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
        className="settings-navigation-link"
        data-active={active || undefined}
        aria-label={registration.label}
        aria-current={active ? "page" : undefined}
      >
        <Icon />
        <span>{registration.label}</span>
      </Link>
    );
  };

  return (
    <aside className="settings-sidebar">
      <div className="settings-navigation-scroller">
        <nav
          className="settings-navigation"
          aria-label={`${props.scope} settings`}
        >
          {sections.map((section) =>
            section.heading === undefined ? (
              section.registrations.map(navigationLink)
            ) : (
              <div key={section.group} className="settings-navigation-group">
                <span
                  id={`${headingId}-${section.group}`}
                  className="settings-navigation-heading"
                >
                  <span className="settings-navigation-heading-text">
                    {section.heading}
                  </span>
                </span>
                <ul
                  className="settings-navigation-list"
                  aria-labelledby={`${headingId}-${section.group}`}
                >
                  {section.registrations.map((registration) => (
                    <li key={registration.id}>
                      {navigationLink(registration)}
                    </li>
                  ))}
                </ul>
              </div>
            ),
          )}
        </nav>
      </div>
      <nav className="settings-rail-footer" aria-label="dx links">
        <ul>
          {railLinks.map(({ label, href, Icon }) => (
            <li key={href}>
              <a href={href} target="_blank" rel="noreferrer">
                <Icon />
                <span>{label}</span>
              </a>
            </li>
          ))}
        </ul>
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
  const subscribe = (_onStoreChange: () => void) => {
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
  };
  React.useSyncExternalStore(
    subscribe,
    settingsEscapeSnapshot,
    settingsEscapeSnapshot,
  );
};

/** Where closing settings returns: the opener's link, or GitHub's install callback. */
const settingsReturnToFor = (location: {
  readonly state: unknown;
  readonly searchStr: string;
}) => {
  const callbackSearch = new URLSearchParams(location.searchStr);
  const callbackReturnTo =
    callbackSearch.get("github") === "installed"
      ? callbackSearch.get("return_to")
      : undefined;
  return (
    settingsReturnToFromState(location.state) ??
    (isValidSettingsReturnTo(callbackReturnTo) ? callbackReturnTo : undefined)
  );
};

export function SettingsPage(props: SettingsPageProps) {
  const { scope, registration } = props;
  const { identity } = useAuthenticatedIdentity();
  const queryClient = useQueryClient();
  const settingsReturnTo = useLocation({ select: settingsReturnToFor });
  const navigate = useNavigate();
  const workspaceSlug =
    props.scope === "workspace" ? props.workspaceSlug : undefined;
  const contextRequest =
    workspaceSlug === undefined
      ? ({ scope: "personal" } as const)
      : ({ scope: "workspace", workspaceSlug } as const);
  const contextQuery = useQuery(
    settingsContextQueryOptions(identity.id, contextRequest),
  );
  // The app-wide theme provider already loads this account; reuse its cache.
  const accountQuery = useQuery(personalAccountQueryOptions(identity.id));
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
      // Forms report dirty on every keystroke; keep the same state object when
      // it does not change so the whole settings page does not re-render.
      current.sectionKey === sectionKey &&
      current.generation === dirtyGeneration &&
      current.dirty !== nextDirty
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
  const workspaceChanged = (nextWorkspace: SettingsWorkspaceData) => {
    queryClient.setQueryData(
      settingsKeys.context(identity.id, contextRequest),
      {
        activeScope: scope,
        workspace: nextWorkspace,
      },
    );
  };
  const closeSettings = () => {
    const destination = settingsReturnTo ?? "/";
    void navigate({ href: destination, replace: true });
  };
  useCloseSettingsOnEscape(closeSettings);

  return (
    <AppFrame className="settings-stage" onBackdropClick={closeSettings}>
      <main className="settings-shell" aria-label="Settings">
        <SettingsTopBar
          scope={scope}
          workspace={workspace}
          avatarUrl={accountQuery.data?.avatarUrl}
          settingsReturnTo={settingsReturnTo}
          dirty={dirty}
          onClose={closeSettings}
        />
        <div className="settings-shell-body">
          {props.scope === "personal" ? (
            <SettingsNavigation
              scope={props.scope}
              active={registration}
              settingsReturnTo={settingsReturnTo}
            />
          ) : (
            <SettingsNavigation
              scope={props.scope}
              workspaceSlug={effectiveWorkspaceSlug}
              workspaceRole={workspace?.role}
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
                {scope === "workspace" &&
                registration.adminOnly === true &&
                !isWorkspaceAdmin(workspace?.role) ? (
                  <div className="settings-route-state" role="status">
                    <h1>{registration.title}</h1>
                    <p>Only workspace admins can view this section.</p>
                  </div>
                ) : (
                  <Section
                    key={sectionKey}
                    onDirtyChange={setDirty}
                    settingsReturnTo={settingsReturnTo}
                    workspace={workspace}
                    workspaceSlug={effectiveWorkspaceSlug}
                    onWorkspaceChanged={workspaceChanged}
                  />
                )}
              </>
            )}
          </section>
        </div>
      </main>
      <UnsavedChangesGuard
        dirty={dirty}
        allowNavigation={
          registration.id === "personal-mode-dial"
            ? isModeOnlyNavigation
            : undefined
        }
        onDiscard={() => setDirty(false)}
      />
    </AppFrame>
  );
}
