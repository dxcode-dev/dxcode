/**
 * How chips and `dx-view` blocks look in the editor. A chip is one inline
 * atom; clicking it asks the editor to open its picker. A toggle shows or
 * hides its tagged chips for this reader only (never saved). A `dx-view`
 * block shows its view, with its HTML source one click away.
 */
import type { Node } from "prosemirror-model";
import { Plugin, PluginKey, Selection, TextSelection } from "prosemirror-state";
import {
  Decoration,
  DecorationSet,
  type EditorProps,
  type EditorView,
  type NodeView,
} from "prosemirror-view";

export type NodeViews = NonNullable<EditorProps["nodeViews"]>;

import {
  type Chip,
  chipTag,
  hiddenChipTags,
  parseChip,
} from "../markdown/chips.js";

/** What the chip and view node views ask of the editor around them. */
export interface ChipViewHost {
  /** A chip was clicked: open its picker (or flip it, for a toggle). */
  readonly onChip: (pos: number, chip: Chip) => void;
  /** Sets an image's alt text. */
  readonly setImageAlt: (pos: number, alt: string) => void;
  /** Shows a `dx-view` block's HTML in `container`; returns its updater. */
  readonly showView: (
    container: HTMLElement,
    source: string,
  ) => {
    readonly update: (source: string) => void;
    readonly remove: () => void;
  };
}

const dateFormat = new Intl.DateTimeFormat(undefined, { dateStyle: "medium" });
const timeFormat = new Intl.DateTimeFormat(undefined, {
  dateStyle: "medium",
  timeStyle: "short",
});

/** A chip's text on screen; times read in the reader's time zone. */
export const chipLabel = (chip: Chip): string => {
  switch (chip.kind) {
    case "date": {
      const [year, month, day] = chip.date.split("-").map(Number);
      return dateFormat.format(new Date(year ?? 0, (month ?? 1) - 1, day ?? 1));
    }
    case "time":
      return timeFormat.format(new Date(chip.instant));
    case "dropdown":
      return chip.options.find((option) => option.selected)?.label ?? "Select";
    case "toggle":
      return chip.label;
    case "mention":
    case "agent":
      return `@${chip.name}`;
  }
};

class ChipView implements NodeView {
  dom: HTMLElement;

  constructor(
    node: Node,
    private readonly getPos: () => number | undefined,
    private readonly host: ChipViewHost,
  ) {
    this.dom = document.createElement("span");
    this.dom.addEventListener("mousedown", (event) => event.preventDefault());
    this.dom.addEventListener("click", (event) => {
      event.preventDefault();
      const position = this.getPos();
      const chip = parseChip(String(this.dom.dataset.source));
      if (position !== undefined && chip !== undefined)
        this.host.onChip(position, chip);
    });
    this.#show(node);
  }

  #show(node: Node) {
    const source = String(node.attrs.source);
    const chip = parseChip(source);
    // Decorations add classes (hidden by a toggle); keep them.
    this.dom.classList.add("artifact-chip");
    this.dom.dataset.source = source;
    this.dom.dataset.kind = chip?.kind ?? "text";
    this.dom.setAttribute("role", "button");
    this.dom.tabIndex = -1;
    const color =
      chip?.kind === "dropdown"
        ? chip.options.find((option) => option.selected)?.color
        : undefined;
    if (color === undefined) delete this.dom.dataset.color;
    else this.dom.dataset.color = color;
    this.dom.textContent = chip === undefined ? source : chipLabel(chip);
    this.dom.title = chip?.kind === "time" ? chip.instant : "";
  }

  update(node: Node) {
    if (node.type.name !== "chip") return false;
    this.#show(node);
    return true;
  }

  ignoreMutation() {
    return true;
  }
}

