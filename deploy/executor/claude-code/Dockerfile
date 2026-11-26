# Executor image for Claude Code: only the Claude Code CLI and what dx's launch script
# needs (bash, mawk, setsid, python3 for the dx tool bridge, curl, tar). No
# repository, toolbelt, Desktop, or dxd. It fits Cloudflare's `basic`
# instance (1/4 vCPU, 1 GiB, 4 GB disk). See
# apps/core/src/executor/executor-object.ts.
FROM debian:13-slim@sha256:a99cfc517144bc59b1978475ec53b46ecabec7e43635402ee5b77cc54cd1b20a

RUN apt-get update && apt-get install -y --no-install-recommends bash ca-certificates curl mawk procps python3 tar util-linux && rm -rf /var/lib/apt/lists/* && useradd --create-home --shell /bin/bash user && mkdir -p /home/user/workspace/repo && chown -R user:user /home/user

USER user
WORKDIR /home/user
# Claude Code, pinned by version and SHA-256 like the Orb image
# (CLAUDE_CODE_VERSION and CLAUDE_CODE_SHA256 in deploy/orb/install.sh, which
# deploy/orb/downloads.test.mjs keeps equal to these; see "Claude Code" in
# deploy/orb/README.md to move to another release). The checked binary goes
# where the native installer keeps each version, so its own `claude install`
# only links ~/.local/bin/claude to it.
RUN curl -fsSL --retry 5 --retry-all-errors --retry-delay 3 -o /tmp/claude https://downloads.claude.ai/claude-code-releases/2.1.326/linux-x64/claude && test "$(sha256sum /tmp/claude | cut -d " " -f 1)" = b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37 && mkdir -p /home/user/.local/share/claude/versions && install -m 0755 /tmp/claude /home/user/.local/share/claude/versions/2.1.326 && rm /tmp/claude && DISABLE_AUTOUPDATER=1 /home/user/.local/share/claude/versions/2.1.326 install 2.1.326 && test "$(sha256sum /home/user/.local/bin/claude | cut -d " " -f 1)" = b6b3647d981130dc44fc670846ae97b6cde531ffb667cf9c4d17cfcafb38cb37 && /home/user/.local/bin/claude --version

ENTRYPOINT ["sleep", "infinity"]
