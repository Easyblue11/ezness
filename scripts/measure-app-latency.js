/**
 * Measures what the user actually sees: time from clicking send to the first
 * rendered character, and how many DOM updates the stream triggers.
 *
 *   npm start -- --remote-debugging-port=9222
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/measure-app-latency.js qwen2.5-coder:1.5b-base
 */
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const PORT = 9222;

async function pageTarget() {
  for (let attempt = 0; attempt < 40; attempt += 1) {
    try {
      const list = await (await fetch(`http://127.0.0.1:${PORT}/json/list`)).json();
      const page = list.find((item) => item.type === 'page' && /index\.html/.test(item.url));
      if (page) return page;
    } catch {
      /* not up yet */
    }
    await sleep(500);
  }
  throw new Error('找不到渲染进程');
}

function connect(url) {
  const ws = new WebSocket(url);
  const pending = new Map();
  let nextId = 0;
  const ready = new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve, { once: true });
    ws.addEventListener('error', reject, { once: true });
  });
  ws.addEventListener('message', (event) => {
    const data = JSON.parse(event.data);
    const entry = pending.get(data.id);
    if (!entry) return;
    pending.delete(data.id);
    data.error ? entry.reject(new Error(JSON.stringify(data.error))) : entry.resolve(data.result);
  });
  const send = (method, params) =>
    new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      ws.send(JSON.stringify({ id, method, params }));
    });
  return { ready, send, close: () => ws.close() };
}

(async () => {
  const modelLabel = process.argv[2] || 'qwen2.5-coder:1.5b-base';
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
      throw new Error(result.exceptionDetails.exception?.description ?? result.exceptionDetails.text);
    }
    return result.result.value;
  }

  console.log('defaults:', await evaluate(`window.ezness.loadSettings().then((s) => s?.defaults)`));

  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(200);
  await evaluate(`document.querySelector('.newchat').click(); true;`);
  await sleep(300);

  // Pick the requested model from the composer menu.
  await evaluate(`document.querySelector('.model-menu .chip').click(); true;`);
  await sleep(200);
  const picked = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('.model-menu .menu__item')];
      const item = items.find((el) => el.textContent.includes(${JSON.stringify(modelLabel)}));
      if (!item) return items.map((el) => el.textContent);
      item.click();
      return true;
    })()
  `);
  console.log('model selection:', picked);
  await sleep(200);

  await evaluate(`
    (() => {
      const textarea = document.querySelector('.composer__input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, '用一句话解释什么是 HTTP');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(200);

  await evaluate(`
    (() => {
      window.__m = { t0: performance.now(), first: null, last: null, count: 0 };
      window.__obs?.disconnect();
      window.__obs = new MutationObserver(() => {
        const el = document.querySelector('.msg--assistant .md');
        if (!el || !(el.textContent || '').trim()) return;
        const now = performance.now() - window.__m.t0;
        if (window.__m.first === null) window.__m.first = now;
        window.__m.last = now;
        window.__m.count += 1;
      });
      window.__obs.observe(document.querySelector('.chat__body'), {
        subtree: true,
        childList: true,
        characterData: true,
      });
      return true;
    })()
  `);

  await evaluate(`
    (() => {
      window.__m.t0 = performance.now();
      document.querySelector('.send').click();
      return true;
    })()
  `);

  const started = Date.now();
  let done = false;
  while (Date.now() - started < 120000) {
    await sleep(500);
    done = await evaluate(`
      (() => !document.querySelector('.send').classList.contains('send--stop')
        && (document.querySelector('.msg--assistant .md')?.textContent || '').trim().length > 0)()
    `);
    if (done) break;
  }

  const metrics = await evaluate(`
    (() => ({
      ...window.__m,
      text: (document.querySelector('.msg--assistant .md')?.textContent || '').replace(/\\s+/g, ' ').slice(0, 120),
    }))()
  `);
  console.log('first paint (ms):', metrics.first === null ? null : Math.round(metrics.first));
  console.log('last paint (ms):', metrics.last === null ? null : Math.round(metrics.last));
  console.log('dom updates:', metrics.count);
  console.log('answer:', metrics.text);
  console.log('stream still running:', !done);

  cdp.close();
})().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
