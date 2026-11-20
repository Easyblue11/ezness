const electron = require('electron');
const path = require('node:path');
const crypto = require('node:crypto');

// If Electron was launched with ELECTRON_RUN_AS_NODE=1 it runs as plain Node and
// require('electron') hands back a path string instead of the API.
if (typeof electron === 'string' || !electron.app) {
  console.error(
    '[Ezness] Electron APIs are unavailable — the app is running as plain Node.\n' +
      'Unset ELECTRON_RUN_AS_NODE (it is set at user level on this machine) and relaunch.',
  );
  process.exit(1);
}

const { app, BrowserWindow, ipcMain, shell, dialog, clipboard, session } = electron;

// userData only holds the pointer to the real data root, but losing it looks
// exactly like a first run. Pin the folder name so renaming the product
// (productName / installer) can never orphan an existing install's data.
// `--user-data-dir` still wins: tests and the packaging smoke run need it.
if (!process.argv.some((arg) => arg.startsWith('--user-data-dir'))) {
  app.setPath('userData', path.join(app.getPath('appData'), 'ezness'));
}

// Taskbar grouping and notification identity. Must match `appId` in
// electron-builder.yml, otherwise Windows treats the app as two programs.
if (process.platform === 'win32') app.setAppUserModelId('com.easyblue.ezness');

// Installed copies are single-instance: two of them would fight over the same
// data root, ports and director queue. Dev/test launches (npm start, CDP
// scripts) stay multi-instance on purpose.
if (app.isPackaged && !app.requestSingleInstanceLock()) {
  app.quit();
  process.exit(0);
}

const { createFileOpener } = require('./file-opener');
const fileOpener = createFileOpener(shell);
const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const { KbEngine } = require('./kb/engine');
const { extract } = require('./kb/extract');
const { Warehouse } = require('./warehouse');
const { VoiceEngine } = require('./voice/engine');
const { status: voiceModelStatus, downloadMissing } = require('./voice/models');
const { OcrService } = require('./ocr/service');
const ocrModels = require('./ocr/models');
const {
  AppStorage,
  migrateDataRoot,
  directorySize,
  fileSize,
  samePath,
  findPortableRoot,
} = require('./storage');
const locales = require('./locales');
const { resolveInside } = require('./agent/paths');
const { UsageStore, CNY_PER_USD } = require('./usage');
const { RemoteManager } = require('./remote/manager');
const { ProxyManager } = require('./proxy/manager');
const { appFetch, bindSession } = require('./app-net');
const remoteIpc = require('./remote/workspace-ipc');
const pricing = require('./pricing');

const kb = new KbEngine();
let storage = null;
let warehouse = null;
let voice = null;
/** SSH connections behind remote workspaces; rebuilt when the data root moves. */
let remoteManager = null;
function remotes() {
  if (!remoteManager || remoteManager.storageRoot !== storage?.root) {
    remoteManager?.closeAll();
    remoteManager = new RemoteManager(storage?.root ?? '');
  }
  return remoteManager;
}
/** Token spend ledger; created once the data root is final. */
let usageStore = null;
/** App-wide outbound proxy; created once Electron's default session exists. */
let proxyManager = null;
const ocr = new OcrService();

// Test hook: feed a WAV file in as the microphone so the whole capture → VAD →
// ASR path can run without a real mic. Unset in normal launches.
if (process.env.EZNESS_FAKE_MIC) {
  app.commandLine.appendSwitch('use-fake-device-for-media-stream');
  app.commandLine.appendSwitch('use-fake-ui-for-media-stream');
  app.commandLine.appendSwitch('use-file-for-fake-audio-capture', process.env.EZNESS_FAKE_MIC);
}

const DEV_URL = process.env.EZNESS_DEV_URL || '';
let mainWindow = null;

// A second launch of the installed app surfaces the window it already has.
app.on('second-instance', () => {
  if (!mainWindow || mainWindow.isDestroyed()) return;
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1280,
    height: 820,
    minWidth: 960,
    minHeight: 620,
    show: false,
    frame: false,
    backgroundColor: '#0e1013',
    icon: path.join(__dirname, 'assets', 'icon.ico'),
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
      // The renderer picks English as its first-launch default for installed
      // builds, while `electron .` during development stays Chinese.
      additionalArguments: app.isPackaged ? ['--ezness-packaged'] : [],
    },
  });

  // The only permission this app needs is the microphone.
  const session = mainWindow.webContents.session;
  session.setPermissionRequestHandler((_webContents, permission, callback) => {
    callback(permission === 'media' || permission === 'audioCapture');
  });
  session.setPermissionCheckHandler((_webContents, permission) => {
    return permission === 'media' || permission === 'audioCapture';
  });

  if (DEV_URL) {
    mainWindow.loadURL(DEV_URL);
    mainWindow.webContents.openDevTools({ mode: 'detach' });
  } else {
    mainWindow.loadFile(path.join(__dirname, '..', 'dist', 'index.html'));
  }

  mainWindow.once('ready-to-show', () => mainWindow.show());

  const pushState = () => {
    if (mainWindow && !mainWindow.isDestroyed()) {
      mainWindow.webContents.send('window:state', mainWindow.isMaximized());
    }
  };
  mainWindow.on('maximize', pushState);
  mainWindow.on('unmaximize', pushState);
  mainWindow.on('enter-full-screen', pushState);
  mainWindow.on('leave-full-screen', pushState);

  // Never let the renderer spawn windows; hand external links to the OS browser.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith('https:') || url.startsWith('http:')) shell.openExternal(url);
    return { action: 'deny' };
  });
}

function broadcast(channel, payload) {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload);
  }
}

app.whenReady().then(async () => {
  storage = new AppStorage(app.getPath('userData'));

  // Portable copy: `EznessData` beside the program (or EZNESS_DATA_ROOT) makes
  // the data root travel with the app instead of living in this machine's
  // userData. Explicit opt-in, so normal installs are untouched.
  const portableRoot = findPortableRoot(
    app.isPackaged ? path.dirname(app.getPath('exe')) : app.getAppPath(),
  );
  if (portableRoot) {
    await fs.mkdir(portableRoot, { recursive: true }).catch(() => undefined);
    storage.usePortable(portableRoot);
  } else {
    await storage.load();
  }
  customTools.setRuntimeRoot(storage.root);

  kb.setEmitter((event) => broadcast('kb:event', event));

  await restoreKb();
  await restoreWarehouse();

  // Voice models live under the data root too. Before the first migration they
  // are still in userData, which is where the engine has to look.
  voice = new VoiceEngine({
    root: storage.initialMigration ? storage.userData : storage.root,
    emit: (event) => broadcast('voice:event', event),
  });

  // First run after the unified storage root ships, or an engine still pointed
  // at a legacy folder: fold everything into <root>/ezrag and <root>/ezstorge.
  const kbNeedsMove = !samePath(kb.config.storageRoot || '', storage.paths.rag);
  const whNeedsMove = !samePath(warehouse.root || '', storage.paths.warehouse);
  if (!storage.initialized || kbNeedsMove || whNeedsMove) {
    try {
      await migrateDataRoot(
        { storage, kb, warehouse, voice, persistKb },
        storage.root,
        { sourceRoot: storage.initialized ? storage.root : storage.userData },
      );
      await storage.save();
    } catch (error) {
      console.error('[Ezness] 数据目录初始化失败：', error);
      // Keep the old layout working; the system settings page can retry later.
      storage.reset(storage.userData);
      voice.root = storage.userData;
    }
  }

  await reloadCustomTools();
  await reloadAgents();
  directorState = await directorStore.load(directorDir());
  // Supervision runs in the main process so it survives a renderer reload and
  // keeps reporting even if the model call fails.
  directorService = new DirectorService({
    dir: directorDir(),
    sessionDir: agentSessionDir(),
    getState: () => directorState,
    // 总监可以单独选模型；空字符串 = 跟随设置里的默认对话模型。
    getProvider: (pick = '') => memoryProvider(pick),
    resolveRun: (taskId, callId, decision) => resolveRunBySession(taskId, callId, decision),
    broadcast,
    // 总监判断派工是否合理要看真实消耗：按会话汇总用量账本。
    usageFor: (taskId, since) => {
      const records = usageStore?.records ?? [];
      let cost = 0;
      let inputTokens = 0;
      let outputTokens = 0;
      let requests = 0;
      let unpriced = 0;
      for (const record of records) {
        if (record.sessionId !== taskId) continue;
        if (since > 0 && record.at < since) continue;
        requests += 1;
        inputTokens += record.inputTokens || 0;
        outputTokens += record.outputTokens || 0;
        if (record.priced && typeof record.cost === 'number') cost += record.cost;
        else unpriced += 1;
      }
      return requests > 0 ? { cost, inputTokens, outputTokens, requests, unpriced } : null;
    },
    onUsage: (report) =>
      usageStore?.record({
        feature: 'director',
        provider: report.provider,
        usage: report.usage,
        sessionId: 'director',
        workspaceName: '工作总监',
      }),
    // 重复工作的建议不能推荐已经有的东西。
    listPresets: () => ({
      tools: customToolDefs.map((definition) => definition.name || definition.id),
      agents: agentDefinitions.map((agent) => agent.name).filter(Boolean),
    }),
  });
  await directorService.start();
  // 旧存档补记忆索引；不挡启动，也不改存档本身。
  void backfillArchiveMemory().catch(() => undefined);
  await applyPendingLedgerPurge().catch(() => undefined);
  // Fire and forget: embedding the existing memories must not delay the window.
  warmMemoryVectors().catch(() => undefined);

  // Usage ledger reads its own file after any first-run migration has settled
  // the data root. It follows later root changes through the root provider.
  usageStore = new UsageStore(
    () => storage.root,
    (payload) => broadcast('usage:event', payload),
  );
  await usageStore.load();
  startMemoryScheduler();

  // All outbound app traffic goes through the Chromium network stack so the
  // proxy below covers model calls, web search and model downloads alike.
  bindSession(session.defaultSession);
  proxyManager = new ProxyManager({
    session: session.defaultSession,
    root: () => storage.root,
  });
  proxyManager.init({ settingsFile: settingsFile() });

  createWindow();
  // Applying an SSH proxy can take a few seconds; the window must not wait.
  proxyManager.loadSaved().catch(() => undefined);
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});

// Close SSH bridges before the process exits so no python child is orphaned.
app.on('before-quit', () => {
  try {
    remoteManager?.closeAll();
  } catch {
    /* exiting anyway */
  }
  proxyManager?.stop().catch(() => undefined);
  // Writes are debounced; flush the director's queue and inbox on the way out.
  void directorService?.flush().catch(() => undefined);
});

ipcMain.handle('window:minimize', () => mainWindow?.minimize());
ipcMain.handle('window:toggle-maximize', () => {
  if (!mainWindow) return false;
  if (mainWindow.isMaximized()) mainWindow.unmaximize();
  else mainWindow.maximize();
  return mainWindow.isMaximized();
});
ipcMain.handle('window:close', () => mainWindow?.close());
ipcMain.handle('window:is-maximized', () => mainWindow?.isMaximized() ?? false);
// The visualization dialog's fullscreen button: a dialog-sized window cannot
// show a real fullscreen board, so the window goes fullscreen with it.
ipcMain.handle('window:set-fullscreen', (event, value) => {
  const win = BrowserWindow.fromWebContents(event.sender) ?? mainWindow;
  if (!win || win.isDestroyed()) return false;
  win.setFullScreen(Boolean(value));
  return win.isFullScreen();
});

/* ------------------------------------------------------------------
   Settings persistence
   Plain JSON next to the app's userData. Keys are stored as entered;
   this is a local-only shell, not a credential vault.
   ------------------------------------------------------------------ */

function settingsFile() {
  return storage.paths.settings;
}

/**
 * Work settings for the main process. Files written before these settings
 * existed have no `work` block, so fall back to the shipped defaults:
 * 24 steps, keep temp files, ask level 3. -1 steps means unlimited.
 */
async function readWorkSettings() {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    const saved = JSON.parse(raw);
    const steps = Math.trunc(Number(saved?.work?.maxSteps));
    const limit = Math.trunc(Number(saved?.work?.contextLimit));
    return {
      maxSteps:
        Number.isFinite(steps) && steps !== 0
          ? steps === -1
            ? -1
            : Math.max(1, steps)
          : 24,
      autoDeleteTemp: saved?.work?.autoDeleteTemp === true,
      autoInstallDeps: saved?.work?.autoInstallDeps !== false,
      askLevel: normalizeAskLevel(saved?.work?.askLevel),
      // Same rule as src/data/work.ts: unusable values fall back to 128K.
      contextLimit: Number.isFinite(limit) && limit >= 1000 ? limit : 128000,
    };
  } catch {
    return {
      maxSteps: 24,
      autoDeleteTemp: false,
      autoInstallDeps: true,
      askLevel: DEFAULT_ASK_LEVEL,
      contextLimit: 128000,
    };
  }
}

/**
 * Remove the agent's scratch folder (`.ezness` in the workspace root).
 * Only that folder is touched — project files the agent wrote are never
 * candidates, even when this runs.
 */
async function cleanAgentTemp(root) {
  if (!root || !path.isAbsolute(root)) return false;
  const workspace = path.resolve(root);
  if (path.parse(workspace).root === workspace) return false;
  const target = path.resolve(workspace, '.ezness');
  if (path.dirname(target) !== workspace) return false;

  try {
    await fs.rm(target, { recursive: true, force: true });
    return true;
  } catch {
    return false;
  }
}

ipcMain.handle('settings:load', async () => {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    return JSON.parse(raw);
  } catch {
    return null;
  }
});

ipcMain.handle('settings:save', async (_event, data) => {
  const file = settingsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, file);
  return true;
});

/* ------------------------------------------------------------------
   Proxy
   The renderer saves the block with everything else, but applying it is an
   explicit action: a half-typed host must not tear the network down.
   ------------------------------------------------------------------ */

ipcMain.handle('proxy:apply', async (_event, settings) => {
  if (!proxyManager) {
    return {
      ok: false,
      applied: false,
      enabled: true,
      mode: 'direct',
      detail: '代理还没有准备好。',
      error: '应用还在启动，请稍后再试。',
    };
  }
  return proxyManager.apply(settings);
});

ipcMain.handle('proxy:status', () =>
  proxyManager?.status() ?? {
    ok: true,
    applied: false,
    enabled: true,
    mode: 'direct',
    detail: '直接连接',
  },
);

// A URL is only accepted so tests can point the probe at a local server; the
// settings page always calls it with no argument.
ipcMain.handle('proxy:test', async (_event, url) =>
  proxyManager?.test(url) ?? {
    ok: false,
    latencyMs: 0,
    detail: '连接失败',
    error: '应用还在启动，请稍后再试。',
  },
);

/* ------------------------------------------------------------------
   Model discovery
   Runs in the main process: no CORS, no CSP, no key leaking into a
   web origin.
   ------------------------------------------------------------------ */

function trimBase(baseUrl) {
  return String(baseUrl || '').trim().replace(/\/+$/, '');
}

function modelsEndpoint(baseUrl, apiType) {
  const base = trimBase(baseUrl);
  if (!base) throw new Error('API 地址为空');

  if (apiType === 'ollama') {
    const root = base.replace(/\/v1$/i, '');
    return `${root}/api/tags`;
  }
  return /\/models$/i.test(base) ? base : `${base}/models`;
}

function authHeaders(apiKey, apiType) {
  const key = String(apiKey || '').trim();
  if (apiType === 'anthropic') {
    return { 'x-api-key': key, 'anthropic-version': '2023-06-01' };
  }
  return key ? { Authorization: `Bearer ${key}` } : {};
}

function isOpenCodeEndpoint(url) {
  try {
    const host = new URL(url).hostname.toLowerCase();
    return host === 'opencode.ai' || host.endsWith('.opencode.ai');
  } catch {
    return false;
  }
}

function extractModels(payload, apiType) {
  if (apiType === 'ollama') {
    return (payload?.models || []).map((item) => item?.name).filter(Boolean);
  }
  if (Array.isArray(payload?.data)) {
    return payload.data.map((item) => item?.id).filter(Boolean);
  }
  if (Array.isArray(payload)) {
    return payload.map((item) => (typeof item === 'string' ? item : item?.id)).filter(Boolean);
  }
  return [];
}

