# How the Mercury Proxy Works — Full Technical Breakdown

This document covers every moving part of `server.js` in depth: how data flows from your client to Mercury and back, how the proxy pool manages state, how tool calls are faked, and what happens at every failure mode.

---

## Table of contents

1. [Architecture overview](#1-architecture-overview)
2. [Startup and config loading](#2-startup-and-config-loading)
3. [The client pool](#3-the-client-pool)
4. [TLS fingerprint impersonation](#4-tls-fingerprint-impersonation)
5. [Session token management](#5-session-token-management)
6. [Background proxy searcher](#6-background-proxy-searcher)
7. [Request routing — `callInception`](#7-request-routing--callinception)
8. [Error handling and retry logic](#8-error-handling-and-retry-logic)
9. [Message format conversion](#9-message-format-conversion)
10. [Tool call injection](#10-tool-call-injection)
11. [Token counting](#11-token-counting)
12. [Conversation ID management](#12-conversation-id-management)
13. [Stream parsing — Mercury SSE → typed events](#13-stream-parsing--mercury-sse--typed-events)
14. [ToolAwareStreamer — holding back tool call markers](#14-toolawarestreamer--holding-back-tool-call-markers)
15. [Tool call extraction](#15-tool-call-extraction)
16. [Streaming response handler](#16-streaming-response-handler)
17. [Non-streaming response handler](#17-non-streaming-response-handler)
18. [Timing instrumentation](#18-timing-instrumentation)
19. [The `/decide/run` endpoint](#19-the-deciderun-endpoint)
20. [The `/chat/follow-ups` endpoint](#20-the-chatfollow-ups-endpoint)
21. [Complete request lifecycle](#21-complete-request-lifecycle)

---

## 1. Architecture overview

The proxy is a Node.js/Express HTTP server. It sits between your client (any OpenAI SDK or tool) and Mercury's private chat API at `chat.inceptionlabs.ai`.

```
Your client (OpenAI SDK, OpenCode, curl…)
        │
        │  POST /chat/completions
        ▼
    Mercury Proxy  (localhost:8101)
        │
        │  POST /api/chat  (Mercury's private SSE API)
        │  x-session-token: <short-lived token>
        │  TLS fingerprint: Chrome 155
        │  via: proxy IP from pool (optional)
        ▼
    chat.inceptionlabs.ai  (Vercel edge + Mercury backend)
```

The proxy does five core jobs:

1. **Auth** — obtains and caches Mercury's short-lived session tokens, refreshes them on rejection.
2. **Fingerprinting** — impersonates a real browser's TLS handshake so Vercel's bot protection doesn't block the connection.
3. **Format translation** — converts your OpenAI-format request into Mercury's internal format, and translates the response SSE stream back into the OpenAI wire format.
4. **Tool calls** — fakes function calling (which Mercury doesn't have natively) by injecting a system prompt and parsing the model's structured output.
5. **Load distribution** — maintains a pool of clients across multiple upstream proxy IPs, each with its own 30 req/min budget.

---

## 2. Startup and config loading

On startup, the server:

1. **Reads `config.json`** synchronously. If the file is missing, `fs.readFileSync` throws and the process exits with `Error reading config file`. There is no fallback — the config is required.

2. **Loads the proxy list** (if `config.proxy.enabled === true`). The file at `config.proxy.path` is read, split on `\r\n`, and filtered down to lines that contain both `http://` and `:`. This is a loose format check — it doesn't validate that the IP or port are real. If the filtered list is empty after loading, the process exits. If `proxy.enabled` is true but the file doesn't exist at all, `fs.readFileSync` throws and the process also exits.

3. **Creates the initial direct client** — a single `Impit` instance with no upstream proxy, `index: 0`, `use_proxy: false`. This is always present in the pool regardless of whether proxy mode is enabled.

4. **Starts the background proxy searcher** via `search_for_proxy(true)` — this immediately finds and validates a working client/token before any requests come in. The 30-second startup delay mentioned in the README is this process running.

---

## 3. The client pool

The pool is a plain JavaScript array called `clients`. Each entry looks like:

```js
{
  use_proxy: false,         // true if routed through an upstream proxy
  client: Impit { ... },   // the actual HTTP client instance
  status: "active",        // "active" | "rate_limited" | "unreachable"
  successfull_reqs: 0,     // count of successful requests (used for scoring)
  proxy_url: "http://...", // present only when use_proxy is true
  index: 0                 // position in the clients array
}
```

### `get_best_client()`

Picks the healthiest client:

1. Sorts the full pool by `successfull_reqs` descending (most reliable first).
2. Re-sorts by `use_proxy` ascending — `false` (direct connection) sorts before `true` (proxied). This means the direct connection is always tried first if it's healthy.
3. Filters to only entries where `status === "active"`.
4. If the filtered list is empty — all known clients are rate-limited or unreachable — calls `create_new_proxy_client()` to pull a fresh one from `PROXY_LIST`.

### `create_new_proxy_client()`

1. Checks that proxy mode is enabled and that `PROXY_LIST` is not empty. If either fails, returns `{ success: false, error: "..." }`.
2. Pops the first proxy off `PROXY_LIST` with `splice(0, 1)` — this is destructive; each proxy is only used once.
3. Creates a new `Impit` instance bound to that proxy URL.
4. Pushes a new client object onto `clients` with `index: clients.length` and `status: "active"`.
5. Calls `invalidateToken()` — the new client has a fresh IP so it needs its own session token, not the previous client's.

### Client status transitions

| Status | Trigger | Duration | Recovery |
|---|---|---|---|
| `active` | Default / recovered | — | — |
| `rate_limited` | 429 on `/api/chat` | 60 seconds (1 min on `/api/chat`; 5 min on `/api/session`) | `setTimeout` resets to `active` |
| `unreachable` | Timeout / network error / connection refused | 1 hour | `setTimeout` resets to `active` |

The status check is conditional: if the status changed to something else during the timeout window (e.g., the user restarted), the reset is skipped:

```js
setTimeout(() => {
  if (clients[index].status === "unreachable") clients[index].status = "active";
}, 1 * 60 * 60 * 1000);
```

---

## 4. TLS fingerprint impersonation

Mercury's web app is served via Vercel, which runs bot detection on incoming TLS connections. Node.js's native `fetch` and `axios` present an OpenSSL TLS ClientHello fingerprint — identifiable as a bot because no real browser uses OpenSSL directly for HTTPS.

The proxy uses [`impit`](https://www.npmjs.com/package/impit), an npm package wrapping Rust's `reqwest` library. `reqwest` with browser impersonation sends a real Chrome or Firefox TLS ClientHello, including:

- Matching cipher suites and their order
- Real ALPN extensions (`h2`, `http/1.1`)
- Correct HTTP/2 settings frames
- Matching header order and capitalisation

This makes the connection look indistinguishable from a real browser to Vercel's bot protection. `impit` is configured with `browser.type` from `config.json` (`"chrome"`, `"firefox"`, or `"edge"`).

In addition to TLS impersonation, every request includes a full set of browser-realistic headers:

```js
const HEADERS = {
  "user-agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
  "sec-ch-ua": '"Microsoft Edge";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  // ... and several more
};
```

---

## 5. Session token management

Mercury's API requires an `x-session-token` header on every request. This token is short-lived and obtained from `/api/session`.

### Token lifecycle

```
token = null  (initial / after invalidation)
     │
     │  First request arrives
     ▼
getToken(best_client)
     │
     ├─ token already set → return it immediately
     │
     └─ tokenPromise already running → await that same promise (deduplication)
          │
          └─ neither → fetchToken(best_client)
                  │
                  │  GET /api/session
                  ▼
              token = data.token  (stored globally)
              return token
```

### Deduplication

`tokenPromise` prevents multiple concurrent token fetches when several requests arrive at startup before the first token is ready:

```js
tokenPromise ??= fetchToken(best_client)
  .then((t) => { token = t; return t; })
  .finally(() => { tokenPromise = null; });
return tokenPromise;
```

The `??=` means: "if `tokenPromise` is null/undefined, assign this new Promise; otherwise use the one already running." All concurrent callers await the same Promise.

### `build_cookies(token)`

Mercury reads the session token from both a request header and a cookie. The function builds a cookie string:

```js
{
  "x-session-token": token,
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
  "inception_cookie_banner_dismissed": "true"
}
```

Values are `encodeURIComponent`-encoded. The cookie banner flag prevents Mercury's frontend from injecting a consent flow.

### Token invalidation

`invalidateToken()` sets the global `token` to `null`. On the next request, `getToken` runs `fetchToken` again. This is called:

- When a 401 or 403 is received from `/api/chat`
- When a new proxy client is created (new IP needs its own session)
- When `search_for_proxy` starts a new search cycle

---

## 6. Background proxy searcher

`search_for_proxy(loop)` is a background function that keeps the proxy pool warm. It runs immediately on startup and loops every 3 minutes when `loop === true`.

### What it does

```
search_for_proxy(true)
  │
  ├─ proxy not enabled → return immediately
  ├─ already running (proxy_searcher_running === true) → return immediately
  │
  └─ set proxy_searcher_running = true
       │
       └─ loop until a working client+token is found:
              │
              ├─ invalidateToken()
              ├─ get_best_client()
              ├─ fetchToken(best_client)
              │     │
              │     ├─ success → errored = false, increment successfull_reqs, exit loop
              │     │
              │     └─ failure → mark client unreachable for 1 hour
              │                   invalidateToken()
              │                   continue loop (try next client)
              │
              └─ if loop === true: setTimeout(search_for_proxy(true), 3 minutes)
```

This ensures there's always a pre-validated client and token in the pool, so the first actual request doesn't have to wait for a cold token fetch.

---

## 7. Request routing — `callInception`

This is the function that actually hits Mercury's backend.

### Parameters

```js
{
  convId,          // Mercury's internal conversation ID
  messages,        // Mercury-format messages array
  reasoningEffort, // "instant" | "low" | "medium" | "high"
  webSearch        // boolean
}
```

### Request body sent to Mercury

```json
{
  "reasoningEffort": "medium",
  "webSearchEnabled": false,
  "voiceMode": false,
  "timezone": "Europe/London",
  "language": "en-GB",
  "id": "<convId>",
  "messages": [...],
  "trigger": "submit-message"
}
```

The `trigger` field is what Mercury's frontend normally sets when a user hits Enter. Without it the backend may not process the message.

### Timeout

Both `impit`'s internal `timeout` option and `AbortSignal.timeout(120_000)` are set to 120 seconds. `impit.fetch` uses the signal from the second argument, not a third argument — this was a source of a known bug where options passed as a third argument were silently ignored, causing requests to hang indefinitely.

### Return value

Returns `res.body` — a `ReadableStream`. The calling code (`handleStreaming` or `handleNonStreaming`) consumes this stream.

---

## 8. Error handling and retry logic

### In `callInception`

| Response | Action |
|---|---|
| `401` or `403` | Cancel response body. `invalidateToken()`. Throw `TokenRejectedError`. |
| `429` | Mark client `rate_limited` for 60 seconds. Call `search_for_proxy(false)`. Throw `Error("429: rate limited")`. |
| `!== 200` | Read body text. Throw generic error with status + first 300 chars of body. |
| Timeout / `"timeout"` / `"refused"` / `"failed"` / `"rejected"` in error message | Mark client `unreachable` for 1 hour. `invalidateToken()`. Call `search_for_proxy(false)`. Re-throw. |

The error message check is case-insensitive and covers several common failure patterns that impit surfaces differently on Windows vs Linux.

### `callWithRetry`

Wraps `callInception` with a single retry on `TokenRejectedError`:

```js
async function callWithRetry(params) {
  try {
    return await callInception(params);
  } catch (err) {
    if (err instanceof TokenRejectedError) return callInception(params);
    throw err;
  }
}
```

After `invalidateToken()` in `callInception`, the second call will `fetchToken` with the same (or next-best) client and get a fresh token.

### In streaming handler (`handleStreaming`)

The streaming handler has its own retry loop up to 3 attempts:

```js
async function handleStreaming(req, res, ctx, attempt = 1) {
  try { ... }
  catch (err) {
    if (attempt < 3) {
      await new Promise(r => setTimeout(r, 1000)); // 1-second backoff
      return handleStreaming(req, res, ctx, attempt + 1);
    } else {
      // emit error SSE chunk + [DONE]
    }
  }
}
```

The SSE headers are flushed before the first attempt, so the connection to the client stays open across retries.

### Client disconnection

If the client closes the connection mid-stream, an `upstream?.cancel()` is called in the `res.on("close")` handler to stop reading from Mercury's stream and free the connection.

---

## 9. Message format conversion

Mercury's API does not use OpenAI's `{role, content}` format. It uses a `parts` array where each part has a `type` field.

### OpenAI → Mercury

The function `toInceptionMessages(stdMessages, tools)` converts the full message array.

#### If tools are present

Before converting the messages, two extra messages are prepended:

1. A user message containing the tool descriptions system prompt (see §10).
2. An assistant message: `"Understood. I will use [TOOL_CALL]: {...} format when I need to call a tool."`

This primes the model with the expected format before any conversation history.

#### Role conversions

**`system`:**
```js
userMessage(`[SYSTEM]: ${content}`)
```
Wrapped in `[SYSTEM]: ` prefix and sent as a user turn. Mercury has no native system role.

**`user`:**
```js
userMessage(content)
// → { id: randId(), role: "user", parts: [{ type: "text", text: content }] }
```

**`assistant`:**
```js
assistantMessage(content)
// → {
//     id: randId(),
//     role: "assistant",
//     parts: [
//       { type: "reasoning", text: "", state: "done" },
//       { type: "text", text: content, state: "done" }
//     ]
//   }
```
Mercury's assistant messages include a `reasoning` part (which the proxy leaves empty) and a `text` part. If the OpenAI message had `tool_calls`, they are rendered as `[TOOL_CALL]: {...}` lines and appended to the text content — this is how tool call history is preserved across turns.

**`tool`:**
```js
userMessage(`[TOOL_RESULT id=${msg.tool_call_id}]: ${content}`)
```
Tool results are injected as user messages with a prefixed ID so the model knows which call they correspond to.

#### Content array handling

If `content` is an array (OpenAI's multimodal format), only `part.text` values are extracted and joined with a space. Images and other non-text parts are silently discarded — this is a text-only adapter.

---

## 10. Tool call injection

Mercury has no native function calling. The proxy adds it in two parts: injection before the request, and extraction after the response.

### Injection — `buildToolsSystemPrompt(tools)`

Builds a user message that tells the model how to signal tool calls:

```
You have access to the following tools. When you need to call a tool,
emit it on its own line in EXACTLY this format and nothing else on that line:
[TOOL_CALL]: {"name": "<function_name>", "arguments": {<args as JSON object>}}

Rules:
- Only call a tool when you actually need external data to answer.
- You may call multiple tools by emitting multiple [TOOL_CALL] lines.
- After receiving tool results (provided as [TOOL_RESULT] messages), continue your response normally.
- Do NOT fabricate tool results.
- Do NOT explain the tool call in plain text — only emit the [TOOL_CALL] line.

Available tools:
### get_weather
Get the current weather for a city.
Parameters: {"type":"object","properties":{"city":{"type":"string"}},"required":["city"]}
```

Each tool is rendered with its name as a heading, its description, and its full JSON Schema.

Both wrapped (`{type, function: {...}}`) and bare (`{name, description, parameters}`) tool definition formats are accepted.

---

## 11. Token counting

The proxy counts tokens for two purposes: `usage` fields in responses, and enforcing `max_tokens`.

```js
let encoder = null;
try {
  encoder = getEncoding("cl100k_base"); // tiktoken, same encoding as GPT-4
} catch {
  /* fall back */
}

function countTokens(text) {
  if (!encoder) return Math.max(1, Math.floor(text.length / 4));
  return encoder.encode(text, [], []).length;
}
```

If `js-tiktoken` fails to initialise (unusual but possible), it falls back to `text.length / 4`, which is a rough approximation (English averages ~4 chars per token).

`estimatePromptTokens(messages)` walks the message array:
- Starts at 2 (OpenAI overhead)
- Adds 4 per message (role + separator overhead)
- Adds `countTokens(content)` for each message's text

This is an estimate. Mercury counts tokens differently internally, but the number only appears in the `usage` field — it doesn't affect what Mercury actually processes.

---

## 12. Conversation ID management

Mercury tracks conversation state by an `id` field on each request. If you send the same `id`, Mercury continues the same conversation (the model remembers prior messages).

The proxy maps your `chatId` to a random Mercury conversation ID:

```js
const convStore = new Map(); // chatId → convId

function getConvId(chatId) {
  if (convStore.has(chatId)) return convStore.get(chatId);
  const created = randId(); // 16-char alphanumeric
  convStore.set(chatId, created);
  return created;
}
```

If you omit `chatId` from your request, the proxy generates a fresh UUID for it via `crypto.randomUUID()`, so each request gets a new conversation unless you explicitly opt into continuity.

On errors, `deleteConvId(ctx.chatId)` is called — the next request with that `chatId` will get a fresh conversation ID, since the previous conversation's state may be corrupted or stuck.

---

## 13. Stream parsing — Mercury SSE → typed events

Mercury's `/api/chat` response is a server-sent events stream. Its format is not OpenAI's format.

### Mercury's SSE events

```
data: {"type":"source-url","sourceId":"__searching__"}
data: {"type":"source-url","url":"https://...","title":"..."}
data: {"type":"text-delta","delta":"Hello"}
data: {"type":"text-delta","delta":", world"}
data: [DONE]
```

### `parseStream(stream)` — an async generator

Reads the `ReadableStream` from `impit.fetch` using its `getReader()`. Accumulates bytes into `pending`, splits on newlines, and yields typed events:

| Mercury event | Yielded event |
|---|---|
| `sourceId === "__searching__"` | `{ type: "searching" }` |
| `type === "source-url"` with URL | `{ type: "source", url, title }` |
| `type === "text-delta"` | `{ type: "text", content: delta }` |
| `[DONE]` | `{ type: "done" }` — generator returns |

Unknown event types are silently ignored (`return null` from `lineToEvent`).

Partial lines are handled by keeping the last (possibly incomplete) line in `pending` until the next chunk arrives or the stream ends.

---

## 14. ToolAwareStreamer — holding back tool call markers

The core problem: `[TOOL_CALL]: {...}` can arrive split across multiple SSE deltas. If the proxy emits text as it arrives, the client will see `[TOOL_CALL` as normal content before the proxy knows it's a tool call.

`ToolAwareStreamer` buffers the stream and only emits text that is definitely not part of a marker.

### State

```js
this.buf = "";       // everything received so far
this.sent = 0;       // how much of buf has been sent to the client
this.toolMode = false; // true once a full [TOOL_CALL] marker is seen
```

### `feed(delta)` — called on every text event

```
buf += delta
if toolMode → return ""  (swallow everything after a marker)

pending = buf.slice(sent)
markerAt = pending.search(/\[TOOL_CALL\]/i)

if markerAt !== -1:
  toolMode = true
  safeLength = markerAt  (everything before the marker)
else:
  safeLength = pending.length - partialMarkerLength(pending)
  // hold back any trailing fragment that could be the start of a marker

sent += safeLength
return pending.slice(0, safeLength)
```

### `partialMarkerLength(text)`

Checks if the end of `text` could be the beginning of `[TOOL_CALL]`:

```
"...Hello [TOOL"  → returns 6 (length of "[TOOL_")
"...Hello world"  → returns 0 (no potential match)
"...Hello ["      → returns 1 (the "[" could start "[TOOL_CALL]")
```

This prevents e.g. `[TOOL` from being emitted to the client before the next chunk arrives confirming it's `[TOOL_CALL]`.

### `flush()`

Called once after the full stream is consumed. Returns everything in `buf` from `sent` to the end. If no tool calls were found (and `extractToolCalls` confirms this), `flush()` sends the held-back tail to the client.

---

## 15. Tool call extraction

After the stream ends, `extractToolCalls(streamer.buf)` processes the full accumulated text.

### Pre-processing

Strips markdown fences that the model sometimes wraps around JSON:

```js
text = text.replace(/```(?:json)?\s*(\{)/g, "$1").replace(/\}\s*```/g, "}");
```

### Scanning

Uses a regex to find each `[TOOL_CALL]: ` marker. For each one:

1. Finds the first `{` after the marker.
2. Calls `extractJsonObject(text, bracePos)` — a brace-balanced scanner.
3. If a valid JSON object is found, constructs a tool call entry and advances `pos` past the object.
4. Text between markers (and before/after all markers) is accumulated as `cleanText`.

### `extractJsonObject(text, start)`

A character-by-character scanner that:
- Tracks `depth` (increments on `{`, decrements on `}`)
- Tracks `inString` (flips on unescaped `"`)
- Tracks `escaped` (set by `\` inside strings)

Returns `{ value: parsedObject, end: indexAfterClosingBrace }` when depth reaches 0, or `null` if the JSON is incomplete or invalid.

This handles edge cases like `{"key": "value with } inside"}` correctly because `}` inside a string doesn't decrement depth.

### Output

```js
{
  cleanText: "text with [TOOL_CALL] blocks removed and trimmed",
  toolCalls: [
    {
      id: "call_a1b2c3d4",
      type: "function",
      function: {
        name: "get_weather",
        arguments: '{"city":"Paris"}'  // always a string
      }
    }
  ] // null if no calls found
}
```

---

## 16. Streaming response handler

`handleStreaming(req, res, ctx, attempt)` orchestrates the full streaming response.

### Response headers

```js
res.set({
  "Content-Type": "text/event-stream",
  "Cache-Control": "no-cache",
  "Connection": "keep-alive",
  "X-Accel-Buffering": "no",   // prevents nginx from buffering SSE
});
res.flushHeaders();
```

Headers are sent immediately so the client knows streaming has started, even before the first token arrives from Mercury.

### Event loop

```
upstream = callWithRetry(ctx.upstreamParams)

emit: { role: "assistant", content: "" }   ← initial role chunk

for each event from parseStream(upstream):

  "searching":
    if first time: emit content("<SEARCHING>")

  "source":
    push to sources array

  "text":
    closeSearchPhase()     ← emits sources chunk + <FINISHED_SEARCHING> once
    countTokens(content)
    safe = streamer.feed(content)
    if safe: emit content(safe)
    if completionTokens > ctx.max_tokens:
      cancel upstream
      emit finish_reason: "length"
      emit [DONE]
      return

after loop:
  closeSearchPhase()
  extractToolCalls(streamer.buf)

  if toolCalls:
    for each line from streamToolCalls(...): res.write(line)
  else:
    rest = streamer.flush()
    if rest: emit content(rest)
    emit stop chunk with usage + timing

res.write("data: [DONE]\n\n")
```

### `closeSearchPhase()`

A one-shot function (guarded by `searchPhaseClosed` flag) that:
1. Emits the sources array as a chunk (if any sources were found).
2. Emits `<FINISHED_SEARCHING>` as a content delta (if a search was started).

This always fires before any answer text reaches the client.

### `streamToolCalls(id, created, toolCalls)` — a generator

For each tool call in order:

```
yield: { tool_calls: [{ index, id, type: "function", function: { name, arguments: "" } }] }

for each 8-char chunk of arguments string:
  yield: { tool_calls: [{ index, function: { arguments: chunk } }] }

yield: { finish_reason: "tool_calls", delta: {} }
```

This mirrors OpenAI's exact streaming format for tool calls: name comes first in one chunk, then argument fragments, then the finish reason.

---

## 17. Non-streaming response handler

`handleNonStreaming` collects the full stream into a string before responding.

```js
let fullText = "";
for await (const event of parseStream(upstream)) {
  if (event.type === "text") fullText += event.content;
}

const { cleanText, toolCalls } = extractToolCalls(fullText);

// If tool calls found:
message = { role: "assistant", content: cleanText || null, tool_calls: toolCalls }

// Otherwise:
message = { role: "assistant", content: fullText }

res.json({
  id, object: "chat.completion", created, model: "mercury",
  choices: [{ index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" }],
  usage: { prompt_tokens, completion_tokens, total_tokens }
})
```

Sources and search markers are ignored in non-streaming mode — only text deltas are collected.

Retries up to 3 times on 429 with a 700ms delay between attempts.

---

## 18. Timing instrumentation

Two timestamps are recorded per streaming request:

```js
let start_time = Date.now();     // set before callWithRetry
let first_token_time = null;     // set on first text/source event
```

The stop chunk carries:

```json
{
  "timing": {
    "first_token_time": 412,    // ms from request start to first content
    "streaming_time": 3081,     // ms from first content to last
    "speed": 47                 // tokens/sec = completionTokens / (streamingTime / 1000)
  }
}
```

This is attached to the final chunk alongside `usage`, `finish_reason: "stop"`, and an empty delta.

---

## 19. The `/decide/run` endpoint

Pass-through to Inception's structured decision API, which runs binary/choice/score evaluations against a system prompt.

### Request normalisation

`normaliseQuestions(questions)` mutates the array in place:

- Fills missing `id` (defaults to `q-N`).
- Fills missing `name` (defaults to `id`).
- Normalises `type`: aliases `binery`, `binary`, `yes_no`, `yes/no`, `probability`, `rate` all map to `noul`. Rejects anything not in `{"noul", "choice", "score"}`.
- Sets `instructions` from the first present of: `q.question`, `q.title`, `q.subject`, `q.q`. Rejects if none found.
- Fills missing `id`, `name`, and `description` on each option.

### Auth handling

Runs in a 2-attempt loop. On attempt 0: if 401/403, invalidate token and `continue` to attempt 1. On attempt 1: if still 401/403, return a 401 error to the client. Any non-200 that isn't 401/403 returns an error immediately.

---

## 20. The `/chat/follow-ups` endpoint

Calls Mercury's internal `/api/follow-ups` endpoint, which returns 3 follow-up question suggestions per call. If you ask for more than 3, it loops.

### Loop logic

```
follow_ups_response = []
reqs = 0

while follow_ups_response.length < count AND reqs < 10:
  reqs++
  resp = POST /api/follow-ups  { messages }
  follow_ups_response.push(resp.follow_ups)
  follow_ups_response = flatten + deduplicate + slice(0, count)

return { follow_ups: follow_ups_response, latencyMs, roundTrips }
```

Deduplication is done with a `reduce` that only pushes an item if it's not already in the accumulator. The result is sliced to exactly `count` items. `roundTrips` in the response is `Math.ceil(count / 3)`.

The endpoint validates that `count` is between 1 and 20 and is a `typeof "number"`.

---

## 21. Complete request lifecycle

Putting it all together, here is the full lifecycle of a streaming `/chat/completions` request with tools:

```
Client: POST /chat/completions
  body: { messages, tools, stream: true, intelligence: 2, chatId: "my-session" }

1. Express handler extracts body fields.

2. getConvId("my-session")
   → looks up or creates a Mercury conversation ID

3. toInceptionMessages(messages, tools)
   → prepends tool system prompt + acknowledgement
   → converts each OpenAI message to Mercury parts format

4. resolveReasoning(2) → "medium"

5. ctx object assembled with msgId, created, promptTokens, upstreamParams

6. handleStreaming(req, res, ctx)
   │
   ├─ set SSE headers, flushHeaders()
   │
   ├─ callWithRetry(upstreamParams)
   │    │
   │    └─ callInception(...)
   │         │
   │         ├─ get_best_client()  → returns direct client (index: 0)
   │         ├─ getToken(best_client) → returns cached token or fetches new one
   │         └─ impit.fetch("https://chat.inceptionlabs.ai/api/chat", {
   │               method: "POST",
   │               headers: { ...HEADERS, "x-session-token": token, cookies: ... },
   │               body: JSON.stringify({ id: convId, messages, reasoningEffort: "medium", ... }),
   │               timeout: 120_000
   │            })
   │            → returns ReadableStream
   │
   ├─ emit: { role: "assistant", content: "" }
   │
   ├─ parseStream(upstream)  [async generator]
   │    │
   │    ├─ event: { type: "text", content: "The " }
   │    │    ├─ closeSearchPhase() (noop — no search)
   │    │    └─ streamer.feed("The ") → returns "The "
   │    │         emit: { content: "The " }
   │    │
   │    ├─ event: { type: "text", content: "weather in Paris is [TOOL" }
   │    │    └─ streamer.feed("weather in Paris is [TOOL")
   │    │         → "weather in Paris is " emitted (holds back "[TOOL")
   │    │         emit: { content: "weather in Paris is " }
   │    │
   │    ├─ event: { type: "text", content: "_CALL]: {\"name\":\"get_weather\"...}" }
   │    │    └─ streamer.feed('_CALL]: {...}')
   │    │         → toolMode = true, returns ""
   │    │         nothing emitted
   │    │
   │    └─ event: { type: "done" } → generator returns
   │
   ├─ extractToolCalls(streamer.buf)
   │    → strips "[TOOL_CALL]: {...}" from buf
   │    → parses { name: "get_weather", arguments: { city: "Paris" } }
   │    → returns { cleanText: "The weather in Paris is ", toolCalls: [{...}] }
   │
   ├─ streamToolCalls(msgId, created, toolCalls)
   │    emit: { tool_calls: [{ id: "call_xyz", type: "function", function: { name: "get_weather", arguments: "" } }] }
   │    emit: { tool_calls: [{ function: { arguments: '{"city' } }] }
   │    emit: { tool_calls: [{ function: { arguments: '":"Pa' } }] }
   │    emit: { tool_calls: [{ function: { arguments: 'ris"}' } }] }
   │    emit: { finish_reason: "tool_calls", delta: {} }
   │
   ├─ res.write("data: [DONE]\n\n")
   └─ res.end()

Client receives a valid OpenAI-format streaming tool call response.
Client sends tool result back as a "tool" role message.
Proxy converts it to: userMessage("[TOOL_RESULT id=call_xyz]: { temperature: 18 }")
Next request continues the conversation with chatId: "my-session".
```

---

*This breakdown reflects `server.js` as written. If you fork and modify the code, the token-budget logic, error thresholds, and rotation timings are all in the client pool functions at the top of the file.*
