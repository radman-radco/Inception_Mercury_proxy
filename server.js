/**
 * Inception Labs proxy — OpenAI-compatible (Node.js port)
 *
 * Endpoints:
 *   POST /chat/completions  chat (streaming + non-streaming, tool calls)
 *   POST /decide/run        Inception Decide API (pass-through with auth injection)
 *   GET  /health
 *
 * Request extras:
 *   intelligence: 0=instant, 1=low, 2=medium, 3=high
 *   search:       false by default, pass true to enable web search
 *   chatId:       reuse the same value to keep the same upstream conversation
 */
const express = require("express");
const axios = require("axios");
const { randomInt } = require("node:crypto");
const { getEncoding } = require("js-tiktoken");
const crypto = require("crypto");
const { Impit } = require("impit");
const fs = require("fs");

const PORT = process.env.PORT || 8101;
const BASE = "https://chat.inceptionlabs.ai";
const MODEL = "mercury";
const PROXY_LIST = []

const config_file = fs.readFileSync("./config.json", "utf-8");
const config = JSON.parse(config_file);
// ---------------------------------------------------------------------------
// HTTP client + headers
// ---------------------------------------------------------------------------
if (config?.proxy?.enabled == true && config?.proxy?.path) {
  try {
    const proxy_list_raw = fs.readFileSync(config.proxy.path, "utf-8")
      .split("\r\n").filter((p) => p.trim() !== "")
      .filter(ip => ip.includes("http://") && ip.includes(":"))
    PROXY_LIST.push(...proxy_list_raw)
    if (PROXY_LIST.length == 0) {
      console.warn("[STARTUP] warning: proxy list is empty or invalid, use this corect format=> http://1.1.1.1:80")
    } else {
      console.log("[STARTUP] Loaded %d proxies from %s", PROXY_LIST.length, config.proxy.path)
    }
  } catch (err) {
    console.error("[STARTUP] Error reading proxy file:", err.message)
    process.exit(1)
  }
}

if (PROXY_LIST.length == 0 && config?.proxy?.enabled == true) {
  console.error("[STARTUP] proxy list is empty, but config.proxie.enabled is true\n Please disable use of proxy or add proxies to the list.")
  process.exit(1)
}

let clients = [{
  use_proxy: false,
  client: new Impit({ browser: config?.browser?.type ?? "chrome", ignoreTlsErrors: false }),
  status: "active",
  successfull_reqs: 0,
  index: 0
}]


async function testProxy() {
  try {
    let client = new Impit({
      browser: "chrome",
      ignoreTlsErrors: false,
      proxyUrl: PROXY_LIST[0],  // Correct option name
    })
    const res = await client.fetch('https://api.ipaddress.com/myip?format=json', {
      signal: AbortSignal.timeout(10000),
    });
    const data = await res.json();
    console.log('Exit IP:', data);
    return data;
  } catch (err) {
    console.error('Proxy test failed:', err);
    return null;
  }
}

function create_new_proxy_client() {
  try {
    if (PROXY_LIST.length == 0) return { success: false, error: "Ran out of proxies" }

    let proxy_url = PROXY_LIST[0]
    PROXY_LIST.splice(0, 1) //remove the picked proxy from the list

    if (!proxy_url.includes("http://") || !proxy_url.includes(":")) return { success: false, error: "proxy url is missing or invalid, working exmaple=> http://1.1.1.1:80" }

    console.log("[NEW_CLIENT] creating new client with proxy: %s", proxy_url)
    let client = new Impit({
      browser: config?.browser?.type ?? "chrome",
      ignoreTlsErrors: false,
      proxyUrl: proxy_url
    })

    clients.push({
      use_proxy: true,
      client: client,
      status: "active",
      proxy_url: proxy_url,
      successfull_reqs: 0,
      index: clients.length,
    })
    invalidateToken()

    return { success: true, client: clients[clients.length - 1] }
  } catch (err) {
    console.error("[NEW_CLIENT] Error creating client with proxy %s: %s", err.message)
    return { success: false, error: err.message }
  }
}


function get_best_client() {
  let sorted = [...clients].sort((a, b) => b.successfull_reqs - a.successfull_reqs) //sort by number of successfull_reqs (most to least) to get the most reliable client first
    .sort((a, b) => Number(b.use_proxy) - Number(a.use_proxy)) //sort by use_proxy (best to dont use proxy first)
  sorted = sorted.filter(c => c.status == "active") //

  if (sorted.length == 0) {
    let new_client = create_new_proxy_client()
    if (new_client.success) sorted = [clients[new_client.client.index]]
    else throw new Error(new_client.error)
  }
  console.log(sorted[0])

  return sorted[0]
}

