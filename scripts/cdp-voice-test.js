/**
 * End-to-end voice input check.
 *
 * Run with a fake microphone feeding a speech WAV:
 *   EZNESS_FAKE_MIC=C:/path/zh.wav npm start -- --remote-debugging-port=9222
 * then:
 *   ELECTRON_RUN_AS_NODE=1 ./node_modules/electron/dist/electron.exe scripts/cdp-voice-test.js
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

  const status = await evaluate('window.ezness.voiceStatus()');
  console.log('models ready:', status.ready, JSON.stringify(status.files.map((f) => [f.key, f.ready, f.size])));

  // Settings → 语音配置
  await evaluate(`document.querySelector('.rail__btn[title="设置"]').click(); true;`);
  await sleep(300);
  await evaluate(`
    (() => {
      const item = [...document.querySelectorAll('.snav-item')].find((el) => el.textContent.includes('语音配置'));
      item.click();
      return true;
    })()
  `);
  await sleep(400);

  const before = await evaluate(`
    (() => ({
      options: [...document.querySelectorAll('.section select.select option')].map((o) => o.textContent),
      files: [...document.querySelectorAll('.voice-file')].map((el) => el.textContent),
    }))()
  `);
  console.log('devices before permission:', JSON.stringify(before.options));
  console.log('model rows:', JSON.stringify(before.files));

  // Grant the fake mic, then the labels show up.
  await evaluate(`
    (() => {
      const btn = [...document.querySelectorAll('.section__head button')].find((el) => el.textContent.includes('授权麦克风'));
      btn.click();
      return true;
    })()
  `);
  await sleep(1500);
  const options = await evaluate(`
    [...document.querySelectorAll('.section select.select option')].map((o) => o.textContent)
  `);
  console.log('devices after permission:', JSON.stringify(options));

  // Back to chat, start voice input.
  await evaluate(`document.querySelector('.rail__btn[title="对话"]').click(); true;`);
  await sleep(300);
  await evaluate(`
    (() => {
      window.__voiceEvents = [];
      window.ezness.onVoiceEvent((event) => window.__voiceEvents.push(event));
      return true;
    })()
  `);
  await evaluate(`document.querySelector('.mic').click(); true;`);

  const timeline = [];
  let transcript = '';
  for (let attempt = 0; attempt < 30; attempt += 1) {
    await sleep(1000);
    const snapshot = await evaluate(`
      (() => ({
        value: document.querySelector('.composer__input').value,
        listening: document.querySelector('.mic').classList.contains('is-listening'),
        busy: document.querySelector('.mic').classList.contains('is-busy'),
        error: document.querySelector('.composer__voice-error')?.textContent ?? '',
        events: (window.__voiceEvents || []).map((e) => e.type + (e.text ? ':' + e.text : '') + (e.error ? ':' + e.error : '')),
      }))()
    `);
    transcript = snapshot.value;
    timeline.push({
      t: attempt + 1,
      listening: snapshot.listening,
      busy: snapshot.busy,
      valueLength: snapshot.value.length,
      error: snapshot.error,
    });
    if (snapshot.value.trim().length > 0) {
      console.log('events:', JSON.stringify(snapshot.events));
      break;
    }
  }
  console.log('timeline:', JSON.stringify(timeline));
  console.log('transcript:', JSON.stringify(transcript));

  const finalEvents = await evaluate(
    `(window.__voiceEvents || []).map((e) => e.type + (e.text ? ':' + e.text : '') + (e.error ? ':' + e.error : ''))`,
  );
  console.log('final events:', JSON.stringify(finalEvents));

  // Stop listening and confirm the button returns to idle.
  const stillListening = await evaluate(`document.querySelector('.mic').classList.contains('is-listening')`);
  if (stillListening) {
    await evaluate(`document.querySelector('.mic').click(); true;`);
    for (let attempt = 0; attempt < 15; attempt += 1) {
      await sleep(500);
      const state = await evaluate(`
        (() => ({
          listening: document.querySelector('.mic').classList.contains('is-listening'),
          busy: document.querySelector('.mic').classList.contains('is-busy'),
        }))()
      `);
      if (!state.listening && !state.busy) break;
    }
  }
  const after = await evaluate(`
    (() => ({
      listening: document.querySelector('.mic').classList.contains('is-listening'),
      busy: document.querySelector('.mic').classList.contains('is-busy'),
      value: document.querySelector('.composer__input').value,
    }))()
  `);
  console.log('after stop:', JSON.stringify(after));

  if (!transcript.trim()) throw new Error('没有转写出文字');
  if (after.listening || after.busy) throw new Error('停止后麦克风按钮没有回到空闲状态');
  cdp.close();
}

main().catch((error) => {
  console.error('FAILED:', error.message);
  process.exit(1);
});
