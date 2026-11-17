/**
 * Streaming smoke test against a local Ollama model.
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-chat.js [model]
 */

const { streamChat } = require('../electron/chat');

const model = process.argv[2] || 'qwen3:4b';

async function main() {
  let text = '';
  let thinking = '';
  let deltas = 0;
  const started = Date.now();

  await streamChat(
    { apiType: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model },
    [{ role: 'user', content: '用一句话介绍一下你自己。' }],
    {
      onDelta: (delta) => {
        deltas += 1;
        text += delta;
        if (deltas === 1) console.log('first answer delta after', Date.now() - started, 'ms');
      },
      onThinking: (delta) => {
        if (!thinking) console.log('first thinking delta after', Date.now() - started, 'ms');
        thinking += delta;
      },
    },
  );

  console.log(`model: ${model}`);
  console.log(`thinking chars: ${thinking.length}, answer chars: ${text.length}, total: ${Date.now() - started}ms`);
  console.log(`answer keeps raw think tags: ${/<think/i.test(text)}`);
  console.log('--- thinking ---');
  console.log(thinking.slice(0, 160));
  console.log('--- answer ---');
  console.log(text.slice(0, 240));
}

main().catch((error) => {
  console.error('FAILED:', error);
  process.exitCode = 1;
});