const HEADERS = {
  accept: "text/html,application/xhtml+xml,application/xml;q=0.9," +
    "image/avif,image/webp,image/apng,*/*;q=0.8," +
    "application/signed-exchange;v=b3;q=0.7",
  "accept-encoding": "gzip, deflate, br, zstd",
  "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
  "cache-control": "max-age=0",
  "content-type": "application/json",
  dnt: "1",
  origin: BASE,
  prefer: "safe",
  priority: "u=0, i",
  referer: `${BASE}/`,
  "sec-ch-ua": '"Microsoft Edge";v="155", "Chromium";v="155", "Not(A:Brand";v="24"',
  "sec-ch-ua-mobile": "?0",
  "sec-ch-ua-platform": '"Windows"',
  "sec-fetch-dest": "empty",
  "sec-fetch-mode": "cors",
  "sec-fetch-site": "same-origin",
  "sec-fetch-user": "?1",
  "upgrade-insecure-requests": "1",
  "user-agent":
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) " +
    "AppleWebKit/537.36 (KHTML, like Gecko) " +
    "Chrome/155.0.0.0 Safari/537.36 Edg/155.0.0.0",
};
const DECIDE_HEADERS = { ...HEADERS, referer: `${BASE}/decide` };

// Never throw on HTTP status; callers check status codes themselves.
const http = axios.create({ validateStatus: () => true });

// ---------------------------------------------------------------------------
// Intelligence scale
// ---------------------------------------------------------------------------
const INTELLIGENCE_MAP = { 0: "instant", 1: "low", 2: "medium", 3: "high" };

/** Accepts 0-3 (number or numeric string) or the level name itself. */
function resolveReasoning(raw) {
  if (raw === undefined || raw === null) return "medium";

  const n = Number.parseInt(raw, 10);
  if (!Number.isNaN(n)) return INTELLIGENCE_MAP[Math.max(0, Math.min(3, n))];

  const s = String(raw).toLowerCase();
  return Object.values(INTELLIGENCE_MAP).includes(s) ? s : "medium";
}

// ---------------------------------------------------------------------------
// Session token management
// ---------------------------------------------------------------------------
let token = null;
let tokenPromise = null; // dedupes concurrent fetches



function build_cookies(token) {
  return Object.entries({
    "x-session-token": token ?? "",
    "accept-language": "en-GB,en-US;q=0.9,en;q=0.8",
    "inception_cookie_banner_dismissed": "true"
  }).reduce((acc, [k, v]) => `${acc}${k}=${encodeURIComponent(v)}; `, '')
}


async function fetchToken(best_client) {
  const res = await best_client.client.fetch(`${BASE}/api/session`,
    { headers: HEADERS, signal: AbortSignal.timeout(5_000), timeout: 5_000 });
  if (res.status >= 400) {
    if (res.status == 429) {
      clients[best_client.index].status = "rate_limited"
      invalidateToken()
      setTimeout(() => {
        if (clients[best_client.index].status == "rate_limited") clients[best_client.index].status = "active"
      }, 5 * 60 * 1000) //5 minutes
      search_for_proxy(false)
    }
    throw new Error("Failed to fetch session, status code: " + res.status);
  }
  const data = await res.json();
  if (!data.ok) throw new Error(`Session not ok: ${JSON.stringify(data)}`);
  data.ip = clients[best_client.index].proxy_url || "local"
  console.log("session: ", data)
  return data.token;
}

async function getToken(best_client) {
  if (token) return token;
  tokenPromise ??= fetchToken(best_client)
    .then((t) => {
      token = t;
      console.log(`[TOKEN] Acquired: ${t.slice(0, 40)}…`);
      return t;
    })
    .finally(() => {
      tokenPromise = null;
    });
  return tokenPromise;
}


let proxy_searcher_running = false;
async function search_for_proxy(timer) {
  if (proxy_searcher_running == true) return;
  proxy_searcher_running = true;

  console.log("[SEARCH_FOR_PROXY] searching for proxy...")

  let errored = true
  while (errored) {
    let best_client = get_best_client()
    try {
      let fetched_token = await fetchToken(best_client)
      if (fetched_token) errored = false
    } catch (err) {
      errored = true
      console.error("[SEARCH_FOR_PROXY] Error fetching token: ", err)
      clients[best_client.index].status = "unreachable"
      setTimeout(() => {
        if (clients[best_client.index].status === "unreachable") clients[best_client.index].status = "active"
      }, 1 * 60 * 60 * 1000) //1 hour
      invalidateToken()
    }
  }

  if (timer == true) {
    setTimeout(search_for_proxy, 30 * 1000) //30 seconds
  }
  proxy_searcher_running = false;
  return true
}

