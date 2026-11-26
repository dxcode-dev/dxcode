// Types for @dxcode/plugin-ui's elements, for plugin views written in
// TypeScript. dx inlines the kit where a view has
// <script type="module" src="dx:plugin-ui"></script>; see README.md.

export type DxTone = "neutral" | "success" | "warning" | "danger" | "info";

export interface DxTableColumn<Row = Record<string, unknown>> {
  readonly key: string;
  readonly label?: string;
  readonly align?: "start" | "end";
  /** A CSS width, such as `"120px"`. */
  readonly width?: string;
  /** Text or a node for the cell; the raw value by default. */
  readonly format?: (value: unknown, row: Row) => string | Node;
}

export interface DxButtonElement extends HTMLElement {
  loading: boolean;
  disabled: boolean;
}
export interface DxTableElement<Row = Record<string, unknown>>
  extends HTMLElement {
  columns: ReadonlyArray<DxTableColumn<Row>> | null;
  rows: ReadonlyArray<Row>;
}
export interface DxFieldElement extends HTMLElement {
  value: string;
  readonly name: string | null;
  readonly form: HTMLFormElement | null;
}
export interface DxToggleElement extends HTMLElement {
  checked: boolean;
  readonly value: string;
  readonly form: HTMLFormElement | null;
}
export interface DxTabsElement extends HTMLElement {
  value: string;
}
export interface DxCodeElement extends HTMLElement {
  code: string;
}
export interface DxPlayerElement extends HTMLElement {
  /** A `MediaStream`, such as a canvas's; plays as live. */
  srcObject: MediaStream | null;
  /** The inner `<video>` or `<audio>`. */
  readonly media: HTMLMediaElement;
}

export interface DxPluginUi {
  readonly version: string;
  /** Asks the person, then opens an http or https URL in a new tab. */
  openLink(url: string): void;
  /** The names `dx-icon` and `icon` attributes take. */
  readonly icons: readonly string[];
}

/**
 * A UI SDK component's root (`<ui-select>`, `<ui-tabs>`, …), which dx
 * inlines into any frame that writes its tag. `value` is live; setting it
 * fires `valuechange`. Popup roots also have a live `open`. UI SDK's docs
 * list every part: https://github.com/vercel-labs/ui
 */
export interface UiSdkElement<T = unknown> extends HTMLElement {
  value: T;
  open?: boolean;
  addEventListener<K extends keyof UiSdkEventMap>(
    type: K,
    listener: (this: UiSdkElement<T>, event: UiSdkEventMap[K]) => unknown,
    options?: boolean | AddEventListenerOptions,
  ): void;
  addEventListener(
    type: string,
    listener: EventListenerOrEventListenerObject,
    options?: boolean | AddEventListenerOptions,
  ): void;
}

/** What UI SDK's events carry in `event.detail`; they don't bubble. */
export interface UiSdkChangeDetail<T = unknown> {
  readonly value: T;
  readonly reason: string;
}

/** The events a UI SDK root fires, beside every element's own. */
export interface UiSdkEventMap extends HTMLElementEventMap {
  valuechange: CustomEvent<UiSdkChangeDetail>;
  openchange: CustomEvent<UiSdkChangeDetail<boolean>>;
  /** A `<ui-menu>` item was chosen; `detail.value` is its `value`. */
  action: CustomEvent<{ readonly value: string }>;
}

declare global {
  interface HTMLElementTagNameMap {
    "ui-select": UiSdkElement<string | string[] | null>;
    "ui-combobox": UiSdkElement<string | string[] | null>;
    "ui-autocomplete": UiSdkElement<string>;
    "ui-tabs": UiSdkElement<string | null>;
    "ui-accordion": UiSdkElement<string[]>;
    "ui-date-picker": UiSdkElement<string | null>;
    "ui-slider": UiSdkElement<number | number[]>;
    "ui-switch": UiSdkElement<boolean>;
    "ui-checkbox": UiSdkElement<boolean>;
    "ui-radio-group": UiSdkElement<string | null>;
    "ui-segmented-control": UiSdkElement<string | null>;
    "ui-dialog": UiSdkElement<boolean>;
    "ui-alert-dialog": UiSdkElement<boolean>;
    "ui-popover": UiSdkElement<boolean>;
    "ui-menu": UiSdkElement<boolean>;
    "ui-tooltip": UiSdkElement<boolean>;
  }
}

declare global {
  interface HTMLElementTagNameMap {
    "dx-button": DxButtonElement;
    "dx-chip": HTMLElement;
    "dx-icon": HTMLElement;
    "dx-spinner": HTMLElement;
    "dx-card": HTMLElement;
    "dx-stat": HTMLElement;
    "dx-list": HTMLElement;
    "dx-list-item": HTMLElement;
    "dx-table": DxTableElement;
    "dx-input": DxFieldElement;
    "dx-textarea": DxFieldElement;
    "dx-select": DxFieldElement;
    "dx-checkbox": DxToggleElement;
    "dx-switch": DxToggleElement;
    "dx-tabs": DxTabsElement;
    "dx-tab": HTMLElement;
    "dx-empty": HTMLElement;
    "dx-code": DxCodeElement;
    "dx-player": DxPlayerElement;
  }
  interface HTMLElementEventMap {
    "row-click": CustomEvent<{ readonly row: unknown; readonly index: number }>;
  }
  interface Window {
    dx?: { ui?: DxPluginUi } & Record<string, unknown>;
  }
}
