# dx workspace template (E2B)

dx threads run inside E2B sandboxes. This recipe builds the template that
`deploy.selfhost.json` needs as `e2bTemplate`.

## Requirements

- An E2B account and `E2B_API_KEY` (https://e2b.dev).
- Node 22+ and `pnpm install` already run in this repo (the `e2b` package is
  a workspace dependency).

## Build

```bash
E2B_API_KEY=<your key> pnpm deploy:selfhost:template
# or with a custom name:
E2B_API_KEY=<your key> node deploy/e2b/build.mjs my-dx-workspace
```

The script prints the template name and immutable build id. Put the name in
`deploy.selfhost.json`:

```json
{ "e2bTemplate": "dx-workspace" }
```

`pnpm deploy:selfhost` verifies the template exists with a ready immutable
build before touching any Cloudflare resource.

## What the image contains

Base: E2B `base` (Debian; Python 3, Node.js, git, curl, build-essential,
GitHub CLI, passwordless `sudo` for `user`). Added packages:

- `systemd` — E2B boots the image's init; `dxd` installs a systemd unit via
  `sudo systemctl`.
- `tmux` — resident terminal sessions (`dxd` terminal manager).
- `ripgrep`, `jq` — workspace tooling.
- `ca-certificates` — dxd calls back to the Worker over TLS.

The build fails if any binary required by the daemon installer is missing
(`systemctl`, `sudo`, `curl`, `sha256sum`, `install`, `cmp`, `tmux`, `git`,
`python3`, `bash`). Locking is handled inside the shipped Node harness and
installer script (`mkdir`-based), so no `flock` is needed.

## Verify a built template

Spawn a throwaway sandbox and check the surface dxd needs:

```bash
e2b sbx spawn dx-workspace
```

Then inside the sandbox: `systemctl is-system-running` should report
`running` or `degraded`, and the binaries above should resolve.
