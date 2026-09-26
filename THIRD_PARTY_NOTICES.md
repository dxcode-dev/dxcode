# Third-party notices

## Alchemy Cloudflare state-store selection

`third-party/alchemy/alchemy@2.0.0-beta.74.patch` modifies Alchemy's Cloudflare
state-store login to select the Secrets Store containing Alchemy's token rather
than an unrelated account store.

- Source: <https://github.com/alchemy-run/alchemy>
- License: Apache-2.0
- License text: <https://github.com/alchemy-run/alchemy/blob/main/LICENSE>

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
