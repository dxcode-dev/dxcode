# Flue 2.0.7 → 2.3.0 upgrade audit

Fork revision `33a2cf7e3796a7f3960a24455f3c5bb57537ee13` merges upstream
[v2.3.0](https://github.com/withastro/flue/commit/deee93b40d275ecc9a50c50af2158f20089d54bc)
into the 2.0.7-based fork (`e7bef20b`). Upstream was merged in three steps so
each overlap was resolved against one upstream feature at a time:

1. `2663e507` (2.0.8 through 2.1.1 and PDF documents): 11 conflicting files.
2. `54cabb7a` (bounded history): recorded with dx's history API kept.
3. `v2.3.0`: 5 conflicting files, plus the pi 1.1.0 transcript model.

Review the exact range with:

```sh
git -C /your/flue log --first-parent --oneline e7bef20be3c74f4ffdeeed83b1fe161a1fb5f0c8..33a2cf7e3796a7f3960a24455f3c5bb57537ee13
```

## Adopted from upstream

| Area | Upstream change | dx consequence |
| --- | --- | --- |
| Models | pi-ai and agent-core 1.1.0 | The system prompt and tools travel as transcript system messages (`TranscriptContext`). dx providers read them with `getCurrentSystemPrompt`/`getCurrentTools`, and dx's one-shot completion passes `normalizeContext(...)`. pi's Azure provider is now `azure`; dx keeps `azure-openai-responses` as its canonical id and maps it. |
| Recovery | Settle interrupted submissions whose recovery render throws (#711) | Kept alongside dx's persisted-input reconciliation. |
| Streaming | Immediate first flush after a quiet interval | Uses dx's configurable 750 ms cadence instead of the fixed 1000 ms. |
| Retries | Hide superseded model errors after a successful retry (#571) | dx keeps its `conversation-invalidated` SSE; the refetched snapshot omits the superseded content. |
| Tools | `timeoutMs`, MCP annotations | Available; dx sets none yet. |
| Attachments | PDF documents | React `sendMessage` accepts `documents` next to `images`. |
| Messages | Server-authored `timestamp` on every message and settlement | Replaces dx's user/chat-only timestamp; indexed history pages carry settlement timestamps so they equal the fold projection. |
| React | Reload-safe `streaming` status (#756) | Chat messages never count as active, because `finishedSubmissionIds` treats their ids as finished. |
| Hooks and observability | `useAgentFinish` re-render (#818), `agentName` on every step, linear trace truncation, Cloudflare binding fixes | No dx change. |

### Model catalogs

Every pi-served provider's model list now comes from the pinned pi catalog,
so a pi upgrade adds newly released models without a dx edit. API-key providers
(OpenAI, Anthropic, Google, xAI and others) read `getBuiltinModels` directly.
The GitHub Copilot catalog
([`catalog.ts`](../../apps/core/src/settings/model-subscriptions/github-copilot/catalog.ts))
derives from pi's `github-copilot` entries. It drops pi's transcript transport
flags and keeps eight older models pi no longer lists. pi 1.1.0 adds
`claude-opus-5.5`, `claude-sonnet-5.5`, `gpt-6-luna`, `gpt-6-sol`,
`gpt-6.1-sol` and `grok-4.7` to Copilot. A Copilot connection serves only
the models its entitlement enables, and an existing connection sees new
models after its next entitlement refresh. The Claude Code list in
[`claude-code.ts`](../../packages/domain/src/settings/claude-code.ts) remains
hand-maintained, because the Claude Code CLI, not pi, serves it.

## Kept in the fork

Every row of the divergence ledger in [README.md](README.md) remains. The
notable overlaps:

- **History.** Upstream 2.2's `history({ limit })`, `historyBefore()` and
  `before` cursor collide by name with dx's indexed, byte-bounded pages
  (`promptLimit`, `maxBytes`, `olderCursor`, `settlementIds`), and lack the byte
  budget and settlement lookup dx's web client needs. The merge records upstream's
  commit without its API; its tests were not restored.
- **React sends.** dx's `deliver`/`retrySend`/`resendPrompt` with minted
  idempotency keys stay; upstream's pass-through of every SDK send control and
  its `AgentSendResult` return are not adopted.
- **Tests upstream deleted.** Upstream's 2.3.0 release removed 28 test files
  with its Changesets tooling (`95a8c862`). They are restored, except the
  bounded-history suites and the AI Gateway id-rewrite cases, whose code the
  2.3.0 release itself removed.

## Verification

Fork: runtime 326, SDK 40, React 51 and Vite 12 tests pass with types and
builds (`build-dx-packages.sh`). dx: see the pull request for unit, Worker,
lifecycle and branch-preview evidence.
