---
title: Report a bug from any Thread
date: 2026-10-31
summary: Report Bug sends a description, screenshots, and redacted diagnostics from the Thread where the problem happened.
kind: news
---

When something goes wrong in a Thread, you can report it without leaving the page.

Choose **More Actions → Report Bug**. Describe the problem, what you expected, and how to reproduce it. Attach up to five images, or paste or drop them in. Then pick the diagnostics to include:

- **Thread and App Diagnostics**, on by default: the transcript, app errors and failed requests, Worker logs, and the Orb's and agent's state, including setup scripts.
- **Diff Diagnostics**, while **Changes** is open.
- **Dictation Diagnostics**, the audio and transcript of your latest dictation in the Thread.

dx redacts secrets from your message and the text diagnostics. Choose **Send Bug Report**, or press Mod+Enter.

Your deployment decides where reports go: it can file each one on GitHub, as a new issue or as a comment on a matching open issue, or keep reports in dx. The issue or comment carries your message and a summary; your images and diagnostics stay in dx, behind a sign-in. Open **Your Reports** to see your recent reports and whether each was filed.
