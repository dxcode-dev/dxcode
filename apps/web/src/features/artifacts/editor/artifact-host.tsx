import * as React from "react";

/**
 * Where an artifact is open, and so what it can reach besides its readers.
 * Inside a Thread or Space everything is there. A standalone artifact has
 * no Thread, so no agent and no Thread folders, and the library page has
 * no Thread composer, so the editor hides what would go nowhere there.
 */
export interface ArtifactHost {
  /**
   * The artifact's Thread has an agent: Notify agent, Ask @dx, and `@dx`
   * mentions reach it. False for a standalone artifact.
   */
  readonly agent: boolean;
  /** A Thread composer is on the page: Send to Thread quotes into it. */
  readonly composer: boolean;
  /**
   * Its Thread holds other artifacts, so it may go in a folder and Delete
   * removes it for everyone in that Thread.
   */
  readonly inThread: boolean;
  /** After Delete, when the page showed only this artifact. */
  readonly onDeleted?: () => void;
}

const InThread: ArtifactHost = { agent: true, composer: true, inThread: true };

const HostContext = React.createContext<ArtifactHost>(InThread);

/** Sets where the artifacts below are open; by default, in a Thread. */
export const ArtifactHostProvider = HostContext.Provider;

export const useArtifactHost = () => React.use(HostContext);
