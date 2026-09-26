import { createContext } from "react";

/** Historical prototypes remain non-submitting; the production page opts in. */
export const LiveAccessContext = createContext(false);
