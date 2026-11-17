/**
 * Checks whether the embedding call evicts the chat model (Ollama keeps a
 * limited number of models resident) and how fast a warm embed call is.
 */
const HOST = 'http://127.0.0.1:11434';

async function embed() {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/embed`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ model: 'nomic-embed-text:latest', input: '知识库检索测试' }),
  });
  await response.json();
  return Math.round(performance.now() - started);
}

async function chatOnce(model) {
  const started = performance.now();
  const response = await fetch(`${HOST}/api/chat`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({
      model,
      messages: [{ role: 'user', content: '说一句你好' }],
      stream: true,
      options: { num_predict: 8 },
    }),
  });
  const decoder = new TextDecoder();
  let buffer = '';
  let first = null;
  for await (const chunk of response.body) {
    buffer += decoder.decode(chunk, { stream: true });
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      const payload = JSON.parse(line);
      if (payload.message?.content && first === null) first = performance.now() - started;
    }
  }
  return { ttft: first === null ? null : Math.round(first), total: Math.round(performance.now() - started) };
}

async function ps() {
  const payload = await (await fetch(`${HOST}/api/ps`)).json();
  return payload.models.map((m) => `${m.name} (vram ${Math.round((m.size_vram || 0) / 1e6)}MB)`).join(', ');
}

(async () => {
  const model = process.argv[2] || 'qwen2.5-coder:1.5b-base';
  console.log('chat warm:', await chatOnce(model), '| loaded:', await ps());
  console.log('embed #1:', await embed(), 'ms', '| loaded:', await ps());
  console.log('embed #2:', await embed(), 'ms', '| loaded:', await ps());
  console.log('chat after embed:', await chatOnce(model), '| loaded:', await ps());
})();
