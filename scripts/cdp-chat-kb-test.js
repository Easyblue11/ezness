/**
 * End-to-end check of the composer knowledge-base popover and RAG sending.
 * Requires the app running with --remote-debugging-port=9222 and a chat model
 * that answers (the local Ollama default is fine).
 *
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/cdp-chat-kb-test.js
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ezness-rag-'));
  const sample = path.join(work, 'RAG测试样本.txt');
  fs.writeFileSync(
    sample,
    'Ezness 内部测试资料。EZNESS_TEST_FACT 的值是 42。除了这份资料，别处没有这个数字。\n',
    'utf8',
  );
  const samplePath = sample.replace(/\\/g, '\\\\');

  // Clean up leftovers from aborted runs.
  const initial = await evaluate('window.ezness.kbSnapshot()');
  for (const category of initial.categories.filter((c) => c.name === 'RAG测试')) {
    for (const doc of initial.documents.filter((d) => d.categoryId === category.id)) {
      await evaluate(`window.ezness.kbDeleteDocument('${doc.id}')`);
    }
    await evaluate(`window.ezness.kbDeleteCategory('${category.id}')`);
  }

  // Fresh conversation, so this run doesn't inherit another test's model/KB.
  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(200);
  await evaluate(`document.querySelector('.newchat').click(); true;`);
  await sleep(300);

  // Pick a small instruct model; a base model ignores the RAG instructions.
  await evaluate(`document.querySelector('.model-menu .chip').click(); true;`);
  await sleep(200);
  const modelPicked = await evaluate(`
    (() => {
      const items = [...document.querySelectorAll('.model-menu .menu__item')];
      const item = items.find((el) => el.textContent.includes('deepseek-r1:1.5b'));
      if (!item) return items.map((el) => el.textContent.trim());
      item.click();
      return true;
    })()
  `);
  console.log('model:', modelPicked);
  await sleep(200);

  const created = await evaluate(`window.ezness.kbCreateCategory('RAG测试')`);
  const cat = created.categories.find((c) => c.name === 'RAG测试');
  const accepted = await evaluate(`window.ezness.kbAddFiles(['${samplePath}'], '${cat.id}')`);
  const docId = accepted[0]?.id;

  // Wait for embedding so the search has vectors.
  let ready = false;
  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1000);
    const snapshot = await evaluate('window.ezness.kbSnapshot()');
    const doc = snapshot.documents.find((d) => d.id === docId);
    if (doc?.status === 'ready') {
      ready = true;
      break;
    }
    if (doc?.status === 'error') throw new Error(`测试文档入库失败：${doc.error}`);
  }
  if (!ready) throw new Error('测试文档一直没有向量化完成');

  // Open the popover if it isn't already, then inspect it.
  await evaluate(`
    (() => {
      if (!document.querySelector('.kbmenu__panel')) document.querySelector('.chip--kb').click();
      return true;
    })()
  `);
  await sleep(300);
  const panel = await evaluate(`
    (() => {
      const el = document.querySelector('.kbmenu__panel');
      if (!el) return null;
      return {
        title: el.querySelector('.kbmenu__title')?.textContent,
        chipOn: document.querySelector('.chip--kb')?.classList.contains('is-on'),
        categoryValue: el.querySelector('.kbmenu__combo-input')?.value,
        modes: [...el.querySelectorAll('.kbmenu__mode-title')].map((o) => o.textContent),
      };
    })()
  `);
  console.log('panel:', JSON.stringify(panel));

  // Turn it on (if it isn't), then filter the category list by typing.
  await evaluate(`
    (() => {
      const toggle = document.querySelector('.kbmenu__panel .switch');
      if (!toggle.classList.contains('is-on')) toggle.click();
      return true;
    })()
  `);
  await sleep(150);
  await evaluate(`
    (() => {
      const input = document.querySelector('.kbmenu__combo-input');
      input.blur();
      input.focus();
      return true;
    })()
  `);
  await sleep(250);
  const allOptions = await evaluate(
    `[...document.querySelectorAll('.kbmenu__combo-item')].map((el) => el.textContent)`,
  );
  console.log('category options:', JSON.stringify(allOptions));

  await evaluate(`
    (() => {
      const input = document.querySelector('.kbmenu__combo-input');
      const setter = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set;
      setter.call(input, 'RAG');
      input.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  let filtered = [];
  for (let attempt = 0; attempt < 20; attempt += 1) {
    await sleep(150);
    filtered = await evaluate(
      `[...document.querySelectorAll('.kbmenu__combo-item')].map((el) => el.textContent)`,
    );
    if (filtered.length === 1 && filtered[0] === 'RAG测试') break;
  }
  console.log('filtered by "RAG":', JSON.stringify(filtered));

  await evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.kbmenu__combo-item')].find((el) => el.textContent === 'RAG测试');
      item.click();
      return true;
    })()
  `);
  await sleep(150);

  await evaluate(`
    (() => {
      const mode = [...document.querySelectorAll('.kbmenu__mode')].find((el) =>
        el.textContent.includes('完全基于知识库'),
      );
      mode.click();
      return true;
    })()
  `);
  await sleep(200);
  const state = await evaluate(`
    (() => ({
      chip: document.querySelector('.chip--kb')?.className,
      chipTitle: document.querySelector('.chip--kb')?.title,
      categoryValue: document.querySelector('.kbmenu__combo-input')?.value,
      activeMode: document.querySelector('.kbmenu__mode.is-active .kbmenu__mode-title')?.textContent,
    }))()
  `);
  console.log('after selecting:', JSON.stringify(state));

  await evaluate(`document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); true;`);
  await sleep(200);

  // Send through the UI so the whole send path runs.
  await evaluate(`
    (() => {
      const textarea = document.querySelector('.composer__input');
      const setter = Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype, 'value').set;
      setter.call(textarea, 'EZNESS_TEST_FACT 的值是多少？');
      textarea.dispatchEvent(new Event('input', { bubbles: true }));
      return true;
    })()
  `);
  await sleep(200);
  await evaluate(`document.querySelector('.send').click(); true;`);

  // Wait for the stream to finish.
  let streamed = false;
  for (let attempt = 0; attempt < 150; attempt += 1) {
    await sleep(1000);
    const streaming = await evaluate(`document.querySelector('.send').classList.contains('send--stop')`);
    if (!streaming) {
      const count = await evaluate(`document.querySelectorAll('.msg--assistant').length`);
      if (count > 0) {
        streamed = true;
        break;
      }
    }
  }
  if (!streamed) throw new Error('没有等到助手回复');

  const answer = await evaluate(`
    (() => {
      const bubbles = [...document.querySelectorAll('.msg--assistant .msg__bubble')];
      const last = bubbles[bubbles.length - 1];
      const sources = [...document.querySelectorAll('.msg__sources')].pop();
      return { text: last?.textContent ?? '', sources: sources?.textContent ?? '' };
    })()
  `);
  console.log('answer:', answer.text.replace(/\s+/g, ' ').slice(0, 300));
  console.log('mentions 42:', answer.text.includes('42'));
  console.log('sources:', answer.sources);

  // Cleanup.
  if (docId) await evaluate(`window.ezness.kbDeleteDocument('${docId}')`);
  await evaluate(`window.ezness.kbDeleteCategory('${cat.id}')`);
  cdp.close();
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
