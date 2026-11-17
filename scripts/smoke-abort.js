/** Verifies chat:abort actually tears down the HTTP stream. */
const { streamChat } = require('../electron/chat');

async function main() {
  const controller = new AbortController();
  let received = 0;
  const started = Date.now();

  const run = streamChat(
    { apiType: 'ollama', baseUrl: 'http://localhost:11434', apiKey: '', model: 'qwen3:4b' },
    [{ role: 'user', content: '数到一百万，一个一个数。' }],
    {
      signal: controller.signal,
      onDelta: () => {
        received += 1;
      },
      onThinking: () => {
        received += 1;
      },
    },
  );

  setTimeout(() => controller.abort(), 4000);

  try {
    await run;
    console.log('stream finished before abort');
  } catch (error) {
    console.log('error name:', error?.name);
    console.log('aborted:', controller.signal.aborted);
    console.log('callbacks after abort:', received, 'elapsed:', Date.now() - started, 'ms');
  }
}

main();
