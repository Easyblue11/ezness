/**
 * Saves a screenshot of the renderer. Usage: node scripts/cdp-shot.js <out.png>
 * Requires the app running with --remote-debugging-port=9222.
 */
const fs = require('node:fs');
const path = require('node:path');

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
  const out = process.argv[2] || path.join(process.env.TEMP || '.', 'ezness.png');
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
    pending.get(data.id)(data.result ?? {});
    pending.delete(data.id);
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });

  const shot = await send('Page.captureScreenshot', { format: 'png' });
  fs.writeFileSync(out, Buffer.from(shot.data, 'base64'));
  console.log(out);
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