search_for_proxy(true);


function invalidateToken() {
  token = null;
}


// ---------------------------------------------------------------------------
// Token counting (tiktoken with a rough fallback)
// ---------------------------------------------------------------------------
let encoder = null;
try {
  encoder = getEncoding("cl100k_base");
} catch {
  /* fall back to the length heuristic below */
}

function countTokens(text) {
  if (!encoder) return Math.max(1, Math.floor(text.length / 4));
  return encoder.encode(text, [], []).length; // treat special-token text as plain text
}

function estimatePromptTokens(messages) {
  let total = 2;
  for (const m of messages) {
    total += 4;
    const content = m.content ?? "";
    if (Array.isArray(content)) {
      for (const part of content) total += countTokens(part?.text ?? "");
    } else {
      total += countTokens(String(content));
    }
  }
  return total;
}

// ---------------------------------------------------------------------------
// Conversation IDs (chatId -> upstream conversation id)
// ---------------------------------------------------------------------------
const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

function randId(length = 16) {
  let id = "";
  for (let i = 0; i < length; i++) id += ALPHANUMERIC[randomInt(ALPHANUMERIC.length)];
  return id;
}

const convStore = new Map();

function getConvId(chatId) {
  const existing = convStore.get(chatId);
  if (existing) {
    console.log(`[CONV] Reuse ${chatId} → ${existing}`);
    return existing;
  }
  const created = randId();
  convStore.set(chatId, created);
  console.log(`[CONV] New   ${chatId} → ${created}`);
  return created;
}

const deleteConvId = (chatId) => convStore.delete(chatId);

// ---------------------------------------------------------------------------
// Tool injection
// Inception has no native tool calling, so tools are described in a prompt and
// the model is asked to emit `[TOOL_CALL]: {...}` lines that we parse back.
// ---------------------------------------------------------------------------
function buildToolsSystemPrompt(tools) {
  const header =
    "You have access to the following tools. When you need to call a tool, " +
    "emit it on its own line in EXACTLY this format and nothing else on that line:\n" +
    '[TOOL_CALL]: {"name": "<function_name>", "arguments": {<args as JSON object>}}\n\n' +
    "Rules:\n" +
    "- Only call a tool when you actually need external data to answer.\n" +
    "- You may call multiple tools by emitting multiple [TOOL_CALL] lines.\n" +
    "- After receiving tool results (provided as [TOOL_RESULT] messages), " +
    "continue your response normally.\n" +
    "- Do NOT fabricate tool results.\n" +
    "- Do NOT explain the tool call in plain text — only emit the [TOOL_CALL] line.\n\n" +
    "Available tools:\n";

  const descriptions = tools.map((tool) => {
    const fn = tool.function ?? tool; // accept {type, function} and bare function objects
    const { name = "unknown", description = "", parameters = {} } = fn;
    return `### ${name}\n${description}\nParameters: ${JSON.stringify(parameters)}\n`;
  });

  return header + descriptions.join("\n");
}

// ---------------------------------------------------------------------------
// Message conversion: OpenAI -> Inception
// ---------------------------------------------------------------------------
const userMessage = (text) => ({ id: randId(), role: "user", parts: [{ type: "text", text }] });

const assistantMessage = (text) => ({
  id: randId(),
  role: "assistant",
  parts: [
    { type: "reasoning", text: "", state: "done" },
    { type: "text", text, state: "done" },
  ],
});

/** Flattens OpenAI content (string or array of parts) into plain text. */
function contentToText(content) {
  if (Array.isArray(content)) {
    return content
      .filter((p) => p && typeof p === "object")
      .map((p) => p.text ?? "")
      .join(" ");
  }
  return content ?? "";
}

/** Rebuilds assistant tool_calls as [TOOL_CALL] lines so history stays consistent. */
function toolCallsToText(toolCalls) {
  return toolCalls
    .map((tc) => {
      const fn = tc.function ?? {};
      let args = fn.arguments ?? "{}";
      if (typeof args === "string") {
        try {
          args = JSON.parse(args);
        } catch {
          args = {};
        }
      }
      return `[TOOL_CALL]: ${JSON.stringify({ name: fn.name ?? "", arguments: args })}`;
    })
    .join("\n");
}

