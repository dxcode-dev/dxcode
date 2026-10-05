# dx workspace template (E2B)

dx threads run inside E2B sandboxes. This recipe builds the template that
`deploy.selfhost.json` needs as `e2bTemplate`. The template is the standard
Orb image: E2B builds it from [`deploy/orb/Dockerfile`](../orb/Dockerfile),
the same file every x86 Orb provider uses ([`template.mjs`](template.mjs)).

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
build before touching any Cloudflare resource. Branch previews name an
existing template in `DX_E2B_TEMPLATE` and build only the per-size aliases
from it.

## What the image contains

See [`deploy/orb/README.md`](../orb/README.md): Debian 13 slim, Node.js 24
LTS, OpenJDK 21, Python 3, build tools, git, git-lfs, GitHub CLI, ripgrep,
jq, tmux, and passwordless `sudo` for `user`. E2B parses the Dockerfile into
template steps and provisions its own init (systemd) and `envd` on top.

dxd does not run as a systemd unit. The image entrypoint script
[`dx-orb-init`](../orb/dx-orb-init) supervises it; E2B runs that script as
the template's start command, so the snapshot every sandbox starts from
already has it running. The image carries the login hook
`/etc/profile.d/dx-terminal.sh`
([`dx-terminal-stub.sh`](../../apps/dxd/assets/dx-terminal-stub.sh)) and the
`/usr/local/bin/dxd` link, so Core's installer needs no root on it. Sandboxes
created from templates built before the standard image keep the systemd
unit the installer wrote for them.

## Verify a built template

Spawn a throwaway sandbox and check the surface dxd needs:

```bash
e2b sbx spawn dx-workspace
```

Inside the sandbox, `ps -eo user,args | grep dx-orb-init` shows the
entrypoint running as `user`, `~/.local/state/dxd/supervisor.pid` exists, and
`node`, `java`, `python3`, `gh`, `git lfs`, `rg`, and `jq` resolve.
