import { huddleView } from "./huddle-session.js";

type DocumentPictureInPicture = {
  requestWindow(options?: { width?: number; height?: number }): Promise<Window>;
};

const documentPip = () =>
  (globalThis as { documentPictureInPicture?: DocumentPictureInPicture })
    .documentPictureInPicture;

/** Chrome and Edge can float a small window above every tab and app. */
export const canPopOut = () => documentPip() !== undefined;

/**
 * Opens the browser's Picture-in-Picture window and hands it to the Huddle
 * layer, which renders the dock there. Closing it returns the dock to dx.
 */
export const popOutHuddle = async () => {
  const pip = documentPip();
  if (pip === undefined) return;
  const popout = await pip.requestWindow({ width: 340, height: 260 });
  for (const sheet of document.styleSheets) {
    const owner = sheet.ownerNode;
    if (owner instanceof HTMLElement)
      popout.document.head.append(owner.cloneNode(true));
  }
  for (const attribute of document.documentElement.attributes)
    popout.document.documentElement.setAttribute(
      attribute.name,
      attribute.value,
    );
  popout.document.body.className = "huddle-popout-body";
  popout.addEventListener("pagehide", () => huddleView.setPopout(undefined), {
    once: true,
  });
  huddleView.setPopout(popout);
};
