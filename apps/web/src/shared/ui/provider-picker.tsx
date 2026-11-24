import type { ReactNode } from "react";
import { cn } from "../utils.js";
import { ProviderMark } from "./provider-marks.js";
import "./provider-picker.css";

/** One choice in a ProviderPicker. */
export interface ProviderPickerOption {
  readonly key: string;
  readonly name: string;
  /** Draws the provider's mark; options without one show their initial. */
  readonly providerId?: string;
  /** Replaces the mark, such as a route icon for a custom URL. */
  readonly icon?: ReactNode;
  /** Why the option can't be picked; it shows under the option, which is disabled. */
  readonly disabledReason?: string;
}

const Option = ({
  option,
  onPick,
}: {
  readonly option: ProviderPickerOption;
  readonly onPick: (key: string) => void;
}) => {
  const describedBy =
    option.disabledReason === undefined
      ? undefined
      : `provider-picker-${option.key}-note`;
  const initial = (
    <span className="provider-picker-initial">{option.name.slice(0, 1)}</span>
  );
  return (
    <div className="min-w-0">
      <button
        type="button"
        className="provider-picker-option"
        disabled={option.disabledReason !== undefined}
        aria-describedby={describedBy}
        onClick={() => onPick(option.key)}
      >
        <span aria-hidden="true" className="contents">
          {option.icon ??
            (option.providerId === undefined ? (
              initial
            ) : (
              <ProviderMark providerId={option.providerId} fallback={initial} />
            ))}
        </span>
        <span className="min-w-0">{option.name}</span>
      </button>
      {option.disabledReason === undefined ? null : (
        <p id={describedBy} className="provider-picker-note">
          {option.disabledReason}
        </p>
      )}
    </div>
  );
};

/**
 * A grid of model providers to pick one from, each with its mark: one
 * column on a phone, two from 640px. `featured` options sit above the rest,
 * set off by a rule. The caller orders the options.
 */
export function ProviderPicker({
  options,
  featured = [],
  featuredLabel = "Most popular",
  onPick,
  className,
}: {
  readonly options: ReadonlyArray<ProviderPickerOption>;
  readonly featured?: ReadonlyArray<ProviderPickerOption>;
  readonly featuredLabel?: string;
  readonly onPick: (key: string) => void;
  readonly className?: string;
}) {
  return (
    <div className={className}>
      {featured.length === 0 ? null : (
        <section
          aria-label={featuredLabel}
          className="provider-picker-grid provider-picker-featured"
        >
          {featured.map((option) => (
            <Option key={option.key} option={option} onPick={onPick} />
          ))}
        </section>
      )}
      <div className={cn("provider-picker-grid")}>
        {options.map((option) => (
          <Option key={option.key} option={option} onPick={onPick} />
        ))}
      </div>
    </div>
  );
}
