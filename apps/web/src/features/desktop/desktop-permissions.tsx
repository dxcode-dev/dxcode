import type { MacDesktopPermissions, MacSettingsPane } from "@dx/api";
import { Monitor, MousePointerClick, ScreenShare } from "lucide-react";
import * as React from "react";
import { Button } from "../../shared/ui/button.js";
import { DisclosureTrigger } from "../../shared/ui/disclosure.js";
import { EmptyState } from "../../shared/ui/empty-state.js";
import {
  RequirementList,
  RequirementRow,
} from "../../shared/ui/requirement-list.js";
import { Textarea } from "../../shared/ui/textarea.js";
import "./desktop-permissions.css";

/** Where one "Open on your Mac" request stands. */
export type SettingsRequest =
  | { readonly state: "idle" }
  | { readonly state: "pending" }
  | { readonly state: "sent" }
  | { readonly state: "failed"; readonly message: string };

export type SettingsRequests = Readonly<
  Record<MacSettingsPane, SettingsRequest>
>;

export interface DesktopPermissionsProps {
  /** What macOS allowed dx's Desktop on the Mac. */
  readonly permissions: MacDesktopPermissions;
  /** The runner's own words and voxl's log, behind Details. */
  readonly detail?: string;
  readonly requests: SettingsRequests;
  /** Opens System Settings on the Mac at that pane. */
  readonly onOpenSettings: (pane: MacSettingsPane) => void;
  /** Details start open (stories). */
  readonly defaultDetailsOpen?: boolean;
}

const ROWS: ReadonlyArray<{
  readonly pane: MacSettingsPane;
  readonly key: keyof MacDesktopPermissions;
  readonly label: string;
  readonly description: string;
  readonly icon: React.ReactNode;
}> = [
  {
    pane: "screen-recording",
    key: "screenRecording",
    label: "Screen Recording",
    description: "To see the screen",
    icon: <ScreenShare />,
  },
  {
    pane: "accessibility",
    key: "accessibility",
    label: "Accessibility",
    description: "To click and type",
    icon: <MousePointerClick />,
  },
];

const noteOf = (request: SettingsRequest) =>
  request.state === "sent"
    ? "System Settings is open on your Mac. Turn on dx there."
    : request.state === "failed"
      ? request.message
      : undefined;

/**
 * A Mac runner's Desktop before macOS allowed dx to record the screen: one
 * row per permission, each opening System Settings on the Mac at its pane.
 * The viewer checks again by itself and streams once Screen Recording is
 * on; Accessibility alone never blocks the stream.
 */
export function DesktopPermissions({
  permissions,
  detail,
  requests,
  onOpenSettings,
  defaultDetailsOpen = false,
}: DesktopPermissionsProps) {
  const [detailsOpen, setDetailsOpen] = React.useState(defaultDetailsOpen);
  const detailsId = React.useId();
  return (
    <div className="desktop-permissions">
      <EmptyState
        className="desktop-permissions-heading"
        icon={<Monitor />}
        title="Allow dx to show this Mac"
        description="macOS asks before dx can see or control this Mac. The Desktop opens by itself once Screen Recording is on."
      />
      <RequirementList aria-label="macOS permissions">
        {ROWS.map((row) => {
          const request = requests[row.pane];
          return (
            <RequirementRow
              key={row.pane}
              icon={row.icon}
              label={row.label}
              description={row.description}
              met={permissions[row.key]}
              action={
                <Button
                  variant="outline"
                  size="xs"
                  busy={request.state === "pending"}
                  onClick={() => onOpenSettings(row.pane)}
                >
                  Open on your Mac
                  <span className="sr-only"> for {row.label}</span>
                </Button>
              }
              note={noteOf(request)}
              noteTone={request.state === "failed" ? "error" : "info"}
            />
          );
        })}
      </RequirementList>
      <p className="desktop-permissions-hint">
        dx listed but still refused? Remove it with −, then add{" "}
        <code>~/.dx/runner/dx.app</code> with +.
      </p>
      {detail === undefined || detail === "" ? null : (
        <div className="desktop-permissions-details">
          <DisclosureTrigger
            expanded={detailsOpen}
            aria-controls={detailsId}
            onClick={() => setDetailsOpen((open) => !open)}
          >
            <span>Details</span>
          </DisclosureTrigger>
          {detailsOpen ? (
            <Textarea
              id={detailsId}
              mono
              readOnly
              rows={6}
              aria-label="Details"
              value={detail}
            />
          ) : null}
        </div>
      )}
    </div>
  );
}
