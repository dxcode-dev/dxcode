# Plugin container image: the `container` plugin host
# (apps/core/src/plugins/hosts/container). Node.js runs the plugin's
# container module through runner.mjs; the native tools plugins most often
# declare in `binaries` are installed here, so a cold start downloads
# nothing. The container has no internet: plugin code reaches dx, and the
# network its manifest grants, only through ctx. It fits Cloudflare's `basic`
# instance (1/4 vCPU, 1 GiB, 4 GB disk).
#
# The apt packages below are PLUGIN_CONTAINER_APT in
# apps/core/src/plugins/hosts/container/limits.ts; keep both lists equal.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update \
 && apt-get install -y --no-install-recommends \
      ca-certificates nodejs procps tini util-linux \
      ffmpeg imagemagick poppler-utils qpdf libimage-exiftool-perl \
      jq sqlite3 zip unzip xz-utils git python3 \
 && rm -rf /var/lib/apt/lists/* \
 && useradd --create-home --shell /bin/sh plugin \
 && mkdir -p /srv/plugin /srv/bin /srv/work \
 && chown -R plugin:plugin /srv/plugin /srv/bin /srv/work

COPY --chown=root:root --chmod=0644 runner.mjs /opt/dx/runner.mjs

USER plugin
WORKDIR /srv/work
# Downloaded binaries come last, so none can stand in for a system tool.
ENV PATH=/usr/local/bin:/usr/bin:/bin:/srv/bin HOME=/home/plugin LANG=C.UTF-8 NODE_ENV=production
ENTRYPOINT ["tini", "--", "sleep", "infinity"]
