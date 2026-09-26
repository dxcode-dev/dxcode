---
title: Contribution guide
description: Prepare a focused, signed contribution to dxcode.
---

dxcode accepts public contributions through
[GitHub](https://github.com/dxcode-dev/dxcode). The source is licensed under
[FSL-1.1-ALv2](https://fsl.software/).

## Prepare a change

1. Fork the public repository and create a focused branch.
2. Install dependencies with `pnpm install --frozen-lockfile`.
3. Make the smallest change that solves the issue.
4. Add or update tests for behavior changes.
5. Run `pnpm verify:changed -- origin/main`.
6. Open a pull request that explains the behavior and verification.

Never include private source, private issue text, credentials, customer data,
internal deployment details, or non-public test fixtures in a contribution.

## Sign off commits

The project uses the Developer Certificate of Origin. Sign off every commit:

```sh
git commit -s -m "Describe the change"
```

The sign-off records that you have the right to submit the contribution under
the project's license. Read the
[Developer Certificate of Origin](https://developercertificate.org/) before
contributing.

## Documentation style

Write instructions a reader can execute. Describe behavior that exists in the
current release. Link to the owning schema or command when exact input matters.
