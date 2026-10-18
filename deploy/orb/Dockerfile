# dx Orb image: the standard workspace for every x86 Orb provider (E2B today,
# Cloudflare Containers next). See deploy/orb/README.md.
#
#   docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
#
# The build context is the repository root; Dockerfile.dockerignore admits
# only the files copied below. E2B builds its template from this same
# file (deploy/e2b/template.mjs), so keep to the instructions its parser
# supports: one FROM, RUN, COPY, ENV, WORKDIR, USER, ENTRYPOINT. Write each
# RUN as one line: the parser rejoins words with single spaces.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN export DEBIAN_FRONTEND=noninteractive && apt-get update && apt-get install -y --no-install-recommends ca-certificates curl wget git git-lfs openssh-client gnupg sudo tini procps psmisc less file unzip zip xz-utils bzip2 zstd ripgrep jq nano build-essential pkg-config libssl-dev zlib1g-dev libffi-dev libsqlite3-dev libbz2-dev liblzma-dev libreadline-dev python3 python3-dev python3-pip python3-venv python-is-python3 default-jdk-headless && rm -rf /var/lib/apt/lists/*

# GitHub CLI from GitHub's own repository: Debian's gh is older than the
# version Core's source runtime requires (source-tool-requirements.ts).
RUN curl -fsSL -o /usr/share/keyrings/githubcli-archive-keyring.gpg https://cli.github.com/packages/githubcli-archive-keyring.gpg && test "$(sha256sum /usr/share/keyrings/githubcli-archive-keyring.gpg | cut -d " " -f 1)" = 6084d5d7bd8e288441e0e94fc6275570895da18e6751f70f057485dc2d1a811b && chmod 0644 /usr/share/keyrings/githubcli-archive-keyring.gpg && echo "deb [arch=amd64 signed-by=/usr/share/keyrings/githubcli-archive-keyring.gpg] https://cli.github.com/packages stable main" >/etc/apt/sources.list.d/github-cli.list && apt-get update && DEBIAN_FRONTEND=noninteractive apt-get install -y --no-install-recommends gh && rm -rf /var/lib/apt/lists/*

# Node.js, current LTS, from nodejs.org with its published checksum; corepack
# provides yarn and pnpm.
RUN curl -fsSL -o /tmp/node.tar.xz https://nodejs.org/dist/v24.21.0/node-v24.21.0-linux-x64.tar.xz && test "$(sha256sum /tmp/node.tar.xz | cut -d " " -f 1)" = fd8e59d5a511510f6a298afb548f18c7d2b1be404d8b4a27d94fbe49f56cb2d6 && tar -xJf /tmp/node.tar.xz -C /usr/local --strip-components=1 --no-same-owner --exclude CHANGELOG.md --exclude README.md --exclude LICENSE && rm /tmp/node.tar.xz && corepack enable && node --version && npm --version

# The workspace account, as on E2B: passwordless sudo, home /home/user. E2B
# provisions `user` itself before these steps run.
RUN if ! id -u user >/dev/null 2>&1; then useradd --create-home --shell /bin/bash --uid 1000 --user-group user; fi && echo "user ALL=(ALL:ALL) NOPASSWD: ALL" >/etc/sudoers.d/user && chmod 0440 /etc/sudoers.d/user

# The Terminal's tmux: tmux's own static (musl) Linux build from
# github.com/tmux/tmux-builds, with its and its libraries' licenses. dxd runs
# it as a separate server (socket `dx`, session `main`) that the person and
# the agent share; see deploy/orb/README.md. It is the only tmux in the image,
# also on PATH, so every client matches the server.
RUN curl -fsSL -o /tmp/tmux.tar.gz https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-linux-x86_64.tar.gz && test "$(sha256sum /tmp/tmux.tar.gz | cut -d " " -f 1)" = cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa && curl -fsSL -o /tmp/tmux-licenses.tar.gz https://github.com/tmux/tmux-builds/releases/download/v3.7c/LICENSES.tar.gz && test "$(sha256sum /tmp/tmux-licenses.tar.gz | cut -d " " -f 1)" = 094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1 && mkdir -p /opt/dx/bin /opt/dx/share/licenses/tmux && tar -xzf /tmp/tmux.tar.gz -C /opt/dx/bin --no-same-owner tmux && tar -xzf /tmp/tmux-licenses.tar.gz -C /opt/dx/share/licenses/tmux --no-same-owner && rm /tmp/tmux.tar.gz /tmp/tmux-licenses.tar.gz && chmod 0755 /opt/dx/bin/tmux && ln -sfn /opt/dx/bin/tmux /usr/local/bin/tmux && /opt/dx/bin/tmux -V

