# 9Router Ultimate

**An enhanced edition of 9Router with Prompt Injection: one injection per target — global, per API key, per model — as a system prompt or a scripted chat.**

9Router Ultimate is a local AI router: connect every AI code tool (Claude Code, Cursor, Codex, Gemini, OpenCode, Cline, OpenClaw…) to 40+ providers and 100+ models through one endpoint, with token saving, smart fallback and multi-account support.

## Install

```bash
npm install -g 9router-ultimate
9router-ultimate
```

The dashboard opens at `http://localhost:20127` (the original 9Router uses 20128, so both can run side by side).

## What makes it different

- **Prompt Injection** — one injection per target (**global**, **per API key**, **per model**), as a single system prompt (prepend/append) or a scripted chat primed as fake history, applied wire-aware for OpenAI / Claude / Gemini / Responses bodies.
- **Per-key token quotas** — a token budget per API key (24h / 7d / 30d) with live usage and 429 enforcement.
- **Key Limits for reselling** — per-key requests/minute, tokens/minute, requests/hour, requests/day and max-concurrent caps.
- **Providers, organized** — a dedicated section for custom (OpenAI/Anthropic-compatible) providers, an all-connections shelf, and Test All in every section.
- **Proxy Pools that maintain themselves** — server-side health checks with dead-pool cleanup, plus per-provider rotation over a hand-picked pool subset.
- **Balanced fallback + Anti-Flaky Guard** — health-tiered account selection and automatic retries on flaky upstream responses.
- **Themes & languages** — a flat dark theme, accent presets plus a custom color picker, and a fully localized dashboard (34 languages).

Full documentation, screenshots and the feature-by-feature comparison with the original live in the [GitHub repository](https://github.com/fanzz-21/9router-ultra).

## Based on

[9Router](https://github.com/decolua/9router) by decolua (MIT). 9Router Ultimate is an independent edition built on top of it.

## License

MIT