/** A `dx-view` block: the view, and its source under Edit Source. */
class ViewBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;
  #shown: ReturnType<ChipViewHost["showView"]>;
  #source: HTMLElement;

  constructor(
    node: Node,
    view: EditorView,
    getPos: () => number | undefined,
    host: ChipViewHost,
  ) {
    this.dom = document.createElement("div");
    this.dom.className = "artifact-view-block";
    const bar = document.createElement("div");
    bar.className = "artifact-view-bar";
    bar.contentEditable = "false";
    const label = document.createElement("span");
    label.textContent = "View";
    const toggle = document.createElement("button");
    toggle.type = "button";
    toggle.className = "artifact-view-toggle";
    toggle.textContent = "Edit Source";
    toggle.addEventListener("mousedown", (event) => event.preventDefault());
    toggle.addEventListener("click", () => {
      const editing = this.dom.dataset.editing !== "true";
      this.dom.dataset.editing = String(editing);
      toggle.textContent = editing ? "Show View" : "Edit Source";
      // Edit Source puts the cursor at the end of the source.
      const position = getPos();
      const current =
        position === undefined ? null : view.state.doc.nodeAt(position);
      if (position === undefined || current === null) return;
      // Show View moves the cursor out of the source it hides.
      const tr = view.state.tr;
      view.dispatch(
        tr.setSelection(
          editing
            ? TextSelection.create(tr.doc, position + current.nodeSize - 1)
            : Selection.near(tr.doc.resolve(position + current.nodeSize)),
        ),
      );
      view.focus();
    });
    bar.append(label, toggle);
    const preview = document.createElement("div");
    preview.className = "artifact-view-preview";
    preview.contentEditable = "false";
    this.#source = document.createElement("pre");
    this.#source.className = "artifact-view-source";
    this.contentDOM = document.createElement("code");
    this.#source.append(this.contentDOM);
    this.dom.append(bar, preview, this.#source);
    this.#shown = host.showView(preview, node.textContent);
  }

  update(node: Node) {
    if (node.type.name !== "code_block" || node.attrs.params !== "dx-view")
      return false;
    this.#shown.update(node.textContent);
    return true;
  }

  ignoreMutation(mutation: MutationRecord | { type: "selection" }) {
    if (mutation.type === "selection") return false;
    return !this.#source.contains(mutation.target as globalThis.Node);
  }

  stopEvent(event: Event) {
    return !this.#source.contains(event.target as globalThis.Node);
  }

  destroy() {
    this.#shown.remove();
  }
}

/** A plain code block, with its language shown. */
class CodeBlockView implements NodeView {
  dom: HTMLElement;
  contentDOM: HTMLElement;

  constructor(node: Node) {
    this.dom = document.createElement("pre");
    if (node.attrs.params)
      this.dom.dataset.language = String(node.attrs.params);
    this.contentDOM = document.createElement("code");
    this.dom.append(this.contentDOM);
  }

  update(node: Node) {
    return (
      node.type.name === "code_block" &&
      node.attrs.params !== "dx-view" &&
      (this.dom.dataset.language ?? "") === String(node.attrs.params ?? "")
    );
  }
}

/**
 * An image, as wide as the page at most. Selected, it offers Open image (a
 * phone taps it to see it full size) and Alt text.
 */
class ImageView implements NodeView {
  readonly dom: HTMLElement;
  readonly #image: HTMLImageElement;
  readonly #tools: HTMLElement;
  readonly #open: HTMLAnchorElement;
  #node: Node;

