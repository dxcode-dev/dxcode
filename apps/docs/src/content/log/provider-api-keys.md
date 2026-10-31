---
title: Add provider API keys in Model Routing
date: 2026-10-31
summary: Model Routing's Add a Provider dialog takes API keys for Anthropic, OpenAI, Google AI Studio, OpenRouter, and 15 more providers.
kind: news
link: /docs/use/connect-a-model/
---

You can now bring a model provider's API key straight from settings.

Open **Personal Settings → Model Routing** and choose **Add**. The **Add a Provider** dialog lists Claude Pro/Max at the top, then every provider in one grid: GitHub Copilot, a Custom URL, and 19 API-key providers, including Anthropic, OpenAI, Google AI Studio, xAI, Amazon Bedrock, Groq, OpenRouter, DeepSeek, and Mistral.

Pick a provider and a sheet opens for its key. dx encrypts the key at rest. Under **Models**, check the models you want to use, or leave the defaults to serve every model the provider supports. Turn on **Advanced** to write a model mapping instead.

A deployment offers all 19 API-key providers unless its operator limits them. Workspace Model Routing takes Custom URL providers only.
