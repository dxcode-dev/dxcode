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

- `systemd` — E2B boots the image's init; Core installs the `dxd` unit once
  via `sudo systemctl`.
- `ripgrep`, `jq` — workspace tooling.
- `ca-certificates` — dxd calls back to the Worker over TLS and downloads its
  own releases.

The image also carries the static login hook `/etc/profile.d/dx-terminal.sh`
([`dx-terminal-stub.sh`](../../apps/dxd/assets/dx-terminal-stub.sh)). It only
sources the shell profile dxd writes in `~/.local/state/dx-terminal/`, so dxd
updates never need a template rebuild or root access to change it.

dxd owns the terminal PTY and captures Changes natively, and Core reads
workspace context with bash and coreutils, so neither `tmux` nor `python3` is
required any more. The build fails if any
binary the bootstrap installer uses is missing (`systemctl`, `sudo`, `curl`,
`sha256sum`, `install`, `cmp`, `git`, `bash`). Locking is handled inside the
installer script (`mkdir`-based), so no `flock` is needed.

## Verify a built template

Spawn a throwaway sandbox and check the surface dxd needs:

```bash
e2b sbx spawn dx-workspace
```

Then inside the sandbox: `sudo systemctl is-system-running` (the `user`
account has no systemd bus) should report
`running` or `degraded`, and the binaries above should resolve.
