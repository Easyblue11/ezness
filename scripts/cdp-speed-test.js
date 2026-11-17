/**
 * Checks the live tok/s readout under the composer.
 * Requires the app running with --remote-debugging-port=9222.
 */
const PORT = 9222;
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && /index\.html/.test(item.url));
      if (page) return page;
    } catch {
      /* not listening yet */
    }
    await sleep(500);
  }
  throw new Error('找不到渲染进程');
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 1;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    if (!data.id || !pending.has(data.id)) return;
    const { resolve, reject } = pending.get(data.id);
    pending.delete(data.id);
    if (data.error) reject(new Error(JSON.stringify(data.error)));
    else resolve(data.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = nextId++;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

async function main() {
  const target = await pageTarget();
  const cdp = connect(target.webSocketDebuggerUrl);
  await cdp.ready;

  async function evaluate(expression) {
    const result = await cdp.send('Runtime.evaluate', {
      expression,
      awaitPromise: true,
      returnByValue: true,
    });
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description ?? result.exceptionDetails.text;
      throw new Error(`渲染进程异常：${detail}`);
    }
    return result.result.value;
  }

  // Fresh chat with a small, fast model.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(200);
  await evaluate(`document.querySelector('.newchat').click(); true;`);
  await sleep(300);
  await evaluate(`document.querySelector('.model-menu .chip').click(); true;`);
  await sleep(200);
  const picked = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('.model-menu .menu__item')];
      const item = items.find((el) => el.textContent.includes('deepseek-r1:1.5b'));
      if (item) item.click();
      return Boolean(item);
    })()
  `);
  console.log('model picked:', picked);

  // Order check: hint line sits above the speed line.
  const layout = await evaluate(`
    (() => {
      const hint = document.querySelector('.composer__hint');
      const speed = document.querySelector('.composer__speed');
      if (!hint || !speed) return null;
      return { hintBottom: hint.getBoundingClientRect().bottom, speedTop: speed.getBoundingClientRect().top };
    })()
  `);
  console.log('layout:', JSON.stringify(layout));

  const initialSpeed = await evaluate(`document.querySelector('.composer__speed')?.textContent ?? ''`);
  console.log('speed while idle:', JSON.stringify(initialSpeed));

  await evaluate(`
    (() => {
      const textarea = document.querySelector('.composer__input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '写一段大约三百字的短文，描述秋天的清晨。');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(100);
  await evaluate(`document.querySelector('.send').click(); true;`);

  const samples = [];
  for (let attempt = 0; attempt < 14; attempt += 1) {
    await sleep(1000);
    const snapshot = await evaluate(`
      (() => ({
        speed: document.querySelector('.composer__speed')?.textContent ?? '',
        streaming: document.querySelector('.send')?.classList.contains('send--stop') ?? false,
      }))()
    `);
    if (snapshot.speed) samples.push(snapshot.speed);
    if (!snapshot.streaming && samples.length > 0) break;
  }
  console.log('speed samples:', JSON.stringify(samples));

  const valid = samples.filter((text) => /^\d+\.\d tok\/s$/.test(text));
  console.log('valid samples:', valid.length);
  if (valid.length === 0) throw new Error('没有出现 tok/s 读数');
  const numbers = valid.map((text) => Number.parseFloat(text));
  console.log('rate range:', Math.min(...numbers), '-', Math.max(...numbers));

  // Stop if still running, then the line must clear itself.
  const stillStreaming = await evaluate(`document.querySelector('.send').classList.contains('send--stop')`);
  if (stillStreaming) await evaluate(`document.querySelector('.send').click(); true;`);
  await sleep(1200);
  const after = await evaluate(`document.querySelector('.composer__speed')?.textContent ?? ''`);
  console.log('speed after stop:', JSON.stringify(after));
  if (after !== '') throw new Error('停止后读数没有清空');

  cdp.close();
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
