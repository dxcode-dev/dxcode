/**
 * Images on their way to the Thread: one placeholder each where the image
 * will go, with its progress, or why it failed and Retry or Remove. A
 * placeholder is a decoration, not document content, so nothing saves it
 * and editing goes on around it; its place follows every edit.
 */
import { type EditorState, Plugin, PluginKey } from "prosemirror-state";
import { Decoration, DecorationSet } from "prosemirror-view";

export interface ImageUpload {
  readonly id: string;
  readonly name: string;
  /** Where the image goes: a new block there, or inline in a table cell. */
  readonly pos: number;
  readonly inline: boolean;
  readonly status:
    | { readonly kind: "uploading"; readonly share: number }
    | { readonly kind: "failed"; readonly message: string };
}

type UploadMeta = { readonly put: ImageUpload } | { readonly remove: string };

export const imageUploadsKey = new PluginKey<ReadonlyArray<ImageUpload>>(
  "artifactImageUploads",
);

export interface ImageUploadHost {
  readonly retry: (id: string) => void;
  readonly remove: (id: string) => void;
}

export const imageUploads = (state: EditorState) =>
  imageUploadsKey.getState(state) ?? [];

const placeholder = (upload: ImageUpload, host: ImageUploadHost) => {
  const box = document.createElement(upload.inline ? "span" : "div");
  box.className = "artifact-image-upload";
  box.dataset.state = upload.status.kind;
  box.contentEditable = "false";
  const label = document.createElement("span");
  label.className = "artifact-image-upload-label";
  box.append(label);
  if (upload.status.kind === "uploading") {
    const percent = Math.round(upload.status.share * 100);
    label.textContent = `Uploading ${upload.name}`;
    const bar = document.createElement("span");
    bar.className = "artifact-image-upload-bar";
    bar.setAttribute("role", "progressbar");
    bar.setAttribute("aria-label", `Uploading ${upload.name}`);
    bar.setAttribute("aria-valuemin", "0");
    bar.setAttribute("aria-valuemax", "100");
    bar.setAttribute("aria-valuenow", String(percent));
    bar.style.setProperty("--share", `${percent}%`);
    box.append(bar);
    return box;
  }
  label.textContent = `${upload.name}: ${upload.status.message}`;
  const actions = document.createElement("span");
  actions.className = "artifact-image-upload-actions";
  for (const [text, run] of [
    ["Retry", host.retry],
    ["Remove", host.remove],
  ] as const) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "artifact-tool";
    button.textContent = text;
    button.addEventListener("mousedown", (event) => event.preventDefault());
    button.addEventListener("click", () => run(upload.id));
    actions.append(button);
  }
  box.append(actions);
  return box;
};

export const imageUploadsPlugin = (host: ImageUploadHost) =>
  new Plugin<ReadonlyArray<ImageUpload>>({
    key: imageUploadsKey,
    state: {
      init: () => [],
      apply: (tr, uploads) => {
        let next = tr.docChanged
          ? uploads.map((upload) => ({
              ...upload,
              pos: tr.mapping.map(upload.pos, upload.inline ? 1 : -1),
            }))
          : uploads;
        const meta = tr.getMeta(imageUploadsKey) as UploadMeta | undefined;
        if (meta !== undefined && "put" in meta)
          next = [
            ...next.filter((upload) => upload.id !== meta.put.id),
            meta.put,
          ];
        if (meta !== undefined && "remove" in meta)
          next = next.filter((upload) => upload.id !== meta.remove);
        return next;
      },
    },
    props: {
      decorations: (state) => {
        const uploads = imageUploads(state);
        if (uploads.length === 0) return null;
        return DecorationSet.create(
          state.doc,
          uploads.map((upload) =>
            Decoration.widget(upload.pos, () => placeholder(upload, host), {
              key: `${upload.id}:${JSON.stringify(upload.status)}`,
              side: upload.inline ? 1 : -1,
              stopEvent: () => true,
              ignoreSelection: true,
            }),
          ),
        );
      },
    },
  });

/** Records or updates an upload's placeholder. */
export const putUpload = (state: EditorState, upload: ImageUpload) =>
  state.tr
    .setMeta(imageUploadsKey, { put: upload })
    .setMeta("addToHistory", false);

/** Takes an upload's placeholder away. */
export const removeUpload = (state: EditorState, id: string) =>
  state.tr
    .setMeta(imageUploadsKey, { remove: id })
    .setMeta("addToHistory", false);
