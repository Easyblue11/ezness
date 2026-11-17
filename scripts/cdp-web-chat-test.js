/**
 * End-to-end check: with only the 联网 switch on (knowledge base off), sending a
 * message performs a local web search and attaches the results to the answer.
 * Requires the app running with --remote-debugging-port=9222 and a reachable model.
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

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(200);
  await evaluate(`document.querySelector('.newchat').click(); true;`);
  await sleep(300);

  // Web on, knowledge base off.
  await evaluate(`document.querySelector('.composer .chip--web').click(); true;`);
  await sleep(150);

  const chatOff = await evaluate(`!document.querySelector('.composer .chip--kb').classList.contains('is-on')`);
  console.log('kb off:', chatOff);

  await evaluate(`(() => {
    const box = document.querySelector('.composer__input');
    const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
    setter.call(box, '上海今天天气怎么样');
    box.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  })()`);
  await sleep(100);
  await evaluate(`document.querySelector('.composer .send').click(); true;`);

  let sources = null;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(500);
    sources = await evaluate(`(() => {
      const el = [...document.querySelectorAll('.msg__sources')].pop();
      return el ? el.textContent.trim() : null;
    })()`);
    if (sources) break;
  }
  console.log('sources:', sources);

  const typing = await evaluate(`(() => {
    const el = document.querySelector('.msg__typing');
    return el ? el.textContent.trim() : null;
  })()`);
  console.log('bubble while streaming:', typing);

  // Stop the generation; we only needed the retrieval part.
  await evaluate(`(() => {
    const stop = document.querySelector('.composer .send--stop');
    if (stop) stop.click();
    return true;
  })()`);
  await sleep(500);

  cdp.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