ipcMain.handle('models:fetch', async (_event, payload = {}) => {
  const { baseUrl, apiKey, apiType } = payload;
  try {
    const response = await appFetch(modelsEndpoint(baseUrl, apiType), {
      headers: {
        'content-type': 'application/json',
        ...authHeaders(apiKey, apiType),
        ...(isOpenCodeEndpoint(baseUrl) ? { 'user-agent': 'Ezness/1.0' } : {}),
      },
      signal: AbortSignal.timeout(20000),
    });

    if (!response.ok) {
      const body = await response.text().catch(() => '');
      return { ok: false, error: `HTTP ${response.status}${body ? ` · ${body.slice(0, 120)}` : ''}` };
    }

    const data = await response.json();
    // Catalogues that carry per-token prices (OpenCode Zen/Go, OpenRouter and
    // similar) also refresh the ledger's price snapshot for future requests.
    try {
      pricing.rememberCatalog(baseUrl, data);
    } catch {
      /* pricing metadata is optional */
    }
    return { ok: true, models: extractModels(data, apiType) };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

/* ------------------------------------------------------------------
   Chat streaming
   ------------------------------------------------------------------ */

const { streamChat } = require('./chat');
const { webSearch } = require('./websearch');

const chatAborts = new Map();

ipcMain.handle('chat:send', async (event, request) => {
  const sender = event.sender;
  const { requestId, provider, messages } = request ?? {};
  if (!requestId || !provider) return false;

  const controller = new AbortController();
  chatAborts.set(requestId, controller);

  const send = (payload) => {
    if (!sender.isDestroyed()) sender.send('chat:event', { requestId, ...payload });
  };

  try {
    const result = await streamChat(provider, messages ?? [], {
      signal: controller.signal,
      onDelta: (text) => send({ type: 'delta', text }),
      onThinking: (text) => send({ type: 'thinking', text }),
    });
    usageStore?.record({
      feature: request?.feature || 'chat',
      provider,
      usage: result?.usage,
      sessionId: provider.sessionId,
    });
    send({ type: 'done' });
  } catch (error) {
    if (error?.usage) {
      usageStore?.record({
        feature: request?.feature || 'chat',
        provider,
        usage: error.usage,
        sessionId: provider.sessionId,
      });
    }
    if (controller.signal.aborted) send({ type: 'aborted' });
    else send({ type: 'error', error: error?.message || String(error) });
  } finally {
    chatAborts.delete(requestId);
  }

  return true;
});

ipcMain.handle('chat:abort', (_event, requestId) => {
  chatAborts.get(requestId)?.abort();
  return true;
});

/* ------------------------------------------------------------------
   自动联网 judge
   ------------------------------------------------------------------ */

const { judgeWebSearch } = require('./webjudge');

ipcMain.handle('web:judge', async (_event, request) => {
  const { requestId, provider, text, recent } = request ?? {};
  const value = String(text ?? '').trim();
  if (!provider || !value) return { search: false, query: '', source: 'rule' };

  // The same request id space as chat:abort, so 停止 also stops the judge.
  const controller = new AbortController();
  if (requestId) chatAborts.set(requestId, controller);

  try {
    const decision = await judgeWebSearch({
      provider,
      text: value,
      recent,
      signal: controller.signal,
    });
    if (decision.usage) {
      usageStore?.record({
        feature: 'other',
        provider,
        usage: decision.usage,
        sessionId: provider.sessionId,
      });
    }
    return {
      search: decision.search,
      query: decision.query,
      source: decision.source,
      fallback: decision.fallback,
    };
  } catch (error) {
    if (controller.signal.aborted) return { search: false, query: '', aborted: true };
    // Timeout or endpoint failure: search rather than drop the user's 联网.
    return {
      search: true,
      query: value,
      fallback: true,
      error: error?.message || String(error),
    };
  } finally {
    if (requestId) chatAborts.delete(requestId);
  }
});

/* ------------------------------------------------------------------
   Usage ledger
   ------------------------------------------------------------------ */

const EMPTY_USAGE_SUMMARY = {
  inputTokens: 0,
  outputTokens: 0,
  cachedInputTokens: 0,
  cost: 0,
  requests: 0,
  unpricedRequests: 0,
};

ipcMain.handle('usage:load', () =>
  usageStore?.snapshot() ?? { records: [], today: { ...EMPTY_USAGE_SUMMARY }, fxRate: CNY_PER_USD },
);

ipcMain.handle('usage:clear', () =>
  usageStore?.clear() ?? { records: [], today: { ...EMPTY_USAGE_SUMMARY }, fxRate: CNY_PER_USD },
);

/**
 * CSV export goes through a real save dialog. A renderer-side blob download
 * silently does nothing in this build, so write the file from main instead.
 * The BOM keeps Excel from mangling the Chinese headers.
 */
ipcMain.handle('usage:export', async (_event, payload) => {
  const csv = String(payload?.csv ?? '');
  const base = String(payload?.filename || 'ezness-usage')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\.csv$/i, '');
  try {
    // Test hook, like EZNESS_FAKE_MIC: skip the native dialog when set.
    const testDir = String(process.env.EZNESS_TEST_EXPORT_DIR || '').trim();
    const result = testDir
      ? { canceled: false, filePath: path.join(testDir, `${base}.csv`) }
      : await saveDialog({
          title: '导出计费统计',
          defaultPath: path.join(app.getPath('documents'), `${base}.csv`),
          filters: [{ name: 'CSV', extensions: ['csv'] }],
        });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    await fs.mkdir(path.dirname(result.filePath), { recursive: true });
    await fs.writeFile(result.filePath, `﻿${csv}`, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

/* ------------------------------------------------------------------
   Workspace agent
   A workspace task runs the tool loop instead of one plain completion.
   Permission and question prompts block inside the loop and are answered
   through `agent:resolve` from the renderer.
   ------------------------------------------------------------------ */

const { AgentRun, compact, isDigest, sizeOf } = require('./agent/loop');
const { normalizeAskLevel, DEFAULT_ASK_LEVEL } = require('./agent/policy');
const { AgentSession } = require('./agent/session');
const { describeCapabilities, builtinCategorySummary, CATEGORY_ORDER } = require('./agent/capabilities');
const {
  setCustomTools,
  setDataBridge,
  setMemoryBridge,
  builtinNames: builtinToolNames,
  setToolEditorBridge,
  setAgentEditorBridge,
} = require('./agent/tools');
const customTools = require('./agent/custom-tools');
const agentsStore = require('./agent/agents');
const agentReview = require('./agent/agent-review');
const directorStore = require('./agent/director');
const { DirectorService } = require('./agent/director-service');
const {
  clusterMessages,
  titleForCluster,
  summaryForCluster,
  sessionForCluster,
  transactionsInRange,
  orphanLedgerEntries,
  ledgerKey,
} = require('./agent/history-cluster');
const workspaceVisualize = require('./workspace-visualize');
const vizFiles = require('./viz-files');
const knowledgeScope = require('./agent/knowledge-scope');
const memoryStore = require('./agent/memory');
const packageIo = require('./agent/package-io');
const memoryVectors = require('./agent/memory-vectors');
const { embedTexts, embedQuery } = require('./kb/embed');
const learning = require('./agent/learning');
const memoryRecheck = require('./agent/memory-recheck');
const toolEditor = require('./agent/tool-editor');
const pythonEnv = require('./python-env');
const agentRuns = new Map();
/**
 * Workspaces whose `.ezness` scratch folder is waiting for cleanup. Deleting
 * while another task is still running could break it, so roots are collected
 * and removed together once the last run ends.
 */
const pendingTempRoots = new Set();
/**
 * Renderer-facing state of every run, mirrored from its event stream.
 *
 * Ctrl+R reloads the page but leaves the run working in this process. The new
 * page asks for these snapshots and reattaches, so the task keeps writing into
 * the same message instead of looking terminated. Finished runs linger for a
 * couple of minutes in case the reload raced the closing events.
 */
const agentSnapshots = new Map();
const SNAPSHOT_KEEP_MS = 120000;

function applyRunEvent(snapshot, payload) {
  switch (payload.type) {
    case 'delta':
      snapshot.content += payload.text ?? '';
      return;
    case 'thinking':
      snapshot.thinking += payload.text ?? '';
      return;
    case 'tool': {
      const call = payload.call;
      if (!call) return;
      const index = snapshot.steps.findIndex((step) => step.id === call.id);
      const previous = index === -1 ? null : snapshot.steps[index];
      const step = {
        id: call.id,
        name: call.name,
        args: call.args ?? {},
        summary: payload.summary ?? previous?.summary,
        status: payload.status ?? 'running',
        result: payload.result ?? previous?.result,
        startedAt: payload.startedAt ?? previous?.startedAt,
        endedAt: payload.endedAt ?? previous?.endedAt,
      };
      if (index === -1) snapshot.steps.push(step);
      else snapshot.steps[index] = step;
      // The prompt or question is settled once its tool reports back.
      snapshot.permissions = snapshot.permissions.filter((item) => item.callId !== call.id);
      snapshot.questions = snapshot.questions.filter((item) => item.callId !== call.id);
      return;
    }
    case 'permission': {
      const call = payload.call;
      if (!call) return;
      if (snapshot.permissions.some((item) => item.callId === call.id)) return;
      snapshot.permissions.push({
        requestId: snapshot.requestId,
        callId: call.id,
        name: call.name,
        args: call.args ?? {},
        summary: payload.summary ?? '',
        reason: payload.reason ?? '',
        danger: Boolean(payload.danger),
        reviewReason: payload.reviewReason ?? '',
        // A reloaded page must still render the credential fields, or the
        // pending call could be approved without one.
        secrets: Array.isArray(payload.secrets) ? payload.secrets : undefined,
      });
      return;
    }
    case 'question': {
      const call = payload.call;
      if (!call) return;
      if (snapshot.questions.some((item) => item.callId === call.id)) return;
      snapshot.questions.push({
        requestId: snapshot.requestId,
        callId: call.id,
        question: payload.question ?? '请选择',
        options: Array.isArray(payload.options) ? payload.options : [],
      });
      return;
    }
    case 'todo':
      if (Array.isArray(payload.todos)) snapshot.todos = payload.todos;
      return;
    case 'compact': {
      const at = Date.now();
      snapshot.steps.push({
        id: `compact-${at}`,
        name: 'compact',
        args: {},
        summary: `把较早的对话压缩为摘要（${Math.round((payload.before ?? 0) / 1000)}K → ${Math.round(
          (payload.after ?? 0) / 1000,
        )}K 词元）`,
        status: 'done',
        startedAt: at,
        endedAt: at,
      });
      return;
    }
    case 'done':
      snapshot.status = 'done';
      snapshot.finishedAt = Date.now();
      return;
    case 'aborted':
      snapshot.status = 'aborted';
      snapshot.finishedAt = Date.now();
      return;
    case 'error':
      snapshot.status = 'error';
      snapshot.error = payload.error ?? '未知错误';
      snapshot.finishedAt = Date.now();
      return;
    default:
  }
}

/**
 * Answer a pending permission/question from outside the renderer: the
 * director resolves by task (session) id, not by request id.
 */
function resolveRunBySession(sessionId, callId, decision) {
  if (!sessionId || !callId) return false;
  for (const [requestId, run] of agentRuns) {
    const snapshot = agentSnapshots.get(requestId);
    if (!snapshot || snapshot.sessionId !== sessionId) continue;
    snapshot.permissions = snapshot.permissions.filter((item) => item.callId !== callId);
    snapshot.questions = snapshot.questions.filter((item) => item.callId !== callId);
    // The renderer keeps its own card list; tell it to drop this one.
    broadcast('agent:event', { requestId, type: 'permission-resolved', callId });
    return run.resolve(callId, decision);
  }
  return false;
}

/** Keep a finished snapshot around long enough for a reloaded page to read it. */
function expireSnapshot(requestId) {
  const timer = setTimeout(() => agentSnapshots.delete(requestId), SNAPSHOT_KEEP_MS);
  timer.unref?.();
}

/** `<data root>/agent` holds the session logs and the custom tool definitions. */
function agentDir() {
  return path.join(storage.root, 'agent');
}

function agentSessionDir() {
  return path.join(agentDir(), 'sessions');
}

/** Agent definitions, re-read after the data root settles. */
let agentDefinitions = [];

/**
 * The categories and documents this Agent may read. The selection is validated
 * against the live knowledge base on every run, so deleted categories or
 * documents simply drop out instead of leaking or breaking the task.
 */
function agentKnowledgeAccess(agent) {
  if (!agent?.knowledge || !kb.store) return null;
  return knowledgeScope.agentDataAccess(
    agent.knowledge,
    kb.store.listCategories(),
    kb.store.listDocuments(),
  );
}

async function reloadAgents() {
  agentDefinitions = await agentsStore.loadAgents(agentDir(), {
    builtinCategories: CATEGORY_ORDER,
  });
  return agentDefinitions;
}

/**
 * 工作总监: mandate, space visibility and per-task drivers. Kept beside the
 * agent data so it survives restarts; the renderer owns the UI, this owns the
 * rules that decide who may steer a task.
 */
let directorState = directorStore.defaults();
/** Started once the data root is settled; null until then. */
let directorService = null;

function directorDir() {
  return path.join(agentDir(), 'director');
}

/** Definitions are cached in memory and recompiled after every save. */
let customToolDefs = [];
/** User-created category rail, stored beside the definitions. */
let toolCategories = [];
/** Last syntax/test result per tool id; broken tools never reach the registry. */
let toolHealth = {};

function enabledDefinitions() {
  return customTools.enabledForRegistry(customToolDefs, toolHealth);
}

/** Only working tools are visible to the model; broken ones stay in the UI. */
function compileToolRegistry() {
  setCustomTools(customTools.compileDefinitions(enabledDefinitions(), agentDir()));
}

function pruneHealth() {
  const ids = new Set(customToolDefs.map((definition) => definition.id));
  for (const id of Object.keys(toolHealth)) {
    if (!ids.has(id)) delete toolHealth[id];
  }
}

async function persistHealth() {
  await customTools.saveHealth(agentDir(), toolHealth);
}

async function reloadCustomTools() {
  customToolDefs = await customTools.loadDefinitions(agentDir(), builtinToolNames());
  toolCategories = await customTools.loadCategories(agentDir(), customToolDefs);
  toolHealth = await customTools.loadHealth(agentDir());
  pruneHealth();
  compileToolRegistry();
  return customToolDefs;
}

/* ------------------------------------------------------------------ */
/* 功能编辑 workspaces                                                 */
/* ------------------------------------------------------------------ */

function categoryById(id) {
  return toolCategories.find((category) => category.id === String(id ?? '')) ?? null;
}

function definitionsInCategory(categoryName) {
  return customToolDefs.filter((definition) => definition.category === categoryName);
}

function editorScratchDir(category) {
  const safe = String(category?.id ?? 'category').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(agentDir(), 'tool-editor', safe);
}

function healthLine(definition) {
  const health = toolHealth[definition.id];
  if (!health) return '未测试';
  if (health.status === 'broken') {
    return `故障：${health.errors?.[0]?.message ?? '测试未通过'}`;
  }
  if (health.status === 'untested') return '未测试';
  return `正常${health.testedAt ? `（测试于 ${new Date(health.testedAt).toLocaleString()}）` : ''}`;
}

async function editorList(scope) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  const definitions = definitionsInCategory(category.name);
  if (definitions.length === 0) return `分类「${category.name}」还没有功能。`;

  const lines = [`分类「${category.name}」共有 ${definitions.length} 个功能：`];
  for (const definition of definitions) {
    const params = (definition.parameters ?? [])
      .map((parameter) => `${parameter.name}:${parameter.type}${parameter.required ? '*' : ''}`)
      .join(', ');
    lines.push(
      `- ${definition.name} [${healthLine(definition)}] ${definition.readOnly ? '只读' : '变更'} · ${
        definition.runtime
      }${params ? ` · 参数 ${params}` : ''}${
        definition.dependencies?.length ? ` · 依赖 ${definition.dependencies.join(', ')}` : ''
      }`,
    );
    lines.push(`  说明：${String(definition.description ?? '').slice(0, 300)}`);
    const health = toolHealth[definition.id];
    if (health?.status === 'broken') {
      for (const error of health.errors?.slice(0, 3) ?? []) {
        lines.push(`  错误：${String(error.message ?? '').slice(0, 500)}`);
      }
    }
  }
  return lines.join('\n');
}

async function editorGet(scope, { name }) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  const definition = definitionsInCategory(category.name).find((item) => item.name === name);
  if (!definition) return `分类「${category.name}」里没有功能 ${name}。`;
  return `${JSON.stringify(definition, null, 2)}\n\n健康状态：${healthLine(definition)}`;
}

function formatEvaluationFailure(result) {
  return result.errors.map((error) => error.message).join('\n');
}

/** A failed editor call still feeds the model text, but the step shows 失败. */
function editorFailure(message) {
  return { ok: false, content: message };
}

/**
 * Syntax + smoke test with the current 工作设置. Dependency auto-install is
 * read per call so toggling it in settings applies to the next test.
 */
async function evaluateCustomTool(definition, { testArgs, scratchDir }) {
  const { autoInstallDeps } = await readWorkSettings();
  return toolEditor.evaluateDefinition(definition, {
    agentDir: agentDir(),
    root: storage.root,
    testArgs,
    scratchDir,
    autoInstallDeps,
  });
}

function installedLine(evaluation) {
  return evaluation.installed?.length
    ? `已自动安装依赖：${evaluation.installed.join('、')}。`
    : '';
}

async function editorCreate(scope, payload) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  if (customToolDefs.length >= customTools.MAX_TOOLS) {
    return editorFailure(`最多 ${customTools.MAX_TOOLS} 个自定义功能，不能再新增。`);
  }

  const raw = payload?.definition && typeof payload.definition === 'object' ? payload.definition : {};
  const normalized = customTools.normalizeDefinition(
    { ...raw, id: '', category: category.name },
    { builtinNames: builtinToolNames(), others: customToolDefs },
  );
  if (!normalized.ok) return editorFailure(`创建失败：\n${normalized.errors.join('\n')}`);

  const definition = normalized.definition;
  const evaluation = await evaluateCustomTool(definition, {
    testArgs: payload?.testArgs,
    scratchDir: editorScratchDir(category),
  });

  const next = [...customToolDefs, definition];
  try {
    await customTools.saveDefinitions(agentDir(), next);
  } catch (error) {
    return editorFailure(`保存失败：${error?.message || String(error)}`);
  }

  customToolDefs = next;
  toolHealth[definition.id] = evaluation.health;
  await persistHealth();
  compileToolRegistry();

  if (!evaluation.ok) {
    return {
      ok: false,
      content: [
        `已创建 ${definition.name}，但测试没有通过，功能不会启用（分类会标红）。`,
        installedLine(evaluation),
        formatEvaluationFailure(evaluation),
        '请根据错误修改后重新测试。',
      ]
        .filter(Boolean)
        .join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      `已创建 ${definition.name} 并通过测试，功能现已生效。`,
      installedLine(evaluation),
      evaluation.health.stdout ? `测试输出：${evaluation.health.stdout.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function editorUpdate(scope, { name, changes, testArgs }) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  const target = definitionsInCategory(category.name).find((item) => item.name === name);
  if (!target) return editorFailure(`分类「${category.name}」里没有功能 ${name}。`);

  const patch = changes && typeof changes === 'object' && !Array.isArray(changes) ? changes : {};
  const candidate = {
    ...target,
    ...patch,
    id: target.id,
    category: category.name,
  };
  const normalized = customTools.normalizeDefinition(candidate, {
    builtinNames: builtinToolNames(),
    others: customToolDefs.filter((item) => item.id !== target.id),
  });
  if (!normalized.ok) {
    return editorFailure(`修改失败（旧版本保持不变）：\n${normalized.errors.join('\n')}`);
  }

  const definition = normalized.definition;
  const evaluation = await evaluateCustomTool(definition, {
    testArgs: testArgs ?? toolHealth[target.id]?.testArgs,
    scratchDir: editorScratchDir(category),
  });
  if (!evaluation.ok) {
    return {
      ok: false,
      content: [
        `${definition.name} 的修改没有通过测试，仍保留上一版可用定义。`,
        formatEvaluationFailure(evaluation),
        '请修正后重试。',
      ].join('\n'),
    };
  }

  const next = customToolDefs.map((item) => (item.id === target.id ? definition : item));
  try {
    await customTools.saveDefinitions(agentDir(), next);
  } catch (error) {
    return editorFailure(`保存失败：${error?.message || String(error)}`);
  }

  customToolDefs = next;
  toolHealth[definition.id] = evaluation.health;
  await persistHealth();
  compileToolRegistry();
  return {
    ok: true,
    content: [
      `已更新 ${definition.name} 并通过测试。`,
      installedLine(evaluation),
      evaluation.health.stdout ? `测试输出：${evaluation.health.stdout.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

async function editorDelete(scope, { name }) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  const target = definitionsInCategory(category.name).find((item) => item.name === name);
  if (!target) return editorFailure(`分类「${category.name}」里没有功能 ${name}。`);

  const next = customToolDefs.filter((item) => item.id !== target.id);
  try {
    await customTools.saveDefinitions(agentDir(), next);
  } catch (error) {
    return editorFailure(`删除失败：${error?.message || String(error)}`);
  }

  customToolDefs = next;
  delete toolHealth[target.id];
  await customTools.removeToolFiles(agentDir(), target.id);
  await persistHealth();
  compileToolRegistry();
  return { ok: true, content: `已删除 ${target.name}。` };
}

async function editorTest(scope, { name, args }) {
  const category = categoryById(scope.categoryId);
  if (!category) return editorFailure('这个功能分类已经被删除，无法继续操作。');
  const target = definitionsInCategory(category.name).find((item) => item.name === name);
  if (!target) return editorFailure(`分类「${category.name}」里没有功能 ${name}。`);

  const evaluation = await evaluateCustomTool(target, {
    testArgs: args ?? toolHealth[target.id]?.testArgs,
    scratchDir: editorScratchDir(category),
  });
  toolHealth[target.id] = evaluation.health;
  await persistHealth();
  compileToolRegistry();

  if (!evaluation.ok) {
    return {
      ok: false,
      content: [`${target.name} 测试未通过：`, formatEvaluationFailure(evaluation)].join('\n'),
    };
  }
  return {
    ok: true,
    content: [
      `${target.name} 测试通过，功能已启用。`,
      installedLine(evaluation),
      evaluation.health.stdout ? `输出：${evaluation.health.stdout.slice(0, 1200)}` : '',
    ]
      .filter(Boolean)
      .join('\n'),
  };
}

setToolEditorBridge({
  list: (scope) => editorList(scope),
  get: (scope, payload) => editorGet(scope, payload),
  create: (scope, payload) => editorCreate(scope, payload),
  update: (scope, payload) => editorUpdate(scope, payload),
  delete: (scope, payload) => editorDelete(scope, payload),
  test: (scope, payload) => editorTest(scope, payload),
});

/* ------------------------------------------------------------------ */
/* Agent 编辑 workspaces                                               */
/* ------------------------------------------------------------------ */

/** Fields the AI editor may change. id/createdAt are never taken from input. */
const AGENT_EDITOR_FIELDS = [
  'name',
  'role',
  'personality',
  'inputSpec',
  'outputSpec',
  'prompt',
  'enabled',
  'capabilities',
];

function agentEditorScratchDir(agentId) {
  const safe = String(agentId ?? 'agent').replace(/[^a-zA-Z0-9_-]/g, '_');
  return path.join(agentDir(), 'agent-editor', safe);
}

/** Short stable hash shown in the workspace title: Agent编辑-<hash>. */
function agentEditorHash(agentId) {
  // Mirrors src/components/WorkspacePage.tsx so the sidebar title and the
  // running session name always agree.
  const raw = String(agentId ?? '').replace(/^agt_/, '').replace(/[^a-zA-Z0-9]/g, '');
  return (raw || 'agent').slice(0, 8);
}

/** A failed editor call still feeds the model text, but the step shows 失败. */
function agentEditorFailure(message) {
  return { ok: false, content: message };
}

function currentAgent(scope) {
  const id = String(scope?.agentId ?? '');
  return agentDefinitions.find((agent) => agent.id === id) ?? null;
}

/** Built-in and custom capability catalog, with names the model can use. */
function agentEditorCatalog() {
  return {
    builtin: builtinCategorySummary(),
    custom: toolCategories.map((category) => ({
      id: category.id,
      name: category.name,
      tools: customToolDefs
        .filter((definition) => definition.category === category.name)
        .map((definition) => definition.name),
    })),
  };
}

function capabilityLine(agent, catalog) {
  if (agent.capabilities?.mode === 'all') return '全部能力分类（包括以后新增的）';
  const builtin = agent.capabilities?.builtin ?? [];
  const custom = (agent.capabilities?.custom ?? []).map(
    (id) => catalog.custom.find((category) => category.id === id)?.name ?? id,
  );
  return `指定分类：内置 ${builtin.join('、') || '无'}；自定义 ${custom.join('、') || '无'}`;
}

async function agentEditorGet(scope) {
  const agent = currentAgent(scope);
  if (!agent) return agentEditorFailure('这个 Agent 已经被删除，无法继续编辑。');
  const catalog = agentEditorCatalog();
  return {
    ok: true,
    content: [
      '当前 Agent 定义：',
      JSON.stringify(agent, null, 2),
      '',
      `能力范围：${capabilityLine(agent, catalog)}`,
      '',
      '可绑定的内置能力分类：',
      ...catalog.builtin.map((category) => `- ${category.name}：${category.tools.join('、')}`),
      '',
      '自定义能力分类（selected 模式下把 id 或名称放进 capabilities.custom）：',
      ...(catalog.custom.length
        ? catalog.custom.map(
            (category) =>
              `- ${category.name}（id: ${category.id}）${
                category.tools.length ? `：${category.tools.join('、')}` : ''
              }`,
          )
        : ['- （暂无）']),
    ].join('\n'),
  };
}

/** Resolve category names or ids to stored custom category ids. */
function resolveCustomCategories(values) {
  const ids = [];
  const unknown = [];
  for (const raw of Array.isArray(values) ? values : []) {
    const key = String(raw ?? '').trim();
    if (!key) continue;
    const hit =
      toolCategories.find((category) => category.id === key) ??
      toolCategories.find((category) => category.name.toLowerCase() === key.toLowerCase());
    if (!hit) {
      if (!unknown.includes(key)) unknown.push(key);
      continue;
    }
    if (!ids.includes(hit.id)) ids.push(hit.id);
  }
  return { ids, unknown };
}

async function agentEditorUpdate(scope, payload) {
  const target = currentAgent(scope);
  if (!target) return agentEditorFailure('这个 Agent 已经被删除，无法继续编辑。');

  const raw =
    payload?.changes && typeof payload.changes === 'object' && !Array.isArray(payload.changes)
      ? payload.changes
      : null;
  if (!raw) return agentEditorFailure('changes 必须是对象，里面放要修改的字段。');

  const changes = {};
  for (const key of AGENT_EDITOR_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(raw, key)) changes[key] = raw[key];
  }
  if (Object.keys(changes).length === 0) {
    return agentEditorFailure(
      `changes 里没有可修改的字段。可用字段：${AGENT_EDITOR_FIELDS.join('、')}。`,
    );
  }

  if (Object.prototype.hasOwnProperty.call(changes, 'capabilities')) {
    const incoming = changes.capabilities;
    if (!incoming || typeof incoming !== 'object' || Array.isArray(incoming)) {
      return agentEditorFailure('capabilities 必须是对象：{ mode, builtin, custom }。');
    }
    const mode =
      incoming.mode === 'selected'
        ? 'selected'
        : incoming.mode === 'all'
          ? 'all'
          : target.capabilities.mode;

    if (mode === 'all') {
      changes.capabilities = { mode: 'all', builtin: [], custom: [] };
    } else {
      const requestedBuiltin = (Array.isArray(incoming.builtin) ? incoming.builtin : [])
        .map((name) => String(name ?? '').trim())
        .filter(Boolean);
      const unknownBuiltin = requestedBuiltin.filter((name) => !CATEGORY_ORDER.includes(name));
      if (unknownBuiltin.length > 0) {
        return agentEditorFailure(
          `这些内置分类不存在：${unknownBuiltin.join('、')}。可用的内置分类：${CATEGORY_ORDER.join('、')}。`,
        );
      }
      const { ids, unknown } = resolveCustomCategories(incoming.custom);
      if (unknown.length > 0) {
        return agentEditorFailure(
          `这些自定义分类不存在：${unknown.join('、')}。当前可用：${
            toolCategories.map((category) => category.name).join('、') || '（暂无）'
          }。`,
        );
      }
      changes.capabilities = { mode, builtin: requestedBuiltin, custom: ids };
    }
  }

  const candidate = {
    ...target,
    ...changes,
    id: target.id,
    createdAt: target.createdAt,
    updatedAt: Date.now(),
  };
  const result = agentsStore.normalizeAgent(candidate, {
    others: agentDefinitions.filter((agent) => agent.id !== target.id),
    builtinCategories: CATEGORY_ORDER,
  });
  if (!result.ok) {
    return agentEditorFailure(`修改没有保存：\n${result.errors.join('\n')}`);
  }

  const next = agentDefinitions.map((agent) => (agent.id === target.id ? result.agent : agent));
  try {
    await agentsStore.saveAgents(agentDir(), next);
  } catch (error) {
    return agentEditorFailure(`保存失败：${error?.message || String(error)}`);
  }
  agentDefinitions = next;

  const catalog = agentEditorCatalog();
  return {
    ok: true,
    content: [
      `已保存 Agent「${result.agent.name}」的修改。`,
      `本次更新：${Object.keys(changes).join('、')}。`,
      `当前状态：${result.agent.enabled ? '已启用' : '未启用（草稿）'}；能力范围：${capabilityLine(
        result.agent,
        catalog,
      )}。`,
    ].join('\n'),
  };
}

setAgentEditorBridge({
  get: (scope) => agentEditorGet(scope),
  update: (scope, payload) => agentEditorUpdate(scope, payload),
});

/**
 * The tool whitelist an Agent's capability scope implies. `null` means the
 * Agent uses everything (mode "all"); an empty array is a legitimate result
 * when every chosen category is currently empty.
 */
function agentAllowedTools(agent) {
  if (!agent || agent.capabilities?.mode !== 'selected') return null;
  const builtin = new Set(agent.capabilities.builtin ?? []);
  const customCategories = new Set(
    toolCategories
      .filter((category) => (agent.capabilities.custom ?? []).includes(category.id))
      .map((category) => category.name),
  );
  const names = new Set();
  for (const category of builtinCategorySummary()) {
    if (!builtin.has(category.name)) continue;
    for (const name of category.tools) names.add(name);
  }
  for (const definition of customToolDefs) {
    if (customCategories.has(definition.category)) names.add(definition.name);
  }
  return [...names];
}

/**
 * The definition a folder task runs with when the user enabled an Agent in the
 * composer. It is plain data: the loop feeds the persona into the system
 * prompt and tools.js enforces `tools`.
 */
function agentRunScope(agent) {
  if (!agent) return null;
  return {
    id: agent.id,
    name: agent.name,
    role: agent.role,
    personality: agent.personality,
    inputSpec: agent.inputSpec,
    outputSpec: agent.outputSpec,
    prompt: agent.prompt,
    tools: agentAllowedTools(agent),
    // The prompt tells the model to consult long-term memory when the Agent
    // has it; the switch only controls learning, not retrieval.
    memoryEnabled: agent.memory?.enabled !== false,
  };
}

/**
 * Titles of the Agent's usable memories. The prompt only carries this index,
 * not the content: it is enough for the model to see that a past conclusion
 * exists and call agent_memory_search for the details, which keeps the token
 * cost of memory constant as the store grows.
 */
async function memoryTitleIndex(agentId) {
  try {
    const store = await memoryStore.loadStore(agentDir(), agentId);
    const now = memoryStore.nowMs();
    const titles = [];
    let chars = 0;
    let expired = 0;
    for (const entry of [...store.entries]
      .filter((entry) => entry.status === 'confirmed')
      .sort((a, b) => b.updatedAt - a.updatedAt)) {
      const state = memoryStore.freshnessOf(entry, now).state;
      if (state === 'expired') {
        expired += 1;
        continue;
      }
      const title = String(entry.title ?? '').trim();
      if (!title) continue;
      // The marker is 4-5 characters and saves the model a wasted lookup:
      // it knows up front that this conclusion needs re-verifying.
      const marker =
        state === 'due' ? '（待复核）' : state === 'stale' ? '（未核实）' : '';
      if (titles.length >= 30 || chars + title.length + marker.length > 1200) break;
      titles.push(`${title}${marker}`);
      chars += title.length + marker.length;
    }
    return { titles, expired };
  } catch {
    return { titles: [], expired: 0 };
  }
}

ipcMain.handle('agent:start', async (event, request) => {
  const sender = event.sender;
  let {
    requestId,
    provider,
    workspacePath,
    workspaceName,
    messages,
    message,
    sessionId,
    mode,
    allowedCommands,
    webEnabled,
    webEntries,
    workspaceKind,
    categoryId,
    agentId,
    messageId,
    userMessageId,
    userMessage,
  } = request ?? {};
  const isToolEditor = workspaceKind === 'tool-editor';
  const isAgentEditor = workspaceKind === 'agent-editor';
  const isDirector = workspaceKind === 'director';
  if (!requestId || !provider) return false;
  if (!isToolEditor && !isAgentEditor && !isDirector && !workspacePath) return false;

  let snapshot = null;
  const runTaskId = sessionId || requestId;
  // The editor workspaces are not tasks the director supervises.
  const supervised = !isToolEditor && !isAgentEditor && !isDirector;
  const send = (payload) => {
    // Mirror first: the reloaded page reads this state when it reattaches.
    if (snapshot) applyRunEvent(snapshot, payload);
    // The director watches every task run except its own conversation. The
    // service decides whether this event is in a space it may see.
    if (supervised && directorService && payload?.type) {
      directorService.onRunEvent({ taskId: runTaskId, payload });
    }
    if (sender.isDestroyed()) return;
    try {
      sender.send('agent:event', { requestId, ...payload });
    } catch {
      // The renderer is mid-reload (Ctrl+R). The run must survive that; the
      // fresh page reattaches through agent:active and rejoins the stream.
    }
  };

  let toolScope = null;
  let toolContext = null;
  // Only a folder task can learn; the editor workspaces never write memory.
  let selectedAgent = null;
  if (isToolEditor) {
    const category = categoryById(categoryId);
    if (!category) {
      send({ type: 'error', error: '这个功能分类已经被删除，无法继续编辑。' });
      return true;
    }
    const scratch = editorScratchDir(category);
    try {
      await fs.mkdir(scratch, { recursive: true });
    } catch (error) {
      send({ type: 'error', error: `测试目录不可用：${error?.message || String(error)}` });
      return true;
    }
    workspacePath = scratch;
    workspaceName = `功能编辑-${category.name}`;
    toolScope = { kind: 'tool-editor', categoryId: category.id };
    toolContext = {
      category,
      definitions: definitionsInCategory(category.name),
      health: toolHealth,
    };
  } else if (isAgentEditor) {
    const agent = agentDefinitions.find((item) => item.id === String(agentId ?? '')) ?? null;
    if (!agent) {
      send({ type: 'error', error: '这个 Agent 已经被删除，无法继续编辑。' });
      return true;
    }
    const scratch = agentEditorScratchDir(agent.id);
    try {
      await fs.mkdir(scratch, { recursive: true });
    } catch (error) {
      send({ type: 'error', error: `编辑目录不可用：${error?.message || String(error)}` });
      return true;
    }
    workspacePath = scratch;
    workspaceName = `Agent编辑-${agentEditorHash(agent.id)}`;
    toolScope = { kind: 'agent-editor', agentId: agent.id };
    toolContext = {
      agent,
      builtinCategories: builtinCategorySummary(),
      customCategories: agentEditorCatalog().custom,
    };
  } else if (isDirector) {
    // The director talks from its own scratch folder; the board it reasons
    // about is passed in by the renderer on every turn, not read from disk.
    const scratch = path.join(directorDir(), 'workspace');
    try {
      await fs.mkdir(scratch, { recursive: true });
    } catch (error) {
      send({ type: 'error', error: `总监目录不可用：${error?.message || String(error)}` });
      return true;
    }
    workspacePath = scratch;
    workspaceName = '工作总监';
    // The director talks and judges; it never edits files itself.
    toolScope = { kind: 'director', mode: directorState.mode };
    const directorQuery = typeof message === 'string' ? message : '';
    toolContext = {
      director: {
        enabled: directorState.enabled,
        mode: directorState.mode,
        spaces: Array.isArray(request?.directorSpaces) ? request.directorSpaces.slice(0, 60) : [],
        tasks: Array.isArray(request?.directorTasks) ? request.directorTasks.slice(0, 60) : [],
        presence: directorState.presence,
        // Only the memories relevant to this turn, not the whole store: the
        // director's conversation must not turn into a transcript replay.
        memories: directorService?.memoriesFor(directorQuery) ?? [],
        instructions: directorService?.instructions ?? [],
        projects: directorService?.projectView() ?? [],
        // 派工时要选 Agent / 知识库，这里给 id 和名字；不读任何内容。
        capabilities: {
          agents: agentDefinitions.map((agent) => ({
            id: agent.id,
            name: agent.name,
            description: agent.description ?? '',
          })),
          kbCategories: (kb.store?.listCategories() ?? []).map((category) => ({
            id: category.id,
            name: category.name,
          })),
        },
        maxDispatch: directorState.maxDispatch,
        service: directorService ?? undefined,
      },
    };
  } else {
    // Activation only. Nothing is read or sent here; the agent gets tools that
    // ask before every content read.
    const chatAccess = prepareWorkspaceDataAccess(request?.dataAccess);
    // A folder task may have picked an Agent in the composer. It only applies
    // here; agent-editor runs resolved their target above.
    selectedAgent =
      agentDefinitions.find((item) => item.id === String(agentId ?? '')) ?? null;
    // The Agent's saved knowledge selection joins whatever the user activated
    // for this chat. Exclusions in the Agent scope always win.
    const dataAccess = knowledgeScope.mergeDataAccess(
      chatAccess,
      agentKnowledgeAccess(selectedAgent),
    );
    const runAgent = agentRunScope(selectedAgent);
    if (runAgent?.memoryEnabled) {
      const index = await memoryTitleIndex(selectedAgent.id);
      runAgent.memoryTitles = index.titles;
      runAgent.memoryExpired = index.expired;
    }
    toolScope = { kind: 'workspace', dataAccess, agent: runAgent };
  }

  // A remote workspace connects here, once per task; its tools and commands
  // run on the host. Local folder tasks use the fs adapter built from the path.
  let workspaceFs = null;
  if (!isToolEditor && !isAgentEditor && !isDirector && request?.workspaceId) {
    try {
      workspaceFs = await remoteWorkspaceFs(request.workspaceId);
      // The renderer sends the display label (user@host:path) for a remote
      // workspace, so the root only becomes a usable path once connected.
      if (workspaceFs) workspacePath = workspaceFs.root;
    } catch (error) {
      send({
        type: 'error',
        error: `远程工作空间连接失败：${error?.message || String(error)}`,
      });
      return true;
    }
  }

  // A remote root lives on the host; workspaceFs checks it there.
  if (!workspaceFs) {
    try {
      const stat = await fs.stat(workspacePath);
      if (!stat.isDirectory()) {
        send({ type: 'error', error: '工作空间不是一个文件夹' });
        return true;
      }
    } catch (error) {
      send({ type: 'error', error: `工作空间不可访问：${error?.message || String(error)}` });
      return true;
    }
  }

  const history = Array.isArray(messages) ? messages : [];
  // Older renderers sent the whole display transcript; take its last user turn
  // so a stale caller still produces a sensible single message.
  const prompt = typeof message === 'string'
    ? message
    : String([...history].reverse().find((item) => item?.role === 'user')?.content ?? '');

  const session = new AgentSession({
    dir: agentSessionDir(),
    sessionId: sessionId || requestId,
  });

  const {
    maxSteps,
    askLevel: globalAskLevel,
    autoDeleteTemp,
    autoInstallDeps,
    contextLimit,
  } = await readWorkSettings();
  // A task carries its own level; the global 工作设置 is the fallback.
  const askLevel = normalizeAskLevel(request?.askLevel ?? globalAskLevel);
  const run = new AgentRun({
    requestId,
    provider,
    workspacePath,
    workspaceName,
    message: prompt,
    session,
    history,
    mode,
    send,
    allowedCommands,
    webEnabled,
    webEntries,
    maxSteps,
    askLevel,
    autoDeleteTemp,
    autoInstallDeps,
    contextLimit,
    toolScope,
    toolContext,
    workspaceFs,
    // The renderer owns the displayed checklist; feeding it back keeps the
    // loop from re-ticking (or regressing) items across turns.
    initialTodos: Array.isArray(request?.todos) ? request.todos : [],
    onUsage: (report) =>
      usageStore?.record({
        feature: report.feature || 'workspace',
        provider,
        usage: report.usage,
        sessionId: sessionId || requestId,
        workspaceName,
      }),
  });

  // Created only once the run is certain to start: a reloaded page reattaches
  // to this by requestId.
  snapshot = {
    requestId,
    sessionId: sessionId || requestId,
    messageId: typeof messageId === 'string' ? messageId : null,
    userMessageId: typeof userMessageId === 'string' ? userMessageId : null,
    userMessage: typeof userMessage === 'string' ? userMessage : null,
    workspaceName: workspaceName ?? '',
    mode: mode ?? 'workspace-write',
    startedAt: Date.now(),
    status: 'running',
    content: '',
    thinking: '',
    steps: [],
    permissions: [],
    questions: [],
    todos: null,
    error: null,
    finishedAt: null,
  };
  agentSnapshots.set(requestId, snapshot);
  agentRuns.set(requestId, run);

  let runOk = false;
  let runError = null;
  if (isDirector) directorService?.setInteractive(true);
  if (supervised) {
    directorService?.onRunStart({
      taskId: runTaskId,
      requestId,
      title: workspaceName,
      workspaceId: request?.workspaceId,
      // 总监要靠这个目录在任务结束后找本次产出的文件（不复制，只引用路径）。
      workspacePath,
    });
  }

  try {
    await run.run();
    runOk = true;
    send({ type: 'done' });
    // Learning reads the finished turn in the background. It must never delay
    // the task's completion or change its outcome.
    if (selectedAgent && prompt.trim()) {
      startMemoryLearning({
        agent: selectedAgent,
        provider,
        history: run.history,
        message: prompt,
        sessionId: sessionId || requestId,
        messageId: typeof messageId === 'string' ? messageId : '',
      });
    }
  } catch (error) {
    runError = error?.message || String(error);
    if (run.controller.signal.aborted) send({ type: 'aborted' });
    else {
      // The renderer shows this too; the terminal keeps the stack for diagnosis.
      console.error('[agent] run failed:', error);
      send({ type: 'error', error: runError });
    }
  } finally {
    if (isDirector) directorService?.setInteractive(false);
    if (supervised) {
      // The report is written here, not by the renderer: it must survive a
      // reloaded page and a model outage.
      void directorService?.onRunEnd({
        taskId: runTaskId,
        requestId,
        ok: runOk,
        error: runError,
        aborted: run.controller.signal.aborted,
      });
    }
    agentRuns.delete(requestId);
    // The outcome stays readable for a while: a page reloaded at the same
    // moment must still be able to finish its message.
    expireSnapshot(requestId);
    // Scratch cleanup waits until no task is running: another task may still
    // be using .ezness, and deleting it mid-run would break it. Runs that ended
    // earlier are remembered so their folders are not left behind.
    const { autoDeleteTemp } = await readWorkSettings();
    if (autoDeleteTemp && !run.ws?.remote) {
      pendingTempRoots.add(run.root);
      if (agentRuns.size === 0) {
        for (const root of pendingTempRoots) await cleanAgentTemp(root);
        pendingTempRoots.clear();
      }
    } else {
      pendingTempRoots.clear();
    }
  }

  return true;
});

/** Runs still alive (plus recently finished ones) for a reloaded renderer. */
ipcMain.handle('agent:active', () => [...agentSnapshots.values()]);

ipcMain.handle('agent:resolve', (_event, request) => {
  const run = agentRuns.get(request?.requestId);
  // The prompt is answered; a reattached page must not show it again.
  const snapshot = agentSnapshots.get(request?.requestId);
  if (snapshot && request?.callId) {
    snapshot.permissions = snapshot.permissions.filter((item) => item.callId !== request.callId);
    snapshot.questions = snapshot.questions.filter((item) => item.callId !== request.callId);
  }
  return run ? run.resolve(request.callId, request.decision) : false;
});

ipcMain.handle('agent:abort', (_event, requestId) => {
  agentRuns.get(requestId)?.abort();
  return true;
});

ipcMain.handle('agent:delete-session', async (_event, sessionId) => {
  await AgentSession.remove(agentSessionDir(), sessionId);
  return true;
});

/**
 * Fold a task's own agent history now. The renderer's summary card only
 * changes what the page shows; the model reads this JSONL file, so a manual
 * "压缩上下文" that does not touch it leaves the real prompt unchanged.
 */
ipcMain.handle('agent:compact', async (_event, request) => {
  const sessionId = String(request?.sessionId ?? '');
  if (!sessionId) return { ok: false, error: '缺少任务 id。' };
  for (const snapshot of agentSnapshots.values()) {
    if (snapshot.sessionId === sessionId && snapshot.finishedAt === null) {
      return { ok: false, error: '这个任务正在运行，结束后再压缩。' };
    }
  }
  const work = await readWorkSettings();
  const requested = Math.trunc(Number(request?.contextLimit ?? work.contextLimit));
  const limit = Number.isFinite(requested) && requested >= 1000
    ? Math.min(requested, 8_000_000)
    : 128000;
  const session = new AgentSession({ dir: agentSessionDir(), sessionId });
  const messages = await session.load();
  if (messages.length === 0) {
    return { ok: true, compacted: false, before: 0, after: 0 };
  }
  const folded = compact(messages, {
    at: Math.round(limit * 0.85),
    keep: Math.max(1000, Math.round(limit * 0.3)),
    force: true,
  });
  if (!folded.compacted) {
    return { ok: true, compacted: false, before: folded.before, after: folded.before };
  }
  // Manual compaction rewrites the file the model reads and cannot be undone
  // message by message, so keep the pre-compaction version once per session.
  await session.backup();
  await session.save(folded.messages);
  return { ok: true, compacted: true, before: folded.before, after: folded.after };
});

/**
 * Current size of a task's agent history. The ring normally trusts the last
 * provider-reported prompt count, but a manual compaction changes the file
 * without making a request — after a restart that old count is stale and the
 * ring would still show the pre-compaction fill. This lets the renderer notice
 * the mismatch and fall back to the live estimate.
 */
ipcMain.handle('agent:context', async (_event, sessionId) => {
  const id = String(sessionId ?? '');
  if (!id) return null;
  const session = new AgentSession({ dir: agentSessionDir(), sessionId: id });
  const messages = await session.load();
  if (messages.length === 0) return null;
  let at = Date.now();
  try {
    at = (await fs.stat(session.file)).mtimeMs;
  } catch {
    /* fall back to now */
  }
  return { tokens: sizeOf(messages), at, digested: isDigest(messages[0]) };
});

ipcMain.handle('agent:capabilities', () => describeCapabilities(agentSessionDir()));

ipcMain.handle('agent:custom-tools', () => customToolDefs);

ipcMain.handle('agent:runtimes', () => customTools.detectRuntimes());

/**
 * 刷新: re-reads everything the main process keeps in memory from disk —
 * custom tools, categories, health and agents. The renderer reloads its own
 * window afterwards, which restarts the rest of the boot-time state (settings,
 * chats, knowledge base, warehouse) the same way relaunching would.
 *
 * A definition edited on disk while the app is running is otherwise invisible:
 * `customToolDefs` is loaded once at boot and every in-app save writes that
 * cached copy back over the file.
 */
ipcMain.handle('app:reload-runtime', async () => {
  try {
    const tools = await reloadCustomTools();
    const agents = await reloadAgents();
    await usageStore?.load();
    return {
      ok: true,
      tools: tools.length,
      categories: toolCategories.length,
      agents: agents.length,
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

/* ------------------------------------------------------------------
   Portable Python environment
   Lives under <data root>/runtimes/python so it follows the storage
   root, and custom tools prefer it over any system Python.
   ------------------------------------------------------------------ */

ipcMain.handle('python:status', () => pythonEnv.status(storage.root));

ipcMain.handle('python:ensure', async () => {
  const result = await pythonEnv.ensure(storage.root);
  // A freshly deployed interpreter must be visible to custom tools at once.
  await customTools.detectRuntimes({ force: true });
  return result;
});

ipcMain.handle('python:modules', () => pythonEnv.listModules(storage.root));

ipcMain.handle('python:install', (_event, spec) => pythonEnv.installModule(storage.root, spec));

ipcMain.handle('python:set-index', (_event, value) => pythonEnv.setIndexUrl(storage.root, value));

/**
 * File picker for a secret parameter. The chosen path goes straight into the
 * permission card; it is never written to a prompt or the transcript.
 */
ipcMain.handle('agent:pick-secret-file', async (_event, request) => {
  const title = String(request?.title ?? '').trim() || '选择文件';
  const result = await openDialog({
    title,
    properties: ['openFile'],
    filters: [{ name: '全部文件', extensions: ['*'] }],
  });
  return result.canceled ? '' : String(result.filePaths?.[0] ?? '');
});

ipcMain.handle('agent:custom-tools-save', async (_event, input) => {
  const others = customToolDefs.filter((tool) => tool.id !== input?.id);
  const result = customTools.normalizeDefinition(input, {
    builtinNames: builtinToolNames(),
    others,
  });
  if (!result.ok) return { ok: false, error: result.errors.join('\n') };

  const definition = result.definition;

  // Keep the tool's category pointing at a stored category; a name typed in the
  // dialog becomes a new category so the sidebar never loses a saved tool.
  const knownCategory = toolCategories.find(
    (category) => category.name.toLowerCase() === definition.category.toLowerCase(),
  );
  if (knownCategory) {
    definition.category = knownCategory.name;
  } else if (toolCategories.length >= customTools.MAX_CATEGORIES) {
    return { ok: false, error: `最多 ${customTools.MAX_CATEGORIES} 个分类。` };
  } else {
    const nextCategories = [
      ...toolCategories,
      { id: crypto.randomUUID(), name: definition.category, pinned: false },
    ];
    try {
      await customTools.saveCategories(agentDir(), nextCategories);
    } catch (error) {
      return { ok: false, error: `保存分类失败：${error?.message || String(error)}` };
    }
    toolCategories = nextCategories;
  }
  const index = customToolDefs.findIndex((tool) => tool.id === definition.id);
  const next = index >= 0
    ? customToolDefs.map((tool, at) => (at === index ? definition : tool))
    : [...customToolDefs, definition];
  if (next.length > customTools.MAX_TOOLS) {
    return { ok: false, error: `最多 ${customTools.MAX_TOOLS} 个自定义功能。` };
  }

  try {
    await customTools.saveDefinitions(agentDir(), next);
  } catch (error) {
    return { ok: false, error: `保存失败：${error?.message || String(error)}` };
  }

  customToolDefs = next;
  // A manual edit invalidates the previous test. Keep broken tools disabled:
  // only an explicit re-test may bring them back into the registry.
  if (toolHealth[definition.id]?.status !== 'broken') {
    toolHealth[definition.id] = { status: 'untested', errors: [] };
  }
  await persistHealth();
  compileToolRegistry();
  return { ok: true, definitions: next, categories: toolCategories, health: toolHealth };
});

ipcMain.handle('agent:tool-health', () => toolHealth);

ipcMain.handle('agent:tool-retest', async (_event, request) => {
  const id = String(request?.id ?? '');
  const target = customToolDefs.find((definition) => definition.id === id);
  if (!target) return { ok: false, error: '功能不存在。' };
  const category = toolCategories.find((item) => item.name === target.category);
  if (!category) return { ok: false, error: '功能所属分类不存在。' };

  const evaluation = await evaluateCustomTool(target, {
    testArgs: request?.args ?? toolHealth[target.id]?.testArgs,
    scratchDir: editorScratchDir(category),
  });
  toolHealth[target.id] = evaluation.health;
  await persistHealth();
  compileToolRegistry();
  return {
    ok: true,
    passed: evaluation.ok,
    health: evaluation.health,
    installed: evaluation.installed ?? [],
    definitions: customToolDefs,
  };
});

ipcMain.handle('agent:categories', () => toolCategories);

ipcMain.handle('agent:category-save', async (_event, input) => {
  const id = String(input?.id ?? '').trim();
  const wantsRename = input?.name !== undefined;
  const wantsPin = typeof input?.pinned === 'boolean';

  if (!id) {
    if (!wantsRename) return { ok: false, error: '分类名称不能为空。' };
    if (toolCategories.length >= customTools.MAX_CATEGORIES) {
      return { ok: false, error: `最多 ${customTools.MAX_CATEGORIES} 个分类。` };
    }
    const parsed = customTools.normalizeCategoryName(input.name);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (toolCategories.some((category) => category.name.toLowerCase() === parsed.name.toLowerCase())) {
      return { ok: false, error: '已经有同名分类了。' };
    }
    const nextCategories = [
      ...toolCategories,
      { id: crypto.randomUUID(), name: parsed.name, pinned: false },
    ];
    try {
      await customTools.saveCategories(agentDir(), nextCategories);
    } catch (error) {
      return { ok: false, error: `保存分类失败：${error?.message || String(error)}` };
    }
    toolCategories = nextCategories;
    return { ok: true, categories: toolCategories, definitions: customToolDefs };
  }

  const current = toolCategories.find((category) => category.id === id);
  if (!current) return { ok: false, error: '分类不存在。' };

  let name = current.name;
  if (wantsRename) {
    const parsed = customTools.normalizeCategoryName(input.name);
    if (!parsed.ok) return { ok: false, error: parsed.error };
    if (
      toolCategories.some(
        (category) => category.id !== id && category.name.toLowerCase() === parsed.name.toLowerCase(),
      )
    ) {
      return { ok: false, error: '已经有同名分类了。' };
    }
    name = parsed.name;
  }
  const pinned = wantsPin ? Boolean(input.pinned) : current.pinned;
  const renamed = name !== current.name;

  if (renamed) {
    const nextDefs = customToolDefs.map((definition) =>
      definition.category === current.name ? { ...definition, category: name } : definition,
    );
    try {
      await customTools.saveDefinitions(agentDir(), nextDefs);
    } catch (error) {
      return { ok: false, error: `重命名失败：${error?.message || String(error)}` };
    }
    customToolDefs = nextDefs;
    compileToolRegistry();
  }

  const nextCategories = toolCategories.map((category) =>
    category.id === id ? { ...category, name, pinned } : category,
  );
  try {
    await customTools.saveCategories(agentDir(), nextCategories);
  } catch (error) {
    return { ok: false, error: `保存分类失败：${error?.message || String(error)}` };
  }
  toolCategories = nextCategories;
  return { ok: true, categories: toolCategories, definitions: customToolDefs };
});

ipcMain.handle('agent:category-delete', async (_event, id) => {
  const current = toolCategories.find((category) => category.id === String(id ?? ''));
  if (!current) return { ok: true, categories: toolCategories, definitions: customToolDefs };

  const removed = customToolDefs.filter((definition) => definition.category === current.name);
  const nextDefs = customToolDefs.filter((definition) => definition.category !== current.name);
  try {
    await customTools.saveDefinitions(agentDir(), nextDefs);
  } catch (error) {
    return { ok: false, error: `删除失败：${error?.message || String(error)}` };
  }
  for (const definition of removed) {
    await customTools.removeToolFiles(agentDir(), definition.id);
  }

  const nextCategories = toolCategories.filter((category) => category.id !== current.id);
  try {
    await customTools.saveCategories(agentDir(), nextCategories);
  } catch (error) {
    return { ok: false, error: `删除分类失败：${error?.message || String(error)}` };
  }

  customToolDefs = nextDefs;
  toolCategories = nextCategories;
  for (const definition of removed) delete toolHealth[definition.id];
  await persistHealth();
  compileToolRegistry();
  return { ok: true, categories: toolCategories, definitions: customToolDefs };
});


ipcMain.handle('agent:custom-tools-delete', async (_event, id) => {
  const targetId = String(id ?? '');
  const next = customToolDefs.filter((tool) => tool.id !== targetId);
  if (next.length === customToolDefs.length) return { ok: true, definitions: customToolDefs };

  try {
    await customTools.saveDefinitions(agentDir(), next);
  } catch (error) {
    return { ok: false, error: `删除失败：${error?.message || String(error)}` };
  }

  await customTools.removeToolFiles(agentDir(), targetId);
  customToolDefs = next;
  delete toolHealth[targetId];
  await persistHealth();
  compileToolRegistry();
  return { ok: true, definitions: next };
});

/* ------------------------------------------------------------------
   能力分类包 / Agent 包
   一个能力分类是一个完整的包（分类 + 它下面的功能，脚本一起走）；一个
   Agent 包带着定义、能力范围、勾选到的那些分类包和长期记忆。知识库不打包。
   ------------------------------------------------------------------ */

/** 导出文件名：去掉 Windows 不允许的字符，空名给个兜底。 */
function packageFileName(name, suffix, fallback) {
  const safe = String(name ?? '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .trim()
    .slice(0, 60);
  return `${safe || fallback}${suffix}.json`;
}

ipcMain.handle('agent:category-export', async (_event, id) => {
  const category = toolCategories.find((item) => item.id === String(id ?? ''));
  if (!category) return { ok: false, error: '分类不存在。' };

  try {
    const result = await saveDialog({
      title: `导出能力分类「${category.name}」`,
      defaultPath: path.join(
        app.getPath('documents'),
        packageFileName(category.name, '.capability', '能力分类'),
      ),
      filters: [{ name: '能力分类包', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const body = packageIo.capabilityPackage(category, customToolDefs);
    await fs.writeFile(result.filePath, JSON.stringify(body, null, 2), 'utf8');
    // 策略矩阵不随包走（见 package-io 顶部说明），导出时说清楚，对方导入后才不会奇怪。
    const withPolicy = customToolDefs.filter(
      (definition) => definition.category === category.name && definition.policy,
    ).length;
    return {
      ok: true,
      path: result.filePath,
      tools: body.tools.length,
      warnings:
        withPolicy > 0
          ? [`${withPolicy} 个功能设了自动放行策略。策略不随包走，导入方按默认规则逐次确认。`]
          : [],
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('agent:category-import', async () => {
  try {
    const picked = await openDialog({
      title: '导入能力分类',
      properties: ['openFile'],
      filters: [{ name: '能力分类包', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };

    const raw = await fs.readFile(picked.filePaths[0], 'utf8');
    const parsed = packageIo.parsePackage(raw, packageIo.CATEGORY_FORMAT);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const before = new Set(customToolDefs.map((definition) => definition.id));
    const applied = packageIo.applyCategoryPackage(parsed.data, {
      categories: toolCategories,
      definitions: customToolDefs,
      builtinNames: builtinToolNames(),
    });
    if (!applied.ok) return { ok: false, error: applied.error };

    // 先分类后功能：功能写失败时最多多一个空分类（看得见、能删），反过来会
    // 留下一批挂在不存在的分类下的功能，界面上根本找不到。
    await customTools.saveCategories(agentDir(), applied.categories);
    if (applied.definitions.length !== customToolDefs.length) {
      await customTools.saveDefinitions(agentDir(), applied.definitions);
    }

    const added = applied.definitions.filter((definition) => !before.has(definition.id));
    customToolDefs = applied.definitions;
    toolCategories = applied.categories;
    for (const definition of added) {
      toolHealth[definition.id] = { status: 'untested', errors: [] };
    }
    await persistHealth();
    compileToolRegistry();
    return {
      ok: true,
      category: applied.category,
      categories: toolCategories,
      definitions: customToolDefs,
      health: toolHealth,
      imported: applied.imported,
      warnings: applied.warnings,
    };
  } catch (error) {
    return { ok: false, error: `导入失败：${error?.message || String(error)}` };
  }
});

/* ------------------------------------------------------------------
   Agents
   Definitions live in agent/agents.json. An Agent selects a slice of the
   user's single shared knowledge base; nothing is stored per Agent there.
   ------------------------------------------------------------------ */

ipcMain.handle('agents:list', () => agentDefinitions);

/**
 * Agent 审查: a separate model call per Agent, with no task context and no
 * tools. The renderer supplies the catalog it can actually apply against, so a
 * suggestion can only refer to a category or document that exists right now.
 * Usage is billed to its own feature so the review is visible in the ledger.
 */
ipcMain.handle('agents:review', async (_event, request) => {
  const provider = request?.provider;
  if (!provider?.baseUrl) return { ok: false, error: '当前没有可用的模型，请先在设置里接入。' };

  const agents = (Array.isArray(request?.agents) ? request.agents : []).slice(
    0,
    agentsStore.MAX_AGENTS,
  );
  if (agents.length === 0) return { ok: false, error: '还没有 Agent 可以审查。' };

  // Only stored definitions are reviewed: an id the renderer made up must not
  // pull a prompt from anywhere else.
  const known = new Set(agentDefinitions.map((agent) => agent.id));
  const list = agents.filter((agent) => known.has(String(agent?.id ?? '')));
  if (list.length === 0) return { ok: false, error: '没有找到要审查的 Agent。' };

  try {
    const result = await agentReview.reviewAgents({
      provider,
      agents: list,
      catalog: request?.catalog,
    });
    for (const item of result.results) {
      if (item.usage) {
        usageStore?.record({ feature: 'agent-review', provider, usage: item.usage });
      }
    }
    return result;
  } catch (error) {
    return { ok: false, error: `审查失败：${error?.message || String(error)}` };
  }
});

// Visualization runs that are still streaming, keyed by the id the renderer
// picked. Closing the dialog must stop the model call, not just ignore it.
const vizRuns = new Map();

ipcMain.on('workspace:viz-cancel', (_event, requestId) => {
  const key = String(requestId ?? '').trim();
  if (!key) return;
  vizRuns.get(key)?.abort();
});

ipcMain.handle('workspace:visualize', async (event, request) => {
  const provider = request?.provider;
  if (!provider?.baseUrl) return { ok: false, error: '当前没有可用的模型，请先在设置里接入。' };

  const topic = String(request?.topic ?? '').trim().slice(0, 200);
  const context = request?.context;
  if (!context || typeof context !== 'object') {
    return { ok: false, error: '没有可以分析的工作空间数据。' };
  }
  if (!Array.isArray(context.tasks) || context.tasks.length === 0) {
    return { ok: false, error: '这个工作空间还没有任务，先新建一个任务再试。' };
  }

  const requestId = String(request?.requestId ?? '').trim();
  const controller = new AbortController();
  if (requestId) vizRuns.set(requestId, controller);
  // The window closing or reloading is the last chance to stop the stream.
  const sender = event.sender;
  const onGone = () => controller.abort();
  if (sender && !sender.isDestroyed()) sender.once('destroyed', onGone);

  try {
    const result = await workspaceVisualize.visualizeWorkspace({
      provider,
      topic,
      context,
      signal: controller.signal,
    });
    if (result.usage) {
      usageStore?.record({ feature: 'workspace-viz', provider, usage: result.usage });
    }
    const payload = { ...result };
    delete payload.usage;
    return payload;
  } catch (error) {
    // Tokens were spent before the stop; bill them like any other run.
    if (error?.usage) {
      usageStore?.record({ feature: 'workspace-viz', provider, usage: error.usage });
    }
    if (controller.signal.aborted) return { ok: false, aborted: true, error: '' };
    return { ok: false, error: `生成失败：${error?.message || String(error)}` };
  } finally {
    if (requestId && vizRuns.get(requestId) === controller) vizRuns.delete(requestId);
    if (sender && !sender.isDestroyed()) sender.removeListener('destroyed', onGone);
  }
});

ipcMain.handle('agents:save', async (_event, input) => {
  const id = String(input?.id ?? '').trim();
  const existing = agentDefinitions.find((agent) => agent.id === id) ?? null;
  if (!existing && agentDefinitions.length >= agentsStore.MAX_AGENTS) {
    return { ok: false, error: `最多 ${agentsStore.MAX_AGENTS} 个 Agent。` };
  }

  const others = agentDefinitions.filter((agent) => agent.id !== id);
  const result = agentsStore.normalizeAgent(
    {
      ...input,
      // An id that is no longer stored becomes a new agent instead of
      // resurrecting a deleted one.
      id: existing ? existing.id : '',
      createdAt: existing?.createdAt ?? Date.now(),
      updatedAt: Date.now(),
    },
    { others, builtinCategories: CATEGORY_ORDER },
  );
  if (!result.ok) return { ok: false, error: result.errors.join('\n') };

  const next = existing
    ? agentDefinitions.map((agent) => (agent.id === existing.id ? result.agent : agent))
    : [...agentDefinitions, result.agent];
  try {
    await agentsStore.saveAgents(agentDir(), next);
  } catch (error) {
    return { ok: false, error: `保存失败：${error?.message || String(error)}` };
  }
  agentDefinitions = next;
  return { ok: true, agents: agentDefinitions, agent: result.agent };
});

ipcMain.handle('agents:delete', async (_event, id) => {
  const target = agentDefinitions.find((agent) => agent.id === String(id ?? ''));
  if (!target) return { ok: false, error: 'Agent 不存在。' };

  const next = agentDefinitions.filter((agent) => agent.id !== target.id);
  try {
    await agentsStore.saveAgents(agentDir(), next);
  } catch (error) {
    return { ok: false, error: `删除失败：${error?.message || String(error)}` };
  }
  agentDefinitions = next;

  // Knowledge base files are shared and user-maintained, so deleting an Agent
  // never touches them. Its long-term memory is private to this Agent, so both
  // files are removed — derived from the id, they cannot hit another Agent.
  const memFile = memoryStore.storePath(agentDir(), target.id);
  if (memFile) await fs.rm(memFile, { force: true }).catch(() => undefined);
  const memEvents = memoryStore.eventsPath(agentDir(), target.id);
  if (memEvents) await fs.rm(memEvents, { force: true }).catch(() => undefined);

  return { ok: true, agents: agentDefinitions };
});

ipcMain.handle('agents:export', async (_event, id) => {
  const agent = agentDefinitions.find((item) => item.id === String(id ?? ''));
  if (!agent) return { ok: false, error: 'Agent 不存在。' };

  try {
    const result = await saveDialog({
      title: `导出 Agent「${agent.name}」`,
      defaultPath: path.join(app.getPath('documents'), packageFileName(agent.name, '.agent', 'Agent')),
      filters: [{ name: 'Agent 包', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const store = await memoryStore.loadStore(agentDir(), agent.id);
    const body = packageIo.agentPackage({
      agent,
      categories: toolCategories,
      definitions: customToolDefs,
      entries: store.entries,
    });
    await fs.writeFile(result.filePath, JSON.stringify(body, null, 2), 'utf8');
    const bundled = new Set(body.capabilities.categories.map((pack) => pack.category.name));
    const withPolicy = customToolDefs.filter(
      (definition) => bundled.has(definition.category) && definition.policy,
    ).length;
    return {
      ok: true,
      path: result.filePath,
      categories: body.capabilities.categories.length,
      memory: body.memory.entries.length,
      warnings:
        withPolicy > 0
          ? [`${withPolicy} 个功能设了自动放行策略。策略不随包走，导入方按默认规则逐次确认。`]
          : [],
    };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('agents:import', async () => {
  try {
    const picked = await openDialog({
      title: '导入 Agent',
      properties: ['openFile'],
      filters: [{ name: 'Agent 包', extensions: ['json'] }],
    });
    if (picked.canceled || !picked.filePaths[0]) return { ok: false, canceled: true };

    const raw = await fs.readFile(picked.filePaths[0], 'utf8');
    const parsed = packageIo.parsePackage(raw, packageIo.AGENT_FORMAT);
    if (!parsed.ok) return { ok: false, error: parsed.error };

    const knownTools = new Set(customToolDefs.map((definition) => definition.id));
    const applied = packageIo.applyAgentPackage(parsed.data, {
      agents: agentDefinitions,
      categories: toolCategories,
      definitions: customToolDefs,
      builtinNames: builtinToolNames(),
      builtinCategories: CATEGORY_ORDER,
    });
    if (!applied.ok) return { ok: false, error: applied.error };

    // 顺序：分类 → 功能（脚本）→ Agent → 记忆。Agent 最后写，它引用的分类和
    // 功能一定已经在盘上；中途失败时重试一次即可，最多多出几份没人引用的数据。
    if (applied.categories.length !== toolCategories.length) {
      await customTools.saveCategories(agentDir(), applied.categories);
    }
    if (applied.definitions.length !== customToolDefs.length) {
      await customTools.saveDefinitions(agentDir(), applied.definitions);
    }
    await agentsStore.saveAgents(agentDir(), applied.agents);

    if (applied.memoryEntries.length > 0) {
      const store = memoryStore.emptyStore(applied.agent.id);
      store.entries = applied.memoryEntries;
      store.updatedAt = memoryStore.nowMs();
      await memoryStore.saveStore(agentDir(), applied.agent.id, store);
    }

    const added = applied.definitions.filter((definition) => !knownTools.has(definition.id));
    const importedCategories = applied.categories.length - toolCategories.length;
    customToolDefs = applied.definitions;
    toolCategories = applied.categories;
    agentDefinitions = applied.agents;
    for (const definition of added) {
      toolHealth[definition.id] = { status: 'untested', errors: [] };
    }
    if (added.length > 0) {
      await persistHealth();
      compileToolRegistry();
    }

    return {
      ok: true,
      agent: applied.agent,
      agents: agentDefinitions,
      categories: toolCategories,
      definitions: customToolDefs,
      health: toolHealth,
      importedCategories,
      memory: applied.memoryEntries.length,
      warnings: applied.warnings,
    };
  } catch (error) {
    return { ok: false, error: `导入失败：${error?.message || String(error)}` };
  }
});

/* ------------------------------------------------------------------
   工作总监
   A mandate (on/off, mode, budget) plus per-space visibility. Ownership is
   not stored per task: the director holds every task by default and the
   renderer reports where the user is standing (presence), which expires.
   ------------------------------------------------------------------ */

ipcMain.handle('director:get', () => directorState);

ipcMain.handle('director:save', async (_event, patch) => {
  const next = directorStore.update(directorState, patch ?? {});
  try {
    await directorStore.save(directorDir(), next);
  } catch (error) {
    return { ok: false, error: `保存失败：${error?.message || String(error)}` };
  }
  directorState = next;
  broadcast('director:event', directorState);
  // Enabling or changing the level may unblock queued instructions.
  directorService?.drain();
  return { ok: true, state: directorState };
});

ipcMain.handle('director:presence', async (_event, input) => {
  const { state, changed } = directorStore.setPresence(directorState, input ?? {});
  directorState = state;
  if (!changed) return { ok: true, state: directorState };
  try {
    await directorStore.save(directorDir(), state);
  } catch (error) {
    return { ok: false, error: `保存失败：${error?.message || String(error)}` };
  }
  broadcast('director:event', directorState);
  // Leaving a task hands it back to the director; instructions that were held
  // for the human can go out now.
  directorService?.drain();
  return { ok: true, state: directorState };
});

/* ------------------------------------------------------------------
   工作总监 · service
   The renderer pushes the task board; the main process holds the queue,
   the ledger, the inbox and the delegation rules.
   ------------------------------------------------------------------ */

ipcMain.handle('director:sync', (_event, payload) => {
  directorService?.sync(payload?.tasks ?? [], payload?.spaces ?? []);
  return { ok: true };
});

ipcMain.handle('director:snapshot', () => ({
  state: directorState,
  inbox: directorService?.inboxView() ?? { items: [], unread: 0, confirms: 0 },
  ledger: directorService?.ledgerView(40) ?? { items: [] },
  instructions: directorService?.instructions ?? [],
}));

ipcMain.handle('director:inbox', () =>
  directorService?.inboxView() ?? { items: [], unread: 0, confirms: 0 },
);

ipcMain.handle('director:mark-read', (_event, ids) => {
  const view = directorService?.markRead(ids);
  return { ok: true, ...(view ?? { items: [], unread: 0, confirms: 0 }) };
});

ipcMain.handle('director:resolve', async (_event, payload) => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.resolveInbox(payload ?? {});
});

/** 内容审计：重复投入的本地统计，打开弹窗就能画图，不等模型。
 *  announce=true 表示用户刚点了「开始审计」，审计组要回一条消息。 */
ipcMain.handle('director:audit', (_event, options) => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.auditView({ announce: Boolean(options?.announce) });
});

/** 审计里「让审计组出一次建议」：用户主动要，不受冷却和每日限额影响。 */
ipcMain.handle('director:review-now', async () => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.reviewNow();
});

ipcMain.handle('director:ledger', (_event, limit) =>
  directorService?.ledgerView(limit) ?? { items: [] },
);

/** 清空对话时把旧记录留档；总监的 JSONL 也一起收进去，方便回看细节。 */
function directorHistoryDir() {
  return path.join(directorDir(), 'history');
}

/** 存档摘要索引：列存档时只读这一张小表，不再把每个存档的全文和会话 JSONL 都读一遍。 */
function directorHistoryIndexPath() {
  return path.join(directorHistoryDir(), 'index.json');
}

async function readHistoryIndex() {
  try {
    const data = JSON.parse(await fs.readFile(directorHistoryIndexPath(), 'utf8'));
    const list = Array.isArray(data) ? data : Array.isArray(data?.items) ? data.items : [];
    return new Map(
      list
        .filter((item) => item && item.id)
        .map((item) => [String(item.id), item]),
    );
  } catch {
    return new Map();
  }
}

async function writeHistoryIndex(index) {
  const items = [...index.values()].sort((a, b) => (Number(b?.at) || 0) - (Number(a?.at) || 0));
  await fs.mkdir(directorHistoryDir(), { recursive: true });
  await fs.writeFile(
    directorHistoryIndexPath(),
    JSON.stringify({ version: 1, items }),
    'utf8',
  );
}

/**
 * 从存档原文生成一行摘要（列表只显示这一行）。
 * 旧存档没有 from/to 的用消息时间补；事务条数按范围从账本实数，
 * 不能因为旧文件没有 transactions 快照就显示 0。
 */
function historyItemFor(data, fallbackId, ledger) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  const from = Number(data?.from) || Number(messages[0]?.createdAt) || 0;
  const to =
    Number(data?.to) || Number(messages[messages.length - 1]?.createdAt) || 0;
  const stored = Array.isArray(data?.transactions) ? data.transactions.length : 0;
  const live =
    from && to
      ? ledger.filter((item) => Number(item?.at) >= from && Number(item?.at) <= to).length
      : 0;
  const named = data?.titleSource === 'model' && Boolean(data?.title);
  return {
    id: String(data?.id ?? fallbackId),
    at: Number(data?.at) || 0,
    from,
    to,
    title: named ? String(data.title) : titleForCluster(messages),
    titleSource: named ? 'model' : 'content',
    count: Number(data?.count) || messages.length,
    transactionCount: Math.max(stored, live),
  };
}

/** 同一段消息被重复留档时，用内容指纹认出来（时间范围可能因清空时刻略有不同）。 */
function archiveSignature(data) {
  const messages = Array.isArray(data?.messages) ? data.messages : [];
  return crypto
    .createHash('sha1')
    .update(
      messages
        .map((message) => `${message?.role ?? ''}\u0000${message?.createdAt ?? 0}\u0000${message?.content ?? ''}`)
        .join('\u0001'),
    )
    .digest('hex');
}

/**
 * 清理重复的对话存档：只删除消息内容完全相同的副本，每组保留时间范围
 * 最完整的一份（最后一个话题段可能多装几条事务）。索引一并重建。
 */
async function dedupeDirectorHistory() {
  const dir = directorHistoryDir();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: true, removed: 0, kept: 0 };
  }
  const files = names.filter((name) => name.endsWith('.json') && name !== 'index.json');
  const keep = new Map();
  const remove = [];
  // 被删副本的原文：里面的事务要跟着删，否则“总监事务”里会留下孤儿。
  const removedData = [];
  // 被删副本 → 保留那份，用来把记忆改指过去。
  const remap = new Map();
  for (const name of files) {
    let data;
    try {
      data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
    } catch {
      continue;
    }
    const signature = archiveSignature(data);
    const previous = keep.get(signature);
    if (!previous) {
      keep.set(signature, { name, data });
      continue;
    }
    if ((Number(data?.to) || 0) > (Number(previous.data?.to) || 0)) {
      remove.push(previous.name);
      removedData.push(previous.data);
      remap.set(previous.name.replace(/\.json$/, ''), name.replace(/\.json$/, ''));
      keep.set(signature, { name, data });
    } else {
      remove.push(name);
      removedData.push(data);
      remap.set(name.replace(/\.json$/, ''), previous.name.replace(/\.json$/, ''));
    }
  }
  for (const name of remove) {
    await fs.rm(path.join(dir, name), { force: true });
  }
  if (remap.size > 0) directorService?.remapArchives(remap);
  // 副本删了，副本里的事务也删；保留那一份里也有的事务不能重复算。
  if (removedData.length > 0) {
    const txKey = ledgerKey;
    const keptKeys = new Set();
    for (const { data } of keep.values()) {
      for (const entry of Array.isArray(data?.transactions) ? data.transactions : []) {
        keptKeys.add(txKey(entry));
      }
    }
    const doomed = removedData.flatMap((data) =>
      Array.isArray(data?.transactions) ? data.transactions : [],
    );
    const tx = doomed.filter((entry) => !keptKeys.has(txKey(entry)));
    if (tx.length > 0) await directorService?.forgetLedger(tx).catch(() => undefined);
  }
  const index = await readHistoryIndex();
  for (const name of remove) index.delete(name.replace(/\.json$/, ''));
  const ledger = Array.isArray(directorService?.ledger) ? directorService.ledger : [];
  for (const { name, data } of keep.values()) {
    const id = name.replace(/\.json$/, '');
    if (!index.has(id)) index.set(id, historyItemFor(data, id, ledger));
  }
  await writeHistoryIndex(index);
  return { ok: true, removed: remove.length, kept: keep.size };
}

/**
 * 给「按上下文分段」准备向量。用的是知识库配置的 embedding 模型；
 * 没配置、服务不可用、超时，或者这个模型本身分不开中文话题（比如部分
 * 英文模型）时返回 null，让切段退回本地词频向量。清空不能因为向量服务卡住。
 */
const TOPIC_PROBES = [
  '帮我把项目周报整理一下',
  '把周报整理成两页并导出到文件',
  '整理项目周报',
  '下周团建去哪里吃饭',
];

/** 留档切段最多等向量服务这么久；超过就用本地词频，清空不能卡住。 */
const TOPIC_VECTOR_TIMEOUT_MS = 1500;
/** 太长的对话不再做向量切段：请求量和等待时间都不划算，词频兜底足够。 */
const TOPIC_VECTOR_MAX_MESSAGES = 400;

async function directorTopicVectors(messages) {
  if (process.env.EZNESS_DISABLE_MEMORY_VECTORS === '1') return null;
  if (messages.length > TOPIC_VECTOR_MAX_MESSAGES) return null;
  const embedding = kb.config?.embedding;
  if (!embedding?.model) return null;
  const texts = messages.map((message) => String(message?.content ?? '').slice(0, 800));
  if (!texts.some((text) => text.trim())) return null;
  try {
    const vectors = await Promise.race([
      embedTexts([...texts, ...TOPIC_PROBES], embedding, { batchSize: 24 }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), TOPIC_VECTOR_TIMEOUT_MS);
        if (timer.unref) timer.unref();
      }),
    ]);
    if (!Array.isArray(vectors) || vectors.length !== texts.length + TOPIC_PROBES.length) {
      return null;
    }
    // 探针：相关的两句话应该明显比不相关的两句更近，否则这个模型不适合
    // 做中文话题切分，交给词频兜底。
    const dot = (a, b) => {
      let sum = 0;
      for (let i = 0; i < a.length; i += 1) sum += a[i] * b[i];
      return sum;
    };
    const offset = texts.length;
    const related = dot(vectors[offset], vectors[offset + 1]);
    const unrelated = dot(vectors[offset + 2], vectors[offset + 3]);
    if (related - unrelated < 0.08) return null;
    return vectors.slice(0, offset);
  } catch {
    return null;
  }
}

/**
 * 给每段存档起一个「名字」——像给文件夹命名，一眼能看出这段在做什么。
 * 优先让总监模型根据整段内容取名；模型不可用、超时或返回不合法时，
 * 退回把这段的用户请求拼起来。清空不能被模型卡住，所以整体只等 10 秒。
 * 返回值里的 model 表示这一批名字是不是模型取的，历史回填据此决定要不要落盘。
 */
async function directorArchiveTitles(clusters) {
  const fallback = clusters.map((cluster) => titleForCluster(cluster));
  const failed = {
    titles: fallback,
    summaries: clusters.map(() => ''),
    sources: fallback.map(() => 'content'),
  };
  if (!directorService || clusters.length === 0) return failed;
  const blocks = clusters.slice(0, 12).map((cluster, index) => {
    const lines = cluster
      .filter((message) => message?.role === 'user' || message?.role === 'assistant')
      .slice(0, 16)
      .map((message) => {
        const who = message.role === 'user' ? '用户' : '总监';
        const text = String(message?.content ?? '').replace(/\s+/g, ' ').slice(0, 260);
        return `${who}：${text}`;
      })
      .join('\n');
    return `【第 ${index + 1} 段】\n${lines}`;
  });
  if (!blocks.some((block) => block.length > 8)) return failed;
  try {
    const answer = await Promise.race([
      directorService.ask({
        system:
          '你是工作总监的助理。给每段对话取一个中文名字，像给文件夹起名：概括这段在做什么，让人一眼能看懂。' +
          '不超过 16 个字，用短名词短语，例如「周报整理与图表导出」「团建餐厅选址」「nginx 部署排错」。' +
          '不要引号、不要句号，不要写成「帮我…」这样的请求句。' +
          '同时写一句粗摘要：这段用户要什么、总监最后怎么处理、有没有未完成的约定，不超过 120 字，只陈述事实。' +
          '只输出 JSON。',
        user:
          '请只返回一个 JSON 对象 {"items": [{"index": 段号, "title": "名字", "summary": "粗摘要"}]}，每段一条。\n\n' +
          blocks.join('\n\n'),
        maxTokens: 800,
      }),
      new Promise((resolve) => {
        const timer = setTimeout(() => resolve(null), 10_000);
        if (timer.unref) timer.unref();
      }),
    ]);
    const parsed = directorService.parseJson(answer);
    // 兼容旧格式 {"titles":[...]} 和新格式 {"items":[...]}。
    const items = Array.isArray(parsed?.items)
      ? parsed.items
      : Array.isArray(parsed?.titles)
        ? parsed.titles
        : [];
    const result = [...fallback];
    const summaries = fallback.map(() => '');
    const sources = fallback.map(() => 'content');
    for (const [position, item] of items.entries()) {
      const index = typeof item === 'string' ? position : Number(item?.index) - 1;
      if (!Number.isInteger(index) || index < 0 || index >= result.length) continue;
      const raw = typeof item === 'string' ? item : item?.title;
      const title = String(raw ?? '')
        .replace(/^["'「」『』]+|["'「」『』。.!！]+$/g, '')
        .replace(/\s+/g, ' ')
        .trim();
      const summary = String(item?.summary ?? '')
        .replace(/\s+/g, ' ')
        .trim();
      if (!title && !summary) continue;
      if (title) {
        result[index] = title.length <= 24 ? title : `${title.slice(0, 24)}…`;
        sources[index] = 'model';
      }
      if (summary) summaries[index] = summary.length <= 240 ? summary : `${summary.slice(0, 240)}…`;
    }
    return { titles: result, summaries, sources };
  } catch {
    return failed;
  }
}

// 模型暂时不可用时，别每次打开历史都白等 10 秒；过几分钟再试。
let directorHistoryTitleRetryAt = 0;
let historyTitleJob = null;

/**
 * 后台把旧存档的名字换成模型取的名字。
 * 打开历史不再等模型：先把按内容拼出来的名字给你，这里整理完再推一条更新。
 */
async function upgradeHistoryTitles(sender, dir, keys) {
  if (keys.length === 0 || historyTitleJob) return;
  if (Date.now() < directorHistoryTitleRetryAt) return;
  historyTitleJob = (async () => {
    try {
      const batches = [];
      for (const key of keys.slice(0, 24)) {
        const file = path.join(dir, `${key}.json`);
        try {
          const data = JSON.parse(await fs.readFile(file, 'utf8'));
          const messages = Array.isArray(data?.messages) ? data.messages : [];
          if (messages.length > 0) batches.push({ key, file, data, messages });
        } catch {
          /* a torn archive is skipped */
        }
      }
      if (batches.length === 0) return;
      const naming = await directorArchiveTitles(batches.map((batch) => batch.messages));
      const index = await readHistoryIndex();
      const updates = [];
      for (const [position, batch] of batches.entries()) {
        const named = naming.sources[position] === 'model';
        const title = named ? naming.titles[position] : '';
        const summary = naming.summaries?.[position] ?? '';
        if (!title && !summary) continue;
        if (title) {
          batch.data.title = title;
          batch.data.titleSource = 'model';
          try {
            await fs.writeFile(batch.file, JSON.stringify(batch.data), 'utf8');
          } catch {
            continue;
          }
          const row = index.get(batch.key);
          if (row) {
            row.title = title;
            row.titleSource = 'model';
          }
          updates.push({ id: row?.id ?? batch.key, title, titleSource: 'model' });
        }
        // 模型写好的粗摘要回填到这条存档记忆里；标题也一起同步。
        if (summary || title) {
          directorService?.updateArchiveMemory(batch.key, {
            title: title || batch.data.title,
            summary,
          });
        }
      }
      if (updates.length > 0) {
        await writeHistoryIndex(index).catch(() => {});
        if (sender && !sender.isDestroyed?.()) {
          sender.send('director:history-changed', { updates });
        }
      }
      // 还有没整理完的，隔几分钟再试；都整理完了就不再触发。
      const remaining = batches.length - updates.length;
      if (remaining > 0) directorHistoryTitleRetryAt = Date.now() + 2 * 60 * 1000;
    } catch {
      directorHistoryTitleRetryAt = Date.now() + 5 * 60 * 1000;
    } finally {
      historyTitleJob = null;
    }
  })();
}

const directorClearInFlight = new Set();

ipcMain.handle('director:clear', async (event, request) => {
  const sessionId = String(request?.sessionId ?? '').trim();
  if (!sessionId) return { ok: false, error: '没有找到总监对话' };
  for (const requestId of agentRuns.keys()) {
    if (agentSnapshots.get(requestId)?.sessionId === sessionId) {
      return { ok: false, error: '总监正在回复，等这一轮结束再清空' };
    }
  }
  // 一次清空还没写完就被再点一次时，第二下直接忽略；否则同一段对话会被
  // 重复留档（历史上那些一模一样的存档就是这么来的）。
  if (directorClearInFlight.has(sessionId)) {
    return { ok: false, error: '清空还在进行中，稍等一下' };
  }
  directorClearInFlight.add(sessionId);
  try {
    const at = Date.now();
    const messages = Array.isArray(request?.messages) ? request.messages.slice(-4000) : [];
    let session = [];
    try {
      session = await new AgentSession({ dir: agentSessionDir(), sessionId }).load();
    } catch {
      /* no session file yet */
    }
    // 按上下文切段：不相关的话题各存一条，而不是把整段聊天揉成一坨。
    const vectors = await directorTopicVectors(messages);
    const clusters = clusterMessages(messages, vectors ? { vectors } : {});
    if (clusters.length === 0) clusters.push([]);
    const dir = directorHistoryDir();
    await fs.mkdir(dir, { recursive: true });
    const ids = [];
    const summaries = [];
    const ledger = Array.isArray(directorService?.ledger) ? directorService.ledger : [];
    // 先按内容拼一个能看懂的名字，清空立刻返回；模型取的好名字在后台补上。
    // 相邻两段在边界毫秒可能重叠；同一条事务只装进一个存档。
    const packed = new Set();
    for (const [index, cluster] of clusters.entries()) {
      const first = cluster[0];
      const last = cluster[cluster.length - 1];
      const id = `h-${at.toString(36)}-${index.toString(36)}-${Math.random()
        .toString(36)
        .slice(2, 6)}`;
      const from = Number(first?.createdAt) || at - (clusters.length - index) * 1000;
      // 这一段一直管到下一段开始前（段与段之间不留时间缝），最后一段管到清空这一刻，
      // 这样两段之间发生的验收/汇报也不会掉到两个存档外面。
      const nextAt = Number(clusters[index + 1]?.[0]?.createdAt) || 0;
      const to =
        index === clusters.length - 1
          ? at
          : nextAt > from
            ? nextAt - 1
            : from;
      // 一个存档就是一个文件夹：对话本身 + 这段时间里总监的事务。
      const transactions = transactionsInRange(ledger, from, to).filter((item) => {
        const key = `${item?.at}-${item?.kind}-${item?.taskId ?? ''}-${item?.text ?? ''}`;
        if (packed.has(key)) return false;
        packed.add(key);
        return true;
      });
      const entry = {
        id,
        at: Number(last?.createdAt) || from,
        from,
        to,
        title: titleForCluster(cluster),
        titleSource: 'content',
        count: cluster.length,
        messages: cluster,
        transactions,
        session: sessionForCluster(session, cluster),
      };
      await fs.writeFile(path.join(dir, `${id}.json`), JSON.stringify(entry), 'utf8');
      // 清空不等于失忆：给这段存档建一条带 archiveId 的粗记忆，之后
      // 匹配到就能顺着编号把原文完整读回来（director_recall）。
      const summary = summaryForCluster(cluster);
      if (summary) {
        directorService?.rememberArchive({
          archiveId: id,
          title: entry.title,
          summary,
          from,
          to,
          count: cluster.length,
        });
      }
      ids.push(id);
      summaries.push({
        id,
        at: entry.at,
        from: entry.from,
        to: entry.to,
        title: entry.title,
        titleSource: 'content',
        count: entry.count,
        transactionCount: transactions.length,
      });
    }
    try {
      const index = await readHistoryIndex();
      for (const summary of summaries) index.set(summary.id, summary);
      await writeHistoryIndex(index);
    } catch {
      /* the list can rebuild the index from files if this write fails */
    }
    // 名字和事务都在后台补；不挡清空，也不挡打开历史。
    void upgradeHistoryTitles(event?.sender, dir, ids);
    await AgentSession.remove(agentSessionDir(), sessionId);
    // 收件箱只留还没处理、带按钮的确认；已处理的和旧汇报一起清掉。
    // keep 由主进程给出，渲染进程据此决定对话里哪些卡片留下，避免本地状态滞后。
    const keep = directorService?.pruneForClear() ?? null;
    return { ok: true, id: ids[0], ids, keep };
  } catch (error) {
    return { ok: false, error: `清空失败：${error?.message || String(error)}` };
  } finally {
    directorClearInFlight.delete(sessionId);
  }
});

ipcMain.handle('director:history', async (event) => {
  const dir = directorHistoryDir();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return { ok: true, items: [] };
  }
  const files = names.filter((name) => name.endsWith('.json') && name !== 'index.json');
  if (files.length === 0) return { ok: true, items: [] };
  // 列表只看索引；索引缺的存档才去读一次原文补上，之后不再碰大文件。
  const index = await readHistoryIndex();
  const ledger = Array.isArray(directorService?.ledger) ? directorService.ledger : [];
  const items = [];
  const needTitle = [];
  let changed = false;
  for (const name of files) {
    const key = name.replace(/\.json$/, '');
    const cached = index.get(key);
    if (cached?.id) {
      items.push(cached);
      if (cached.titleSource !== 'model') needTitle.push(key);
      continue;
    }
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, name), 'utf8'));
      const item = historyItemFor(data, key, ledger);
      index.set(key, item);
      items.push(item);
      changed = true;
      if (item.titleSource !== 'model') needTitle.push(key);
    } catch {
      /* a torn archive is skipped, not fatal */
    }
  }
  // 磁盘上已经删掉的存档，索引里也清掉。
  const alive = new Set(files.map((name) => name.replace(/\.json$/, '')));
  for (const key of [...index.keys()]) {
    if (!alive.has(key)) {
      index.delete(key);
      changed = true;
    }
  }
  if (changed) await writeHistoryIndex(index).catch(() => {});
  items.sort((a, b) => b.at - a.at);
  // 打开历史不等模型：先把列表给你，名字整理完再推一条更新。
  void upgradeHistoryTitles(event?.sender, dir, needTitle);
  return { ok: true, items };
});

ipcMain.handle('director:history-dedupe', async () => {
  try {
    return await dedupeDirectorHistory();
  } catch (error) {
    return { ok: false, error: `清理失败：${error?.message || String(error)}` };
  }
});

ipcMain.handle('director:history-delete', async (_event, ids) => {
  try {
    return await deleteDirectorHistory(ids);
  } catch (error) {
    return { ok: false, error: `删除失败：${error?.message || String(error)}` };
  }
});

/**
 * 用户手选的对话存档删除：只动这几条，索引同步移除；不碰别的存档。
 */
async function deleteDirectorHistory(ids) {
  const wanted = (Array.isArray(ids) ? ids : [])
    .map((id) => String(id ?? '').trim())
    .filter(Boolean);
  if (wanted.length === 0) return { ok: false, error: '没有选中要删除的存档' };
  const dir = directorHistoryDir();
  const index = await readHistoryIndex();
  const removedIds = [];
  const doomedTx = [];
  // 存档里的事务快照跟着存档一起删；但同一段时间若还有别的存档保留着，
  // 事务可能属于那一份，先剔掉，别误删。
  const keepTx = new Set();
  const keepRanges = [];
  const txKey = ledgerKey;
  const sacrificial = new Set(wanted.filter((id) => /^[\w-]+$/.test(id)));
  let survivors = [];
  try {
    survivors = (await fs.readdir(dir))
      .filter((name) => name.endsWith('.json') && name !== 'index.json')
      .map((name) => name.replace(/\.json$/, ''))
      .filter((id) => !sacrificial.has(id));
  } catch {
    survivors = [];
  }
  for (const id of survivors) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
      for (const entry of Array.isArray(data?.transactions) ? data.transactions : []) {
        keepTx.add(txKey(entry));
      }
      const from = Number(data?.from) || 0;
      const to = Number(data?.to) || 0;
      if (from > 0 && to > 0) keepRanges.push([from, to]);
    } catch {
      /* a torn archive is skipped */
    }
  }
  // 删掉的最晚时间点。账本里早于它、又没有存档认领的条目都是遗留。
  let cutoff = 0;
  for (const id of wanted) {
    if (!/^[\w-]+$/.test(id)) continue;
    const file = path.join(dir, `${id}.json`);
    let data = null;
    try {
      data = JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* already gone */
    }
    if (data) {
      cutoff = Math.max(cutoff, Number(data.to) || 0);
      if (Array.isArray(data.transactions)) {
        for (const entry of data.transactions) cutoff = Math.max(cutoff, Number(entry?.at) || 0);
        doomedTx.push(...data.transactions);
      } else if (Number(data.from) || Number(data.to)) {
        // 很老的存档没有事务快照：按它自己的时间范围补一次。
        const ledger = Array.isArray(directorService?.ledger) ? directorService.ledger : [];
        doomedTx.push(
          ...transactionsInRange(ledger, Number(data.from) || 0, Number(data.to) || 0),
        );
      }
    }
    try {
      await fs.rm(file, { force: true });
    } catch {
      continue;
    }
    index.delete(id);
    removedIds.push(id);
  }
  let removedTransactions = 0;
  if (removedIds.length > 0) {
    await writeHistoryIndex(index).catch(() => {});
    // 存档就是这段历史的记忆：你在对话历史里删掉它，总监也随之忘掉。
    directorService?.forgetArchives(removedIds);
    const tx = doomedTx.filter((entry) => !keepTx.has(txKey(entry)));
    if (tx.length > 0) removedTransactions = await directorService?.forgetLedger(tx) ?? 0;
    // 老存档（或以前“清理重复”删掉的副本）没有把事务带走，会一直留在
    // “总监事务”里。删档时顺手扫一遍：删掉的最晚时间点之前、又没有任何
    // 存活存档认领的条目，一并清掉；之后的当前事务不动。
    if (cutoff > 0) {
      const orphans = orphanLedgerEntries(directorService?.ledger, {
        cutoff,
        keepKeys: keepTx,
        keepRanges,
      });
      if (orphans.length > 0) {
        removedTransactions += (await directorService?.forgetLedger(orphans)) ?? 0;
      }
    }
  }
  return { ok: true, removed: removedIds.length, transactions: removedTransactions };
}

/**
 * 一次性清理请求：存档已经删了、但事务还留在账本里的历史遗留。
 * `<数据根>/agent/director/ledger-purge.json` 里写 {"before": 时间戳}，
 * 启动时删掉该时间点及之前的事务，然后删掉请求文件。只删一次。
 */
async function applyPendingLedgerPurge() {
  if (!directorService) return 0;
  const file = path.join(directorDir(), 'ledger-purge.json');
  let request = null;
  try {
    request = JSON.parse(await fs.readFile(file, 'utf8'));
  } catch {
    return 0;
  }
  const before = Number(request?.before) || 0;
  const doomed =
    before > 0
      ? directorService.ledger.filter((entry) => Number(entry?.at) <= before)
      : [];
  const removed = doomed.length > 0 ? await directorService.forgetLedger(doomed) : 0;
  await fs.rm(file, { force: true }).catch(() => {});
  return removed;
}

/**
 * 本次升级之前留下的存档没有对应记忆：启动时补一遍粗索引，让旧历史
 * 也能被匹配、被 director_recall 读回。只读存档、只写 memory.json。
 */
async function backfillArchiveMemory() {
  if (!directorService) return;
  const dir = directorHistoryDir();
  let names = [];
  try {
    names = await fs.readdir(dir);
  } catch {
    return;
  }
  const linked = new Set(
    (Array.isArray(directorService.memory) ? directorService.memory : [])
      .filter((entry) => entry?.archiveId)
      .map((entry) => entry.archiveId),
  );
  const pending = names
    .filter((name) => name.endsWith('.json') && name !== 'index.json')
    .map((name) => name.replace(/\.json$/, ''))
    .filter((id) => !linked.has(id))
    .slice(0, 60);
  for (const id of pending) {
    try {
      const data = JSON.parse(await fs.readFile(path.join(dir, `${id}.json`), 'utf8'));
      const messages = Array.isArray(data?.messages) ? data.messages : [];
      const summary = summaryForCluster(messages);
      if (!summary) continue;
      directorService.rememberArchive({
        archiveId: id,
        title: data?.title || titleForCluster(messages),
        summary,
        from: Number(data?.from) || 0,
        to: Number(data?.to) || 0,
        count: messages.length,
      });
    } catch {
      /* a torn archive is skipped */
    }
  }
}

ipcMain.handle('director:history-get', async (_event, id) => {
  const safe = String(id ?? '').replace(/[^a-zA-Z0-9_-]/g, '');
  if (!safe) return { ok: false, error: '记录不存在' };
  try {
    const data = JSON.parse(await fs.readFile(path.join(directorHistoryDir(), `${safe}.json`), 'utf8'));
    return { ok: true, entry: data };
  } catch {
    return { ok: false, error: '记录不存在或已损坏' };
  }
});

ipcMain.handle('director:inspect', async (_event, payload) => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.inspect(payload?.taskId, payload?.part ?? 'overview');
});

ipcMain.handle('director:instruction-ack', (_event, payload) => {
  if (!directorService) return { ok: false };
  return directorService.instructionAck(payload ?? {});
});

// 界面按总监的派工单建好了员工任务：把 taskId 交回来，转为普通指令。
ipcMain.handle('director:spawn-ack', (_event, payload) => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.spawnAck(payload ?? {});
});

// 界面执行完总监的任务操作（删除/导出）之后回执。
ipcMain.handle('director:task-ack', (_event, payload) => {
  if (!directorService) return { ok: false, error: '工作总监还没有启动' };
  return directorService.taskAck(payload ?? {});
});

// 任务还没开始就卡住了（例如没有可用模型）：让总监把换模型的选择交给用户。
ipcMain.handle('director:run-blocked', (_event, payload) => {
  if (!directorService) return { ok: false };
  return directorService.offerModelChoice({
    taskId: payload?.taskId ?? '',
    reason: payload?.reason ?? '',
  });
});

ipcMain.handle('director:user-message', (_event, payload) => {
  directorService?.noteUserMessage(payload ?? {});
  return { ok: true };
});

ipcMain.handle('director:typing', (_event, active) => {
  directorService?.noteTyping(Boolean(active));
  return { ok: true };
});

ipcMain.handle('session:export', async (_event, payload) => {
  const title = String(payload?.title || '对话');
  const markdown = String(payload?.markdown ?? '');
  const safe = title.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '对话';

  // 总监发起的导出：写进任务自己的工作空间，不弹保存框。远程空间或路径
  // 不可用时统一落到数据根的 exports/，再作为文件卡片发给用户。
  // folder 传了（哪怕是空串）就表示“别弹保存框”：空串或不可用的路径统一落到 exports/。
  const wantsFolder = typeof payload?.folder === 'string';
  const folder = String(payload?.folder ?? '').trim();
  if (wantsFolder) {
    try {
      let target = folder;
      try {
        const info = await fs.stat(target);
        if (!info.isDirectory()) target = '';
      } catch {
        target = '';
      }
      if (!target) target = path.join(storage.root, 'exports');
      await fs.mkdir(target, { recursive: true });
      let file = path.join(target, `${safe}.md`);
      for (let n = 2; n < 100; n += 1) {
        const exists = await fs
          .stat(file)
          .then(() => true)
          .catch(() => false);
        if (!exists) break;
        file = path.join(target, `${safe} (${n}).md`);
      }
      await fs.writeFile(file, markdown, 'utf8');
      return { ok: true, path: file };
    } catch (error) {
      return { ok: false, error: error?.message || String(error) };
    }
  }

  try {
    const result = await saveDialog({
      title: '导出对话',
      defaultPath: path.join(app.getPath('documents'), `${safe}.md`),
      filters: [{ name: 'Markdown', extensions: ['md'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    await fs.writeFile(result.filePath, markdown, 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

/* ------------------------------------------------------------------
   Prompt templates
   The library lives at <storage root>/prompts.json. Export writes one
   template per file (with a small envelope so imports can tell what it is).
   ------------------------------------------------------------------ */

function promptsFile() {
  return storage.paths.prompts;
}

async function readPromptArray(file) {
  try {
    const data = JSON.parse(await fs.readFile(file, 'utf8'));
    return Array.isArray(data) ? data : null;
  } catch {
    return null;
  }
}

ipcMain.handle('prompts:load', async () => {
  // 提示词库只认用户自己的 prompts.json：没有就是空的，不塞任何出厂模板，
  // 也不塞示例。null 表示还没建过库，页面会停在空态。
  return readPromptArray(promptsFile());
});

ipcMain.handle('prompts:save', async (_event, data) => {
  if (!Array.isArray(data)) return false;
  const file = promptsFile();
  await fs.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(data, null, 2), 'utf8');
  await fs.rename(temp, file);
  return true;
});

ipcMain.handle('prompts:export', async (_event, payload) => {
  const template = payload?.template;
  if (!template || typeof template !== 'object') return { ok: false, error: '没有可导出的模板' };
  const name = String(template.name || template.nameEn || '提示词模板');
  const safe = name.replace(/[\\/:*?"<>|]/g, '_').slice(0, 60) || '提示词模板';

  try {
    const result = await saveDialog({
      title: '导出提示词模板',
      defaultPath: path.join(app.getPath('documents'), `${safe}.prompt.json`),
      filters: [{ name: '提示词模板', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    const body = { format: 'ezness.prompt', version: 1, template };
    await fs.writeFile(result.filePath, JSON.stringify(body, null, 2), 'utf8');
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('prompts:import', async () => {
  try {
    const result = await openDialog({
      title: '导入提示词模板',
      properties: ['openFile'],
      filters: [{ name: '提示词模板', extensions: ['json'] }],
    });
    if (result.canceled || !result.filePaths[0]) return { ok: false, canceled: true };

    const raw = await fs.readFile(result.filePaths[0], 'utf8');
    return { ok: true, data: JSON.parse(raw), path: result.filePaths[0] };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('web:search', (_event, query, entries) => webSearch(query, { entries }));

ipcMain.handle('clipboard:write', (_event, text) => {
  clipboard.writeText(String(text ?? ''));
  return true;
});

/* ------------------------------------------------------------------
   Voice input — Silero VAD + SenseVoiceSmall, both local
   ------------------------------------------------------------------ */

let voiceDownload = null;

ipcMain.handle('voice:status', () => voiceModelStatus(storage.root));

ipcMain.handle('voice:download', async () => {
  if (voiceDownload) return { ok: false, error: '模型正在下载中' };
  const controller = new AbortController();
  voiceDownload = controller;
  try {
    const result = await downloadMissing(storage.root, {
      signal: controller.signal,
      onProgress: (payload) => broadcast('voice:event', { type: 'download', ...payload }),
    });
    return { ok: true, status: result };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  } finally {
    voiceDownload = null;
  }
});

ipcMain.handle('voice:cancel-download', () => {
  voiceDownload?.abort();
  return true;
});

ipcMain.handle('voice:start', async () => {
  if (!voice) return { ok: false, error: '语音模块还没准备好' };
  try {
    return await voice.start();
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('voice:chunk', (_event, payload) => {
  if (!voice) return false;
  let buffer = null;
  if (payload instanceof ArrayBuffer) buffer = payload;
  else if (ArrayBuffer.isView(payload)) {
    buffer = payload.buffer.slice(payload.byteOffset, payload.byteOffset + payload.byteLength);
  }
  if (!buffer || buffer.byteLength < 2) return false;
  return voice.push(buffer);
});

ipcMain.handle('voice:stop', () => voice?.stop() ?? { ok: true });
ipcMain.handle('voice:cancel', () => voice?.cancel() ?? { ok: true });

/* ------------------------------------------------------------------
   OCR — PaddleOCR PP-OCRv5, local inference
   ------------------------------------------------------------------ */

ipcMain.handle('ocr:status', () => ocrModels.status());

/* ------------------------------------------------------------------
   Knowledge base
   ------------------------------------------------------------------ */

function openDialog(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showOpenDialog(mainWindow, options)
    : dialog.showOpenDialog(options);
}

function saveDialog(options) {
  return mainWindow && !mainWindow.isDestroyed()
    ? dialog.showSaveDialog(mainWindow, options)
    : dialog.showSaveDialog(options);
}

async function readJsonFirst(files) {
  for (const file of files) {
    try {
      return JSON.parse(await fs.readFile(file, 'utf8'));
    } catch {
      /* try the next location */
    }
  }
  return null;
}

async function restoreKb() {
  const targetRoot = storage.paths.rag;
  const stored = await readJsonFirst([
    storage.paths.kbConfig,
    path.join(app.getPath('userData'), 'kb-config.json'),
  ]);

  // Prefer the unified location once it has a library; before the first
  // migration, follow the legacy config so the library stays visible.
  let storageRoot = targetRoot;
  if (!fsSync.existsSync(path.join(targetRoot, 'kb.sqlite')) && stored?.storageRoot) {
    storageRoot = path.resolve(String(stored.storageRoot));
  }

  try {
    kb.configure({ ...(stored ?? {}), storageRoot });
  } catch (error) {
    console.error('[Ezness] 知识库初始化失败：', error);
  }
}

async function persistKb() {
  try {
    const file = storage.paths.kbConfig;
    await fs.mkdir(path.dirname(file), { recursive: true });
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(kb.config, null, 2), 'utf8');
    await fs.rename(temp, file);
  } catch (error) {
    console.error('[Ezness] 保存知识库配置失败：', error);
  }
}

ipcMain.handle('kb:snapshot', () => ({ ...kb.snapshot(), config: kb.config }));

ipcMain.handle('kb:set-config', async (_event, patch) => {
  kb.configure(patch ?? {});
  await persistKb();
  return { ...kb.snapshot(), config: kb.config };
});

ipcMain.handle('kb:pick-files', async () => {
  const result = await openDialog({
    title: '选择要加入知识库的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '支持的文档',
        extensions: [
          'pdf', 'docx', 'xlsx', 'xlsm',
          'pptx', 'pptm', 'ppsx', 'potx',
          'txt', 'md', 'markdown', 'csv', 'json', 'html', 'htm',
        ],
      },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('kb:add-files', (_event, filePaths, categoryId) => kb.enqueue(filePaths ?? [], categoryId));
ipcMain.handle('kb:create-category', (_event, name, kind, includes) =>
  kb.createCategory(name, kind, includes),
);
ipcMain.handle('kb:rename-category', (_event, id, name) => kb.renameCategory(id, name));
ipcMain.handle('kb:set-category-includes', (_event, id, includes) => kb.setCategoryIncludes(id, includes));
ipcMain.handle('kb:delete-category', (_event, id) => kb.deleteCategory(id));
ipcMain.handle('kb:reorder-categories', (_event, ids) => kb.reorderCategories(ids));
ipcMain.handle('kb:move-document', (_event, docId, categoryId) => kb.moveDocument(docId, categoryId));
ipcMain.handle('kb:delete-document', (_event, docId) => kb.deleteDocument(docId));

// "Download" for a knowledge-base file: the ingest step keeps a byte-identical
// copy of the original, so this just saves it under its original name.
/** Save one stored original through a save dialog. Shared by both libraries. */
async function exportKbDocument(store, docId) {
  try {
    const doc = store?.getDocument(docId);
    if (!doc?.stored_path) return { ok: false, error: '找不到这个文件' };

    try {
      await fs.access(doc.stored_path);
    } catch {
      return { ok: false, error: '原始文件已不在知识库目录里了' };
    }

    const safe = String(doc.name || path.basename(doc.stored_path))
      .replace(/[\\/:*?"<>|]/g, '_')
      .slice(0, 80);
    const result = await saveDialog({
      title: '下载原文件',
      defaultPath: path.join(app.getPath('downloads'), safe),
      buttonLabel: '下载',
    });
    if (result.canceled || !result.filePath) return { ok: false, canceled: true };

    await fs.copyFile(doc.stored_path, result.filePath);
    return { ok: true, path: result.filePath };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
}

ipcMain.handle('kb:export-document', (_event, docId) => exportKbDocument(kb.store, docId));

ipcMain.handle('kb:search', (_event, query, options) => kb.search(query, options));

/* ------------------------------------------------------------------
   Conversation warehouse
   ------------------------------------------------------------------ */

async function restoreWarehouse() {
  const targetRoot = storage.paths.warehouse;
  let root = targetRoot;

  // Before the first migration the warehouse still has its own config (and
  // default folder) in userData; follow it so existing files stay listed.
  if (!fsSync.existsSync(path.join(targetRoot, 'warehouse.json'))) {
    const legacy = await readJsonFirst([
      path.join(app.getPath('userData'), 'warehouse-config.json'),
    ]);
    const legacyRoot = legacy?.root
      ? path.resolve(String(legacy.root))
      : path.join(app.getPath('userData'), 'warehouse');
    if (
      fsSync.existsSync(path.join(legacyRoot, 'warehouse.json')) ||
      fsSync.existsSync(path.join(legacyRoot, 'files'))
    ) {
      root = legacyRoot;
    }
  }

  warehouse = new Warehouse(root);
  try {
    await warehouse.load();
  } catch (error) {
    console.error('[Ezness] 仓库初始化失败：', error);
  }
}

ipcMain.handle('warehouse:snapshot', async () => {
  await warehouse.load();
  return warehouse.snapshot();
});

ipcMain.handle('warehouse:pick-files', async () => {
  const result = await openDialog({
    title: '选择要放进仓库的文件',
    properties: ['openFile', 'multiSelections'],
    filters: [
      {
        name: '图片与文档',
        extensions: [
          'png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg',
          'pdf', 'docx', 'xlsx',
          'pptx', 'pptm', 'ppsx', 'potx',
          'txt', 'md', 'csv', 'json', 'html',
        ],
      },
      { name: '全部文件', extensions: ['*'] },
    ],
  });
  return result.canceled ? [] : result.filePaths;
});

ipcMain.handle('workspace:pick-folder', async () => {
  const result = await openDialog({
    title: '选择工作空间文件夹',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] ?? null;
});

// Workspaces, their tasks and transcripts live in <data root>/workspaces.json.
// The renderer debounces saves; writes go through a temp file so a crash
// mid-write cannot leave a half-written JSON behind.
function workspaceStateFile() {
  return path.join(storage.root, 'workspaces.json');
}

ipcMain.handle('workspace:load', async () => {
  try {
    const data = JSON.parse(await fs.readFile(workspaceStateFile(), 'utf8'));
    rememberWorkspaceRoots(data);
    return data;
  } catch {
    return null;
  }
});

ipcMain.handle('workspace:save', async (_event, data) => {
  // Remember roots first: the renderer can open the file tree right after
  // creating a workspace, before this write lands on disk.
  rememberWorkspaceRoots(data);
  try {
    const file = workspaceStateFile();
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data), 'utf8');
    await fs.rename(temp, file);
    // Credentials for workspaces that were deleted do not outlive them.
    const ids = (Array.isArray(data?.workspaces) ? data.workspaces : [])
      .filter((workspace) => workspace?.kind === 'remote')
      .map((workspace) => workspace.id);
    await remotes().pruneSecrets(ids).catch(() => undefined);
    remotes().closeMissing(ids);
    return true;
  } catch (error) {
    console.error('[Ezness] 工作空间保存失败：', error);
    return false;
  }
});

/* ------------------------------------------------------------------ */
/* 远程工作空间                                                         */
/* ------------------------------------------------------------------ */

ipcMain.handle('workspace:remote-connect', async (_event, request) => {
  try {
    const info = await remotes().connect(request?.config ?? request ?? {});
    return { ok: true, ...info };
  } catch (error) {
    return { ok: false, code: error?.code ?? '', error: error?.message || String(error) };
  }
});

ipcMain.handle('workspace:remote-list', async (_event, request) => {
  try {
    const result = await remotes().list(request?.sessionId, request?.path);
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, code: error?.code ?? '', error: error?.message || String(error) };
  }
});

ipcMain.handle('workspace:remote-open', async (_event, request) => {
  try {
    const result = await remotes().open({
      sessionId: request?.sessionId,
      dir: request?.path,
      workspaceId: request?.workspaceId,
    });
    return { ok: true, ...result };
  } catch (error) {
    return { ok: false, code: error?.code ?? '', error: error?.message || String(error) };
  }
});

ipcMain.handle('workspace:remote-close', async (_event, request) => {
  await remotes().close(request?.sessionId).catch(() => undefined);
  return { ok: true };
});

ipcMain.handle('workspace:pick-key-file', async () => {
  const result = await openDialog({
    title: '选择私钥文件',
    properties: ['openFile'],
    filters: [{ name: '私钥', extensions: ['*'] }],
  });
  return result.canceled ? '' : String(result.filePaths?.[0] ?? '');
});

/* ------------------------------------------------------------------ */
/* 对话（普通会话）                                                      */
/* ------------------------------------------------------------------ */

/* ------------------------------------------------------------------ */
/* 对话（普通会话）                                                      */
/* ------------------------------------------------------------------ */

/**
 * 对话 sessions and their transcripts live in <data root>/chats.json. This is
 * its own file rather than a field in workspaces.json so a broken workspace
 * file cannot take the normal conversations with it. Writes go through a temp
 * file, same as workspaces: a crash mid-write must not truncate history.
 */
function chatStateFile() {
  return path.join(storage.root, 'chats.json');
}

ipcMain.handle('chats:load', async () => {
  try {
    const data = JSON.parse(await fs.readFile(chatStateFile(), 'utf8'));
    // A damaged file should read as "nothing saved yet", not crash the page.
    if (!data || typeof data !== 'object') return null;
    return {
      sessions: Array.isArray(data.sessions) ? data.sessions : [],
      messages: Array.isArray(data.messages) ? data.messages : [],
      activeId: typeof data.activeId === 'string' ? data.activeId : null,
    };
  } catch {
    return null;
  }
});

ipcMain.handle('chats:save', async (_event, data) => {
  try {
    const file = chatStateFile();
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, JSON.stringify(data), 'utf8');
    await fs.rename(temp, file);
    return true;
  } catch (error) {
    console.error('[Ezness] 对话保存失败：', error);
    return false;
  }
});

/* ------------------------------------------------------------------ */
/* 工作空间文件树                                                       */
/* ------------------------------------------------------------------ */

/**
 * workspaceId → { root, isScratch }. Only workspaces the renderer saved are
 * readable, so the renderer can never point the tree at an arbitrary folder.
 * 功能编辑 workspaces have no user folder; their tree is the hidden scratch
 * directory the category's tools run in.
 */
const workspaceRoots = new Map();

function rememberWorkspaceRoots(state) {
  const list = Array.isArray(state?.workspaces) ? state.workspaces : [];
  workspaceRoots.clear();
  for (const workspace of list) {
    const id = String(workspace?.id ?? '');
    if (!id) continue;
    if (workspace.kind === 'tool-editor') {
      workspaceRoots.set(id, {
        root: editorScratchDir({ id: workspace.categoryId }),
        isScratch: true,
      });
    } else if (workspace.kind === 'agent-editor') {
      workspaceRoots.set(id, {
        root: agentEditorScratchDir(workspace.agentId),
        isScratch: true,
      });
    } else if (workspace.kind === 'remote' && workspace.remote?.root) {
      workspaceRoots.set(id, {
        root: String(workspace.remote.root),
        isScratch: false,
        remote: {
          host: String(workspace.remote.host ?? ''),
          port: Number(workspace.remote.port) || 22,
          username: String(workspace.remote.username ?? ''),
          root: String(workspace.remote.root),
          fingerprint: String(workspace.remote.fingerprint ?? ''),
        },
      });
    } else if (typeof workspace.path === 'string' && workspace.path.trim()) {
      workspaceRoots.set(id, { root: workspace.path, isScratch: false });
    }
  }
}

async function workspaceRootInfo(workspaceId) {
  const id = String(workspaceId ?? '');
  if (workspaceRoots.has(id)) return workspaceRoots.get(id);
  try {
    const saved = JSON.parse(await fs.readFile(workspaceStateFile(), 'utf8'));
    rememberWorkspaceRoots(saved);
  } catch {
    /* nothing saved yet */
  }
  return workspaceRoots.get(id) ?? null;
}

function describeFsError(error) {
  if (error?.code === 'ENOENT') return '文件夹不存在，或已经被移动。';
  if (error?.code === 'EACCES' || error?.code === 'EPERM') return '没有权限修改这个位置。';
  if (error?.code === 'EISDIR') return '这是一个文件夹。';
  if (error?.code === 'ENOTDIR') return '目标位置不是文件夹。';
  if (error?.code === 'EEXIST' || error?.code === 'ENOTEMPTY') return '已经有同名文件或文件夹。';
  if (error?.code === 'EBUSY') return '这个项目正在被其他程序使用。';
  if (error?.code === 'path_escape') return error.message;
  return error?.message ? String(error.message) : '操作失败。';
}

/** Windows file names: one path segment, no reserved characters or devices. */
function validateEntryName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { error: '名称不能为空。' };
  if (name === '.' || name === '..') return { error: '这个名称不能用。' };
  if (/[<>:"/\\|?*\u0000-\u001F]/.test(name)) {
    return { error: '名称里不能包含 < > : " / \\ | ? * 这些字符。' };
  }
  if (/[. ]$/.test(name)) return { error: '名称不能以空格或句点结尾。' };
  if (/^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\..*)?$/i.test(name)) {
    return { error: '这是 Windows 的保留名称，请换一个。' };
  }
  if (name.length > 255) return { error: '名称太长。' };
  return { name };
}

function toWorkspacePath(root, target) {
  return path.relative(root, target).split(path.sep).join('/');
}

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

/** Resolve a relative entry path and keep it inside the workspace root. */
async function resolveWorkspaceTarget(workspaceId, relativePath) {
  const info = await workspaceRootInfo(workspaceId);
  if (!info) throw new Error('找不到这个工作空间，请重新选择一个文件夹。');
  if (info.remote) throw new Error('这是远程工作空间。');
  if (info.isScratch) await fs.mkdir(info.root, { recursive: true });
  const root = await fs.realpath(info.root);
  const target = await resolveInside(root, relativePath || '.');
  return { root, target };
}

/** The remote adapter for this workspace, or null when it is a local folder. */
async function remoteWorkspaceFs(workspaceId) {
  const info = await workspaceRootInfo(workspaceId);
  if (!info?.remote) return null;
  return remotes().fsFor(String(workspaceId ?? ''), info.remote);
}

const TREE_LIMIT = 500;
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 12 * 1024 * 1024;
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

/**
 * Rows read from the files the workspace contains (CSV/TSV, Excel, SQLite,
 * JSON, Markdown tables). The visualization dialog feeds these to the model so
 * a pile of generated data is charted by its numbers, not by its file count.
 */
ipcMain.handle('workspace:viz-tables', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return { ok: false, error: '远程工作空间暂不支持读取表格内容。' };
    const { root } = await resolveWorkspaceTarget(request?.workspaceId);
    const tables = await vizFiles.collectWorkspaceTables(root);
    return { ok: true, tables };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:viz-table-rows', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return { ok: false, error: '远程工作空间暂不支持展开表格。' };
    const { root } = await resolveWorkspaceTarget(request?.workspaceId);
    const table = await vizFiles.readTableRows(root, request?.refs);
    if (!table) return { ok: false, error: '读不到这张表的原始文件了，可能已经被删除。' };
    return { ok: true, ...table };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:tree', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.tree(remoteFs, request ?? {});
    const { root, target } = await resolveWorkspaceTarget(request?.workspaceId, request?.dir);
    const dirents = await fs.readdir(target, { withFileTypes: true });
    const base = path.relative(root, target).split(path.sep).join('/');
    const entries = [];
    let truncated = false;
    for (const dirent of dirents) {
      if (entries.length >= TREE_LIMIT) {
        truncated = true;
        break;
      }
      let isDir = dirent.isDirectory();
      if (dirent.isSymbolicLink()) {
        try {
          isDir = (await fs.stat(path.join(target, dirent.name))).isDirectory();
        } catch {
          isDir = false;
        }
      }
      entries.push({
        name: dirent.name,
        path: base ? `${base}/${dirent.name}` : dirent.name,
        isDir,
      });
    }
    entries.sort(
      (a, b) =>
        Number(b.isDir) - Number(a.isDir) ||
        a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
    );
    return { ok: true, root, dir: base, entries, truncated };
  } catch (error) {
    return { ok: false, code: error?.code ?? '', error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:read-file', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.readFile(remoteFs, request ?? {});
    const { root, target } = await resolveWorkspaceTarget(request?.workspaceId, request?.path);
    const stat = await fs.stat(target);
    const name = path.basename(target);
    const relativePath = path.relative(root, target).split(path.sep).join('/');
    if (stat.isDirectory()) return { ok: false, error: '这是一个文件夹，不能预览。' };

    const ext = path.extname(target).slice(1).toLowerCase();
    const mime = IMAGE_MIME[ext];
    if (mime) {
      if (stat.size > IMAGE_PREVIEW_LIMIT) {
        return { ok: false, error: `图片太大（${formatBytes(stat.size)}），无法在应用内预览。` };
      }
      const data = await fs.readFile(target);
      return {
        ok: true,
        kind: 'image',
        name,
        path: relativePath,
        size: stat.size,
        mtime: stat.mtimeMs,
        mime,
        dataUrl: `data:${mime};base64,${data.toString('base64')}`,
      };
    }

    const length = Math.min(stat.size, TEXT_PREVIEW_LIMIT);
    const buffer = Buffer.alloc(length);
    const handle = await fs.open(target, 'r');
    try {
      await handle.read(buffer, 0, length, 0);
    } finally {
      await handle.close();
    }

    // A NUL byte in the first few KB is the usual sign of a binary file; text
    // files never carry one, so preview them as plain text.
    if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
      return { ok: true, kind: 'binary', name, path: relativePath, size: stat.size, mtime: stat.mtimeMs };
    }

    return {
      ok: true,
      kind: 'text',
      name,
      path: relativePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      content: buffer.toString('utf8').replace(/^\uFEFF/, ''),
      truncated: stat.size > TEXT_PREVIEW_LIMIT,
    };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:open-file', async (_event, request) => {
  try {
    if (await remoteWorkspaceFs(request?.workspaceId)) {
      return { ok: false, error: '这是远程文件，不能直接用本机程序打开；请在应用内预览。' };
    }
    const { target } = await resolveWorkspaceTarget(request?.workspaceId, request?.path);
    const error = await fileOpener.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:reveal', async (_event, request) => {
  try {
    if (await remoteWorkspaceFs(request?.workspaceId)) {
      return { ok: false, error: '这是远程工作空间，文件不在本机上。' };
    }
    const { target } = await resolveWorkspaceTarget(request?.workspaceId, request?.path);
    const stat = await fs.stat(target);
    if (!stat.isDirectory()) {
      fileOpener.revealPath(target);
      return { ok: true };
    }
    const error = await fileOpener.openPath(target);
    return error ? { ok: false, error } : { ok: true };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:create-folder', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.createFolder(remoteFs, request ?? {});
    const { root, target: parent } = await resolveWorkspaceTarget(
      request?.workspaceId,
      request?.parent,
    );
    const checked = validateEntryName(request?.name);
    if (checked.error) return { ok: false, error: checked.error };
    if (!(await fs.stat(parent)).isDirectory()) {
      return { ok: false, error: '只能在文件夹里新建文件夹。' };
    }
    const target = path.join(parent, checked.name);
    await fs.mkdir(target);
    return { ok: true, path: toWorkspacePath(root, target) };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:move', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.move(remoteFs, request ?? {});
    const fromRequest = String(request?.from ?? '').trim();
    if (!fromRequest) return { ok: false, error: '没有选中要移动的项目。' };
    const { root, target: from } = await resolveWorkspaceTarget(
      request?.workspaceId,
      fromRequest,
    );
    if (from === root) return { ok: false, error: '不能移动工作空间的根目录。' };

    const { target: toDir } = await resolveWorkspaceTarget(
      request?.workspaceId,
      request?.toDir,
    );
    if (!(await fs.stat(toDir)).isDirectory()) {
      return { ok: false, error: '只能移动到文件夹里。' };
    }
    if (path.dirname(from) === toDir) {
      return { ok: true, path: toWorkspacePath(root, from) };
    }

    const fromStat = await fs.stat(from);
    if (fromStat.isDirectory()) {
      const relativeToSource = path.relative(from, toDir);
      if (
        relativeToSource === '' ||
        (!relativeToSource.startsWith('..') && !path.isAbsolute(relativeToSource))
      ) {
        return { ok: false, error: '不能把文件夹移动到它自己或它的子文件夹里。' };
      }
    }

    const target = path.join(toDir, path.basename(from));
    if (target === from) return { ok: true, path: toWorkspacePath(root, from) };
    try {
      await fs.access(target);
      return { ok: false, error: '目标文件夹里已经有同名项目。' };
    } catch {
      /* target is free */
    }
    await fs.rename(from, target);
    return { ok: true, path: toWorkspacePath(root, target) };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:rename', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.rename(remoteFs, request ?? {});
    const { root, target: from } = await resolveWorkspaceTarget(
      request?.workspaceId,
      request?.path,
    );
    if (from === root) return { ok: false, error: '不能重命名工作空间的根目录。' };
    const checked = validateEntryName(request?.name);
    if (checked.error) return { ok: false, error: checked.error };

    const parent = path.dirname(from);
    const target = path.join(parent, checked.name);
    if (target === from) return { ok: true, path: toWorkspacePath(root, from) };

    // Windows paths are case-insensitive; a case-only rename is not a conflict.
    const caseOnly = process.platform === 'win32' && target.toLowerCase() === from.toLowerCase();
    if (!caseOnly) {
      try {
        await fs.access(target);
        return { ok: false, error: '已经有同名文件或文件夹。' };
      } catch {
        /* target is free */
      }
    }
    await fs.rename(from, target);
    return { ok: true, path: toWorkspacePath(root, target) };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:delete', async (_event, request) => {
  try {
    // A remote host has no recycle bin; the UI says the delete is permanent.
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.remove(remoteFs, request ?? {});
    const { root, target } = await resolveWorkspaceTarget(
      request?.workspaceId,
      request?.path,
    );
    if (target === root) return { ok: false, error: '不能删除工作空间的根目录。' };
    await fs.lstat(target);
    await shell.trashItem(target);
    return { ok: true };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

ipcMain.handle('workspace:properties', async (_event, request) => {
  try {
    const remoteFs = await remoteWorkspaceFs(request?.workspaceId);
    if (remoteFs) return await remoteIpc.properties(remoteFs, request ?? {});
    const { root, target } = await resolveWorkspaceTarget(
      request?.workspaceId,
      request?.path,
    );
    const stat = await fs.stat(target);
    const isDir = stat.isDirectory();
    return {
      ok: true,
      name: path.basename(target),
      path: toWorkspacePath(root, target),
      absolutePath: target,
      kind: isDir ? 'folder' : 'file',
      size: isDir ? undefined : stat.size,
      mtime: stat.mtimeMs,
      ctime: stat.ctimeMs,
      birthtime: stat.birthtimeMs,
    };
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }
});

/* ------------------------------------------------------------------ */
/* 工作空间实时文件监听                                                  */
/* ------------------------------------------------------------------ */

// Only the folders the renderer currently has open are watched: the root plus
// every expanded folder. A recursive watch on a project folder would also follow
// node_modules and .git, which is exactly the kind of traffic we do not need.
// FS events are coalesced per workspace so an agent writing many files sends one
// refresh per folder instead of one per write.
const workspaceWatchers = new Map();
const WATCH_DEBOUNCE = 150;

function closeWorkspaceWatchers(workspaceId) {
  const state = workspaceWatchers.get(workspaceId);
  if (!state) return;
  if (state.timer) clearTimeout(state.timer);
  for (const watcher of state.watchers.values()) {
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
  }
  workspaceWatchers.delete(workspaceId);
}

function closeAllWorkspaceWatchers() {
  for (const workspaceId of [...workspaceWatchers.keys()]) {
    closeWorkspaceWatchers(workspaceId);
  }
}

function queueWorkspaceChange(workspaceId, dir) {
  const state = workspaceWatchers.get(workspaceId);
  if (!state) return;
  state.pending.add(dir);
  if (state.timer) return;
  state.timer = setTimeout(() => {
    state.timer = null;
    const dirs = [...state.pending];
    state.pending.clear();
    if (dirs.length > 0) broadcast('workspace:changed', { workspaceId, dirs });
  }, WATCH_DEBOUNCE);
}

ipcMain.handle('workspace:watch', async (_event, request) => {
  const workspaceId = String(request?.workspaceId ?? '');
  if (!workspaceId) return { ok: false, error: '没有指定工作空间。' };
  // A remote host cannot be watched with fs.watch; the tree refreshes on open
  // and on demand instead.
  if ((await workspaceRootInfo(workspaceId))?.remote) return { ok: true, dirs: [] };

  let root;
  try {
    ({ root } = await resolveWorkspaceTarget(workspaceId, ''));
  } catch (error) {
    return { ok: false, error: describeFsError(error) };
  }

  let state = workspaceWatchers.get(workspaceId);
  if (!state || state.root !== root) {
    closeWorkspaceWatchers(workspaceId);
    state = { root, watchers: new Map(), pending: new Set(), timer: null };
    workspaceWatchers.set(workspaceId, state);
  }

  const wanted = new Set(['']);
  for (const value of Array.isArray(request?.dirs) ? request.dirs : []) {
    const dir = String(value ?? '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '');
    if (!dir) continue;
    try {
      const target = await resolveInside(root, dir);
      const stat = await fs.stat(target);
      if (stat.isDirectory()) wanted.add(dir);
    } catch {
      /* folder vanished or escaped — simply not watched */
    }
  }

  const watching = state.watchers;
  for (const [dir, watcher] of [...watching]) {
    if (wanted.has(dir)) continue;
    try {
      watcher.close();
    } catch {
      /* already closed */
    }
    watching.delete(dir);
  }

  for (const dir of wanted) {
    if (watching.has(dir)) continue;
    let target;
    try {
      target = dir ? await resolveInside(root, dir) : root;
    } catch {
      continue;
    }
    if (watching.has(dir)) continue;
    try {
      const watcher = fsSync.watch(target, { persistent: false }, () => {
        queueWorkspaceChange(workspaceId, dir);
      });
      watcher.on('error', () => {
        // A watched folder can disappear (rename/delete); drop it and refresh
        // once so the renderer sees the new parent listing.
        try {
          watcher.close();
        } catch {
          /* already closed */
        }
        if (watching.get(dir) === watcher) watching.delete(dir);
        queueWorkspaceChange(workspaceId, dir);
      });
      watching.set(dir, watcher);
      // A write can land between the renderer's readdir and this watch being
      // installed; refresh once so that gap cannot hide a change.
      queueWorkspaceChange(workspaceId, dir);
    } catch {
      /* watching is best-effort; a manual refresh still works */
    }
  }

  return { ok: true, dirs: [...watching.keys()] };
});

ipcMain.handle('workspace:unwatch', (_event, workspaceId) => {
  closeWorkspaceWatchers(String(workspaceId ?? ''));
  return true;
});

app.on('before-quit', closeAllWorkspaceWatchers);

ipcMain.handle('warehouse:add-files', async (_event, filePaths, origin) => {
  const result = await warehouse.addFiles(filePaths ?? [], origin);
  broadcast('warehouse:event', result.snapshot);
  return result;
});

ipcMain.handle('warehouse:add-blobs', async (_event, entries, origin) => {
  const result = await warehouse.addBlobs(entries ?? [], origin);
  broadcast('warehouse:event', result.snapshot);
  return result;
});

ipcMain.handle('warehouse:delete', async (_event, id) => {
  const snapshot = await warehouse.delete(id);
  broadcast('warehouse:event', snapshot);
  return snapshot;
});

ipcMain.handle('warehouse:delete-many', async (_event, ids) => {
  const snapshot = await warehouse.deleteMany(ids ?? []);
  broadcast('warehouse:event', snapshot);
  return snapshot;
});

ipcMain.handle('warehouse:open', async (_event, id) => {
  const found = await warehouse.itemPath(id);
  if (!found) return { ok: false, error: '仓库里找不到这个文件' };
  const error = await fileOpener.openPath(found.path);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle('warehouse:reveal', async (_event, id) => {
  const found = await warehouse.itemPath(id);
  if (!found) return { ok: false, error: '仓库里找不到这个文件' };
  fileOpener.revealPath(found.path);
  return { ok: true };
});

ipcMain.handle('warehouse:open-root', async () => {
  await warehouse.load();
  const error = await fileOpener.openPath(warehouse.root);
  return error ? { ok: false, error } : { ok: true };
});

ipcMain.handle('warehouse:thumbnail', (_event, id) => warehouse.thumbnail(id));

/**
 * Text of chat attachments, extracted on demand. Nothing is indexed or cached:
 * the warehouse stays a plain file store, and the text only lives in the
 * request for that turn (plus the hidden context kept on the message).
 */
const MAX_ATTACHMENT_CHARS = 200_000;

function readOcrOptions(options) {
  // -1 (and an omitted/zero value) means "no page limit"; positive values cap
  // at 200 like before.
  const requested = Math.round(Number(options?.maxPages));
  return {
    enabled: options?.enabled !== false,
    pdf: options?.pdf !== false,
    maxPages:
      !Number.isFinite(requested) || requested <= 0 ? -1 : Math.min(200, requested),
  };
}

async function readWarehouseFile(id, ocrOptions) {
  const found = await warehouse.itemPath(id);
  if (!found) return { id, ok: false, error: '仓库里找不到这个文件' };

  const { item, path: filePath } = found;
  const base = {
    id: item.id,
    name: item.name,
    ext: item.ext,
    size: item.size,
    kind: item.kind,
    // the real location — an attached .pptx has to be passed to a tool as a
    // path, so the model must know where it lives instead of guessing
    path: filePath,
  };

  if (item.kind === 'image') {
    if (!ocrOptions.enabled) {
      return { ...base, ok: false, error: '图片识别没有开启（设置 → OCR 配置）' };
    }
    try {
      const full = (await ocr.recognizeImage(filePath)).trim();
      if (!full) throw new Error('图片里没有识别到文字');
      const truncated = full.length > MAX_ATTACHMENT_CHARS;
      return {
        ...base,
        ok: true,
        ocr: true,
        text: truncated ? full.slice(0, MAX_ATTACHMENT_CHARS) : full,
        truncated,
      };
    } catch (error) {
      return { ...base, ok: false, error: error?.message || String(error) };
    }
  }

  const isPdf = (item.ext || '').replace(/^\./, '').toLowerCase() === 'pdf';
  let extracted = { pages: [] };
  let extractError = null;
  try {
    extracted = await extract(filePath);
  } catch (error) {
    extractError = error;
  }

  let full = extracted.pages
    .map((page) => page.text)
    .join('\n\n')
    .trim();
  let usedOcr = false;
  let note = '';

  // A scanned PDF still parses fine — it just yields no (or a handful of)
  // characters. Render those pages and OCR them instead of handing the model
  // an empty attachment.
  const thinText =
    isPdf && full.replace(/\s+/g, '').length < Math.max(20, extracted.pages.length * 20);
  if (isPdf && ocrOptions.pdf && (thinText || extractError)) {
    try {
      const scanned = await ocr.recognizePdf(filePath, { maxPages: ocrOptions.maxPages });
      const text = scanned.pages
        .map((page) => `【第 ${page.page} 页】\n${page.text}`.trim())
        .join('\n\n')
        .trim();
      if (text) {
        full = text;
        usedOcr = true;
        if (scanned.truncated) {
          note = `文档共 ${scanned.totalPages} 页，只识别了前 ${scanned.pages.length} 页`;
        }
      }
    } catch (error) {
      // Keep the text layer when OCR fails; the note explains the fallback.
      note = `扫描件 OCR 失败：${error?.message || String(error)}`;
    }
  }

  if (!full) {
    const reason = extractError?.message || note || '文件里没有可读取的文字';
    return { ...base, ok: false, error: reason };
  }

  const truncated = full.length > MAX_ATTACHMENT_CHARS;
  return {
    ...base,
    ok: true,
    ocr: usedOcr || undefined,
    note: note || undefined,
    text: truncated ? full.slice(0, MAX_ATTACHMENT_CHARS) : full,
    truncated,
  };
}

ipcMain.handle('warehouse:read-text', async (_event, ids, options) => {
  const ocrOptions = readOcrOptions(options);
  const results = [];
  for (const id of Array.isArray(ids) ? ids : []) {
    results.push(await readWarehouseFile(id, ocrOptions));
  }
  return results;
});

/* ------------------------------------------------------------------
   Agent access to the knowledge base and warehouse (read-only)
   ------------------------------------------------------------------ */

/** OCR switches for agent-initiated reads, taken from the saved settings. */
async function readOcrSettings() {
  try {
    const raw = await fs.readFile(settingsFile(), 'utf8');
    return readOcrOptions(JSON.parse(raw)?.ocr ?? {});
  } catch {
    return readOcrOptions({});
  }
}

/** Recursively turn selected categories (which may be groups) into file categories. */
function expandKbCategoryIds(ids, byId) {
  const categories =
    byId ?? new Map((kb.store?.listCategories() ?? []).map((category) => [category.id, category]));
  const allowed = new Set();
  const visit = (id, depth) => {
    if (depth > 8 || allowed.has(id)) return;
    const category = categories.get(id);
    if (!category) return;
    if (category.kind === 'group') {
      for (const member of category.includes ?? []) visit(member, depth + 1);
      return;
    }
    allowed.add(id);
  };
  for (const id of Array.isArray(ids) ? ids : []) visit(String(id), 0);
  return [...allowed];
}

/**
 * Validate what the renderer asked for against the real categories.
 * Returns null when nothing is active, so the agent gets no data tools at all.
 */
function prepareWorkspaceDataAccess(raw) {
  if (!raw || typeof raw !== 'object') return null;

  const categories = kb.store?.listCategories() ?? [];
  const byId = new Map(categories.map((category) => [category.id, category]));
  const requested =
    raw?.kb?.enabled === false || !Array.isArray(raw?.kb?.categoryIds)
      ? []
      : raw.kb.categoryIds.map(String);
  const selected = [...new Set(requested)].filter((id) => byId.has(id));
  const expanded = expandKbCategoryIds(selected, byId);
  const warehouseOn = raw?.warehouse === true;

  if (expanded.length === 0 && !warehouseOn) return null;

  return {
    // Only file categories are useful for filtering; group ids are expanded.
    kbCategoryIds: expanded,
    // The prompt names what the user actually picked, groups included.
    kbCategoryNames: selected.map((id) => byId.get(id)?.name).filter(Boolean),
    warehouse: warehouseOn,
  };
}

function kbCategoriesData(categoryIds, documentIds) {
  if (!kb.store) return [];
  const categories = kb.store.listCategories();
  const byId = new Map(categories.map((category) => [category.id, category]));
  const allowed = new Set(expandKbCategoryIds(categoryIds, byId));
  // Documents picked one by one make their category relevant for the meta
  // listing even when the whole category was not selected.
  const picked = new Set(Array.isArray(documentIds) ? documentIds.map(String) : []);
  if (picked.size > 0) {
    for (const doc of kb.store.listDocuments()) {
      if (picked.has(doc.id) && doc.categoryId && byId.has(doc.categoryId)) {
        allowed.add(doc.categoryId);
      }
    }
  }
  const counts = new Map();
  for (const doc of kb.store.listDocuments()) {
    counts.set(doc.categoryId, (counts.get(doc.categoryId) ?? 0) + 1);
  }
  return categories
    .filter((category) => allowed.has(category.id))
    .map((category) => ({
      id: category.id,
      name: category.name,
      kind: category.kind,
      documentCount: counts.get(category.id) ?? 0,
    }));
}

async function kbSearchData(query, categoryIds, topK, options = {}) {
  if (!kb.store) return { hits: [], note: '知识库还没有准备好' };
  const categories = kb.store.listCategories();
  const byId = new Map(categories.map((category) => [category.id, category]));
  const allowed = expandKbCategoryIds(categoryIds, byId);
  const docIds = Array.isArray(options.docIds) ? options.docIds.map(String) : [];
  if (allowed.length === 0 && docIds.length === 0) {
    return { hits: [], note: '没有可访问的分类或文档' };
  }

  const result = await kb.search(query, {
    categoryIds: allowed,
    docIds,
    excludeDocIds: Array.isArray(options.excludeDocIds) ? options.excludeDocIds.map(String) : [],
    topK: Math.min(8, Math.max(1, topK)),
    candidates: 40,
  });

  const docs = new Map(kb.store.listDocuments().map((doc) => [doc.id, doc]));
  const hits = (result.results ?? []).map((hit, index) => {
    const doc = docs.get(hit.docId);
    return {
      rank: index + 1,
      docId: hit.docId,
      chunkId: hit.chunkId,
      docName: hit.docName ?? doc?.name ?? '未命名文档',
      categoryId: doc?.categoryId ?? null,
      categoryName: doc?.categoryId ? byId.get(doc.categoryId)?.name ?? '' : '',
      section: hit.section ?? null,
      page: hit.page ?? null,
      text: hit.text ?? '',
      score: hit.score ?? 0,
    };
  });

  return { hits, note: result.note || null };
}

function kbReadData(docId, categoryIds, offset, maxChars, options = {}) {
  if (!kb.store) return { ok: false, error: '知识库还没有准备好' };

  const doc = kb.store.getDocument(docId);
  if (!doc) return { ok: false, error: '知识库里没有这篇文档' };

  const excluded = new Set(
    Array.isArray(options.excludeDocIds) ? options.excludeDocIds.map(String) : [],
  );
  if (excluded.has(doc.id)) {
    return { ok: false, error: '这篇文档被这个 Agent 的可见范围排除了' };
  }
  const allowedDocs = new Set(
    Array.isArray(options.docIds) ? options.docIds.map(String) : [],
  );
  const allowed = new Set(expandKbCategoryIds(categoryIds));
  if (!allowed.has(doc.category_id) && !allowedDocs.has(doc.id)) {
    return { ok: false, error: '这篇文档不在本任务激活的分类或文档里' };
  }

  const totalChunks = kb.store.countChunks(docId);
  if (totalChunks === 0) return { ok: false, error: '这篇文档还没有可读取的内容' };
  const start = Math.max(0, Math.min(totalChunks - 1, Math.trunc(offset) || 0));

  const category = kb.store
    .listCategories()
    .find((item) => item.id === doc.category_id);

  const chunks = [];
  let used = 0;
  let truncated = false;
  const rows = kb.store.chunksForDocument(docId, start, 60);
  for (const row of rows) {
    const text = String(row.text ?? '').trim();
    if (!text) continue;
    if (used + text.length > maxChars) {
      const room = Math.max(0, maxChars - used);
      if (room > 200) chunks.push({ ...row, text: `${text.slice(0, room)}…` });
      truncated = true;
      break;
    }
    chunks.push({ ...row, text });
    used += text.length;
    if (used >= maxChars) {
      truncated = true;
      break;
    }
  }

  if (chunks.length === 0) return { ok: false, error: '这一段没有可读取的内容' };

  return {
    ok: true,
    docName: doc.name,
    categoryName: category?.name ?? '',
    chunks,
    totalChunks,
    fromChunk: start,
    truncated,
  };
}

async function warehouseListData(query, limit) {
  await warehouse.load();
  const needle = String(query ?? '').trim().toLowerCase();
  const all = warehouse.snapshot().items;
  const matched = needle ? all.filter((item) => String(item.name).toLowerCase().includes(needle)) : all;
  return {
    total: matched.length,
    items: matched.slice(0, limit).map((item) => ({
      id: item.id,
      name: item.name,
      ext: item.ext,
      size: item.size,
      kind: item.kind,
      addedAt: item.addedAt,
    })),
  };
}

async function warehouseReadData(id) {
  const result = await readWarehouseFile(id, await readOcrSettings());
  return result;
}

setDataBridge({
  kbCategories: kbCategoriesData,
  kbSearch: kbSearchData,
  kbRead: kbReadData,
  warehouseList: warehouseListData,
  warehouseRead: warehouseReadData,
});

/* ------------------------------------------------------------------
   Agent long-term memory

   Learning is candidate-first: a background extraction call proposes
   memories, and only confirmed entries are ever returned to a model.
   Every entry carries its observation time and a validity window; a
   stale entry is rechecked on the web before it can be quoted again.
   The files live under agent/memories and are plain JSON, so the whole
   store stays readable and editable by hand as well.
   ------------------------------------------------------------------ */

const MEMORY_RECHECK_START_MS = 90 * 1000;
const MEMORY_RECHECK_EVERY_MS = 6 * 60 * 60 * 1000;
const MEMORY_RECHECK_BATCH = 2;
const MEMORY_REVIEW_STATUS = {
  confirm: 'confirmed',
  reject: 'rejected',
  archive: 'archived',
  restore: 'confirmed',
  dispute: 'disputed',
};

function memoryAgent(id) {
  return agentDefinitions.find((agent) => agent.id === String(id ?? '')) ?? null;
}

/** Chat target from 设置里的默认对话模型; null when nothing is configured. */
async function memoryProvider(override = '') {
  try {
    const saved = JSON.parse(await fs.readFile(settingsFile(), 'utf8'));
    const pick = String(override || saved?.defaults?.chat || '');
    const split = pick.indexOf('::');
    const providerId = split === -1 ? pick : pick.slice(0, split);
    const configured = saved?.providers?.[providerId];
    if (!configured || !configured.baseUrl) return null;
    const model = (split === -1 ? '' : pick.slice(split + 2)) || configured.models?.[0] || '';
    if (!model) return null;
    return {
      apiType: configured.apiType,
      baseUrl: configured.baseUrl,
      apiKey: configured.apiKey ?? '',
      model,
      providerId,
      providerName: configured.name,
    };
  } catch {
    return null;
  }
}

/** Save the store, append the audit line, and refresh every open panel. */
async function commitMemory(agentId, store, event) {
  await memoryStore.saveStore(agentDir(), agentId, store);
  if (!event) return;
  const payload = { agentId, ...event };
  await memoryStore.appendEvent(agentDir(), agentId, payload);
  broadcast('agent:memory-event', { ...payload, at: memoryStore.nowMs() });
}

/**
 * Fire-and-forget extraction for a finished task. The caller has already sent
 * `done`; nothing here may delay or alter that outcome.
 */
function startMemoryLearning({ agent, provider, history, message, sessionId, messageId }) {
  if (!agent || agent.memory?.enabled === false || !provider) return;
  setImmediate(() => {
    learning
      .learnFromRun({
        agent,
        provider,
        history,
        message,
        agentDir: agentDir(),
        sessionId,
        messageId,
        onUsage: (usage) =>
          usageStore?.record({
            feature: 'other',
            provider,
            usage,
            sessionId,
            workspaceName: '长期记忆',
          }),
        onEvent: (payload) => broadcast('agent:memory-event', { ...payload, at: Date.now() }),
      })
      .catch((error) => console.warn('[memory] learning failed:', error?.message || String(error)));
  });
}

async function recheckMemory(agent, store, entry, options = {}) {
  if (!agent.memory?.allowWebRecheck && !options.force) {
    return { ok: false, error: '这个 Agent 关闭了联网复核。' };
  }
  const provider = await memoryProvider();
  if (!provider) return { ok: false, error: '还没有可用的对话模型，无法复核。' };

  const verdict = await memoryRecheck.verifyEntry({ entry, provider });
  usageStore?.record({
    feature: 'other',
    provider,
    usage: verdict.usage,
    sessionId: '',
    workspaceName: '记忆复核',
  });
  const applied = memoryStore.applyVerdict(store, entry.id, verdict, {
    force: Boolean(options.force),
    verifiedBy: options.verifiedBy || 'auto',
  });
  if (!applied.ok) return { ok: false, error: applied.error };

  await commitMemory(agent.id, store, {
    type: 'recheck',
    kind: verdict.kind,
    title: entry.title,
    reason: verdict.reason || '',
    applied: applied.applied !== false,
    proposal: Boolean(applied.proposal),
  });
  return {
    ok: true,
    kind: verdict.kind,
    reason: verdict.reason || '',
    applied: applied.applied !== false,
    proposal: Boolean(applied.proposal),
    entry: applied.entry,
    search: verdict.search,
  };
}

ipcMain.handle('agents:memory-snapshot', async (_event, id) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const snapshot = memoryStore.snapshotOf(store);
  const events = await memoryStore.readEvents(agentDir(), agent.id, 40);
  return {
    ok: true,
    agentId: agent.id,
    settings: agent.memory,
    entries: snapshot.entries,
    stats: snapshot.stats,
    now: snapshot.now,
    events,
    volatility: memoryStore.VOLATILITY,
  };
});

ipcMain.handle('agents:memory-save', async (_event, id, input) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const memoryId = String(input?.id ?? '').trim();
  const previous = memoryId ? store.entries.find((item) => item.id === memoryId) : null;
  if (memoryId && !previous) return { ok: false, error: '这条记忆已经不存在。' };

  const now = memoryStore.nowMs();
  const previousTags = JSON.stringify(previous?.tags ?? []);
  const nextTags = JSON.stringify(input?.tags ?? previous?.tags ?? []);
  const contentChanged =
    Boolean(previous) &&
    (String(input?.title ?? previous.title) !== previous.title ||
      String(input?.content ?? previous.content) !== previous.content ||
      previousTags !== nextTags);

  const temporal = {
    ...(previous?.temporal ?? {}),
    ...(input?.temporal ?? {}),
    // A hand edit is a fresh observation: its validity window restarts.
    ...(contentChanged
      ? {
          observedAt: now,
          lastVerifiedAt: now,
          validFrom: now,
          validUntil: undefined,
          nextCheckAt: undefined,
          unverified: false,
        }
      : {}),
  };

  const result = memoryStore.normalizeEntry(
    {
      ...(previous ?? {}),
      ...input,
      id: previous?.id,
      origin: previous?.origin ?? 'manual',
      status: input?.status ?? previous?.status,
      revision: previous?.revision ?? 1,
      history: previous?.history ?? [],
      proposal: previous?.proposal ?? null,
      temporal,
    },
    { agentId: agent.id, now, previous },
  );
  if (!result.ok) return { ok: false, error: result.error };
  const entry = result.entry;
  if (previous && contentChanged) {
    entry.history = [
      ...(previous.history ?? []),
      memoryStore.snapshotEntry(previous, { now, reason: '用户手动修改', verifiedBy: 'manual' }),
    ].slice(-20);
    entry.revision = (previous.revision ?? 1) + 1;
  }

  if (previous) store.entries[store.entries.indexOf(previous)] = entry;
  else store.entries.unshift(entry);
  await commitMemory(agent.id, store, {
    type: previous ? 'update' : 'create',
    title: entry.title,
    origin: entry.origin,
  });
  return { ok: true, entry };
});

ipcMain.handle('agents:memory-delete', async (_event, id, memoryId) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const index = store.entries.findIndex((item) => item.id === String(memoryId ?? ''));
  if (index === -1) return { ok: false, error: '这条记忆已经不存在。' };
  const [removed] = store.entries.splice(index, 1);
  await commitMemory(agent.id, store, {
    type: 'delete',
    title: removed.title,
    origin: removed.origin,
  });
  return { ok: true };
});

ipcMain.handle('agents:memory-review', async (_event, id, memoryId, decision) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const status = MEMORY_REVIEW_STATUS[String(decision ?? '')];
  if (!status) return { ok: false, error: '未知的操作。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const entry = store.entries.find((item) => item.id === String(memoryId ?? ''));
  if (!entry) return { ok: false, error: '这条记忆已经不存在。' };

  const now = memoryStore.nowMs();
  entry.status = status;
  entry.updatedAt = now;
  if (status === 'confirmed') {
    entry.temporal.lastVerifiedAt = now;
    entry.temporal.unverified = false;
    if (!entry.temporal.nextCheckAt || entry.temporal.nextCheckAt <= now) {
      entry.temporal.nextCheckAt =
        now + (entry.temporal.recheckDays || 30) * memoryStore.DAY;
    }
    // The user vouching for it is at least as strong as extraction confidence.
    if (entry.confidence < 0.7) entry.confidence = 0.7;
  }
  await commitMemory(agent.id, store, {
    type: 'review',
    decision: String(decision),
    title: entry.title,
  });
  return { ok: true, entry };
});

ipcMain.handle('agents:memory-recheck', async (_event, id, memoryId) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const entry = store.entries.find((item) => item.id === String(memoryId ?? ''));
  if (!entry) return { ok: false, error: '这条记忆已经不存在。' };
  try {
    return await recheckMemory(agent, store, entry, { force: true, verifiedBy: 'user' });
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

ipcMain.handle('agents:memory-proposal', async (_event, id, memoryId, accept) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const store = await memoryStore.loadStore(agentDir(), agent.id);
  const result = memoryStore.applyProposal(store, String(memoryId ?? ''), Boolean(accept), {
    now: memoryStore.nowMs(),
  });
  if (!result.ok) return { ok: false, error: result.error };
  await commitMemory(agent.id, store, {
    type: accept ? 'proposal-accept' : 'proposal-dismiss',
    title: result.entry?.title ?? '',
  });
  return { ok: true, entry: result.entry };
});

ipcMain.handle('agents:memory-events', async (_event, id) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  return {
    ok: true,
    events: await memoryStore.readEvents(agentDir(), agent.id, 60),
  };
});

ipcMain.handle('agents:memory-config', async (_event, id, patch) => {
  const agent = memoryAgent(id);
  if (!agent) return { ok: false, error: 'Agent 不存在。' };
  const next = agentDefinitions.map((item) =>
    item.id === agent.id
      ? { ...item, memory: agentsStore.normalizeMemory({ ...item.memory, ...(patch ?? {}) }), updatedAt: Date.now() }
      : item,
  );
  try {
    await agentsStore.saveAgents(agentDir(), next);
  } catch (error) {
    return { ok: false, error: `保存失败：${error?.message || String(error)}` };
  }
  agentDefinitions = next;
  // Turning auto-confirm on clears the review queue too: entries that were
  // waiting for approval now take effect, which is what the switch promises.
  if (patch?.autoConfirm === true && agent.memory?.autoConfirm !== true) {
    const store = await memoryStore.loadStore(agentDir(), agent.id);
    const pending = store.entries.filter((entry) => entry.status === 'candidate');
    if (pending.length > 0) {
      const now = memoryStore.nowMs();
      for (const entry of pending) {
        entry.status = 'confirmed';
        entry.updatedAt = now;
      }
      await commitMemory(agent.id, store, {
        type: 'config',
        action: 'auto-confirm-on',
        confirmed: pending.length,
      });
    }
  }
  const saved = agentDefinitions.find((item) => item.id === agent.id) ?? null;
  broadcast('agents:updated', agentDefinitions);
  return { ok: true, agents: agentDefinitions, memory: saved?.memory };
});

/**
 * Retrieval bridge for the in-run tool. Confirmed, unexpired entries only;
 * using an entry is recorded so the panel can show what the Agent leans on.
 */
/**
 * Serialises vector-index work per Agent. Two searches in the same run share
 * one embedding pass instead of racing on the sidecar file.
 */
const memoryVectorJobs = new Map();

function runMemoryJob(key, fn) {
  const previous = memoryVectorJobs.get(key) ?? Promise.resolve();
  const next = previous.then(fn, fn);
  const tracked = next.finally(() => {
    if (memoryVectorJobs.get(key) === tracked) memoryVectorJobs.delete(key);
  });
  memoryVectorJobs.set(key, tracked);
  return next;
}

/** Memory the model may actually see: confirmed and not past its validity. */
function searchableMemories(store, now) {
  return store.entries.filter((entry) => {
    if (entry.status !== 'confirmed') return false;
    const state = memoryStore.freshnessOf(entry, now).state;
    return state === 'fresh' || state === 'due' || state === 'stale';
  });
}

/**
 * Hybrid retrieval. Returns null when embeddings are not configured or the
 * service fails, and the caller falls back to the keyword search.
 */
async function vectorMemorySearch(agent, store, query, limit, now) {
  // Sandbox runs stay hermetic: no dependency on a local embedding service.
  if (process.env.EZNESS_DISABLE_MEMORY_VECTORS === '1') return null;
  const embedding = kb.config?.embedding;
  if (!embedding?.model) return null;

  const index = await memoryVectors.loadIndex(agentDir(), agent.id);
  const { changed } = await memoryVectors.ensureVectors(
    index,
    searchableMemories(store, now),
    {
      model: embedding.model,
      embed: (texts) => embedTexts(texts, embedding, { batchSize: 8 }),
    },
  );
  if (changed) await memoryVectors.saveIndex(agentDir(), agent.id, index);

  const queryVector = await embedQuery(query, embedding);
  return memoryStore.searchEntriesHybrid(store, query, {
    limit,
    now,
    queryVector,
    vectors: memoryVectors.vectorMap(index),
  });
}

/**
 * Embed every Agent's memory once after startup so the first search of a day
 * does not wait for the model to load. Failures are silent: retrieval falls
 * back to keywords.
 */
async function warmMemoryVectors() {
  if (process.env.EZNESS_DISABLE_MEMORY_VECTORS === '1') return;
  if (!kb.config?.embedding?.model) return;
  for (const agent of agentDefinitions) {
    if (agent.memory?.enabled === false) continue;
    try {
      await runMemoryJob(`vectors:${agent.id}`, async () => {
        const store = await memoryStore.loadStore(agentDir(), agent.id);
        const now = memoryStore.nowMs();
        const index = await memoryVectors.loadIndex(agentDir(), agent.id);
        const { changed } = await memoryVectors.ensureVectors(
          index,
          searchableMemories(store, now),
          {
            model: kb.config.embedding.model,
            embed: (texts) => embedTexts(texts, kb.config.embedding, { batchSize: 8 }),
          },
        );
        if (changed) await memoryVectors.saveIndex(agentDir(), agent.id, index);
      });
    } catch (error) {
      console.warn(
        '[Ezness] 记忆向量预建立失败，检索会退回关键词：',
        error?.message || error,
      );
    }
  }
}

setMemoryBridge({
  search: async (agentId, query, limit) => {
    const agent = memoryAgent(agentId);
    if (!agent) return { error: 'Agent 不存在。' };
    const store = await memoryStore.loadStore(agentDir(), agent.id);
    const now = memoryStore.nowMs();

    let result = null;
    if (agent.memory?.enabled !== false) {
      try {
        result = await runMemoryJob(`vectors:${agent.id}`, () =>
          vectorMemorySearch(agent, store, query, limit, now),
        );
      } catch (error) {
        console.warn(
          '[Ezness] 记忆向量检索不可用，改用关键词：',
          error?.message || error,
        );
      }
    }
    if (!result) {
      result = {
        ...memoryStore.searchEntries(store, query, { limit, now }),
        mode: 'keyword',
      };
    }

    if (result.hits.length > 0) {
      for (const hit of result.hits) {
        const entry = store.entries.find((item) => item.id === hit.id);
        if (!entry) continue;
        entry.lastUsedAt = now;
        entry.useCount = (entry.useCount ?? 0) + 1;
      }
      await memoryStore
        .saveStore(agentDir(), agent.id, store)
        .catch(() => undefined);
    }
    // Usage telemetry: enough to tell whether memory retrieval earns its
    // tokens, without copying answers or tool output into the audit log.
    await memoryStore
      .appendEvent(agentDir(), agent.id, {
        type: 'search',
        query: String(query ?? '').slice(0, 80),
        hits: result.hits.length,
        expired: result.expired ?? 0,
        candidates: result.candidates ?? result.hits.length,
        mode: result.mode ?? 'keyword',
      })
      .catch(() => undefined);
    return result;
  },
});

/** Recheck a couple of due memories at a time; never blocks a task. */
async function memoryRecheckTick() {
  if (process.env.EZNESS_DISABLE_MEMORY_RECHECK === '1') return;
  const provider = await memoryProvider();
  if (!provider) return;
  let budget = MEMORY_RECHECK_BATCH;
  for (const agent of [...agentDefinitions]) {
    if (budget <= 0) break;
    if (!agent.memory?.enabled || !agent.memory?.allowWebRecheck) continue;
    let store;
    try {
      store = await memoryStore.loadStore(agentDir(), agent.id);
    } catch {
      continue;
    }
    const now = memoryStore.nowMs();
    const due = store.entries.filter(
      (entry) =>
        entry.status === 'confirmed' &&
        ['due', 'stale'].includes(memoryStore.freshnessOf(entry, now).state),
    );
    for (const entry of due.slice(0, budget)) {
      budget -= 1;
      try {
        await recheckMemory(agent, store, entry);
      } catch (error) {
        console.warn('[memory] recheck failed:', error?.message || String(error));
      }
    }
  }
}

function startMemoryScheduler() {
  if (process.env.EZNESS_DISABLE_MEMORY_RECHECK === '1') return;
  const timer = setTimeout(() => {
    memoryRecheckTick().catch(() => undefined);
  }, MEMORY_RECHECK_START_MS);
  timer.unref?.();
  const interval = setInterval(() => {
    memoryRecheckTick().catch(() => undefined);
  }, MEMORY_RECHECK_EVERY_MS);
  interval.unref?.();
}


/* ------------------------------------------------------------------
   Unified storage root — one address for every file the app produces
   ------------------------------------------------------------------ */

async function storageInfo() {
  await warehouse.load();
  const paths = storage.paths;
  const kbStats = kb.snapshot().stats;
  const wh = warehouse.snapshot();
  const voiceInfo = voiceModelStatus(storage.root);

  const [ragBytes, warehouseBytes, voiceBytes, settingsBytes, promptsBytes, kbConfigBytes] =
    await Promise.all([
      directorySize(paths.rag),
      directorySize(paths.warehouse),
      directorySize(paths.voiceModels),
      fileSize(paths.settings),
      fileSize(paths.prompts),
      fileSize(paths.kbConfig),
    ]);

  return {
    root: storage.root,
    layout: {
      settings: paths.settings,
      prompts: paths.prompts,
      kbConfig: paths.kbConfig,
      rag: paths.rag,
      warehouse: paths.warehouse,
      voiceModels: paths.voiceModels,
    },
    stats: {
      kbDocuments: kbStats.documents,
      kbChunks: kbStats.chunks,
      warehouseFiles: wh.count,
      warehouseBytes: wh.totalBytes,
      voiceReady: voiceInfo.ready,
      ragBytes,
      warehouseDirBytes: warehouseBytes,
      voiceBytes,
      configBytes: settingsBytes + promptsBytes + kbConfigBytes,
    },
  };
}

ipcMain.handle('storage:info', () => storageInfo());

ipcMain.handle('storage:pick-root', async () => {
  const result = await openDialog({
    title: '选择应用数据的储存位置',
    properties: ['openDirectory', 'createDirectory'],
  });
  return result.canceled ? null : result.filePaths[0] || null;
});

ipcMain.handle('storage:open-root', async () => {
  const error = await fileOpener.openPath(storage.root);
  return error ? { ok: false, error } : { ok: true };
});

/* ------------------------------------------------------------------
   Language packs
   Custom packs live beside the rest of the user's data, so they move with
   the storage root and never need a rebuild to add a language.
   ------------------------------------------------------------------ */

ipcMain.handle('locales:list', () => locales.list(storage.root));

ipcMain.handle('locales:read', (_event, file) => locales.read(storage.root, file));

ipcMain.handle('locales:open-folder', (_event, example) =>
  locales.openFolder(storage.root, example, (dir) => fileOpener.openPath(dir)),
);

ipcMain.handle('storage:migrate-root', async (_event, targetPath) => {
  try {
    await migrateDataRoot(
      { storage, kb, warehouse, voice, persistKb },
      targetPath,
      { sourceRoot: storage.root },
    );
    // runtimes/ moved with the data root; point discovery at the new home and
    // drop the old cache so the bundled Python is found immediately.
    customTools.setRuntimeRoot(storage.root);
    await customTools.detectRuntimes({ force: true });
    await reloadAgents();
    // The ledger and its price cache moved with the data root.
    await usageStore?.reattach();
    kb.emit({ type: 'refresh', ...kb.snapshot() });
    broadcast('warehouse:event', warehouse.snapshot());
    return { ok: true, info: await storageInfo() };
  } catch (error) {
    return { ok: false, error: error?.message || String(error) };
  }
});

app.on('will-quit', () => {
  usageStore?.flushSync();
  ocr.dispose();
  try {
    kb.store?.close();
  } catch {
    /* already closed */
  }
});
