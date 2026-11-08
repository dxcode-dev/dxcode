# Third-party notices

## Alchemy Cloudflare state-store selection

`third-party/alchemy/alchemy@2.0.0-beta.83.patch` modifies Alchemy's Cloudflare
state-store login to select the Secrets Store containing Alchemy's token rather
than an unrelated account store, and adds the scopes named in
`ALCHEMY_CLOUDFLARE_OAUTH_EXTRA_SCOPES` to its Basic and Custom OAuth scope
choices.

- Source: <https://github.com/alchemy-run/alchemy>
- License: Apache-2.0
- License text: <https://github.com/alchemy-run/alchemy/blob/main/LICENSE>

## Ghostty Web rendering

`third-party/ghostty-web/ghostty-web@0.4.0.patch` modifies Ghostty Web's
renderer to read the terminal viewport once per frame, its resize to
allocate the canvas once, its Terminal to draw only when something changed
and not while hidden, and its WebAssembly loader to fetch the module by URL
without a second, embedded copy.

- Source: <https://github.com/coder/ghostty-web>
- License: MIT
- License text: <https://github.com/coder/ghostty-web/blob/main/LICENSE>

## voxl web client

`apps/web/src/features/desktop/voxl/` is a port of voxl's browser client
(`web/src/protocol.ts`, `web/src/worker.ts`, and
`web/src/client/{video,pointer,keyboard,touch,resize,clipboard,cursor}.ts`)
at commit `176f8be` (v0.3.4), without its files, microphone, and audio
parts. dx's changes: the socket and decoders run on the page instead of a
worker, input reaches the desktop only while the viewer has focus, pointer
positions map onto the letterboxed picture, and the desktop's size follows
dx's pane.

- Source: <https://github.com/tembo/voxl/tree/176f8be/web/src>
- License: MIT, Copyright (c) 2026 Tembo
- License text: <https://github.com/tembo/voxl/blob/176f8be/LICENSE>

## ElevenLabs UI waveform

`apps/web/src/shared/ui/waveform.tsx` adapts the base canvas waveform from
ElevenLabs UI:

- Source: <https://github.com/elevenlabs/ui/blob/main/apps/www/registry/elevenlabs-ui/ui/waveform.tsx>
- License: MIT
- License text: <https://github.com/elevenlabs/ui/blob/main/LICENSE.md>

MIT License

Copyright (c) 2025 Eleven Labs Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## dx view kit icons

The `icons.svg` symbols in `packages/api/src/views/kit/` are Lucide icons:

- Source: <https://github.com/lucide-icons/lucide>
- License: ISC

Copyright (c) for portions of Lucide are held by Cole Bemis 2013-2022 as part
of Feather (MIT). All other copyright (c) for Lucide are held by Lucide
Contributors 2022.

Permission to use, copy, modify, and/or distribute this software for any
purpose with or without fee is hereby granted, provided that the above
copyright notice and this permission notice appear in all copies.

THE SOFTWARE IS PROVIDED "AS IS" AND THE AUTHOR DISCLAIMS ALL WARRANTIES WITH
REGARD TO THIS SOFTWARE INCLUDING ALL IMPLIED WARRANTIES OF MERCHANTABILITY AND
FITNESS. IN NO EVENT SHALL THE AUTHOR BE LIABLE FOR ANY SPECIAL, DIRECT,
INDIRECT, OR CONSEQUENTIAL DAMAGES OR ANY DAMAGES WHATSOEVER RESULTING FROM LOSS
OF USE, DATA OR PROFITS, WHETHER IN AN ACTION OF CONTRACT, NEGLIGENCE OR OTHER
TORTIOUS ACTION, ARISING OUT OF OR IN CONNECTION WITH THE USE OR PERFORMANCE OF
THIS SOFTWARE.

## Pi coding agent

The baseline dx agent prompt in
`apps/core/src/agents/dx-agent-prompt.ts` is adapted from the Pi coding agent
system prompt:

- Source: <https://github.com/earendil-works/pi/blob/main/packages/coding-agent/src/core/system-prompt.ts>
- License: MIT

Copyright (c) 2025 Mario Zechner.

## Flue E2B sandbox blueprint

`apps/core/src/execution/e2b/adapter.ts` is copied without behavioral changes
from the Flue `sandbox/e2b@1` blueprint distributed with Flue 2.0.3:

