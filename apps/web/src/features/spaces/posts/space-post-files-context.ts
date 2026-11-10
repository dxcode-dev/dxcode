import * as React from "react";
import type { MessageFilesSlot } from "../../../shared/composer/composer-slot.js";

const nothing = () => null;

/**
 * The Thread transcript's file views for the Space's posts, from the Space
 * page; without them, posts show their words only.
 */
export const SpacePostFilesContext = React.createContext<MessageFilesSlot>({
  Images: nothing,
  Links: nothing,
});
