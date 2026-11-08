/**
 * dx-orb-check (deploy/orb/toolbelt/dx-orb-check) proves an Orb has every
 * workspace feature dx needs: the account, the tools Core and the agent
 * run, the Terminal's tmux, and the Desktop end to end (frames from the
 * voxl streamer, its screenshot of the display, and a Chromium screenshot). Each
 * provider's preparation runs it on its test Orb, so an Orb missing a
 * feature never reaches a Thread.
 *
 * The command runs it as the workspace account with dxd's environment,
 * whether the provider runs commands as root or as `user`.
 */
export const ORB_CHECK_COMMAND =
  "sudo -n -u user env -i HOME=/home/user USER=user LOGNAME=user SHELL=/bin/bash LANG=C.UTF-8 PATH=/home/user/.local/bin:/usr/local/bin:/usr/bin:/bin /opt/dx/bin/dx-orb-check";

/** The command's time limit: a cold Desktop start plus a few seconds of video. */
export const ORB_CHECK_TIMEOUT_SECONDS = 180;

/**
 * Why the test Orb failed dx-orb-check, from its output and exit code, or
 * undefined when it passed.
 */
export const orbCheckFailure = (output: string, exitCode: number) => {
  if (exitCode === 0) return undefined;
  const failed = [
    ...new Set(
      output
        .split("\n")
        .flatMap((line) => /^FAIL\s+(\S+)/.exec(line)?.slice(1, 2) ?? []),
    ),
  ];
  return failed.length > 0
    ? `The test Orb is missing workspace features: ${failed.join(", ")}.`
    : "The test Orb could not run dx-orb-check.";
};
