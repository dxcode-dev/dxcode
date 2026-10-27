/**
 * Markdown galleries: consecutive Markdown images in a message, grouped at
 * parse time and rendered by `MarkdownMediaGallery` (`markdown-media.tsx`).
 */
interface MarkdownNode {
  type: string;
  value?: string;
  url?: string;
  alt?: string | null;
  title?: string | null;
  children?: MarkdownNode[];
  data?: Record<string, unknown>;
}

/** A Markdown image a gallery shows: its source as written, and its text. */
export interface GalleryItem {
  readonly src: string;
  readonly alt: string;
  readonly title: string;
}

const isMediaParagraph = (node: MarkdownNode) =>
  node.type === "paragraph" &&
  node.children !== undefined &&
  node.children.some((child) => child.type === "image") &&
  node.children.every(
    (child) =>
      child.type === "image" ||
      child.type === "break" ||
      (child.type === "text" && (child.value ?? "").trim() === ""),
  );

/**
 * Groups consecutive paragraphs that hold nothing but Markdown images into
 * one `dx-media-gallery` element when they hold two or more, carrying the
 * images in `data-items`. The paragraphs stay its children, so a gallery
 * whose items are not all viewable media renders them unchanged.
 */
export const remarkMediaGalleries = () => (tree: MarkdownNode) => {
  const visit = (node: MarkdownNode) => {
    if (node.children === undefined) return;
    const children: MarkdownNode[] = [];
    let run: MarkdownNode[] = [];
    const flush = () => {
      const images = run.flatMap(
        (paragraph) =>
          paragraph.children?.filter((child) => child.type === "image") ?? [],
      );
      if (images.length >= 2)
        children.push({
          type: "mediaGallery",
          data: {
            hName: "dx-media-gallery",
            hProperties: {
              dataItems: JSON.stringify(
                images.map(
                  (image): GalleryItem => ({
                    src: image.url ?? "",
                    alt: image.alt ?? "",
                    title: image.title ?? "",
                  }),
                ),
              ),
            },
          },
          children: run,
        });
      else children.push(...run);
      run = [];
    };
    for (const child of node.children) {
      if (isMediaParagraph(child)) {
        run.push(child);
        continue;
      }
      flush();
      visit(child);
      children.push(child);
    }
    flush();
    node.children = children;
  };
  visit(tree);
};

/** The items a gallery element carries; anything malformed is none. */
export const galleryItems = (value: unknown): ReadonlyArray<GalleryItem> => {
  try {
    const parsed: unknown = typeof value === "string" ? JSON.parse(value) : [];
    if (!Array.isArray(parsed)) return [];
    return parsed.flatMap((item: unknown): GalleryItem[] =>
      typeof item === "object" &&
      item !== null &&
      "src" in item &&
      "alt" in item &&
      "title" in item &&
      typeof item.src === "string" &&
      typeof item.alt === "string" &&
      typeof item.title === "string"
        ? [{ src: item.src, alt: item.alt, title: item.title }]
        : [],
    );
  } catch {
    return [];
  }
};
