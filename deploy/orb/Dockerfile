# dx Orb image: the workspace E2B, Cloudflare Containers, and Docker Cloud
# Sandboxes boot. See deploy/orb/README.md.
#
#   docker build --platform linux/amd64 -f deploy/orb/Dockerfile -t dx-orb .
#
# The build context is the repository root; Dockerfile.dockerignore admits
# only the files copied below. E2B builds its template from this same
# file (deploy/e2b/template.mjs), so keep to the instructions its parser
# supports: one FROM, RUN, COPY, ENV, WORKDIR, USER, ENTRYPOINT. Write each
# RUN as one line: the parser rejoins words with single spaces.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

# Everything comes from deploy/orb/install.sh, the installer Boat and
# Freestyle machines run too, so every Orb provider gets the same Orb: the
# base packages, Node.js, the GitHub CLI, the `user` account (passwordless
# sudo, home /home/user; E2B provisions `user` itself before these steps),
# the dx toolbelt (/opt/dx: the Terminal's tmux and the Desktop, built once
# with their own libraries; deploy/orb/toolbelt), dx's login hooks and
# entrypoint, and Claude Code for `user`. Every download retries transient
# failures and checks its pinned SHA-256 (downloads.test.mjs). One COPY per
# file: Core inlines each copied file for templates it builds in a person's
# own E2B team (apps/core/src/execution/e2b/team-templates.ts). One RUN per
# installer part keeps each layer a few hundred MB: one 1.2 GB layer failed
# to push to Cloudflare's registry twice in a row.
COPY deploy/orb/install.sh /tmp/dx-orb-setup/install.sh
COPY apps/dxd/assets/dx-terminal-stub.sh /tmp/dx-orb-setup/files/dx-terminal.sh
COPY deploy/orb/dx-orb-init /tmp/dx-orb-setup/files/dx-orb-init
COPY deploy/orb/dx-orb-hostname.sh /tmp/dx-orb-setup/files/dx-orb-hostname.sh
COPY deploy/orb/dx-orb-open-files.sh /tmp/dx-orb-setup/files/dx-orb-open-files.sh
COPY deploy/orb/tmux.conf /tmp/dx-orb-setup/files/tmux.conf
RUN bash /tmp/dx-orb-setup/install.sh --image /tmp/dx-orb-setup/files /tmp/dx-orb-setup packages
RUN bash /tmp/dx-orb-setup/install.sh --image /tmp/dx-orb-setup/files /tmp/dx-orb-setup runtimes
RUN bash /tmp/dx-orb-setup/install.sh --image /tmp/dx-orb-setup/files /tmp/dx-orb-setup toolbelt
RUN bash /tmp/dx-orb-setup/install.sh --image /tmp/dx-orb-setup/files /tmp/dx-orb-setup finish && rm -rf /tmp/dx-orb-setup

USER user
WORKDIR /home/user

ENTRYPOINT ["/usr/bin/tini", "--", "/usr/local/bin/dx-orb-init"]
