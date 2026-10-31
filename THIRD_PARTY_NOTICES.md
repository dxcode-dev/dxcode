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

## Waymote video startup

`third-party/waymote/@rockorager__waymote@0.1.6.patch` makes Waymote's
browser SDK decode everything its gateway sends a new viewer, the latest full
picture and up to 240 frames since. The SDK holds 241 frames instead of 6
while its decoder is set up, and drops frames for a long decoder queue only
once a picture is showing.

- Source: <https://github.com/rockorager/waymote>
- License: MIT
- License text: <https://github.com/rockorager/waymote/blob/main/LICENSE>

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

The standard Orb image (`deploy/orb/Dockerfile`) ships tmux 3.7c as an
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
