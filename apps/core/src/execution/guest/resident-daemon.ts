import { env } from "cloudflare:workers";
import type { Bindings } from "../../http/types.js";
import type {
  ExecutionResidentDaemonProvider,
  ExecutionWorkspaceHandle,
} from "../../plugins/execution/provider.js";
import { atDaemonInstallationStage } from "../activation.js";
import { type DaemonGuest, ensureDaemonInGuest } from "./daemon-installer.js";
import {
  loadDaemonRelease,
  loadDaemonReleaseMetadata,
} from "./daemon-release.js";

/** A workspace whose raw guest runs the daemon installer's commands. */
export interface DaemonGuestHandle extends ExecutionWorkspaceHandle {
  readonly guest: ExecutionWorkspaceHandle["guest"] & DaemonGuest;
}

/**
 * `execution.resident-daemon` for a guest that boots the standard Orb
 * (deploy/orb): the guest installer puts dxd in place and `dx-orb-init`
 * supervises it, so the bootstrap needs no root and no provider API beyond
 * commands and file writes. Every provider whose guest runs the Orb can
 * use it as is.
 */
export const guestResidentDaemon = <
  Handle extends DaemonGuestHandle,
>(): ExecutionResidentDaemonProvider<Handle> => ({
  async install(_context, handle, input) {
    const bindings = env as Bindings;
    const release = await atDaemonInstallationStage(
      "release",
      loadDaemonReleaseMetadata(bindings),
    );
    let releaseLoadedAt: number | undefined;
    const guest = await ensureDaemonInGuest(handle.guest, {
      threadId: input.threadId,
      endpoint: input.endpoint,
      sha256: release.sha256,
      releaseUrl: release.url,
      credential: input.credential,
      mintCredential: input.mintCredential,
      loadBinary: async () => {
        const loaded = await atDaemonInstallationStage(
          "release",
          loadDaemonRelease(bindings),
        );
        releaseLoadedAt = Date.now();
        return loaded.binary;
      },
      ...(input.signal === undefined ? {} : { signal: input.signal }),
    });
    return {
      guest,
      ...(releaseLoadedAt === undefined ? {} : { releaseLoadedAt }),
    };
  },
});