function toInceptionMessages(stdMessages, tools = []) {
  const result = [];

  if (tools.length) {
    result.push(userMessage(buildToolsSystemPrompt(tools)));
    result.push(
      assistantMessage("Understood. I will use [TOOL_CALL]: {...} format when I need to call a tool.")
    );
  }

  for (const msg of stdMessages) {
    const role = msg.role ?? "user";
    let content = contentToText(msg.content);

    if (role === "system") {
      result.push(userMessage(`[SYSTEM]: ${content}`));
    } else if (role === "user") {
      result.push(userMessage(content));
    } else if (role === "assistant") {
      if (msg.tool_calls?.length) {
        const callsText = toolCallsToText(msg.tool_calls);
        content = content ? `${content}\n${callsText}` : callsText;
      }
      result.push(assistantMessage(content));
    } else if (role === "tool") {
      result.push(userMessage(`[TOOL_RESULT id=${msg.tool_call_id ?? ""}]: ${content}`));
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Tool-call extraction
// ---------------------------------------------------------------------------

/**
 * Parses a balanced JSON object that starts at `start` (must be '{').
 * Returns { value, end } or null if the object is incomplete or invalid.
 */
function extractJsonObject(text, start) {
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (escaped) {
      escaped = false;
    } else if (c === "\\" && inString) {
      escaped = true;
    } else if (c === '"') {
      inString = !inString;
    } else if (!inString) {
      if (c === "{") depth++;
      else if (c === "}" && --depth === 0) {
        try {
          return { value: JSON.parse(text.slice(start, i + 1)), end: i + 1 };
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/**
 * Finds every `[TOOL_CALL]: {...}` block in `text`.
 * Returns { cleanText, toolCalls } where toolCalls is null when none were found.
 * Tolerates markdown fences around the JSON and skips malformed calls.
 */
function extractToolCalls(text) {
  text = text.replace(/```(?:json)?\s*(\{)/g, "$1").replace(/\}\s*```/g, "}");

  const toolCalls = [];
  const cleanParts = [];
  const marker = /\[TOOL_CALL\]:\s*/gi;
  let pos = 0;
  let match;

  while ((match = marker.exec(text)) !== null) {
    if (match.index < pos) continue; // marker was inside an already-parsed object
    cleanParts.push(text.slice(pos, match.index));

    const bracePos = text.indexOf("{", match.index + match[0].length);
    const parsed = bracePos === -1 ? null : extractJsonObject(text, bracePos);
    if (!parsed) {
      pos = match.index + match[0].length;
      continue;
    }

    // Accept both {name, arguments} and {function: {name, arguments}}
    const call = parsed.value.function ?? parsed.value;
    const args = call.arguments ?? {};
    toolCalls.push({
      id: `call_${randId(8)}`,
      type: "function",
      function: {
        name: call.name ?? "unknown",
        arguments: typeof args === "string" ? args : JSON.stringify(args),
      },
    });
    pos = parsed.end;
  }

  cleanParts.push(text.slice(pos));
  return {
    cleanText: cleanParts.join("").trim(),
    toolCalls: toolCalls.length ? toolCalls : null,
  };
}

// ---------------------------------------------------------------------------
// Upstream /api/chat call
// ---------------------------------------------------------------------------
class TokenRejectedError extends Error { }

/** Reads a whole stream into a string (used for error bodies). */
async function readStream(stream) {
  const chunks = [];
  for await (const chunk of stream) chunks.push(Buffer.from(chunk));
  return Buffer.concat(chunks).toString("utf8");
}

async function callInception({ convId, messages, reasoningEffort, webSearch }) {

  let best_client = get_best_client()

  try {
    const authToken = await getToken(best_client);
    const res = await best_client.client.fetch(
      `${BASE}/api/chat`,
      {
        method: "POST",
        headers: {
          ...HEADERS,
          "x-session-token": authToken,
          cookies: build_cookies(authToken),
        },
        body: JSON.stringify({
          reasoningEffort,
          webSearchEnabled: webSearch,
          voiceMode: false,
          timezone: "Europe/London",
          language: "en-GB",
          id: convId,
          messages,
          trigger: "submit-message",
        }),
        timeout: 120_000,
        signal: AbortSignal.timeout(120_000)
      }
    );

    if (res.status === 401 || res.status === 403) {
      // impit's body is ReadableStream, no .destroy() method
      // Directly cancel the stream (optional)
      try { await res.body?.cancel(); } catch { }
      invalidateToken();
      throw new TokenRejectedError(`Token rejected (${res.status}), invalidated`);
    }

    if (res.status == 429) {
      console.log("[429] Rate limited, deactivating client for 1 minute")
      clients[best_client.index].status = "rate_limited"
      setTimeout(() => {
        console.log("[cron] Re-activating client with ip: " + (clients[best_client.index].proxy_url || "local"))
        if (clients[best_client.index].status == "rate_limited") clients[best_client.index].status = "active"
      }, 1 * 60 * 1000) //1 minute
      search_for_proxy(false)
    }

    if (res.status !== 200) {
      const body = await res.text(); // Directly read text using impit's .text()
      throw new Error(`Inception ${res.status}: ${body.slice(0, 300)}`);
    }

    clients[best_client.index].successfull_reqs++;
    return res.body; // Return ReadableStream, not res.data
  } catch (error) {
    error.message = error?.message?.toLowerCase()?.trim()
    if (error?.message?.includes("timeout") || error?.message?.includes("time out") || error?.message?.includes("Network error") || error?.message?.includes("rejected")) {
      clients[best_client.index].status = "unreachable"
      invalidateToken()
      setTimeout(() => {
        if (clients[best_client.index].status === "unreachable") {
          clients[best_client.index].status = "active"
        }
      }, 1 * 60 * 60 * 1000) //1 hour
      search_for_proxy(false)
    }

    throw error;
  }
}

/** Calls Inception, retrying once with a fresh token if the old one was rejected. */
async function callWithRetry(params) {
  try {
    return await callInception(params);
  } catch (err) {
    if (err instanceof TokenRejectedError) return callInception(params);
    throw err;
  }
}

// ---------------------------------------------------------------------------
// Upstream stream parser — yields typed events
//   { type: "searching" } | { type: "source", url, title }
//   { type: "text", content } | { type: "done" }
// ---------------------------------------------------------------------------
function lineToEvent(line) {
  if (!line.startsWith("data: ")) return null;
  const payload = line.slice(6);
  if (payload === "[DONE]") return { type: "done" };

  let chunk;
  try {
    chunk = JSON.parse(payload);
  } catch {
    return null;
  }

  if (chunk.type === "source-url") {
    if (chunk.sourceId === "__searching__") return { type: "searching" };
    return { type: "source", url: chunk.url ?? "", title: chunk.title ?? "" };
  }
  if (chunk.type === "text-delta" && chunk.delta) {
    return { type: "text", content: chunk.delta };
  }
  return null;
}

async function* parseStream(stream) {
  const reader = stream.getReader();
  const decoder = new TextDecoder("utf-8");
  let pending = "";

  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;

      pending += decoder.decode(value, { stream: true });
      const lines = pending.split("\n");
      pending = lines.pop();

      for (const line of lines) {
        const event = lineToEvent(line.replace(/\r$/, ""));
        if (!event) continue;
        yield event;
        if (event.type === "done") return;
      }
    }

    pending += decoder.decode();
    const event = lineToEvent(pending.trim());
    if (event) yield event;
  } finally {
    reader.releaseLock();
  }
}

// ---------------------------------------------------------------------------
// OpenAI SSE helpers
// ---------------------------------------------------------------------------
const sse = (obj) => `data: ${JSON.stringify(obj)}\n\n`;

function chunkObj(id, created, delta, finishReason = null, usage = undefined, start_time = null, first_token_time = null, token_per_second = null) {
  const obj = {
    id,
    object: "chat.completion.chunk",
    created,
    model: MODEL,
    choices: [{ index: 0, delta, finish_reason: finishReason }],
  };
  if (usage) obj.usage = usage;
  if (start_time && first_token_time && token_per_second) {
    obj.timing = {
      first_token_time: first_token_time - start_time,
      streaming_time: Date.now() - first_token_time,
      speed: token_per_second,
    }

  }
  return obj;
}

/**
 * Mirrors OpenAI's streaming tool-call format:
 *  - first chunk per call: id + type + function.name + empty arguments
 *  - following chunks: only an arguments delta
 *  - last chunk: finish_reason "tool_calls" with an empty delta
 */
function* streamToolCalls(id, created, toolCalls, chunkSize = 8) {
  for (const [index, tc] of toolCalls.entries()) {
    const { name, arguments: args } = tc.function;

    yield sse(
      chunkObj(id, created, {
        tool_calls: [
          { index, id: tc.id, type: "function", function: { name, arguments: "" } },
        ],
      })
    );

    for (let pos = 0; pos < args.length; pos += chunkSize) {
      yield sse(
        chunkObj(id, created, {
          tool_calls: [{ index, function: { arguments: args.slice(pos, pos + chunkSize) } }],
        })
      );
    }
  }
  yield sse(chunkObj(id, created, {}, "tool_calls"));
}

function buildUsage(promptTokens, completionTokens) {
  return {
    prompt_tokens: promptTokens,
    completion_tokens: completionTokens,
    total_tokens: promptTokens + completionTokens,
    prompt_tokens_details: { cached_tokens: 0, audio_tokens: 0 },
    completion_tokens_details: {
      reasoning_tokens: 0,
      audio_tokens: 0,
      accepted_prediction_tokens: 0,
      rejected_prediction_tokens: 0,
    },
  };
}

// ---------------------------------------------------------------------------
// Streamer that keeps [TOOL_CALL] text out of normal content deltas
// ---------------------------------------------------------------------------
const TOOL_MARKER = "[TOOL_CALL]";

/** Length of the longest suffix of `text` that could still grow into the marker. */
function partialMarkerLength(text) {
  for (let len = Math.min(TOOL_MARKER.length - 1, text.length); len > 0; len--) {
    if (text.slice(-len).toUpperCase() === TOOL_MARKER.slice(0, len)) return len;
  }
  return 0;
}

class ToolAwareStreamer {
  constructor() {
    this.buf = ""; // everything received so far
    this.sent = 0; // how much of buf has been emitted as content
    this.toolMode = false; // true once a full [TOOL_CALL] marker was seen
  }

  /** Feeds a delta; returns the text that is safe to emit as content now. */
  feed(delta) {
    this.buf += delta;
    if (this.toolMode) return "";

    const pending = this.buf.slice(this.sent);
    const markerAt = pending.search(/\[TOOL_CALL\]/i);

    let safeLength;
    if (markerAt !== -1) {
      this.toolMode = true;
      safeLength = markerAt;
    } else {
      // hold back a trailing fragment that might still turn into the marker
      safeLength = pending.length - partialMarkerLength(pending);
    }

    this.sent += safeLength;
    return pending.slice(0, safeLength);
  }

  /** Returns any text not yet emitted (used when no valid tool call was parsed). */
  flush() {
    const rest = this.buf.slice(this.sent);
    this.sent = this.buf.length;
    return rest;
  }
}

// ---------------------------------------------------------------------------
// /chat/completions
// ---------------------------------------------------------------------------
const hostOf = (url) => {
  try {
    return new URL(url).host;
  } catch {
    return "";
  }
};

async function handleStreaming(req, res, ctx) {
  const { msgId, created, promptTokens } = ctx;

  res.set({
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
    "X-Accel-Buffering": "no",
  });
  res.flushHeaders();

  const write = (obj) => res.write(sse(obj));
  const content = (text) => write(chunkObj(msgId, created, { content: text }));

  const sources = [];
  let searchStarted = false;
  let searchPhaseClosed = false;
  let completionTokens = 0;
  const streamer = new ToolAwareStreamer();
  let upstream;

  // Stop reading upstream if the client goes away.
  res.on("close", () => {
    upstream?.cancel().catch(() => { });
  });

  // Emit collected sources and the FINISHED marker once, before the answer text.
  const closeSearchPhase = () => {
    if (searchPhaseClosed) return;
    searchPhaseClosed = true;
    if (sources.length) {
      write(chunkObj(msgId, created, { role: "assistant", content: "", sources }));
    }
    if (searchStarted) content("<FINISHED_SEARCHING>");
  };

  let start_time = Date.now()
  let first_token_time = null
  try {
    upstream = await callWithRetry(ctx.upstreamParams);
    write(chunkObj(msgId, created, { role: "assistant", content: "" }));

    for await (const event of parseStream(upstream)) {
      if (!first_token_time) first_token_time = Date.now()
      if (event.type === "searching") {
        if (!searchStarted) {
          searchStarted = true;
          content("<SEARCHING>");
        }
      } else if (event.type === "source") {
        sources.push({
          url: event.url,
          title: event.title,
          snippet: "",
          cite_index: sources.length + 1,
          published_at: null,
          site_name: hostOf(event.url),
          query_indexes: [0],
        });
      } else if (event.type === "text") {
        closeSearchPhase();
        completionTokens += countTokens(event.content);
        const safe = streamer.feed(event.content);
        if (safe) content(safe);
      }
      
      // If the model generates more tokens than the user requested, stop the stream.
      if(completionTokens > ctx.max_tokens){
          upstream?.cancel().catch(() => {});
          const usage = buildUsage(promptTokens, completionTokens);
          write(chunkObj(msgId, created, {}, "length", usage));
          res.write("data: [DONE]\n\n");
          res.end();
          return;
      }
    }

    closeSearchPhase();

    const { toolCalls } = extractToolCalls(streamer.buf);
    if (toolCalls) {
      for (const line of streamToolCalls(msgId, created, toolCalls)) res.write(line);
    } else {
      const rest = streamer.flush();
      if (rest) content(rest);
      const usage = buildUsage(promptTokens, completionTokens);
      const token_per_second = Math.ceil(completionTokens / ((Date.now() - first_token_time) / 1000))
      write(chunkObj(msgId, created, {}, "stop", usage, start_time, first_token_time, token_per_second));
    }
    res.write("data: [DONE]\n\n");
  } catch (err) {
    console.error(`[STREAM] Error: ${err.message.slice(0, 1000)}`);
    search_for_proxy(false);
    deleteConvId(ctx.chatId);
    if (err?.message?.includes("429") || err?.message?.includes("timeout") || err?.message?.includes("time out")) {
    write({ error: { message: "Got ratelimited please wait 20s while we try to find a different proxy...", type: "proxy_error" } });
    }else{
    write({ error: { message: err.message, type: "proxy_error" } });
    }
    res.write("data: [DONE]\n\n");
  } finally {
    res.end();
  }
}

async function handleNonStreaming(req, res, ctx) {
  const { msgId, created, promptTokens } = ctx;

  try {
    const upstream = await callWithRetry(ctx.upstreamParams);
    let fullText = "";
    let completionTokens = 0;

    for await (const event of parseStream(upstream)) {
      if (event.type === "text") {
        fullText += event.content;
        completionTokens += countTokens(event.content);
      }
    }

    const { cleanText, toolCalls } = extractToolCalls(fullText);
    const message = toolCalls
      ? { role: "assistant", content: cleanText || null, tool_calls: toolCalls }
      : { role: "assistant", content: fullText };

    res.json({
      id: msgId,
      object: "chat.completion",
      created,
      model: MODEL,
      choices: [
        { index: 0, message, finish_reason: toolCalls ? "tool_calls" : "stop" },
      ],
      usage: {
        prompt_tokens: promptTokens,
        completion_tokens: completionTokens,
        total_tokens: promptTokens + completionTokens,
      },
    });
  } catch (err) {
    console.error(`[CHAT] Error: ${err.message}`);
    search_for_proxy(false);
    deleteConvId(ctx.chatId);
    if (err.message.includes("413")) {
      return res.status(413).json({
        "error": {
          "message": "This model's maximum context length is 1_000_000 tokens. However, your request resulted in murcery to return an length error. Please reduce the length of the messages.",
          "type": "invalid_request_error",
          "param": null,
          "code": "context_length_exceeded"
        }
      });
    } else if (err.message.includes("429")) {
      return res.status(429).json({
        "error": {
          "message": "Murcery is rate limiting your ip, please wait 60s or configer proxy settings.",
          "type": "invalid_request_error",
          "param": null,
          "code": "too_many_requests"
        }
      });
    }

    res.status(400).json({ error: { message: err.message, type: "proxy_error" } });
  }
}

// ---------------------------------------------------------------------------
// /decide/run
// ---------------------------------------------------------------------------
const DECIDE_TYPES = new Set(["noul", "choice", "score"]);
const DECIDE_TYPE_ALIASES = new Set(["binery", "binary", "yes_no", "yes/no", "probability", "rate"]);

/**
 * Fills in missing ids/names/descriptions and validates each question.
 * Returns an error string, or null when the questions are valid.
 * Mutates `questions` in place.
 */
function normaliseQuestions(questions) {
  for (const [i, q] of questions.entries()) {
    q.id ||= `q-${i + 1}`;
    q.name ||= q.id;

    let type = String(q.type ?? "").toLowerCase().trim();
    if (DECIDE_TYPE_ALIASES.has(type)) type = "noul";
    if (!DECIDE_TYPES.has(type)) return "Invalid question type!";
    q.type = type;

    // Inception uses `instructions` as the question prompt
    q.instructions = q.question || q.title || q.subject || q.q || null;
    if (!q.instructions) return "Required prompt for each question";

    for (const [j, opt] of (q.options ?? []).entries()) {
      opt.id ||= `opt-${i}-${j}`;
      opt.name ||= opt.id;
      opt.description ??= opt.label || opt.value || opt.name || "";
    }
  }
  return null;
}

// ---------------------------------------------------------------------------
// App
// ---------------------------------------------------------------------------
const app = express();
app.use(express.json({ limit: "20mb" })); // decide requests may carry images

app.post("/chat/completions", async (req, res) => {
  const body = req.body ?? {};
  const messages = body.messages ?? [];
  const tools = body.tools ?? [];
  const chatId = body.chatId ?? crypto.randomUUID();
  const convId = getConvId(chatId);

  const ctx = {
    chatId,
    msgId: `chatcmpl-${convId}`,
    created: Math.floor(Date.now() / 1000),
    promptTokens: estimatePromptTokens(messages),
    upstreamParams: {
      convId,
      messages: toInceptionMessages(messages, tools),
      reasoningEffort: resolveReasoning(body.intelligence),
      webSearch: Boolean(body.search),
    },
    max_tokens: body.max_tokens || 2_000,
  };

  if (body.stream ?? true) return handleStreaming(req, res, ctx);
  return handleNonStreaming(req, res, ctx);
});

app.post("/decide/run", async (req, res) => {
  const body = req.body ?? {};
  const questions = body.questions;
  const state = body.state || body.system || body.prompt || body.system_prompt || null;

  if (!state || !Array.isArray(questions) || questions.length === 0) {
    return res.status(400).json({ error: "System prompt or questions is missing" });
  }

  const validationError = normaliseQuestions(questions);
  if (validationError) return res.status(400).json({ error: validationError });

  const payload = { state, questions, images: body.images ?? [] };

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      const best_client = get_best_client();
      const authToken = await getToken(best_client);
      const upstream = await best_client.client.fetch(`${BASE}/api/decide/run`, {
        method: "POST",
        headers: { ...DECIDE_HEADERS, "x-session-token": authToken, cookies: build_cookies(authToken) },
        body: JSON.stringify(payload),
        timeout: 5_000,
        signal: AbortSignal.timeout(5_000),
      });

      if (upstream.status === 401 || upstream.status === 403) {
        invalidateToken();
        if (attempt === 0) continue;
        return res.status(401).json({ error: { message: "Auth failed after retry" } });
      }
      if (upstream.status !== 200) {
        const text = typeof upstream.data === "string" ? upstream.data : JSON.stringify(upstream.data);
        return res
          .status(upstream.status)
          .json({ error: { message: `Inception ${upstream.status}: ${text.slice(0, 300)}` } });
      }
      const data = await upstream.json()
      return res.json(data);
    } catch (err) {
      if (attempt === 1) return res.status(500).json({ error: { message: err.message } });
    }
  }
});



app.post("/chat/follow-ups", async (req, res) => {
  const body = req.body ?? {};
  const messages = body.messages;
  const count = body.count || 3;

  if (!Array.isArray(messages) || messages.length === 0 || count < 1 || count > 20 || typeof count !== "number") {
    return res.status(400).json({ error: "Messages is missing or count is invalid,\n count must be a number between 1-20" });
  }

  let start_time = Date.now();
  let best_client = get_best_client();

  try {
    let authToken = await getToken(best_client);
    let reqs = 0;
    let follow_ups_response = [];
    while (follow_ups_response.length < count && reqs < 10) {
      reqs += 1;
      let resp = await best_client.client.fetch("https://chat.inceptionlabs.ai/api/follow-ups", {
        headers: { ...HEADERS, "x-session-token": authToken, cookies: build_cookies(authToken) },
        body: JSON.stringify({ messages }),
        method: "POST",
        timeout: 5_000,
        signal: AbortSignal.timeout(5_000)
      });
      if (resp.status == 429) {

        console.log("[429] Rate limited, deactivating client for 1 minute")
        clients[best_client.index].status = "rate_limited";
        setTimeout(() => {
          console.log("[cron] Re-activating client with ip: " + (clients[best_client.index].proxy_url || "local"))
          if (clients[best_client.index].status == "rate_limited") clients[best_client.index].status = "active";
        }, 60 * 1000);
        invalidateToken();
        search_for_proxy(false);
        return res.status(429).json({ error: { message: "Got ratelimited please wait 20s while we try to find a different proxy..." } })
      }
      if (resp.status !== 200) {
        return res.status(res.status).json({ error: { message: `Inception ${resp.status}: ${resp.data.slice(0, 300)}` } });
      }

      const data = await resp.json()

      clients[best_client.index].successfull_reqs++

      follow_ups_response.push(data.follow_ups || []);
      follow_ups_response = follow_ups_response.flat(Infinity)  // merge all responses
        .reduce((acc, s) => { // remove duplicates
          if (!acc.includes(s)) acc.push(s)
          return acc
        }, []).slice(0, count); // return only the first 'count' unique follow-ups
    }

    return res.json({ success: true, follow_ups: follow_ups_response, latencyMs: Date.now() - start_time, roundTrips: Math.ceil(count / 3) });

  } catch (error) {
    console.error(`[FOLLOW-UPS] Error: ${error.message}`);
    if (error?.message?.includes("timeout") || error?.message?.includes("time out") || error?.message?.includes("Network error") || error?.message?.includes("rejected")) {
      clients[best_client.index].status = "unreachable"
      invalidateToken()
      setTimeout(() => {
        if (clients[best_client.index].status === "unreachable") clients[best_client.index].status = "active"
      }, 1 * 60 * 60 * 1000) //1 hour
      search_for_proxy(false)
    }
    return res.status(500).json({ success: false, message: error.message });
  }

});


app.get("/health", (req, res) => res.json({ status: "ok", token_loaded: token !== null }));


app.listen(PORT, () => {
  console.log(`Inception proxy → http://localhost:${PORT}`);
  console.log("  POST /chat/completions   OpenAI-compatible chat");
  console.log("  POST /decide/run         Inception Decide API");
  console.log("  GET  /health");
});
