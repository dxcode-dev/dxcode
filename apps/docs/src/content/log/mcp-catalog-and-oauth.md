---
title: Connect MCP servers from a catalog, with OAuth sign-in
date: 2026-10-28
summary: Integrations & MCP lists more than 70 MCP server templates, and servers can sign you in with OAuth or send custom headers.
kind: news
---

Connecting an MCP server now takes a click for most popular tools.

## The catalog

**Settings → Integrations & MCP** lists more than 70 server templates, including Linear, GitHub, Notion, Sentry, Stripe, Supabase, Figma, and Cloudflare. Search the list, then choose **Connect** on a template. In workspace settings, choose **Enable** to offer a template to the whole workspace. **Add MCP Server** still connects any server by URL.

## Sign in with OAuth

Most templates use OAuth. Choose **Connect** on the template, then **Connect** in the dialog, and dx takes you to the provider to sign in. To sign in again later, use **Sign in** in the server's settings. Sign-ins are always your own. On a workspace server, each member signs in with their own account, and a Thread uses the sign-in of the person who started it.

## Headers and other authentication

When you add a server by URL with **Add MCP Server**, its authentication starts at Automatic Detection, and you can change it to OAuth, Bearer Token, or No Authentication. You can also send custom **Headers** and mark a header's value as secret, so dx encrypts it and never shows it again.
