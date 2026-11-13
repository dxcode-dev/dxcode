import { GitBranch } from "lucide-react";
import * as React from "react";
import {
  ComboboxEmpty,
  ComboboxField,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  ComboboxPopup,
  ComboboxRoot,
} from "../../shared/ui/combobox.js";
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
    <ComboboxRoot
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
      <ComboboxField
        className="repository-combobox-control"
        size={inPlace ? "sm" : "md"}
        toggleLabel="Open repository list"
      >
        <ComboboxInput
          id={inPlace ? undefined : "project-repository"}
          aria-label={inPlace ? "Repository URL" : undefined}
          placeholder="Search repositories or paste a URL"
          autoComplete="off"
          autoFocus={!inPlace}
          aria-busy={loading !== undefined}
        />
      </ComboboxField>
      <ComboboxPopup width="anchor" className="repository-combobox-popup">
        <ComboboxEmpty>
          {loading ?? "No repositories found. Paste a Git URL."}
        </ComboboxEmpty>
        <ComboboxList>
          {(option: RepositoryOption) => (
            <ComboboxItem key={option.value} value={option}>
              <GitBranch aria-hidden="true" />
              <span className="dx-picker-item-label">{option.label}</span>
            </ComboboxItem>
          )}
        </ComboboxList>
      </ComboboxPopup>
    </ComboboxRoot>
  );
}
