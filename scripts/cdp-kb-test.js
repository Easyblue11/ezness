/**
 * Live renderer check for the knowledge base.
 *
 * Talks to the running app over the Chrome DevTools Protocol so it exercises
 * exactly what the UI does: preload -> IPC -> engine -> kb:event back into the
 * page. Launch the app with `npm start -- --remote-debugging-port=9222` first.
 *
 * Run with:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/cdp-kb-test.js
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
      /* app not listening yet */
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

  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'ezness-cdp-'));
  const sample = path.join(work, 'CDP测试样本.txt');
  fs.writeFileSync(
    sample,
    'Ezness 知识库端到端测试。\n这是一段用于验证导入事件的文本，包含中文分词、切片和向量化流程。\n',
    'utf8',
  );
  const samplePath = sample.replace(/\\/g, '\\\\');

  console.log('renderer:', target.url);
  console.log('api keys:', await evaluate('Object.keys(window.ezness).length'));

  // Start recording events and clear any previous recording.
  await evaluate(`
    window.__kbEvents = [];
    if (window.__kbUnsub) window.__kbUnsub();
    window.__kbUnsub = window.ezness.onKbEvent((event) => window.__kbEvents.push(event));
    true;
  `);

  const before = await evaluate('window.ezness.kbSnapshot()');
  console.log('categories before:', before.categories.map((c) => `${c.id}:${c.name}`).join(', '));

  const category = await evaluate(
    `window.ezness.kbCreateCategory('CDP测试分类')`,
  );
  const testCat = category.categories.find((c) => c.name === 'CDP测试分类');
  console.log('created category:', testCat);

  const accepted = await evaluate(
    `window.ezness.kbAddFiles(['${samplePath}'], '${testCat.id}')`,
  );
  console.log('accepted:', accepted);
  const docId = accepted[0]?.id;

  // Insertion should show up immediately, without a reload.
  await sleep(1200);
  let snapshot = await evaluate('window.ezness.kbSnapshot()');
  let doc = snapshot.documents.find((item) => item.id === docId);
  console.log('after 1.2s:', doc ? `${doc.status} cat=${doc.categoryId}` : 'NOT FOUND');

  for (let attempt = 0; attempt < 40; attempt += 1) {
    await sleep(1500);
    snapshot = await evaluate('window.ezness.kbSnapshot()');
    doc = snapshot.documents.find((item) => item.id === docId);
    if (!doc) break;
    if (doc.status === 'ready' || doc.status === 'error') break;
  }
  console.log('final status:', doc ? `${doc.status} chunks=${doc.chunkCount} cat=${doc.categoryId} err=${doc.error ?? ''}` : 'MISSING');

  const events = await evaluate('window.__kbEvents');
  const summary = {};
  for (const event of events) {
    const key = event.type === 'refresh' ? 'refresh' : `${event.type}:${event.stage ?? '?'}`;
    summary[key] = (summary[key] ?? 0) + 1;
  }
  console.log('events observed:', summary);

  // Clean up so the user's library is left as it was.
  if (docId) await evaluate(`window.ezness.kbDeleteDocument('${docId}')`);
  await evaluate(`window.ezness.kbDeleteCategory('${testCat.id}')`);
  const after = await evaluate('window.ezness.kbSnapshot()');
  console.log('documents after cleanup:', after.documents.length, 'categories:', after.categories.length);

  cdp.close();
  fs.rmSync(work, { recursive: true, force: true });
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
