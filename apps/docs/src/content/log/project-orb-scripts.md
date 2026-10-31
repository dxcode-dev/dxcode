---
title: Project Orb scripts, including Desktop resume
date: 2026-10-31
summary: Set up every Orb in a project with pre-clone, pre-setup, and Desktop Resume scripts, without committing setup files.
kind: news
---

You can now prepare a project's Orbs from its settings instead of from files in the repository.

Open the project's settings, go to **Orb**, and find **Orb Scripts**. Each script saves on its own, and a script without a shebang runs in Bash.

- **Pre-clone Script** runs in the workspace folder before dx clones the repository. If it fails, dx does not clone, so you can fix it and retry.
- **Pre-setup Script** runs from the repository root right before the repository's `.agents/setup`, even when the repository has none.
- **Desktop Resume Script** runs from the repository root each time the Desktop starts, in place of a blank Chromium window. Use it to open your app or a dashboard. If the repository has an executable `.agents/desktop/resume`, that file runs instead.

The repository's `.agents/resume` also became more predictable: it runs when an Orb first starts, after each wake, and when the Orb's environment variables change.
