# Flue 2.0.3 → 2.0.7 upgrade audit

This review compares upstream Flue's 2.0.3 base (`bf86b872`) with the 2.0.7 release (`dd07a7e3`), then rebases dx's maintained changes on that release. The official-steering preview revision is `5ca261d64d6f26322ef79631a7e46af39ca44f0e`; source, tarballs, and hashes are reproducible from this directory's README.

## Upstream runtime changes adopted

| Area | Upstream change | dx benefit |
| --- | --- | --- |
| Model failure handling | [Retry `Connection error.`](https://github.com/withastro/flue/commit/a5b32a55) | A transient provider connection error enters the retry path instead of prematurely failing an execution. |
| Workers AI | [Normalize assistant content](https://github.com/withastro/flue/commit/c663410f) | Tool-only or null-content Workers AI responses no longer violate assistant-message assumptions. |
| Skills and JSX imports | [Parse JSX markdown importers and delegate skill registries](https://github.com/withastro/flue/commit/d830034a) | The Vite virtual Skills integration uses Flue's corrected importer and registry path. |
| React | [Keep `useFlueAgent` callbacks stable](https://github.com/withastro/flue/commit/6e622780) | Render consumers avoid needless callback churn; dx adds a replacement-client test to ensure stability does not mean a stale client. |
| Tool execution | [Prevent recursive harness invocation](https://github.com/withastro/flue/commit/21c6240d), [resume truncated batches](https://github.com/withastro/flue/commit/68dbb37c), [accept union-shaped output](https://github.com/withastro/flue/commit/4a86eaa7), and [repair batches on abort](https://github.com/withastro/flue/commit/2227864c) | Aborts, truncation, nested invocation, and provider output variants recover through Flue's supported path rather than dx owning competing repairs. Checkpoint format 5 first invalidates old folds, so a cached pre-upstream recovery state is never reused. |
| Compaction and overflow | [Populate compacted-context telemetry](https://github.com/withastro/flue/commit/c1ceacdb), [compact after terminated tool runs](https://github.com/withastro/flue/commit/750f1f11), and [settle overflow responses](https://github.com/withastro/flue/commit/75277392) | Continuations are observable and progress after terminating tools or overflow. |
| Cloudflare observability | [Add tracing join IDs](https://github.com/withastro/flue/commit/4b436f74) and [include persisted output in terminal telemetry](https://github.com/withastro/flue/commit/96b8f0b7) | dx can correlate Cloudflare spans and terminal output with the runtime's own IDs and persisted result telemetry. |
| Cloudflare sandbox | [Use newlines for `readdir`](https://github.com/withastro/flue/commit/b8c07bb8) | E2B/workspace-adjacent directory listings preserve correct file separation. |
| Reconnection | [Reset healthy-stream reconnect backoff](https://github.com/withastro/flue/commit/ef0c89f8) | A later disconnect does not inherit a stale large backoff after a healthy observation. |
| Model catalog | [Preserve Cloudflare Anthropic gateway compatibility](https://github.com/withastro/flue/commit/da7c0855) | Catalog routing retains compatible Anthropic gateway model handling. |
| Dependencies and packaging | [Pin Hono workspace-wide](https://github.com/withastro/flue/commit/1ae1c85d), prepare and smoke-test packaged docs | A single Hono graph fixes the `createAgentRouter` incompatibility found in dx; release packages carry documentation. |

The remaining 2.0.4–2.0.7 commits are release, CI, formatting, documentation, and publication-process changes. Review the exact upstream range with:

```sh
git -C /your/flue checkout dd07a7e3aa58ab5de23f3edb932e1d78c6284d95
git -C /your/flue log --reverse --oneline bf86b872..HEAD
```

## Overlap resolution

Upstream wins for callback stability, lifecycle/recovery of partial tool batches, compaction continuation, reconnection, Vite Skills importer behavior, and tracing IDs. The fork keeps functionality with no equivalent upstream public contract:

- provider invocation context and durable receipt fencing;
- durable receipts, indexed history, final-output descriptors, retained browser sessions, retry/resend, and content-free resume. The custom steering intent, pause/FIFO queue, queue inspection, and continuation endpoint were removed in favor of upstream turn-boundary joins.
- workspace-context snapshots; and
- first-meaningful-output telemetry.

The fork therefore does not retain a rival implementation of the upstream fixes. Its React regression proves the subtle integration boundary: after a client replacement, `sendMessage` targets the replacement rather than a stale stable callback.

## Preview and production plan

1. **Preview:** build and install only the retained 2.0.7 artifacts; verify source hash, package hashes, one runtime/vite instance, and one Pi graph. Exercise core worker/lifecycle and settings contracts.
2. **Persistence gate:** restore an immutable D1/DO record corpus from before and after the existing format-3 change. Read history; resume a content-free session; continue an interrupted tool batch; and replay legacy `length` + tool-call and `stop` + tool-call records with later user turns, including leaf, unsettled, head/indexed-page, and resumed cases. Compare final output, receipts, offsets, traces, and canonical records.
3. **Rollback gate:** prove whether production can read preview-written records. If it cannot, deploy behind a write-gate; rehearse disabling new writes and restoring a compatible runtime instead of assuming an old reader works.
4. **Failure gate:** inject a Workers AI tool-only response, nested invocation attempt, provider connection error, tool-batch abort, reconnect during steer, and overflow continuation. Verify one settlement and no duplicate provider dispatch for each.
5. **Promotion:** deploy only after the gates pass on the exact artifact revision and retain the corpus, trace IDs, and results with the release record.

## Proven and not yet proven

Source tests pass: runtime 249, SDK 37, React 24. dx verifies artifact identities, hashes, resolution, and retained APIs. This proves a reproducible integration candidate. It does **not** prove compatibility with every production durable record; the persistence and rollback gates are required evidence before that claim.
