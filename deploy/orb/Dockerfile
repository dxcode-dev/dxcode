# dx Orb image: the standard workspace for every x86 Orb provider (E2B today,
# Cloudflare Containers next). See deploy/orb/README.md.
#
#   docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
#
# The build context is the repository root; Dockerfile.dockerignore admits
# only the two files copied below. E2B builds its template from this same
# file (deploy/e2b/template.mjs), so keep to the instructions its parser
# supports: one FROM, RUN, COPY, ENV, WORKDIR, USER, ENTRYPOINT. Write each
# RUN as one line: the parser rejoins words with single spaces.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git git-lfs openssh-client gnupg sudo tini procps psmisc less file unzip zip xz-utils bzip2 zstd ripgrep jq tmux nano build-essential pkg-config libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev liblzma-dev libreadline-dev python3 python3-dev python3-pip python3-venv python-is-python3 default-jdk-headless && rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's own repository: Debian's gh is older than the
# version Core's source runtime requires (source-tool-requirements.ts).
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && test "$(sha256sum /usr/share/keyrings/githubcli-archive-keyring.gpg | cut -d " " -f 1)" = 6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b && chmod 0644 /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# Node.js, current LTS, from nodejs.org with its published checksum; corepack
# provides yarn and pnpm.
RUN curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz && test "$(sha256sum /tmp/node.tar.xz | cut -d " " -f 1)" = fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner --exclude CHANGELOG.md --exclude README.md --exclude LICENSE && rm /tmp/node.tar.xz && corepack enable && node --version && npm --version

# The workspace account, as on E2B: passwordless sudo, home /home/user. E2B
# provisions `user` itself before these steps run.
RUN if ! id -u user >/dev/null 2>&1; then useradd --create-home --shell /bin/bash --uid 1000 --user-group user; fi && echo "user ALL=(ALL:ALL) NOPASSWD: ALL" >/etc/sudoers.d/user && chmod 0440 /etc/sudoers.d/user

# dxd. Core installs and updates the binary under the user's state directory;
# the image only carries the root-owned pieces, so no install needs root:
# the static login hook that sources the shell profile dxd writes, the
# /usr/local/bin/dxd link, and the entrypoint that runs dxd.
COPY apps/dxd/assets/dx-terminal-stub.sh /etc/profile.d/dx-terminal.sh
COPY deploy/orb/dx-orb-init /usr/local/bin/dx-orb-init
COPY deploy/orb/dx-orb-hostname.sh /etc/profile.d/dx-orb-hostname.sh
RUN chown root:root /etc/profile.d/dx-terminal.sh /etc/profile.d/dx-orb-hostname.sh /usr/local/bin/dx-orb-init && chmod 0644 /etc/profile.d/dx-terminal.sh /etc/profile.d/dx-orb-hostname.sh && chmod 0755 /usr/local/bin/dx-orb-init && ln -sfn /home/user/.local/state/dxd/bin/dxd /usr/local/bin/dxd

# Every binary Core's daemon installer and source runtime invoke.
RUN for bin in sudo curl sha256sum install cmp git git-lfs gh bash setpriv setsid readlink tini rg jq node java python3; do command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }; done

USER user
WORKDIR /home/user
ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dx-orb-init"]
