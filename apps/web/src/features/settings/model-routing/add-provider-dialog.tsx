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
import {
  ProviderPicker,
  type ProviderPickerOption,
} from "../../../shared/ui/provider-picker.js";
import { providerKeyPresentation } from "./provider-key-presentation.js";

export type AddConnectionPick =
  | "copilot"
  | "claude"
  | "custom"
  | CatalogProviderData;

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
  const picks = new Map<string, AddConnectionPick>([
    ...providers.map((provider) => [provider.id, provider] as const),
    ["custom", "custom"],
    ["copilot", "copilot"],
    ["claude", "claude"],
  ]);
  const choose = (key: string) => {
    const pick = picks.get(key);
    if (pick === undefined) return;
    setOpen(false);
    onPick(pick);
  };
  const options: ProviderPickerOption[] = [
    ...providers.map((provider) => ({
      key: provider.id,
      name: providerKeyPresentation(provider.id, provider.name).name,
      providerId: provider.id,
    })),
    { key: "custom", name: "Custom URL", icon: <Route /> },
    ...(showCopilot
      ? [
          {
            key: "copilot",
            name: "GitHub Copilot",
            icon: <GitHubIcon />,
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
          <ProviderPicker
            className="routing-add-provider-body"
            featured={
              showClaude
                ? [
                    {
                      key: "claude",
                      name: "Claude Pro/Max",
                      icon: <ClaudeIcon />,
                    },
                  ]
                : []
            }
            options={options}
            onPick={choose}
          />
        </DialogContent>
      </DialogRoot>
    </>
  );
};
