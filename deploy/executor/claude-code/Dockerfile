# Executor image for Claude Code: only the Claude Code CLI and what dx's launch script
# needs (bash, mawk, setsid, python3 for the dx tool bridge, curl, tar). No
# repository, toolbelt, Desktop, or dxd. It fits Cloudflare's `basic`
# instance (1/4 vCPU, 1 GiB, 4 GB disk). See
# apps/core/src/executor/executor-object.ts.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl mawk procps python3 tar util-linux && rm -rf /var/lib/apt/lists/* && useradd --create-home --shell /bin/bash user && mkdir -p /home/user/workspace/repo && chown -R user:user /home/user

USER user
WORKDIR /home/user
RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/claude-install.sh https://claude.ai/install.sh && bash /tmp/claude-install.sh 2.1.319 && rm /tmp/claude-install.sh && /home/user/.local/bin/claude --version

ENTRYPOINT ["sleep", "infinity"]
