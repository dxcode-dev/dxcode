---
title: Freestyle and Docker Cloud Sandboxes are Orb providers
date: 2026-10-28
summary: Run your Orbs as Freestyle VMs or Docker Cloud Sandboxes in your own account.
kind: news
link: /docs/use/connect-an-orb-provider/
---

Two more Orb providers joined E2B and Cloudflare. Connect either one in **Personal Settings → Orb Providers**.

## Freestyle

Paste a **Freestyle API key** from the Freestyle dashboard. dx builds its Orb snapshots in your account first, which takes about ten minutes. Freestyle offers three sizes, from fs.small (2 CPU, 4 GiB) to fs.large (8 CPU, 16 GiB). fs.large needs Freestyle's Hobby or Pro plan. See the [Freestyle guide](/docs/guides/freestyle/).

## Docker Cloud Sandboxes

Enter your **Docker ID** and a **Personal access token** created with Allow Cloud Sandboxes access. Your Docker account needs the Docker Agentic Platform plan. dx starts and checks a test Orb in your account first, which takes a few minutes. Docker Cloud Sandboxes offers four sizes, from dk.small (2 CPU, 4 GiB) to dk.xl (16 CPU, 32 GiB). See the [Docker Cloud Sandboxes guide](/docs/guides/docker-cloud-sandboxes/).

Docker Cloud Sandboxes boots from dx's public Orb image, so it can be connected only on deployments that publish one on Docker Hub.