  constructor(
    node: Node,
    view: EditorView,
    readonly getPos: () => number | undefined,
    readonly host: ChipViewHost,
  ) {
    this.#node = node;
    this.dom = document.createElement("span");
    this.dom.className = "artifact-image";
    this.#image = document.createElement("img");
    this.#image.draggable = false;
    this.#tools = document.createElement("span");
    this.#tools.className = "artifact-image-tools";
    this.#tools.contentEditable = "false";
    this.#open = document.createElement("a");
    this.#open.className = "artifact-tool";
    this.#open.target = "_blank";
    this.#open.rel = "noopener noreferrer";
    this.#open.textContent = "Open";
    this.#open.setAttribute("aria-label", "Open image");
    const alt = document.createElement("button");
    alt.type = "button";
    alt.className = "artifact-tool";
    alt.textContent = "Alt text";
    alt.setAttribute("aria-label", "Alt text");
    alt.addEventListener("mousedown", (event) => event.preventDefault());
    alt.addEventListener("click", () => this.#editAlt());
    this.#tools.append(this.#open, ...(view.editable ? [alt] : []));
    this.dom.append(this.#image, this.#tools);
    // A reader taps the image itself to see it full size.
    if (!view.editable)
      this.#image.addEventListener("click", () =>
        window.open(String(this.#node.attrs.src), "_blank", "noopener"),
      );
    this.#render();
  }

  #render() {
    const { src, alt, title } = this.#node.attrs;
    this.#image.src = String(src);
    this.#image.alt = String(alt ?? "");
    if (title === null) this.#image.removeAttribute("title");
    else this.#image.title = String(title);
    this.#open.href = String(src);
  }

  #editAlt() {
    const field = document.createElement("input");
    field.className = "artifact-image-alt";
    field.setAttribute("aria-label", "Alt text");
    field.value = String(this.#node.attrs.alt ?? "");
    let finished = false;
    const done = (apply: boolean) => {
      // Removing the field blurs it, which comes back here.
      if (finished) return;
      finished = true;
      const pos = this.getPos();
      field.remove();
      if (apply && pos !== undefined) this.host.setImageAlt(pos, field.value);
    };
    field.addEventListener("keydown", (event) => {
      if (event.key === "Enter") {
        event.preventDefault();
        done(true);
      } else if (event.key === "Escape") {
        event.preventDefault();
        done(false);
      }
    });
    field.addEventListener("blur", () => {
      if (field.isConnected) done(true);
    });
    this.#tools.append(field);
    field.focus();
    field.select();
  }

  selectNode() {
    this.dom.classList.add("ProseMirror-selectednode");
  }

  deselectNode() {
    this.dom.classList.remove("ProseMirror-selectednode");
  }

  update(node: Node) {
    if (node.type !== this.#node.type) return false;
    this.#node = node;
    this.#render();
    return true;
  }

  stopEvent(event: Event) {
    return (
      event.target instanceof globalThis.Node &&
      this.#tools.contains(event.target)
    );
  }

  ignoreMutation() {
    return true;
  }
}

export const chipNodeViews = (host: ChipViewHost): NodeViews => ({
  image: (node: Node, view: EditorView, getPos: () => number | undefined) =>
    new ImageView(node, view, getPos, host),
  chip: (node: Node, _view: EditorView, getPos: () => number | undefined) =>
    new ChipView(node, getPos, host),
  code_block: (
    node: Node,
    view: EditorView,
    getPos: () => number | undefined,
  ) =>
    node.attrs.params === "dx-view"
      ? new ViewBlockView(node, view, getPos, host)
      : new CodeBlockView(node),
});

// ---------------------------------------------------------------------------
// Toggles: which keys this reader turned on.

export const chipTogglesKey = new PluginKey<ReadonlySet<string>>(
  "artifactChipToggles",
);

export const chipToggles = new Plugin<ReadonlySet<string>>({
  key: chipTogglesKey,
  state: {
    init: () => new Set(),
    apply: (tr, shown) => {
      const key = tr.getMeta(chipTogglesKey) as string | undefined;
      if (key === undefined) return shown;
      const next = new Set(shown);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    },
  },
  props: {
    decorations: (state) => {
      const shown = chipTogglesKey.getState(state) ?? new Set<string>();
      const chips: Array<{ node: Node; pos: number }> = [];
      state.doc.descendants((node, pos) => {
        if (node.type.name === "chip") chips.push({ node, pos });
      });
      if (chips.length === 0) return DecorationSet.empty;
      const hidden = hiddenChipTags(
        chips.map(({ node }) => String(node.attrs.source)),
        shown,
      );
      const decorations: Decoration[] = [];
      for (const { node, pos } of chips) {
        const chip = parseChip(String(node.attrs.source));
        if (chip === undefined) continue;
        const tag = chipTag(chip);
        if (tag !== undefined && hidden.has(tag))
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              class: "artifact-chip-hidden",
            }),
          );
        if (chip.kind === "toggle")
          decorations.push(
            Decoration.node(pos, pos + node.nodeSize, {
              "aria-pressed": String(shown.has(chip.key)),
            }),
          );
      }
      return DecorationSet.create(state.doc, decorations);
    },
  },
});
