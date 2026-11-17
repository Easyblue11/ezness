/**
 * Evaluates an expression in the renderer and prints the JSON result.
 * Usage: node scripts/cdp-eval.js "<expression>"
 * Requires the app running with --remote-debugging-port=9222.
 */
const PORT = 9222;

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && /index\.html/.test(item.url));
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await new Promise((resolve) => setTimeout(resolve, 500));
  }
  throw new Error('找不到渲染进程');
}

async function main() {
  const expression = process.argv.slice(2).join(' ');
  if (!expression) throw new Error('用法：node scripts/cdp-eval.js "<expression>"');

  const target = await pageTarget();
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 1;
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    pending.get(data.id)(data.result);
    pending.delete(data.id);
  });
  const result = await new Promise((resolve) => {
    const id = nextId++;
    pending.set(id, resolve);
    ws.send(
      JSON.stringify({
        id,
        method: 'Runtime.evaluate',
        params: { expression, awaitPromise: true, returnByValue: true },
      }),
    );
  });
  if (result?.exceptionDetails) {
    console.error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    process.exitCode = 1;
  } else {
    console.log(JSON.stringify(result?.result?.value, null, 2));
  }
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