# dxd. Core installs and updates the binary under the user's state directory;
# the image only carries the root-owned pieces, so no install needs root:
# the static login hook that sources the shell profile dxd writes, the
# /usr/local/bin/dxd link, the entrypoint that runs dxd, and the Terminal's
# tmux configuration.
COPY apps/dxd/assets/dx-terminal-stub.sh /etc/profile.d/dx-terminal.sh
COPY deploy/orb/dx-orb-init /usr/local/bin/dx-orb-init
COPY deploy/orb/dx-orb-hostname.sh /etc/profile.d/dx-orb-hostname.sh
COPY deploy/orb/tmux.conf /opt/dx/share/tmux.conf
RUN chown root:root /etc/profile.d/dx-terminal.sh /etc/profile.d/dx-orb-hostname.sh /usr/local/bin/dx-orb-init /opt/dx/share/tmux.conf && chmod 0644 /etc/profile.d/dx-terminal.sh /etc/profile.d/dx-orb-hostname.sh /opt/dx/share/tmux.conf && chmod 0755 /usr/local/bin/dx-orb-init && ln -sfn /home/user/.local/state/dxd/bin/dxd /usr/local/bin/dxd

# The Desktop (README.md#desktop): headless labwc with Xwayland, foot,
# Chromium, and Waymote. Debian 13's labwc 0.8.3 runs on wlroots 0.18, which
# lacks ext-data-control-v1 (Waymote's clipboard), so labwc 0.9.7 and
# wlroots 0.19.3 come from Debian builds on snapshot.debian.org, pinned by
# SHA-256 with the three libraries they need beyond Debian 13 (libxml2-16,
# libsfdo0 0.1.4, libdisplay-info3 0.3.0); they upgrade no Debian 13 package.
# wlroots must be 0.19.3 or later: earlier 0.19 releases give a virtual
# pointer's axis source to one axis only, so a diagonal scroll from the
# Desktop viewer aborts labwc (wlr_seat_pointer_send_axis assertion). Waymote's
# prebuilt server release is pinned the same way. dbus-x11 provides the
# session bus that Chromium's dependencies ask for, so apt does not choose
# dbus-user-session, which would pull in systemd. The step fails only if it
# installed systemd itself: E2B provisions systemd before these steps run.
RUN export DEBIAN_FRONTEND=noninteractive && if dpkg -s systemd >/dev/null 2>&1; then had_systemd=1; else had_systemd=0; fi && mkdir /tmp/dx-desktop && cd /tmp/dx-desktop && for deb in libxml2-16:8a792d08b983e140764e0a94f2af709c4f965d6e:1e776ab2b366f26b709202967a12438c6519def0311f53896a1e96a34a25fca3 libsfdo0:d604c35b3e42000dcade3b9458eae59d6362341b:261cb3ccd23f96efeabedd242d3bf39222dd8b6f80a7d7e804c6799fcddc4a46 libdisplay-info3:d5067b9c6314a74ba88613398b4a7125b4610bbd:86ee84a5107a57f6426cb20f3d5fc87591d11547fd42ae99d4691f6441dfdd4d libwlroots-0.19:2f1ff8c2bd3c356f9b483d6c3c9223bb1e99cbc6:78a833ebca544ec8d947817ced790624dc72041ab18e0341cfa88aadf2ad19f9 labwc:f02ac75763892e400ecc1ee84189faeb5fcd433b:39cb6af1850a0e7a8007fd7b19cd9fec03d5d5272394d1407ea86725f246b84e; do name=${deb%%:*} && hashes=${deb#*:} && curl -fsSL -o "$name.deb" "https://snapshot.debian.org/file/${hashes%%:*}" && test "$(sha256sum "$name.deb" | cut -d " " -f 1)" = "${hashes#*:}" || exit 1; done && curl -fsSL -o waymote.tar.gz https://github.com/rockorager/waymote/releases/download/v0.1.6/waymote-server-0.1.6-linux-x86_64.tar.gz && test "$(sha256sum waymote.tar.gz | cut -d " " -f 1)" = 7de49aef104a4bfad2bcef659f73361b24f289cfdea543350c234197bd2610d2 && apt-get update && apt-get install -y --no-install-recommends ./libxml2-16.deb ./libsfdo0.deb ./libdisplay-info3.deb ./libwlroots-0.19.deb ./labwc.deb xwayland foot chromium ffmpeg wlr-randr dbus-daemon dbus-bin dbus-x11 xkb-data fonts-dejavu-core fonts-liberation && { [ "$had_systemd" = 1 ] || ! dpkg -s systemd >/dev/null 2>&1; } && mkdir -p /opt/dx/desktop/waymote && tar -xzf waymote.tar.gz -C /opt/dx/desktop/waymote --strip-components=1 --no-same-owner && cd / && rm -rf /tmp/dx-desktop /var/lib/apt/lists/* && /opt/dx/desktop/waymote/bin/waymote-gateway -version && labwc --version
# One COPY per file: Core inlines each copied file for templates it builds in
# a person's own E2B team (apps/core/src/execution/e2b/team-templates.ts).
COPY deploy/orb/desktop/start /opt/dx/desktop/start
COPY deploy/orb/desktop/stop /opt/dx/desktop/stop
COPY deploy/orb/desktop/session /opt/dx/desktop/session
COPY deploy/orb/desktop/chromium /opt/dx/desktop/chromium
COPY deploy/orb/desktop/bin/ffmpeg /opt/dx/desktop/bin/ffmpeg
COPY deploy/orb/desktop/labwc/autostart /opt/dx/desktop/labwc/autostart
COPY deploy/orb/desktop/labwc/rc.xml /opt/dx/desktop/labwc/rc.xml
COPY deploy/orb/desktop/labwc/menu.xml /opt/dx/desktop/labwc/menu.xml
RUN chown -R root:root /opt/dx && chmod 0755 /opt/dx /opt/dx/desktop /opt/dx/desktop/bin /opt/dx/desktop/labwc /opt/dx/desktop/start /opt/dx/desktop/stop /opt/dx/desktop/session /opt/dx/desktop/chromium /opt/dx/desktop/bin/ffmpeg && chmod 0644 /opt/dx/desktop/labwc/autostart /opt/dx/desktop/labwc/rc.xml /opt/dx/desktop/labwc/menu.xml && for bin in labwc Xwayland foot chromium ffmpeg wlr-randr dbus-run-session flock setsid pgrep pkill unshare awk paste; do command -v "$bin" >/dev/null || { echo "missing desktop binary: $bin"; exit 1; }; done && ! ldd /opt/dx/desktop/waymote/bin/waymote-streamd | grep "not found"

# Every binary Core's daemon installer and source runtime invoke.
RUN for bin in sudo curl sha256sum install cmp git git-lfs gh bash setpriv setsid readlink tini rg jq node java python3 awk tmux; do command -v "$bin" >/dev/null || { echo "missing required binary: $bin"; exit 1; }; done

USER user
WORKDIR /home/user

# Claude Code for Claude Code mode, pinned and self-update disabled at run
# time (DISABLE_AUTOUPDATER), installed for the workspace account in
# ~/.local/bin. Core installs it on first use in an older workspace.
RUN curl -fsSL https://claude.ai/install.sh | bash -s 2.1.296 && /home/user/.local/bin/claude --version

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dx-orb-init"]
