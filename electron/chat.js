/**
 * Provider-agnostic streaming chat.
 *
 * One code path streams from Ollama (/api/chat, NDJSON), OpenAI-compatible
 * (/chat/completions, SSE) and Anthropic (/messages, SSE). The caller only sees
 * text deltas, so the renderer never has to know which wire format it is on.
 *
 * When `tools` are passed the same path also parses tool calls and returns
 * them in a provider-neutral shape:
 *
 *   { id, name, args }
 *
 * Messages may also use the neutral tool shapes produced by the agent loop:
 *
 *   { role: 'assistant', content, toolCalls: [{ id, name, args }] }
 *   { role: 'tool', toolCallId, name, content }
 *
 * Without `tools`, messages keep the old string-only handling untouched.
 */

const { randomUUID } = require('node:crypto');
const { appFetch } = require('./app-net');
const uiText = require('./ui-text');

const DEFAULT_MAX_TOKENS = 4096;
const OPENCODE_USER_AGENT = 'Ezness/1.0';
/** Stable fallback when the caller has no conversation id to offer. */
const OPENCODE_FALLBACK_SESSION = randomUUID();

/** Character-based token estimate, used only when a provider reports none. */
function estimateTokens(text) {
  const value = String(text ?? '');
  const cjk = value.match(/[㐀-䶿一-鿿豈-﫿]/g)?.length ?? 0;
  return cjk + (value.length - cjk) / 4;
}

function estimateMessages(messages) {
  let total = 0;
  for (const message of messages ?? []) {
    total += estimateTokens(message?.content) + 20;
    if (Array.isArray(message?.toolCalls) && message.toolCalls.length > 0) {
      total += estimateTokens(JSON.stringify(message.toolCalls));
    }
  }
  return Math.round(total);
}

function trimBase(url) {
  return String(url || '').replace(/\/+$/, '');
}

