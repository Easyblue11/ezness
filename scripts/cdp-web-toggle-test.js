/**
 * Checks the three-state 联网 control next to 知识库:
 *   - the chip opens a menu with 关闭 / 自动 / 总是
 *   - 总是 / 关闭 switch the chip state without touching the knowledge base
 *   - choosing "知识库 + 联网补充" with 关闭 raises the web mode to 自动
 *   - turning 联网 off while on that KB mode drops it back to 知识库为主
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

  const chip = `.composer .chip--web`;
  const state = () =>
    evaluate(`(() => {
      const el = document.querySelector('${chip}');
      if (!el) return null;
      return {
        pressed: el.getAttribute('aria-pressed'),
        on: el.classList.contains('is-on'),
        mode: el.querySelector('.chip__state')?.textContent ?? '',
      };
    })()`);
  const choose = (label) =>
    evaluate(
      `[...document.querySelectorAll('.kbmenu__panel--web .ask-slider__label')].find((b) => b.textContent.trim() === ${JSON.stringify(label)}).click(); true;`,
    );

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(200);
  await evaluate(`document.querySelector('.newchat').click(); true;`);
  await sleep(400);

  console.log('new chat:', JSON.stringify(await state()));

  await evaluate(`document.querySelector('${chip}').click(); true;`);
  await sleep(150);
  console.log('menu stops:', await evaluate(
    `[...document.querySelectorAll('.kbmenu__panel--web .ask-slider__label')].map((b) => b.textContent.trim())`,
  ));

  // 总是 on its own, with the knowledge base still off.
  await choose('总是');
  await sleep(150);
  console.log('after 总是:', JSON.stringify(await state()));
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);

  // Enable the KB, then pick 知识库 + 联网补充 (third mode).
  await evaluate(`document.querySelector('.kbmenu .chip--kb').click(); true;`);
  await sleep(150);
  await evaluate(`document.querySelector('.kbmenu .switch').click(); true;`);
  await sleep(150);
  await evaluate(`document.querySelectorAll('.kbmenu__mode')[2].click(); true;`);
  await sleep(150);
  console.log('kb mode selected:', JSON.stringify(await state()));

  // Turning 联网 off must drop the KB mode back to 知识库为主 (second mode).
  await evaluate(`document.querySelector('.kbmenu .chip--kb').click(); true;`);
  await sleep(100);
  await evaluate(`document.querySelector('${chip}').click(); true;`);
  await sleep(100);
  await choose('关闭');
  await sleep(150);
  const modeState = await evaluate(`(() => {
    const modes = [...document.querySelectorAll('.kbmenu__mode')];
    return modes.map((el) => ({ title: el.querySelector('.kbmenu__mode-title')?.textContent, active: el.classList.contains('is-active') }));
  })()`);
  console.log('after 关闭:', JSON.stringify(await state()));
  console.log('modes:', JSON.stringify(modeState));

  // Selecting the 联网 mode again must raise the chip from 关闭 to 自动.
  await evaluate(`document.querySelectorAll('.kbmenu__mode')[2].click(); true;`);
  await sleep(150);
  console.log('web mode again:', JSON.stringify(await state()));

  cdp.close();
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
