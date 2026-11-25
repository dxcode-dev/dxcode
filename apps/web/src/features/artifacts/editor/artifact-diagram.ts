/**
 * A `mermaid` block's diagram in an artifact, drawn outside React like the
 * editor's other node views. It renders through the same Pele store as reply
 * diagrams, in the document's current appearance and palette, and redraws
 * when either changes. Source Pele cannot render shows as text.
 */
import {
  type DiagramPicture,
  type MermaidRender,
  type MermaidTheme,
  mermaidRender,
  requestMermaid,
  subscribeMermaid,
} from "../../../shared/ui/markdown-mermaid.js";

const documentTheme = (): MermaidTheme => {
  const { resolvedAppearance, palette } = document.documentElement.dataset;
  return {
    appearance: resolvedAppearance === "light" ? "light" : "dark",
    palette: palette ?? "daydream",
  };
};

const picture = (
  { src, width, height }: DiagramPicture,
  className: string,
  label: string,
) => {
  const image = document.createElement("img");
  image.className = className;
  image.src = src;
  image.alt = label;
  image.width = width;
  image.height = height;
  image.draggable = false;
  return image;
};

const draw = (container: HTMLElement, source: string, image: MermaidRender) => {
  if (image === undefined) return;
  if (image === null) {
    const fallback = document.createElement("pre");
    fallback.className = "artifact-view-fallback";
    fallback.textContent = source.trim() === "" ? "Empty diagram" : source;
    container.replaceChildren(fallback);
    return;
  }
  const frame = document.createElement("div");
  frame.className = "artifact-diagram diagram-frame";
  frame.dataset.diagramLabel = image.label;
  frame.append(picture(image, "diagram-wide", image.label));
  if (image.narrow)
    frame.append(picture(image.narrow, "diagram-narrow", image.label));
  container.replaceChildren(frame);
};

export const showDiagram = (container: HTMLElement, initial: string) => {
  let source = initial;
  let shown: MermaidRender;
  const paint = () => {
    const theme = documentTheme();
    if (source.trim() === "") {
      shown = null;
      draw(container, source, null);
      return;
    }
    requestMermaid(source, theme);
    const image = mermaidRender(source, theme);
    if (image === shown) return;
    shown = image;
    draw(container, source, image);
  };
  const unsubscribe = subscribeMermaid(paint);
  const themeChanges = new MutationObserver(paint);
  themeChanges.observe(document.documentElement, {
    attributes: true,
    attributeFilter: ["data-resolved-appearance", "data-palette"],
  });
  paint();
  return {
    update: (next: string) => {
      source = next;
      paint();
    },
    remove: () => {
      unsubscribe();
      themeChanges.disconnect();
    },
  };
};