function isOpenCodeEndpoint(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

/**
 * OpenCode asks third-party clients to identify themselves and to send one
 * stable session id per conversation. Go rejects requests without it, Zen
 * accepts it too; both keep routing and prompt caching sane.
 */
function opencodeHeaders(provider) {
  return {
    'user-agent': OPENCODE_USER_AGENT,
    'x-opencode-session': provider.sessionId || OPENCODE_FALLBACK_SESSION,
  };
}

function normalizeArgs(value) {
  if (value && typeof value === 'object' && !Array.isArray(value)) return value;
  if (typeof value === 'string' && value.trim()) {
    try {
      const parsed = JSON.parse(value);
      return parsed && typeof parsed === 'object' ? parsed : { value: parsed };
    } catch {
      return { _raw: value };
    }
  }
  return {};
}

function toolResultText(message) {
  return typeof message.content === 'string'
    ? message.content
    : JSON.stringify(message.content ?? '');
}

/* ---------------- provider-specific message conversion ---------------- */

function openAIMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', tool_call_id: message.toolCallId, content: toolResultText(message) };
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || null,
        tool_calls: message.toolCalls.map((call) => ({
          id: call.id,
          type: 'function',
          function: { name: call.name, arguments: JSON.stringify(call.args ?? {}) },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function ollamaMessages(messages) {
  return messages.map((message) => {
    if (message.role === 'tool') {
      return { role: 'tool', content: toolResultText(message) };
    }
    if (message.role === 'assistant' && Array.isArray(message.toolCalls) && message.toolCalls.length > 0) {
      return {
        role: 'assistant',
        content: message.content || '',
        tool_calls: message.toolCalls.map((call) => ({
          function: { name: call.name, arguments: call.args ?? {} },
        })),
      };
    }
    return { role: message.role, content: message.content };
  });
}

function anthropicMessages(messages) {
  const system = messages
    .filter((message) => message.role === 'system')
    .map((message) => message.content)
    .join('\n\n');

  const out = [];
  for (const message of messages) {
    if (message.role === 'system') continue;

    if (message.role === 'tool') {
      const block = {
        type: 'tool_result',
        tool_use_id: message.toolCallId,
        content: toolResultText(message),
      };
      const last = out[out.length - 1];
      if (last && last.role === 'user' && Array.isArray(last.content)) {
        last.content.push(block);
      } else {
        out.push({ role: 'user', content: [block] });
      }
      continue;
    }

    if (message.role === 'assistant') {
      const blocks = [];
      if (message.content) blocks.push({ type: 'text', text: message.content });
      for (const call of message.toolCalls ?? []) {
        blocks.push({ type: 'tool_use', id: call.id, name: call.name, input: call.args ?? {} });
      }
      if (blocks.length > 0) out.push({ role: 'assistant', content: blocks });
      continue;
    }

    out.push({ role: 'user', content: message.content });
  }

  return { system, messages: out };
}

function openAITools(tools) {
  return tools.map((tool) => ({
    type: 'function',
    function: { name: tool.name, description: tool.description, parameters: tool.parameters },
  }));
}

function anthropicTools(tools) {
  return tools.map((tool) => ({
    name: tool.name,
    description: tool.description,
    input_schema: tool.parameters,
  }));
}

/* ---------------- request building ---------------- */

/**
 * `maxTokens` is optional: normal conversations keep each provider's default
 * (Anthropic still gets the 4096 fallback), while tiny calls such as the 自动
 * 联网 judge cap the answer so they cannot ramble.
 */
function buildRequest(provider, messages, tools = [], maxTokens = 0) {
  const base = trimBase(provider.baseUrl);
  const model = provider.model;
  const key = provider.apiKey;
  const explicitMax = Number(maxTokens);
  const limit = Number.isFinite(explicitMax) && explicitMax > 0 ? Math.round(explicitMax) : 0;

  if (provider.apiType === 'anthropic') {
    const converted = tools.length > 0
      ? anthropicMessages(messages)
      : {
          system: messages
            .filter((message) => message.role === 'system')
            .map((message) => message.content)
            .join('\n\n'),
          messages: messages
            .filter((message) => message.role !== 'system')
            .map((message) => ({
              role: message.role === 'assistant' ? 'assistant' : 'user',
              content: message.content,
            })),
        };

    return {
      url: `${base}/messages`,
      headers: {
        'content-type': 'application/json',
        'x-api-key': key || '',
        'anthropic-version': '2023-06-01',
      },
      body: {
        model,
        max_tokens: limit || DEFAULT_MAX_TOKENS,
        stream: true,
        ...(converted.system ? { system: converted.system } : {}),
        messages: converted.messages,
        ...(tools.length > 0 ? { tools: anthropicTools(tools) } : {}),
      },
      style: 'anthropic',
    };
  }

  if (provider.apiType === 'ollama') {
    return {
      url: `${base}/api/chat`,
      headers: {
        'content-type': 'application/json',
        ...(key ? { authorization: `Bearer ${key}` } : {}),
      },
      // Keep the model resident so the next message skips a cold load.
      body: {
        model,
        messages: tools.length > 0 ? ollamaMessages(messages) : messages,
        stream: true,
        keep_alive: '30m',
        ...(limit ? { options: { num_predict: limit } } : {}),
        ...(tools.length > 0 ? { tools: openAITools(tools) } : {}),
      },
      style: 'ollama',
    };
  }

  return {
    url: `${base}/chat/completions`,
    headers: {
      'content-type': 'application/json',
      ...(key ? { authorization: `Bearer ${key}` } : {}),
      ...(isOpenCodeEndpoint(base) ? opencodeHeaders(provider) : {}),
    },
    body: {
      model,
      messages: tools.length > 0 ? openAIMessages(messages) : messages,
      stream: true,
      ...(limit ? { max_tokens: limit } : {}),
      // Ask for the exact token counts OpenAI-compatible servers otherwise
      // omit from a stream. `streamChat` retries without it if a gateway
      // rejects the field.
      stream_options: { include_usage: true },
      ...(tools.length > 0 ? { tools: openAITools(tools), tool_choice: 'auto' } : {}),
    },
    style: 'openai',
  };
}

function extractDelta(style, payload) {
  if (style === 'ollama') return payload?.message?.content ?? '';
  if (style === 'anthropic') {
    return payload?.type === 'content_block_delta' ? payload?.delta?.text ?? '' : '';
  }
  return payload?.choices?.[0]?.delta?.content ?? '';
}

/**
 * Some chat templates inline reasoning as `<think>…</think>` in the content
 * stream. Split it out so the renderer can show it collapsed instead of
 * mixing it into the answer. Handles tags cut across chunk boundaries.
 */
function createThinkSplitter(onContent, onThinking) {
  const OPEN = /<think(?:ing)?>/i;
  const CLOSE = /<\/think(?:ing)?>/i;
  let mode = 'content';
  let buffer = '';

  const emitSafe = (text, sink) => {
    if (text) sink(text);
  };

  const drain = () => {
    for (let guard = 0; guard < 1000; guard += 1) {
      const matcher = mode === 'content' ? OPEN : CLOSE;
      const found = buffer.search(matcher);

      if (found === -1) {
        // Hold a possible partial tag at the tail until more text arrives.
        const lt = buffer.lastIndexOf('<');
        const keep = lt !== -1 && buffer.length - lt <= 12 ? lt : buffer.length;
        emitSafe(buffer.slice(0, keep), mode === 'content' ? onContent : onThinking);
        buffer = buffer.slice(keep);
        return;
      }

      emitSafe(buffer.slice(0, found), mode === 'content' ? onContent : onThinking);
      buffer = buffer.slice(found);

      const match = buffer.match(matcher);
      if (!match) return;
      buffer = buffer.slice(match[0].length);
      mode = mode === 'content' ? 'thinking' : 'content';
    }
  };

  return {
    push(text) {
      buffer += text;
      drain();
    },
    flush() {
      emitSafe(buffer, mode === 'content' ? onContent : onThinking);
      buffer = '';
    },
  };
}

let callSequence = 0;
function fallbackId() {
  callSequence += 1;
  return `call_${Date.now().toString(36)}_${callSequence}`;
}

async function streamChat(provider, messages, options = {}) {
  const {
    signal,
    onDelta,
    onThinking = () => {},
    tools = [],
    maxTokens = 0,
    onToolProgress,
  } = options;
  let text = '';
  let thinkingText = '';
  let aborted = false;
  let finishReason = '';

  // Wall-clock marks for the rate in the per-conversation stats. Chunks are
  // counted in characters here and scaled to the provider's output tokens at
  // the end, so a cheap per-chunk estimate never leaks into the numbers.
  const startedAt = Date.now();
  let firstTokenAt = 0;
  let lastTokenAt = 0;
  let emittedChars = 0;
  const rateSamples = [];
  const markEmitted = (chunk) => {
    if (!chunk) return;
    const now = Date.now();
    if (!firstTokenAt) firstTokenAt = now;
    lastTokenAt = now;
    emittedChars += chunk.length;
    rateSamples.push({ at: now, chars: emittedChars });
  };

  // Provider-reported usage, filled in from each wire format as it arrives.
  const usage = {
    inputTokens: 0,
    outputTokens: 0,
    cachedInputTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
    reported: false,
  };
  const numberOr = (value) => {
    const number = Number(value);
    return Number.isFinite(number) ? number : 0;
  };
  const applyOpenAIUsage = (payload) => {
    if (!payload || typeof payload !== 'object') return;
    const input = payload.prompt_tokens ?? payload.input_tokens;
    const output = payload.completion_tokens ?? payload.output_tokens;
    if (input === undefined && output === undefined) return;
    usage.reported = true;
    if (input !== undefined) usage.inputTokens = numberOr(input);
    if (output !== undefined) usage.outputTokens = numberOr(output);

    const details = payload.prompt_tokens_details;
    const cached = details?.cached_tokens ?? payload.prompt_cache_hit_tokens ?? payload.cached_input_tokens;
    if (cached !== undefined) usage.cachedInputTokens = numberOr(cached);
    const written = details?.cache_creation_tokens ?? payload.cache_creation_input_tokens;
    if (written !== undefined) usage.cacheWriteTokens = numberOr(written);

    const reasoning = payload.completion_tokens_details?.reasoning_tokens ?? payload.reasoning_tokens;
    if (reasoning !== undefined) usage.reasoningTokens = numberOr(reasoning);
  };
  const emitThinking = (chunk) => {
    if (!chunk) return;
    markEmitted(chunk);
    thinkingText += chunk;
    onThinking(chunk);
  };

  const splitter = createThinkSplitter(
    (chunk) => {
      markEmitted(chunk);
      text += chunk;
      onDelta(chunk);
    },
    emitThinking,
  );
  let request = buildRequest(provider, messages, tools, maxTokens);

  // Tool-call accumulation, keyed by wire-format index.
  const openaiCalls = new Map();
  const anthropicCalls = new Map();
  const ollamaCalls = [];

  const post = () =>
    appFetch(request.url, {
      method: 'POST',
      headers: request.headers,
      body: JSON.stringify(request.body),
      signal,
    });

  let response = await post();
  if (!response.ok) {
    let detail = await response.text().catch(() => '');
    // A few older gateways reject `stream_options` outright. Usage is optional
    // for billing (the fallback estimate still runs), so drop it and retry
    // rather than fail a normal conversation over a token counter.
    const rejectable =
      request.style === 'openai' &&
      request.body?.stream_options &&
      (response.status === 400 || response.status === 422) &&
      /stream_options|unrecognized|unsupported|unknown|invalid/i.test(detail);
    if (rejectable) {
      const body = { ...request.body };
      delete body.stream_options;
      request = { ...request, body };
      response = await post();
      detail = response.ok ? '' : await response.text().catch(() => '');
    }
    if (!response.ok) {
      throw new Error(
        uiText.t('main.chat.httpError', {
          status: response.status,
          detail: detail ? ` · ${detail.slice(0, 200)}` : '',
        }),
      );
    }
  }
  if (!response.body) throw new Error(uiText.t('main.chat.noStream'));

  const decoder = new TextDecoder();
  let buffer = '';

  /**
   * Tool arguments stream for seconds to minutes (a large write_file is tens of
   * KB) and previously produced no visible activity at all. Report the growing
   * size, throttled, so the renderer can show "正在生成写入文件… 12s, 4.2 KB".
   */
  //
  // `tokens` rides along so the renderer's live rate readout can count work
  // done inside a tool call: a make_docx generates its whole document as
  // argument JSON, and those tokens used to show up nowhere until the request
  // ended.
  let lastToolProgressAt = 0;
  const reportToolProgress = (name, chars, tokens) => {
    if (typeof onToolProgress !== 'function') return;
    const now = Date.now();
    if (now - lastToolProgressAt < 250) return;
    lastToolProgressAt = now;
    try {
      onToolProgress({
        name: String(name || ''),
        chars: Number(chars) || 0,
        tokens: Number(tokens) || 0,
      });
    } catch {
      /* a progress callback must never break the stream */
    }
  };

  const handleToolDeltas = (payload) => {
    if (tools.length === 0) return;

    if (request.style === 'openai') {
      const deltas = payload?.choices?.[0]?.delta?.tool_calls;
      if (!Array.isArray(deltas)) return;
      for (const part of deltas) {
        const index = part.index ?? 0;
        const current = openaiCalls.get(index) ?? {
          id: '',
          name: '',
          argsText: '',
          argsTokens: 0,
        };
        if (part.id) current.id = part.id;
        if (part.function?.name) current.name += part.function.name;
        if (part.function?.arguments) {
          current.argsText += part.function.arguments;
          // The estimate is additive: CJK count and length both sum, so the
          // running total equals the estimate of the concatenation.
          current.argsTokens = (current.argsTokens ?? 0) + estimateTokens(part.function.arguments);
          // Tool arguments are output too. Leaving them out of the rate samples
          // made a tool-heavy turn look like a 1 ms burst of a few characters
          // while the provider counted the whole call.
          markEmitted(part.function.arguments);
        }
        openaiCalls.set(index, current);
        reportToolProgress(current.name, current.argsText.length, current.argsTokens);
      }
      return;
    }

    if (request.style === 'anthropic') {
      if (payload?.type === 'content_block_start' && payload?.content_block?.type === 'tool_use') {
        anthropicCalls.set(payload.index, {
          id: payload.content_block.id,
          name: payload.content_block.name,
          argsText: '',
          argsTokens: 0,
        });
      } else if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'input_json_delta') {
        const current = anthropicCalls.get(payload.index);
        if (current) {
          const fragment = payload.delta.partial_json ?? '';
          current.argsText += fragment;
          current.argsTokens = (current.argsTokens ?? 0) + estimateTokens(fragment);
          markEmitted(fragment);
          reportToolProgress(current.name, current.argsText.length, current.argsTokens);
        }
      }
      return;
    }

    const calls = payload?.message?.tool_calls;
    if (Array.isArray(calls)) {
      for (const call of calls) {
        ollamaCalls.push({
          id: fallbackId(),
          name: call.function?.name ?? '',
          args: normalizeArgs(call.function?.arguments),
        });
        if (call.function?.name) {
          try {
            const argsText = JSON.stringify(call.function.arguments ?? {});
            markEmitted(argsText);
            reportToolProgress(call.function.name, argsText.length, estimateTokens(argsText));
          } catch {
            /* unserializable arguments are not worth a crash */
          }
        }
      }
    }
  };

  const handleLine = (raw) => {
    const line = raw.trim();
    if (!line) return;

    if (request.style === 'ollama') {
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        return;
      }
      if (payload?.error) throw new Error(payload.error);
      if (payload?.done && payload?.done_reason) finishReason = String(payload.done_reason);
      if (payload?.prompt_eval_count !== undefined) {
        usage.reported = true;
        usage.inputTokens = numberOr(payload.prompt_eval_count);
      }
      if (payload?.eval_count !== undefined) {
        usage.reported = true;
        usage.outputTokens = numberOr(payload.eval_count);
      }
      // Ollama exposes native reasoning on its own channel…
      const thinking = payload?.message?.thinking;
      if (thinking) emitThinking(thinking);
      // …and some templates inline it as <think> tags instead.
      const delta = payload?.message?.content;
      if (delta) splitter.push(delta);
      handleToolDeltas(payload);
      return;
    }

    if (!line.startsWith('data:')) {
      // Some gateways answer 200 with a plain JSON error instead of a stream.
      // Ignoring it would look like an empty (but successful) model answer.
      if (line.startsWith('{') && line.includes('"error"')) {
        try {
          const payload = JSON.parse(line);
          const detail =
            payload?.error?.message ?? payload?.error ?? uiText.t('main.chat.modelError');
          throw new Error(String(detail).slice(0, 300));
        } catch (error) {
          if (error instanceof SyntaxError) return;
          throw error;
        }
      }
      return;
    }
    const data = line.slice(5).trim();
    if (!data || data === '[DONE]') return;

    let payload;
    try {
      payload = JSON.parse(data);
    } catch {
      return;
    }
    if (payload?.type === 'error') {
      throw new Error(payload?.error?.message ?? uiText.t('main.chat.modelError'));
    }

    // OpenAI-style usage (the final chunk when stream_options is honoured).
    if (payload?.usage) applyOpenAIUsage(payload.usage);

    // Anthropic reports prompt tokens on message_start and output tokens on
    // message_delta. input_tokens excludes the two cache buckets; fold them in
    // so the ledger's input count is the whole prompt.
    if (payload?.type === 'message_start' && payload?.message?.usage) {
      const part = payload.message.usage;
      usage.reported = true;
      usage.cachedInputTokens = numberOr(part.cache_read_input_tokens);
      usage.cacheWriteTokens = numberOr(part.cache_creation_input_tokens);
      usage.inputTokens =
        numberOr(part.input_tokens) + usage.cachedInputTokens + usage.cacheWriteTokens;
      if (part.output_tokens !== undefined) usage.outputTokens = numberOr(part.output_tokens);
    }
    if (payload?.type === 'message_delta' && payload?.usage) {
      usage.reported = true;
      if (payload.usage.output_tokens !== undefined) {
        usage.outputTokens = numberOr(payload.usage.output_tokens);
      }
      if (payload.usage.input_tokens !== undefined) {
        usage.cachedInputTokens = numberOr(payload.usage.cache_read_input_tokens);
        usage.cacheWriteTokens = numberOr(payload.usage.cache_creation_input_tokens);
        usage.inputTokens =
          numberOr(payload.usage.input_tokens) + usage.cachedInputTokens + usage.cacheWriteTokens;
      }
    }

    const finish = payload?.choices?.[0]?.finish_reason;
    if (finish) finishReason = String(finish);

    // OpenAI-compatible reasoning channel (DeepSeek-R1 and friends).
    const reasoning = payload?.choices?.[0]?.delta?.reasoning_content;
    if (reasoning) emitThinking(reasoning);

    // Anthropic extended thinking.
    if (payload?.type === 'content_block_delta' && payload?.delta?.type === 'thinking_delta') {
      if (payload.delta.thinking) emitThinking(payload.delta.thinking);
      return;
    }

    if (payload?.type === 'message_delta' && payload?.delta?.stop_reason) {
      finishReason = String(payload.delta.stop_reason);
    }

    handleToolDeltas(payload);

    const delta = extractDelta(request.style, payload);
    if (delta) splitter.push(delta);
  };

  const buildUsage = () => {
    // Fill whatever the provider did not report with a character estimate. The
    // ledger flags estimated records so the billing page never presents them as
    // exact provider numbers. Tool arguments count as output here for the same
    // reason the rate samples include them: they are generated tokens, and a
    // write_file can be the bulk of a turn's output.
    const estimatedInput = estimateMessages(messages);
    const toolArgsText = [
      ...[...openaiCalls.values()].map((call) => call.argsText),
      ...[...anthropicCalls.values()].map((call) => call.argsText),
      ...ollamaCalls.map((call) => JSON.stringify(call.args ?? {})),
    ].join('');
    const estimatedOutput = Math.round(
      estimateTokens(text + thinkingText) + estimateTokens(toolArgsText),
    );
    return {
      inputTokens: usage.inputTokens > 0 ? usage.inputTokens : estimatedInput,
      outputTokens: usage.outputTokens > 0 ? usage.outputTokens : estimatedOutput,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteTokens: usage.cacheWriteTokens,
      reasoningTokens:
        usage.reasoningTokens > 0 ? usage.reasoningTokens : Math.round(estimateTokens(thinkingText)),
      reported: usage.reported,
    };
  };

  /**
   * Rate figures for the stats panel. `tokensPerSecond` spans first → last
   * streamed chunk, so the wait for the first token is reported separately
   * instead of silently dragging the average down.
   */
  const buildTiming = (final) => {
    const durationMs = Math.max(0, Date.now() - startedAt);
    const outputTokens = Math.max(0, Math.round(Number(final?.outputTokens) || 0));
    const rate = (tokens, ms) => (ms > 0 ? tokens / (ms / 1000) : 0);
    if (!firstTokenAt) {
      // Tool-only reply or an early stop: the request itself is the only span.
      // A quarter second is the shortest span worth dividing by — a cached
      // answer can finish within a millisecond and would otherwise read as tens
      // of thousands of tokens per second.
      const tps = rate(outputTokens, Math.max(durationMs, 250));
      return {
        durationMs,
        firstTokenMs: durationMs,
        generationMs: durationMs,
        tokensPerSecond: tps,
        peakTokensPerSecond: tps,
      };
    }
    // Span between the first and last streamed piece. A short answer can
    // arrive entirely inside one network read, leaving a 1–2 ms gap; dividing
    // by that tick reported six-figure tok/s (123 tokens in 1 ms = 123,000).
    // When the stream was too short to observe, the request's wall-clock is
    // the only honest upper bound — the same one the tool-only branch uses.
    const observedMs = lastTokenAt - firstTokenAt;
    const generationMs = observedMs >= 250 ? observedMs : Math.max(durationMs, 250);
    const tokensPerSecond = rate(outputTokens, generationMs);
    let peakTokensPerSecond = tokensPerSecond;
    // A one-second window means nothing when the whole stream was shorter than
    // that: the window covers everything, so "peak" would just repeat the
    // average with extra quantization noise.
    if (emittedChars >= 40 && outputTokens > 0 && rateSamples.length > 1 && observedMs >= 1000) {
      const scale = outputTokens / emittedChars;
      let start = 0;
      for (let end = 0; end < rateSamples.length; end += 1) {
        // Trailing one-second window. The span is measured from the window
        // edge, not from the first sample inside it: a buffered burst lands
        // many chunks in the same millisecond, and dividing by that millisecond
        // would invent a rate thousands of times too high.
        const windowStart = Math.max(firstTokenAt, rateSamples[end].at - 1000);
        while (start < end && rateSamples[start].at < windowStart) start += 1;
        const base = start > 0 ? rateSamples[start - 1].chars : 0;
        // A quarter second is the shortest window worth dividing by: the first
        // sample(s) arrive within a millisecond or two, and dividing a chunk by
        // that sliver would report tens of thousands of tokens per second.
        const span = Math.max(250, rateSamples[end].at - windowStart);
        peakTokensPerSecond = Math.max(
          peakTokensPerSecond,
          ((rateSamples[end].chars - base) * scale * 1000) / span,
        );
      }
    }
    return {
      durationMs,
      firstTokenMs: Math.max(0, firstTokenAt - startedAt),
      generationMs,
      tokensPerSecond,
      peakTokensPerSecond,
    };
  };

  try {
    for await (const chunk of response.body) {
      buffer += decoder.decode(chunk, { stream: true });
      let index;
      while ((index = buffer.indexOf('\n')) >= 0) {
        const line = buffer.slice(0, index);
        buffer = buffer.slice(index + 1);
        handleLine(line);
      }
    }
    buffer += decoder.decode();
    if (buffer) handleLine(buffer);
    splitter.flush();
  } catch (error) {
    aborted = Boolean(signal?.aborted);
    // A stopped answer still spent tokens. Carry the partial counts so the
    // caller can bill them instead of dropping the request.
    try {
      const partial = buildUsage();
      error.usage = { ...partial, ...buildTiming(partial) };
    } catch {
      /* keep the original error intact */
    }
    throw error;
  }

  const toolCalls = [];
  if (!aborted) {
    if (request.style === 'openai') {
      for (const call of openaiCalls.values()) {
        if (!call.name) continue;
        toolCalls.push({
          id: call.id || fallbackId(),
          name: call.name,
          args: normalizeArgs(call.argsText),
        });
      }
    } else if (request.style === 'anthropic') {
      for (const call of anthropicCalls.values()) {
        if (!call.name) continue;
        toolCalls.push({
          id: call.id || fallbackId(),
          name: call.name,
          args: normalizeArgs(call.argsText),
        });
      }
    } else {
      toolCalls.push(...ollamaCalls);
    }
  }

  const finalUsage = buildUsage();
  return {
    text,
    thinking: thinkingText,
    toolCalls,
    finishReason,
    usage: { ...finalUsage, ...buildTiming(finalUsage) },
  };
}

module.exports = { streamChat, buildRequest, estimateTokens };
