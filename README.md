# Inception OpenAI Proxy

An OpenAI-compatible HTTP proxy for [Inception Labs](https://inceptionlabs.ai)'s
**Mercury** model. Point any OpenAI SDK at it and talk to Mercury without
changing your client code.

Built as a contribution to [ZeroKey](https://github.com/downloaddoctor/zerokey),
which already ships Mercury 3 as its Inception provider. This proxy exposes the
same model through the `/v1/chat/completions` shape so it can be dropped into
existing tooling, and adds streaming tool-call reconstruction that ZeroKey can
reuse.

## What it does

| Feature | Details |
|---|---|
| OpenAI-compatible endpoint | `POST /chat/completions` accepts the standard `messages`, `tools`, `stream` fields |
| Streaming | SSE deltas in OpenAI's `chat.completion.chunk` format, terminated by `[DONE]` |
| Tool calls | Mercury has no native function calling; tools are described in a prompt and `[TOOL_CALL]: {...}` lines are parsed back into OpenAI's `tool_calls` structure, streamed in the same fragmented format OpenAI uses |
| Web search | `search: true` enables Mercury's built-in web search; sources are returned as an OpenAI-style `sources` array and the `SEARCHING` / `FINISHED` markers are surfaced as content chunks |
| Reasoning levels | `intelligence: 0–3` maps to Mercury's `instant` / `low` / `medium` / `high` |
| Conversation reuse | Pass the same `chatId` to keep the same upstream conversation across requests |
| Decide API | `POST /decide/run` passes through to Inception's Decide endpoint with auth injection |
| TLS impersonation | Uses [`impit`](https://www.npmjs.com/package/impit) so requests present a real browser TLS fingerprint rather than Node's OpenSSL one |
| Multi-client rotation | Optional proxy pool with per-client health tracking, 429 cooldowns, and automatic failover |

## Quick start

```bash
npm install
node server.js
