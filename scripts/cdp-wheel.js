/**
 * Drives real wheel events through CDP so Chromium performs its own hit-testing
 * and scroll chaining, then reports the chat scroll position after each step.
 * Usage: node scripts/cdp-wheel.js <x> <y> <steps> [deltaY]
 */
const PORT = 9222;

async function pageTarget() {
  const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
  const page = list.find((item) => item.type === 'page' && /index\.html/.test(item.url));
  if (!page) throw new Error('找不到渲染进程');
  return page;
}

async function main() {
  const [x, y, steps, delta] = process.argv.slice(2).map(Number);
  if (![x, y, steps].every(Number.isFinite)) {
    throw new Error('用法：node scripts/cdp-wheel.js <x> <y> <steps> [deltaY]');
  }
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
    pending.get(data.id)(data);
    pending.delete(data.id);
  });
  const send = (method, params) =>
    new Promise((resolve) => {
      const id = nextId++;
      pending.set(id, resolve);
      ws.send(JSON.stringify({ id, method, params }));
    });
  const evaluate = (expression) =>
    send('Runtime.evaluate', { expression, returnByValue: true, awaitPromise: true });

  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y, button: 'none' });
  const rows = [];
  for (let step = 0; step < steps; step += 1) {
    await send('Input.dispatchMouseEvent', {
      type: 'mouseWheel',
      x,
      y,
      deltaX: 0,
      deltaY: delta ?? 120,
      button: 'none',
    });
    await new Promise((resolve) => setTimeout(resolve, 120));
    const result = await evaluate(
      `(() => { const b = document.querySelector('.chat__body');
        return { st: Math.round(b.scrollTop), max: Math.round(b.scrollHeight - b.clientHeight),
                 target: (() => { const el = document.elementFromPoint(${x}, ${y});
                   return el ? el.tagName + '.' + String(el.className).slice(0, 28) : null })() };
      })()`,
    );
    rows.push(result.result?.result?.value);
  }
  console.log(JSON.stringify(rows));
  ws.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
