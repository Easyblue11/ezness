/**
 * Renders the knowledge page in the running app and checks that a file added
 * while a category is selected shows up in that category's DOM without a
 * reload. Complements cdp-kb-test.js, which checks the IPC/event layer only.
 *
 *   npm start -- --remote-debugging-port=9222
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/cdp-kb-ui-test.js
 */
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

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
  throw new Error('找不到渲染进程，应用是否带 --remote-debugging-port=9222 启动？');
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ezness-ui-'));
  const sample = path.join(work, 'UI测试样本.txt');
  fs.writeFileSync(sample, 'UI 测试：验证导入后列表立即刷新。\n', 'utf8');
  const samplePath = sample.replace(/\\/g, '\\\\');

  // Remove leftovers from an aborted earlier run.
  const stale = await evaluate('window.ezness.kbSnapshot()');
  for (const category of stale.categories.filter((c) => c.name === 'UI测试分类')) {
    await evaluate(`window.ezness.kbDeleteCategory('${category.id}')`);
  }

  // Open the knowledge page and create the scratch category through the UI,
  // the same way a user would.
  await evaluate(`document.querySelector('.rail__btn[title="知识库"]').click(); true;`);
  await sleep(300);
  await evaluate(`document.querySelector('.kb__cats-head .iconbtn').click(); true;`);
  await sleep(200);
  await evaluate(`
    (() => {
      const input = document.querySelector('.kb-cat__input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'UI测试分类');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(150);
  await evaluate(`
    (() => {
      const input = document.querySelector('.kb-cat__input');
      input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
      return true;
    })()
  `);
  await sleep(400);

  const snap = await evaluate('window.ezness.kbSnapshot()');
  const cat = snap.categories.find((c) => c.name === 'UI测试分类');
  if (!cat) throw new Error('分类没有创建成功');

  const clicked = await evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.kb-cat')].find((el) => el.textContent.includes('UI测试分类'));
      if (!item) return false;
      item.click();
      return true;
    })()
  `);
  if (!clicked) throw new Error('左侧分类列表里没找到新分类');
  await sleep(300);

  const accepted = await evaluate(`window.ezness.kbAddFiles(['${samplePath}'], '${cat.id}')`);
  const docId = accepted[0]?.id;

  // Poll the DOM the way a user watching the list would.
  let names = [];
  for (let attempt = 0; attempt < 12; attempt += 1) {
    await sleep(500);
    names = await evaluate(`[...document.querySelectorAll('.kb-doc__name')].map((el) => el.textContent)`);
    if (names.includes('UI测试样本.txt')) break;
  }
  const headerCount = await evaluate(`document.querySelector('.kb__count')?.textContent ?? ''`);
  console.log('category selected:', await evaluate(`document.querySelector('.kb__title span')?.textContent ?? ''`));
  console.log('list shows:', names);
  console.log('header:', headerCount);
  console.log('appeared without reload:', names.includes('UI测试样本.txt'));

  // Clean up and go back to the aggregate view.
  if (docId) await evaluate(`window.ezness.kbDeleteDocument('${docId}')`);
  await evaluate(`window.ezness.kbDeleteCategory('${cat.id}')`);
  await evaluate(`
    (() => {
      const all = [...document.querySelectorAll('.kb-cat')].find((el) => el.textContent.includes('全部'));
      all?.click();
      return true;
    })()
  `);
  await sleep(200);
  const left = await evaluate('window.ezness.kbSnapshot()');
  console.log('documents after cleanup:', left.documents.length, 'categories:', left.categories.length);

  cdp.close();
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
