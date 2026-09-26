import { createServer } from "node:net";

export const LOCAL_DEV_HOST = "127.0.0.1";

const hostPortAvailable = (port, host) =>
  new Promise((resolveAvailability) => {
    const server = createServer();
    server.once("error", () => resolveAvailability(false));
    server.listen(port, host, () =>
      server.close(() => resolveAvailability(true)),
    );
  });

const worktreeSlot = (workspaceRoot) => {
  let hash = 2_166_136_261;
  for (const character of workspaceRoot) {
    hash ^= character.codePointAt(0);
    hash = Math.imul(hash, 16_777_619);
  }
  return (hash >>> 0) % 900;
};

export const selectLocalDevPorts = async (
  workspaceRoot,
  mainWorktree,
  available = hostPortAvailable,
) => {
  const portAvailable = (port) => available(port, LOCAL_DEV_HOST);
  if (
    mainWorktree &&
    (await portAvailable(3000)) &&
    (await portAvailable(5173)) &&
    (await portAvailable(5175))
  )
    return { web: 3000, core: 5173, localRuntime: 5175 };

  const initialSlot = worktreeSlot(workspaceRoot);
  for (let offset = 0; offset < 900; offset += 1) {
    const slot = (initialSlot + offset) % 900;
    const ports = {
      web: 3100 + slot,
      core: 5100 + slot,
      localRuntime: 8100 + slot,
    };
    if (
      (await portAvailable(ports.web)) &&
      (await portAvailable(ports.core)) &&
      (await portAvailable(ports.localRuntime))
    )
      return ports;
  }
  throw new Error("No free local dx development port set is available.");
};
