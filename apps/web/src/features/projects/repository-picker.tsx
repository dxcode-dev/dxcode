import { Combobox } from "@base-ui/react/combobox";
import { Check, ChevronDown, GitBranch } from "lucide-react";
import * as React from "react";
import {
  matchesQuery,
  optionsWithTypedUrl,
  type RepositoryOption,
  sameRepository,
  urlOption,
} from "./repository-options.js";

/**
 * One field to search connected repositories or paste a Git URL. In place,
 * as in Project settings, a typed URL is the value without picking it.
 */
export function RepositoryPicker({
  options,
  value,
  loading,
  inPlace = false,
  disabled,
  onValueChange,
}: {
  readonly options: ReadonlyArray<RepositoryOption>;
  readonly value?: RepositoryOption;
  readonly loading?: string;
  readonly inPlace?: boolean;
  readonly disabled?: boolean;
  readonly onValueChange: (value: RepositoryOption | undefined) => void;
}) {
  const [query, setQuery] = React.useState(value?.label ?? "");
  const items = optionsWithTypedUrl(options, query);
  const typed = (text: string) => {
    const pasted = urlOption(text);
    return pasted === undefined
      ? undefined
      : (options.find((option) => sameRepository(option, pasted)) ?? pasted);
  };
  return (
    <Combobox.Root
      items={items}
      value={value ?? null}
      inputValue={query}
      onInputValueChange={(next, { reason }) => {
        // In place, the field keeps what was typed: closing the list with no
        // item chosen would otherwise reset it to the chosen item's label.
        if (inPlace && (reason === "input-clear" || reason === "none")) return;
        setQuery(next);
        if (inPlace) {
          const option = typed(next);
          if (option?.value !== value?.value) onValueChange(option);
        } else if (value !== undefined && next !== value.label)
          onValueChange(undefined);
      }}
      onValueChange={(option) => onValueChange(option ?? undefined)}
      isItemEqualToValue={(option, selected) => option.value === selected.value}
      filter={matchesQuery}
      autoHighlight
      disabled={disabled}
    >
      <Combobox.InputGroup className="repository-combobox-control">
        <Combobox.Input
          id={inPlace ? undefined : "project-repository"}
          aria-label={inPlace ? "Repository URL" : undefined}
          placeholder="Search repositories or paste a URL"
          autoComplete="off"
          autoFocus={!inPlace}
          aria-busy={loading !== undefined}
        />
        <Combobox.Trigger aria-label="Open repository list">
          <ChevronDown aria-hidden="true" />
        </Combobox.Trigger>
      </Combobox.InputGroup>
      <Combobox.Portal>
        <Combobox.Positioner
          className="repository-combobox-positioner"
          sideOffset={4}
          align="start"
        >
          <Combobox.Popup className="repository-combobox-popup">
            <Combobox.Empty className="repository-combobox-empty">
              {loading ?? "No repositories found. Paste a Git URL."}
            </Combobox.Empty>
            <Combobox.List className="repository-combobox-list">
              {(option: RepositoryOption) => (
                <Combobox.Item
                  key={option.value}
                  value={option}
                  className="repository-combobox-item repository-option"
                >
                  <GitBranch aria-hidden="true" />
                  <span>{option.label}</span>
                  <Combobox.ItemIndicator className="repository-combobox-indicator">
                    <Check aria-hidden="true" />
                  </Combobox.ItemIndicator>
                </Combobox.Item>
              )}
            </Combobox.List>
          </Combobox.Popup>
        </Combobox.Positioner>
      </Combobox.Portal>
    </Combobox.Root>
  );
}
