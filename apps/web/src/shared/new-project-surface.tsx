import type { ProjectId } from "@dx/domain";
import * as React from "react";

export interface NewProjectSurfaceProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** After the project is created; the dialog has closed. */
  readonly onCreated: (project: { readonly id: ProjectId }) => void;
}

/**
 * The New Project dialog, for features outside Projects to open: the
 * application root provides it. Absent where no root provides it, such as a
 * component mounted on its own in a test.
 */
export const NewProjectSurfaceContext = React.createContext<
  React.ComponentType<NewProjectSurfaceProps> | undefined
>(undefined);

export function useNewProjectSurface() {
  return React.useContext(NewProjectSurfaceContext);
}
