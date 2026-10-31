import type { CatalogProviderData } from "@dx/api";
import { Plus, Route } from "lucide-react";
import { useState } from "react";
import { Button } from "../../../shared/ui/button.js";
import { ClaudeIcon } from "../../../shared/ui/claude-icon.js";
import {
  DialogContent,
  DialogRoot,
  DialogTitle,
} from "../../../shared/ui/dialog.js";
import { GitHubIcon } from "../../../shared/ui/github-icon.js";
import { providerKeyPresentation } from "./provider-key-presentation.js";
import { hasProviderMark } from "./provider-mark-ids.js";
import { ProviderMark } from "./provider-marks.js";

export type AddConnectionPick =
  | "copilot"
  | "claude"
  | "custom"
  | CatalogProviderData;

interface PickerEntry {
  readonly key: string;
  readonly name: string;
  readonly icon: React.ReactNode;
  readonly pick: AddConnectionPick;
  readonly disabledReason?: string;
}

const ProviderOption = ({
  entry,
  onPick,
}: {
  readonly entry: PickerEntry;
  readonly onPick: (pick: AddConnectionPick) => void;
}) => {
  const describedBy =
    entry.disabledReason === undefined ? undefined : `add-${entry.key}-note`;
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="routing-provider-option"
        disabled={entry.disabledReason !== undefined}
        aria-describedby={describedBy}
        onClick={() => onPick(entry.pick)}
      >
        <span aria-hidden="true" className="contents">
          {entry.icon}
        </span>
        <span className="min-w-0">{entry.name}</span>
      </button>
      {entry.disabledReason === undefined ? null : (
        <p id={describedBy} className="routing-provider-option-note">
          {entry.disabledReason}
        </p>
      )}
    </div>
  );
};

/**
 * The Add a Provider dialog: subscriptions on top, then every provider and
 * Custom URL in one alphabetical two-column grid.
 */
export const AddProviderDialog = ({
  showClaude,
  showCopilot,
  copilotConnected,
  providers,
  onPick,
}: {
  readonly showClaude: boolean;
  readonly showCopilot: boolean;
  readonly copilotConnected: boolean;
  /** Catalog providers that connect with an API key. */
  readonly providers: ReadonlyArray<CatalogProviderData>;
  readonly onPick: (pick: AddConnectionPick) => void;
}) => {
  const [open, setOpen] = useState(false);
  const choose = (pick: AddConnectionPick) => {
    setOpen(false);
    onPick(pick);
  };
  const entries: PickerEntry[] = [
    ...providers.map((provider) => ({
      key: provider.id,
      name: providerKeyPresentation(provider.id, provider.name).name,
      icon: hasProviderMark(provider.id) ? (
        <ProviderMark providerId={provider.id} />
      ) : (
        <span className="routing-provider-option-fallback">
          {provider.name.slice(0, 1)}
        </span>
      ),
      pick: provider,
    })),
    {
      key: "custom",
      name: "Custom URL",
      icon: <Route />,
      pick: "custom" as const,
    },
    ...(showCopilot
      ? [
          {
            key: "copilot",
            name: "GitHub Copilot",
            icon: <GitHubIcon />,
            pick: "copilot" as const,
            ...(copilotConnected
              ? {
                  disabledReason:
                    "Only one GitHub Copilot subscription can be connected. Delete it to add another.",
                }
              : {}),
          },
        ]
      : []),
  ].sort((a, b) => a.name.localeCompare(b.name));
  return (
    <>
      <Button size="xs" onClick={() => setOpen(true)}>
        <Plus aria-hidden="true" />
        Add
      </Button>
      <DialogRoot open={open} onOpenChange={setOpen}>
        <DialogContent className="routing-add-provider-dialog">
          <DialogTitle className="routing-add-provider-title">
            Add a Provider
          </DialogTitle>
          <div className="routing-add-provider-body">
            {showClaude ? (
              <section
                aria-label="Most popular"
                className="routing-provider-grid routing-provider-popular"
              >
                <ProviderOption
                  entry={{
                    key: "claude",
                    name: "Claude Pro/Max",
                    icon: <ClaudeIcon />,
                    pick: "claude",
                  }}
                  onPick={choose}
                />
              </section>
            ) : null}
            <div className="routing-provider-grid">
              {entries.map((entry) => (
                <ProviderOption key={entry.key} entry={entry} onPick={choose} />
              ))}
            </div>
          </div>
        </DialogContent>
      </DialogRoot>
    </>
  );
};
