# `inception-openai-proxy`

An OpenAI-compatible HTTP proxy for [Inception Labs](https://inceptionlabs.ai)'s **Mercury** model, with streaming, tool-call reconstruction, web search, timing instrumentation, and a rotating pool of optional upstream proxies.

> **⚠️ Educational use only.** This project exists to demonstrate how an OpenAI-compatible adapter can be built against a streaming upstream that does not natively expose the OpenAI wire format. It is **not** intended for abuse, resale, circumvention of access controls, or any use that violates Inception Labs' or Vercel's Terms of Service. See [`WARNING.txt`](./WARNING.txt) before running it. You are responsible for how you use this code.

---

## Table of contents

- [What this is](#what-this-is)
- [Features](#features)
- [Measured performance](#measured-performance)
- [Upstream limits you should know](#upstream-limits-you-should-know)
- [Installation](#installation)
- [Configuration (`config.json`)](#configuration-configjson)
- [Proxy pool](#proxy-pool)
- [API reference](#api-reference)
- [Message format](#message-format)
- [Tool calls](#tool-calls)
- [Streaming markers and timing](#streaming-markers-and-timing)
- [Examples](#examples)
- [Troubleshooting](#troubleshooting)
- [Legal](#legal)

---

## What this is

Mercury is a diffusion-based language model served at `chat.inceptionlabs.ai`. Its public chat surface speaks a bespoke SSE dialect that is **not** the OpenAI wire format: messages are `parts` arrays, tool calls are emitted as inline `[TOOL_CALL]: {...}` text, web-search sources arrive as separate `source-url` events, and authentication is a short-lived `x-session-token` fetched from `/api/session`.

This proxy adapts all of that into `/v1/chat/completions`-compatible JSON and SSE. Point any OpenAI SDK at `http://localhost:8101` and it just works — including `stream: true`, `tools`, and `tool_choice`-style round-trips.

It was built as a contribution to [ZeroKey](https://github.com/downloaddoctor/zerokey), which already ships Mercury 3 as its Inception provider. ZeroKey handles the UI, provider registry, and long-chat rotation; this repo is the standalone proxy that contributed the streaming tool-call reconstruction and timing instrumentation.

---

## Features

### Core

- **OpenAI-compatible `POST /chat/completions`** — accepts `messages`, `tools`, `stream`, and the standard response shape.
- **True streaming** — SSE `chat.completion.chunk` deltas, terminated by `data: [DONE]`. No buffering.
- **Non-streaming** — set `stream: false` for a single `chat.completion` object.
- **Tool calls (beta)** — Mercury has no native function calling. Tools are described in a prompt and `[TOOL_CALL]: {...}` lines are parsed back into OpenAI's `tool_calls` structure, streamed in the same fragmented format OpenAI uses (`id` + `function.name` first, then `arguments` deltas, then `finish_reason: "tool_calls"`).
- **Web search** — `search: true` enables Mercury's built-in web search. Sources are returned as an OpenAI-style `sources` array and `<SEARCHING>` / `<FINISHED_SEARCHING>` markers are surfaced as content deltas so text-only clients can show progress.
- **Reasoning levels** — `intelligence: 0–3` maps to Mercury's `instant` / `low` / `medium` / `high`.
- **Conversation reuse** — pass the same `chatId` to keep the same upstream conversation across requests. Omit it and a UUID is generated per request.

### Infrastructure

- **TLS fingerprint impersonation** — uses [`impit`](https://www.npmjs.com/package/impit), which wraps Rust's `reqwest` with real browser TLS/HTTP2 fingerprints. Node's native `fetch`/`axios` present an OpenSSL fingerprint that Vercel's bot protection flags; `impit` does not.
- **Multi-client rotation** — a pool of `Impit` instances, each optionally bound to a different upstream proxy. `get_best_client()` picks the healthiest one based on chat count and proxy status.
- **Proxy pool** — load a list of `http://host:port` proxies from a file. Each proxy becomes its own client. Unhealthy proxies are marked `unreachable` and skipped.
- **Automatic failover** — 401/403 invalidates the token and retries with a fresh one. 429 marks the client `rate-limited` for 60 s. Timeouts and network errors mark it `unreachable` for 1 hour. A background searcher continuously probes for a working client.
- **Timing instrumentation** — the final `stop` chunk carries a `timing` object with time-to-first-token, total streaming time, and tokens/sec.
- **`POST /decide/run`** — pass-through to Inception's Decide API with auth injection and automatic retry on token rejection.
- **`GET /health`** — `{ status, token_loaded }` for liveness checks.

---

## Measured performance

Benchmarked against the upstream with a warm client. Numbers are approximate and will vary by region, time of day, and upstream load.

### No proxy (default — uses your machine directly)

| Metric | Input/output < 75k tokens | Input/output > 75k tokens |
|---|---|---|
| Time to first token | **~200–600 ms** | **~1–7 s** |
| Throughput | **~954–1279 t/s** | **~717–924 t/s** |
| Tool-call reliability (beta) | **~87 %** | **~62 %** |

**Reading the table:** short prompts start fast and stream fast. Long prompts (over 75k input or output tokens) pay a visible TTFT penalty because the model has more context to process before the first token; throughput also drops ~20–30 %. Tool-call reliability degrades on long conversations because the `[TOOL_CALL]` marker is more likely to be split across chunks or wrapped in markdown fences by the model — the parser handles both, but not perfectly.

### With a proxy

Proxy overhead depends entirely on the node. A healthy datacenter proxy adds ~50–150 ms to TTFT and roughly the same throughput. A dead or overloaded proxy will fail the 4-second session timeout and be marked `unreachable`.

---

## Upstream limits you should know

These are hard limits enforced by `chat.inceptionlabs.ai`, not by this proxy:

| Limit | Value | Notes |
|---|---|---|
| Requests per second per IP | **30 req/s** | No token-rate limit, just request-rate. Exceed it and you get a `429`. |
| Maximum context | **1,000,000 tokens** | You can send up to 1M tokens in a single request without issues. |
| Recommended context | **< 750,000 tokens** | Beyond ~750k, performance degrades noticeably (see the table above). Keep it lower for production use. |

If you run multiple proxies, each gets its own 30 req/s budget. That is the main reason the proxy pool exists — not to bypass the limit, but to spread load across IPs so no single one saturates.

---

## Installation

### Prerequisites

- **Node.js 20.18.1 or newer** (required by `undici@7`, which `impit` depends on). Node 22 LTS is recommended.
- **npm** (comes with Node).

On Windows, if `npm` fails with `running scripts is disabled`, either:

```powershell
Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned
```

or use `npm.cmd` instead of `npm`.

### Steps

```bash
git clone https://github.com/<you>/inception-openai-proxy.git
cd inception-openai-proxy
npm install
```

Create `config.json` (see below), then:

```bash
node server.js
```

The proxy listens on `http://localhost:8101` by default. Override with `PORT`:

```bash
PORT=9000 node server.js
```

---

## Configuration (`config.json`)

`server.js` reads `./config.json` at startup. The file is required — if it is missing, the process exits immediately with `Error reading config file`.

### Minimal config (no proxy)

```json
{
  "browser": { "type": "chrome" },
  "proxy": { "enabled": false }
}
```

### Full config

```json
{
  "browser": {
    "type": "chrome"
  },
  "proxy": {
    "enabled": true,
    "path": "./proxies.txt"
  }
}
```

### Field reference

| Field | Type | Default | Description |
|---|---|---|---|
| `browser.type` | string | `"chrome"` | Browser profile `impit` impersonates. Valid values: `"chrome"`, `"firefox"`, `"edge"`. This controls the TLS ClientHello, HTTP/2 settings, header order, and ALPN list sent to the upstream. |
| `proxy.enabled` | boolean | `false` | When `true`, the proxy pool is loaded from `proxy.path` and clients are created per proxy. When `false`, a single direct client is used. |
| `proxy.path` | string | `"./proxies.txt"` | Path to a newline-delimited list of `http://host:port` proxies. Only lines that contain `http://` and `:` are kept. |

### Behaviour

- If `proxy.enabled` is `true` but `proxy.path` is missing or the file is empty, the server logs a warning and exits — it does not silently fall back to direct.
- If `proxy.enabled` is `false`, `proxy.path` is ignored.
- `browser.type` is applied to every client, proxied or not.

---

## Proxy pool

Free public proxies are unreliable — expect 40–60 % to be dead at any moment. The pool is designed around that reality.

### `proxies.txt` format

One proxy per line, `http://host:port`, nothing else:

```
http://130.110.103.245:3128
http://38.123.220.105:999
http://79.106.231.17:8080
```

- Lines are split on `\r\n`, so Windows line endings are fine.
- Empty lines and lines without `http://` are filtered out at load.
- Do **not** include `https://` — most free proxies speak plain HTTP and tunnel HTTPS via `CONNECT`. If the node genuinely supports TLS, `http://` still works because `impit` will negotiate it during the CONNECT.

### How rotation works

1. On startup, one direct client is created (`use_proxy: false`, `index: 0`).
2. Each call to `get_best_client()` sorts active clients by `use_proxy` (direct first), then by `chats` (fewest first). If none are active, it calls `create_new_proxy_client()`, which pops the next proxy off `PROXY_LIST`, creates an `Impit` instance bound to it, and adds it to the pool.
3. When a request fails:
   - **401 / 403** → token is invalidated, the same client is retried once with a fresh token.
   - **429** → the client is marked `rate-limited` for 60 s, then reactivated automatically.
   - **Timeout / network error** → the client is marked `unreachable` for 1 hour.
4. A background `search_for_proxy(true)` loop runs every 10 s, probing for a working client so the pool stays warm even when no requests are coming in.

### Important

The proxy pool is **not** a way to circumvent the 30 req/s per-IP limit. Each proxy gets its own budget because it has its own IP, but the limit still applies to each one. If you push more than 30 req/s through a single proxy, you will get 429s on that proxy.

---

## API reference

### `POST /chat/completions`

OpenAI-compatible chat completions.

**Request body**

| Field | Type | Default | Description |
|---|---|---|---|
| `messages` | array | `[]` | OpenAI-format messages. See [Message format](#message-format). |
| `stream` | boolean | `true` | `true` for SSE, `false` for a single JSON response. |
| `tools` | array | `[]` | OpenAI-format tool definitions. See [Tool calls](#tool-calls). |
| `intelligence` | number \| string | `2` | Reasoning level. `0` = instant, `1` = low, `2` = medium, `3` = high. Also accepts the level name. |
| `search` | boolean | `false` | Enable Mercury's web search. |
| `chatId` | string | random UUID | Reuse the same value to keep the same upstream conversation. |

**Response (streaming)** — SSE stream of `chat.completion.chunk` objects, terminated by `data: [DONE]`.

**Response (non-streaming)** — a single `chat.completion` object.

**Errors** — returned as `{ "error": { "message": "...", "type": "..." } }` with an appropriate status code:

| Status | Meaning |
|---|---|
| `400` | Upstream error, malformed request, or proxy error. `error.type` is `proxy_error` or `invalid_request_error`. |
| `413` | Context length exceeded. `error.code` is `context_length_exceeded`. |
| `429` | Upstream rate limit. `error.code` is `too_many_requests`. |
| `500` | Unexpected proxy failure. |

---

### `POST /decide/run`

Pass-through to Inception's Decide API with auth injection and retry on token rejection. The request body is forwarded largely as-is after validation.

**Request body**

| Field | Type | Required | Description |
|---|---|---|---|
| `state` (or `system`, `prompt`, `system_prompt`) | string | yes | The system prompt / context for the decision. |
| `questions` | array | yes | One or more question objects. Each needs an `id`, `name`, `type` (`noul`, `choice`, `score`), and an `instructions` (or `question`, `title`, `subject`, `q`) field. |
| `images` | array | no | Base64 images to attach to the decision. |

Aliases for `type`: `binery`, `binary`, `yes_no`, `yes/no`, `probability`, `rate` are all mapped to `noul`.

Missing `id`, `name`, and option `description` fields are filled in automatically.

---

### `GET /health`

```json
{ "status": "ok", "token_loaded": true }
```

`token_loaded` reflects whether the proxy currently holds a session token. Useful as a liveness/readiness probe.

---

## Message format

The proxy accepts standard OpenAI messages and converts them to Mercury's `parts` array internally.

### Supported roles

| Role | Conversion |
|---|---|
| `system` | Converted to a user message prefixed with `[SYSTEM]: ` |
| `user` | Converted to a user message with a single text part |
| `assistant` | Converted to an assistant message with a reasoning part and a text part. If `tool_calls` are present, they are rendered as `[TOOL_CALL]: {...}` lines appended to the text. |
| `tool` | Converted to a user message prefixed with `[TOOL_RESULT id=<tool_call_id>]: ` |

### Content arrays

`content` may be a string or an array of parts. For arrays, only `part.text` is extracted and the parts are joined with a space. Images and other part types are **not** forwarded to Mercury — this is a text-only adapter.

### Example

```json
{
  "messages": [
    { "role": "system", "content": "You are a helpful assistant." },
    { "role": "user", "content": "What is the weather in Paris?" },
    { "role": "assistant", "content": null, "tool_calls": [
      { "id": "call_abc", "type": "function",
        "function": { "name": "get_weather", "arguments": "{\"city\":\"Paris\"}" } }
    ]},
    { "role": "tool", "tool_call_id": "call_abc",
      "content": "{\"temperature\":18,\"conditions\":\"cloudy\"}" }
  ]
}
```

---

## Tool calls

Mercury has **no native function calling**. The proxy implements tool calls by:

1. **Injecting a system prompt.** When `tools` is non-empty, `buildToolsSystemPrompt()` renders each tool's name, description, and JSON Schema into a user message followed by an assistant acknowledgement. The prompt instructs the model to emit calls in exactly this format:

   ```
   [TOOL_CALL]: {"name": "get_weather", "arguments": {"city": "Paris"}}
   ```

2. **Parsing those markers out of the stream.** `ToolAwareStreamer` buffers incoming deltas so a partial `[TOOL_CALL]` marker is never emitted as normal content. Once the stream ends, `extractToolCalls()` walks the buffer with a brace-balancing JSON scanner (string-aware, escape-aware) and rebuilds each call.

3. **Re-emitting them in OpenAI's format.** `streamToolCalls()` produces:

   - First chunk per call: `tool_calls[].id`, `type: "function"`, `function.name`, `function.arguments: ""`.
   - N chunks with `function.arguments` deltas (8 chars each).
   - Final chunk: `finish_reason: "tool_calls"`.

### Reliability

Tool-call reliability is **~87 % on short conversations** and **~62 % on conversations over 75k tokens**. Failures fall into three buckets:

- The model wraps the JSON in markdown fences — the parser strips ` ```json ` and ` ``` ` before scanning, so most of these recover.
- The JSON contains a `}` inside a string value — the brace counter is string- and escape-aware, so this is handled.
- The stream ends mid-JSON (upstream timeout, rate limit mid-generation) — the parser skips the malformed call and keeps the surrounding text as content.

### Tool definition format

Standard OpenAI:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get the current weather for a city.",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string" },
        "unit": { "type": "string", "enum": ["celsius", "fahrenheit"] }
      },
      "required": ["city"]
    }
  }
}
```

Bare function objects (`{ "name": ..., "description": ..., "parameters": ... }` without the `type`/`function` wrapper) are also accepted.

---

## Streaming markers and timing

### Search markers

When `search: true` and the model searches, two string markers appear inside `delta.content`:

- `<SEARCHING>` — emitted once when the upstream starts a web search.
- `<FINISHED_SEARCHING>` — emitted once before the answer text begins.

Sources are attached as a `sources` array on a separate content chunk:

```json
{
  "choices": [{
    "delta": {
      "role": "assistant",
      "content": "",
      "sources": [
        {
          "url": "https://example.com",
          "title": "Example",
          "snippet": "",
          "cite_index": 1,
          "published_at": null,
          "site_name": "example.com",
          "query_indexes": [0]
        }
      ]
    }
  }]
}
```

Clients that understand sources can render citations; clients that don't will ignore the field.

### Timing

The final `stop` chunk carries a `timing` object:

```json
{
  "choices": [{ "delta": {}, "finish_reason": "stop" }],
  "usage": { "prompt_tokens": 42, "completion_tokens": 318, "total_tokens": 360 },
  "timing": {
    "first_token_time": 412,
    "streaming_time": 3081,
    "speed": 47
  }
}
```

| Field | Meaning |
|---|---|
| `first_token_time` | Milliseconds from request start to the first content delta. |
| `streaming_time` | Milliseconds from the first content delta to the last. |
| `speed` | Tokens per second, computed as `completion_tokens / (streaming_time / 1000)`. |

---

## Examples

### OpenAI Python SDK

```python
from openai import OpenAI

client = OpenAI(
    base_url="http://localhost:8101",
    api_key="unused",
)

# Streaming
for chunk in client.chat.completions.create(
    model="mercury",
    messages=[{"role": "user", "content": "Explain diffusion models in one paragraph."}],
    stream=True,
    extra_body={"intelligence": 2, "search": False},
):
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### OpenAI Node SDK

```javascript
import OpenAI from "openai";

const client = new OpenAI({
  baseURL: "http://localhost:8101",
  apiKey: "unused",
});

const stream = await client.chat.completions.create({
  model: "mercury",
  messages: [{ role: "user", content: "What's the weather in Paris?" }],
  tools: [{
    type: "function",
    function: {
      name: "get_weather",
      description: "Get the current weather for a city.",
      parameters: {
        type: "object",
        properties: { city: { type: "string" } },
        required: ["city"],
      },
    },
  }],
  stream: true,
  extra_body: { intelligence: 1, search: false },
});

for await (const chunk of stream) {
  const delta = chunk.choices[0]?.delta;
  if (delta?.content) process.stdout.write(delta.content);
  if (delta?.tool_calls) console.log("tool:", delta.tool_calls);
}
```

### curl (streaming)

```bash
curl -N http://localhost:8101/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What is 2+2?"}],
    "stream": true,
    "intelligence": 1
  }'
```

### curl (web search)

```bash
curl -N http://localhost:8101/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "What did the BBC publish today?"}],
    "stream": true,
    "search": true,
    "intelligence": 2
  }'
```

### Multi-turn with conversation reuse

```bash
# Turn 1
curl http://localhost:8101/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "messages": [{"role": "user", "content": "My name is Sam."}],
    "stream": false,
    "chatId": "session-42"
  }'

# Turn 2 — same chatId, model remembers
curl http://localhost:8101/chat/completions \
  -H "content-type: application/json" \
  -d '{
    "messages": [
      {"role": "user", "content": "What is my name?"}
    ],
    "stream": false,
    "chatId": "session-42"
  }'
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error reading config file` at startup | `config.json` missing | Create it (see [Configuration](#configuration-configjson)). |
| `proxy list is empty, but config.proxy.enabled is true` | `proxies.txt` missing or empty | Disable the proxy or add proxies. |
| `Cannot read properties of undefined (reading 'getReader')` | `parseStream` received `undefined` — the upstream call failed before returning a body | Check the `[STREAM] Error` log line above it. Usually a timeout or 429. |
| Requests hang for ~30 s then fail | `AbortSignal.timeout` not applied — options were passed as a third argument to `impit.fetch` | All options must be in the **second** argument: `fetch(url, { headers, signal, timeout, body })`. |
| `TypeError: Cannot read properties of undefined (reading 'bind')` in `undici` | Node < 22.15 lacks `zlib.createZstdDecompress` | Upgrade Node to 22.15+ or 24. |
| `429 Too Many Requests` from upstream | >30 req/s on one IP | Add proxies or throttle. |
| `413 context_length_exceeded` | >1M tokens | Reduce message length. |
| Tool calls never appear | Model did not emit `[TOOL_CALL]` | See [Tool calls](#tool-calls). Try a shorter prompt. |
| `stream ended without [DONE]` | Upstream dropped the connection | Retry. The proxy's `finally` block closes the response cleanly. |

---

## Legal

This project is provided **as-is**, for **educational and research purposes only**.

- It is **not** affiliated with, endorsed by, or supported by Inception Labs or Vercel.
- Using it against Inception's production endpoints may violate their Terms of Service.
- Using it to circumvent Vercel's bot protection may violate Vercel's Acceptable Use Policy.
- The proxy pool is intended for load distribution and resilience, **not** for evading rate limits or access controls.
- You are solely responsible for ensuring your use complies with all applicable laws, terms of service, and policies.

See [`WARNING.txt`](./WARNING.txt) for the full notice. If you do not agree with it, do not run this code.

---

## License

MIT
</｜｜DSML｜｜ parameter>
</｜｜DSML｜｜ invoke>
</｜｜DSML｜｜ calls>