- Source: <https://github.com/withastro/flue/blob/v2.0.3/blueprints/sandbox--e2b.md>
- License: Apache License 2.0
- License text: <https://github.com/withastro/flue/blob/v2.0.3/LICENSE>

The source/version marker is retained in the copied file so later changes can
be reviewed against the licensed upstream blueprint.

## QuickJS and quickjs-emscripten

The Code plugin distributes QuickJS WebAssembly through
`quickjs-emscripten-core` and `@jitl/quickjs-wasmfile-release-sync` 0.32.0.

- Source: <https://github.com/justjake/quickjs-emscripten>
- QuickJS source: <https://bellard.org/quickjs/>
- License: MIT

quickjs-emscripten copyright (c) 2019-2024 Jake Teton-Landis

QuickJS Javascript Engine

Copyright (c) 2017-2021 Fabrice Bellard
Copyright (c) 2017-2021 Charlie Gordon

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## tmux (Orb image Terminal)

The dx toolbelt (`deploy/orb/toolbelt`), which every Orb installs, ships tmux 3.7c as an
unmodified, statically linked binary at `/opt/dx/bin/tmux`, downloaded from
the tmux project's own build repository and checked by SHA-256. The license
texts of tmux and every library linked into it ship next to it in
`/opt/dx/share/licenses/tmux/` (the release's `LICENSES.tar.gz`).

- Binary: <https://github.com/tmux/tmux-builds/releases/download/v3.7c/tmux-3.7c-linux-x86_64.tar.gz>
  (SHA-256 `cc56bd1cc873eb6089c615f0496b072385bda8a6d944069f38564a5d49c128aa`)
- License texts: <https://github.com/tmux/tmux-builds/releases/download/v3.7c/LICENSES.tar.gz>
  (SHA-256 `094905d3ba42397c65fecd817dc29736dd14bd35e75600441403a365125f47d1`)
- Build recipe: <https://github.com/tmux/tmux-builds> (`versions.env` at `v3.7c`)
- tmux: ISC license, copyright (c) various authors; source <https://github.com/tmux/tmux>
- Linked libraries (versions from `versions.env`): musl 1.2.5 (MIT),
  libevent 2.1.12 (3-clause BSD), ncurses 6.5 (MIT/X11-style), utf8proc
  2.11.2 (MIT, with Unicode data under the Unicode license)

`deploy/orb/tmux.conf` is dx's own configuration file.

## dx toolbelt (Orb Desktop programs)

Every Orb installs the dx toolbelt (`deploy/orb/toolbelt`), published as
`dx-toolbelt.tar.zst` on the `orb-toolbelt-<version>` releases of
<https://github.com/dxcode-dev/dxcode/releases> and mirrored as
`docker.io/dxcodedev/dx-toolbelt`. Apart from tmux (above), its programs
are unmodified builds from nixpkgs (<https://github.com/NixOS/nixpkgs>) at
the revision `deploy/orb/toolbelt/flake.lock` pins, with every library they
use, and voxl, built from its own source. The main ones and their licenses:

- voxl 0.3.4 (<https://github.com/tembo/voxl> at
  `176f8befef4c4420e7bc6df5f143886a0f023b8a`): MIT, copyright (c) 2026 Tembo;
  the binary links x264 (GPL-2.0-or-later), so the binary is distributed
  under the GPL
- Xvfb from xorg-server 21.1.24, with voxl's patch giving its XTEST pointer
  scroll axes (`patches/xorg-server-xtest-scroll.patch` in voxl): MIT/X11
- openbox 3.6.1: GPL-2.0-or-later; xterm: MIT/X11
- Chromium 157.0.8103.38: BSD-3-Clause, with the licenses of its bundled
  components in its `about:credits` page
- D-Bus 1.16.2: GPL-2.0-or-later
- glibc 2.42: LGPL-2.1-or-later
- GNU bash, coreutils, gawk, grep, findutils: GPL-3.0-or-later;
  util-linux, procps: GPL-2.0-or-later and other free licenses
- curl: curl license; DejaVu fonts: free (Bitstream Vera); Liberation
  fonts 2.1.5: OFL-1.1

Source: each program's source is the one nixpkgs fetches for that revision
(`nix build --derivation ./deploy/orb/toolbelt#toolbelt`, then
`nix-store --query --requisites` on the derivation lists every source; Nix's
own cache keeps a copy at <https://cache.nixos.org>).
