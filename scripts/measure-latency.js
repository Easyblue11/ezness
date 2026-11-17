/**
 * Measures raw Ollama latency: first token, chunks, total, embedding time.
 * Used to separate model slowness from app-side delay.
 *
 *   node scripts/measure-latency.js [model...]
 */
const HOST = 'http://127.0.0.1:11434';

async function chat(model, prompt, options = {}) {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: prompt }],
      stream: true,
      options: { num_predict: 64, ...options },
    }),
  });
  if (!response.ok) {
    return { model, error: `${response.status} ${(await response.text()).slice(0, 120)}` };
  }

  const decoder = new TextDecoder();
  let buffer = '';
  let first = null;
  let answer = '';
  let thinking = '';
  let chunks = 0;

  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      let payload;
      try {
        payload = JSON.parse(line);
      } catch {
        continue;
      }
      chunks += 1;
      if (payload.message?.thinking) thinking += payload.message.thinking;
      if (payload.message?.content) {
        if (first === null) first = performance.now() - started;
        answer += payload.message.content;
      }
    }
  }

  return {
    model,
    ttft: first === null ? null : Math.round(first),
    total: Math.round(performance.now() - started),
    chunks,
    answer: answer.replace(/\s+/g, ' ').slice(0, 70),
    thinkingChars: thinking.length,
  };
}

async function embed(model, text) {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model, input: text }),
  });
  const payload = await response.json();
  return {
    model,
    ms: Math.round(performance.now() - started),
    dims: payload.embeddings?.[0]?.length ?? 0,
    error: payload.error,
  };
}

(async () => {
  const models = process.argv.slice(2);
  const targets = models.length > 0 ? models : ['qwen2.5-coder:1.5b-base', 'qwen3:4b'];

  for (const model of targets) {
    // Cold and warm, so model-load time doesn't hide streaming speed.
    console.log('cold:', await chat(model, '用一句话介绍你自己'));
    console.log('warm:', await chat(model, '说一句你好'));
  }

  console.log('embed:', await embed('nomic-embed-text:latest', '知识库检索测试'));
})();
