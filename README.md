# Mercury AI Proxy

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)

**Free, unlimited access to [Mercury](https://chat.inceptionlabs.ai) — the same model behind Inception Labs' paid API — by routing requests through their free chat endpoint and exposing it as a fully OpenAI-compatible local server.**

This proxy gives you free acsess to Mercury-3 for free: including streaming, tool calls (~85% reliability), and up to 1,000,000 tokens of context. The included 1,900+ proxy list gives each proxy its own 30 req/min budget from Mercury's backend (1,900 × 30 = **57,000 req/min**), and rolling session management automatically switches proxies before you hit a limit — so long agentic runs never get cut off. In local testing on a consumer PC, we reached **927 req/s** before stopping.

Personally used with [OpenCode](https://opencode.ai). Experimental and educational use only — see [Legal](#legal).

> **⚠️ Educational use only.** This project exists to demonstrate how an OpenAI-compatible adapter can be built against a streaming upstream that does not natively expose the OpenAI wire format. It is **not** intended for abuse, resale, circumvention of access controls, or any use that violates Inception Labs' or Vercel's Terms of Service. See [`WARNING.txt`](./WARNING.txt) before running it. You are responsible for how you use this code.

---

## What it does

Mercury's paid API isn't free, but their public web chat is. This proxy sits between you and that chat endpoint, handling session tokens, request formatting, and response parsing — then hands everything back in the OpenAI wire format your tools already understand.

It also solves a throughput problem. Mercury limits each IP to **30 requests per minute**. With a pool of proxies, each one gets its own independent 30 req/min budget. The included `proxies.txt` ships with **1,900+ proxies**, giving a theoretical ceiling of **57,000 requests per minute**. In local testing we reached **927 req/s** before stopping — and it likely goes higher.

When a session approaches its limit on the current proxy, the proxy automatically rolls to the next one — no dropped requests, no manual intervention required.

```
Your PC running the worker  ==>  Free Proxy  ==> chat.inceptionlabs.ai
```

---

## Features

- **OpenAI-compatible API** — `POST /chat/completions` with streaming, tool calls, and non-streaming modes. Works with any OpenAI SDK, CLI tool, or editor integration out of the box.
- **Free access to Mercury** — routes through the public chat endpoint. The paid API gives the same model; this gives it to you at no cost.
- **Up to 1,000,000 token context** — the full Mercury window. Recommended to compact around 500k tokens to avoid quality degradation.
- **Tool calls with ~85% reliability** — Mercury has no native function calling. The proxy adds it by injecting tool definitions as a system prompt, parsing the model's structured output, and re-emitting it as standard OpenAI `tool_calls`. Reliability drops to ~62% on conversations over 75k tokens.
- **Automatic proxy rotation** — a background health checker keeps the pool warm. Dead proxies are quarantined for an hour, rate-limited ones for 60 seconds. When all active proxies are exhausted, a fresh one is pulled from the list automatically.
- **57,000+ req/min theoretical throughput** — 1,900+ proxies × 30 req/min each. Real-world tested to 927 req/s on a consumer machine.
- **Web search** — pass `"search": true` to let Mercury search the web; sources come back as a cited array in the response.
- **Follow-ups endpoint** — `POST /chat/follow-ups` returns deduplicated suggested follow-up questions.
- **Decide API** — `POST /decide/run` exposes Inception's structured classification/scoring endpoint with auto-injected auth.
- **Timing data** — every streaming response ends with time-to-first-token, total streaming time, and tokens/sec.

---

## Performance

Benchmarked locally, single machine, no proxy:

| Context size | Time to first token | Throughput |
|---|---|---|
| < 75k tokens | ~200–600 ms | ~954–1,279 t/s |
| > 75k tokens | ~1–7 s | ~717–924 t/s |

**Tool call reliability:** ~85% on short conversations, ~62% on conversations over 75k tokens.

With proxies enabled, throughput scales with how many are active in the pool. Each proxy gets its own independent 30 req/min budget from Mercury's backend — the 927 req/s figure above was achieved by spreading load across the proxy pool on a single consumer machine.

---

## Quick start

**Requirements:** Node.js 20.18.1 or newer (Node 22 LTS recommended)

```bash
git clone https://github.com/radman-radco/Inception_Mercury_proxy
cd Inception_Mercury_proxy
npm install
```

Create `config.json` in the project root:

```json
{
  "browser": { "type": "chrome" },
  "proxy": { "enabled": false }
}
```

Start the server:

```bash
node server.js
```

The proxy listens on `http://localhost:8101`. **Wait about 30 seconds on first start** while it finds and validates a working session before sending requests.

To use a different port: `PORT=9000 node server.js`

> **Windows note:** if `npm install` fails with a script execution error, run `Set-ExecutionPolicy -Scope CurrentUser -ExecutionPolicy RemoteSigned` in PowerShell first.

---

## Enabling the proxy pool

For higher throughput, enable the included proxy list. This is what unlocks the 57,000 req/min ceiling.

```json
{
  "browser": { "type": "chrome" },
  "proxy": {
    "enabled": true,
    "path": "./proxies.txt"
  }
}
```

`proxies.txt` ships with 1,900+ public proxies in `http://host:port` format. Free proxies are unreliable — expect 40–60% to be dead at any given moment. The pool handles this: failed proxies are marked unreachable, healthy ones are prioritised, and a background worker keeps probing so there's always a live option ready.

**Format** (one per line):
```
http://130.110.103.245:3128
http://38.123.220.105:999
```

Each proxy gets its own Mercury session and its own 30 req/min budget. The proxy rotation is rolling — when a session's limit is approaching, the next proxy is picked automatically before the current one starts failing.

---

## Usage

Point any OpenAI-compatible client at `http://localhost:8101`. The API key field is ignored — pass anything.

### Python

```python
from openai import OpenAI

client = OpenAI(base_url="http://localhost:8101", api_key="unused")

for chunk in client.chat.completions.create(
    model="mercury",
    messages=[{"role": "user", "content": "Explain diffusion models in one paragraph."}],
    stream=True,
    extra_body={"intelligence": 2},
):
    if chunk.choices[0].delta.content:
        print(chunk.choices[0].delta.content, end="", flush=True)
```

### Node.js

```javascript
import OpenAI from "openai";

const client = new OpenAI({ baseURL: "http://localhost:8101", apiKey: "unused" });

const stream = await client.chat.completions.create({
  model: "mercury",
  messages: [{ role: "user", content: "What is 2 + 2?" }],
  stream: true,
  extra_body: { intelligence: 1 },
});

for await (const chunk of stream) {
  const content = chunk.choices[0]?.delta?.content;
  if (content) process.stdout.write(content);
}
```

### curl

```bash
curl -N http://localhost:8101/chat/completions \
  -H "content-type: application/json" \
  -d '{"messages":[{"role":"user","content":"Hi"}],"stream":true}'
```

### Request fields

| Field | Type | Default | Description |
|---|---|---|---|
| `messages` | array | — | Standard OpenAI message array |
| `stream` | boolean | `true` | `true` for server-sent events, `false` for a single JSON response |
| `tools` | array | `[]` | OpenAI-format tool definitions |
| `intelligence` | 0–3 | `2` | Reasoning depth: `0` instant · `1` low · `2` medium · `3` high |
| `search` | boolean | `false` | Enable Mercury's web search |
| `chatId` | string | random UUID | Reuse to continue the same upstream conversation |
| `max_tokens` | number | `2000` | Stop after this many completion tokens |

---

## Context and long sessions

Mercury supports up to **1,000,000 tokens** in a single request — the same limit as the paid API. For agentic or multi-turn workflows, the proxy handles session rotation automatically — a session expiring mid-task won't interrupt your run.

Quality starts to degrade past ~500k–750k tokens. For anything long-running, it's worth compacting your context around the 500k mark.

---

## Endpoints

### `POST /chat/completions`
Main chat endpoint. Fully OpenAI-compatible.

---

### `POST /chat/follow-ups`
Returns a list of suggested follow-up questions for a conversation.

**Request:**
```json
{ "messages": [...], "count": 3 }
```

**Response:**
```json
{ "success": true, "follow_ups": ["Question 1", "Question 2", "Question 3"], "latencyMs": 420 }
```

`count` must be between 1 and 20. Duplicates are removed automatically.

---

### `POST /decide/run`
Exposes Inception's structured decision API for binary questions, scoring, and multiple-choice classification — with automatic auth injection.

**Request:**
```json
{
  "state": "You are evaluating customer sentiment.",
  "questions": [
    {
      "type": "noul",
      "instructions": "Is this message positive?",
      "options": [
        { "id": "y", "description": "Yes" },
        { "id": "n", "description": "No" }
      ]
    }
  ]
}
```

Accepted question types: `noul` (binary/yes-no), `choice`, `score`. Aliases like `binary`, `yes_no`, and `probability` are mapped automatically.

---

### `GET /health`
Liveness check.

```json
{ "status": "ok", "token_loaded": true }
```

---

## Tool calls

Mercury has no native function calling. The proxy adds it by:

1. Injecting your tool definitions into the system prompt before each request.
2. Asking the model to emit calls in a structured format when it needs to use a tool.
3. Parsing that output and re-emitting it as OpenAI's standard `tool_calls` structure — streamed in the same fragmented format OpenAI uses.

**Reliability: ~85% on short conversations, ~62% on conversations over 75k tokens.** Longer context increases the chance the model reformats the marker. The parser handles markdown-fenced JSON and most common formatting variations, but it isn't perfect.

**Tool definition format** — standard OpenAI:

```json
{
  "type": "function",
  "function": {
    "name": "get_weather",
    "description": "Get current weather for a city.",
    "parameters": {
      "type": "object",
      "properties": {
        "city": { "type": "string" }
      },
      "required": ["city"]
    }
  }
}
```

---

## Troubleshooting

| Symptom | Cause | Fix |
|---|---|---|
| `Error reading config file` at startup | `config.json` is missing | Create it — see [Quick start](#quick-start) |
| `proxy list is empty` error | `proxies.txt` is missing or empty, but proxy is enabled | Add proxies or set `"enabled": false` |
| Requests hang for ~30s then fail | A session timeout or upstream error | Check the log for `[STREAM] Error` just above the hang |
| `TypeError: zlib.createZstdDecompress` | Node.js version is too old | Upgrade to Node 22.15+ |
| `429 Too Many Requests` | Exceeded 30 req/min on your current proxy IP | Enable the proxy pool and add more proxies |
| `413 context_length_exceeded` | Message history is over 1M tokens | Compact your context |
| Tool calls never appear | Model didn't emit the structured marker | Try a shorter conversation; tool call reliability drops on long context |

---

## Contributing

Forks and pull requests are welcome. If you fork or redistribute this project, your version must carry the GPL v3 license.

---

## Legal

This project is released under **GPL v3**. Free to use and modify; any distributed modifications must include this license. **Not for commercial use. Experimental only.**

This project is not affiliated with or endorsed by Inception Labs or Vercel. Using it against Inception's production endpoints may conflict with their Terms of Service — you're solely responsible for your usage. Read [`WARNING.txt`](./WARNING.txt) before running.

[![License: GPL v3](https://img.shields.io/badge/License-GPLv3-blue.svg)](https://www.gnu.org/licenses/gpl-3.0)
