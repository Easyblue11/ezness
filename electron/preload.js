const { contextBridge, ipcRenderer, webUtils } = require('electron');

contextBridge.exposeInMainWorld('ezness', {
  platform: process.platform,
  /** True in an installed build, false for `electron .` during development. */
  isPackaged: process.argv.includes('--ezness-packaged'),
  versions: {
    electron: process.versions.electron ?? '',
    chrome: process.versions.chrome ?? '',
    node: process.versions.node ?? '',
  },
  minimize: () => ipcRenderer.invoke('window:minimize'),
  toggleMaximize: () => ipcRenderer.invoke('window:toggle-maximize'),
  close: () => ipcRenderer.invoke('window:close'),
  isMaximized: () => ipcRenderer.invoke('window:is-maximized'),
  /** Window-level fullscreen, used by the visualization dialog. */
  setFullscreen: (value) => ipcRenderer.invoke('window:set-fullscreen', Boolean(value)),
  onWindowState: (callback) => {
    const listener = (_event, maximized) => callback(maximized);
    ipcRenderer.on('window:state', listener);
    return () => ipcRenderer.removeListener('window:state', listener);
  },
  fetchModels: (payload) => ipcRenderer.invoke('models:fetch', payload),
  loadSettings: () => ipcRenderer.invoke('settings:load'),
  saveSettings: (settings) => ipcRenderer.invoke('settings:save', settings),
  proxyApply: (settings) => ipcRenderer.invoke('proxy:apply', settings),
  proxyStatus: () => ipcRenderer.invoke('proxy:status'),
  proxyTest: (url) => ipcRenderer.invoke('proxy:test', url),

  // Chat
  chatSend: (request) => ipcRenderer.invoke('chat:send', request),
  chatAbort: (requestId) => ipcRenderer.invoke('chat:abort', requestId),
  copyText: (text) => ipcRenderer.invoke('clipboard:write', text),
  webSearch: (query, entries) => ipcRenderer.invoke('web:search', query, entries),
  webJudge: (request) => ipcRenderer.invoke('web:judge', request),
  exportSession: (payload) => ipcRenderer.invoke('session:export', payload),

  // Prompt templates
  promptsLoad: () => ipcRenderer.invoke('prompts:load'),
  promptsSave: (templates) => ipcRenderer.invoke('prompts:save', templates),
  promptsExport: (payload) => ipcRenderer.invoke('prompts:export', payload),
  promptsImport: () => ipcRenderer.invoke('prompts:import'),

  // OCR
  ocrStatus: () => ipcRenderer.invoke('ocr:status'),

  // Voice input
  voiceStatus: () => ipcRenderer.invoke('voice:status'),
  voiceDownload: () => ipcRenderer.invoke('voice:download'),
  voiceCancelDownload: () => ipcRenderer.invoke('voice:cancel-download'),
  voiceStart: () => ipcRenderer.invoke('voice:start'),
  voiceChunk: (buffer) => ipcRenderer.invoke('voice:chunk', buffer),
  voiceStop: () => ipcRenderer.invoke('voice:stop'),
  voiceCancel: () => ipcRenderer.invoke('voice:cancel'),
  onVoiceEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('voice:event', listener);
    return () => ipcRenderer.removeListener('voice:event', listener);
  },
  onChatEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('chat:event', listener);
    return () => ipcRenderer.removeListener('chat:event', listener);
  },

  // Usage ledger (token + cost history)
  usageLoad: () => ipcRenderer.invoke('usage:load'),
  usageClear: () => ipcRenderer.invoke('usage:clear'),
  usageExport: (payload) => ipcRenderer.invoke('usage:export', payload),
  onUsageEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('usage:event', listener);
    return () => ipcRenderer.removeListener('usage:event', listener);
  },

  // Workspace agent (tool loop)
  agentStart: (request) => ipcRenderer.invoke('agent:start', request),
  agentAbort: (requestId) => ipcRenderer.invoke('agent:abort', requestId),
  agentActive: () => ipcRenderer.invoke('agent:active'),
  agentResolve: (request) => ipcRenderer.invoke('agent:resolve', request),
  agentDeleteSession: (sessionId) => ipcRenderer.invoke('agent:delete-session', sessionId),
  agentCompact: (request) => ipcRenderer.invoke('agent:compact', request),
  agentContext: (sessionId) => ipcRenderer.invoke('agent:context', sessionId),
  agentCapabilities: () => ipcRenderer.invoke('agent:capabilities'),
  agentCustomTools: () => ipcRenderer.invoke('agent:custom-tools'),
  agentRuntimes: () => ipcRenderer.invoke('agent:runtimes'),
  pythonEnvStatus: () => ipcRenderer.invoke('python:status'),
  pythonEnvEnsure: () => ipcRenderer.invoke('python:ensure'),
  pythonModules: () => ipcRenderer.invoke('python:modules'),
  pythonInstallModule: (spec) => ipcRenderer.invoke('python:install', spec),
  pythonSetIndex: (value) => ipcRenderer.invoke('python:set-index', value),
  agentPickSecretFile: (request) => ipcRenderer.invoke('agent:pick-secret-file', request),
  agentCustomToolSave: (definition) => ipcRenderer.invoke('agent:custom-tools-save', definition),
  agentCustomToolDelete: (id) => ipcRenderer.invoke('agent:custom-tools-delete', id),
  agentToolHealth: () => ipcRenderer.invoke('agent:tool-health'),
  agentToolRetest: (request) => ipcRenderer.invoke('agent:tool-retest', request),
  agentCategories: () => ipcRenderer.invoke('agent:categories'),
  agentCategorySave: (input) => ipcRenderer.invoke('agent:category-save', input),
  agentCategoryDelete: (id) => ipcRenderer.invoke('agent:category-delete', id),
  // 一个能力分类 / 一个 Agent 各自是一个可搬走的包。知识库不在包里。
  agentCategoryExport: (id) => ipcRenderer.invoke('agent:category-export', id),
  agentCategoryImport: () => ipcRenderer.invoke('agent:category-import'),
  onAgentEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:event', listener);
    return () => ipcRenderer.removeListener('agent:event', listener);
  },

  // Agents: definitions; each one selects a slice of the shared knowledge base.
  agentsList: () => ipcRenderer.invoke('agents:list'),
  agentsSave: (definition) => ipcRenderer.invoke('agents:save', definition),
  agentsReview: (request) => ipcRenderer.invoke('agents:review', request),
  agentsDelete: (id) => ipcRenderer.invoke('agents:delete', id),
  agentsExport: (id) => ipcRenderer.invoke('agents:export', id),
  agentsImport: () => ipcRenderer.invoke('agents:import'),

  // 工作总监: mandate, space visibility, and which task the user is standing in.
  directorGet: () => ipcRenderer.invoke('director:get'),
  directorSave: (patch) => ipcRenderer.invoke('director:save', patch),
  directorPresence: (input) => ipcRenderer.invoke('director:presence', input),
  onDirectorEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:event', listener);
    return () => ipcRenderer.removeListener('director:event', listener);
  },
  // 工作总监 · 服务：任务清单、汇报收件箱、事务清单、透视与指令下发。
  directorSync: (tasks, spaces) => ipcRenderer.invoke('director:sync', { tasks, spaces }),
  directorSnapshot: () => ipcRenderer.invoke('director:snapshot'),
  directorInbox: () => ipcRenderer.invoke('director:inbox'),
  directorMarkRead: (ids) => ipcRenderer.invoke('director:mark-read', ids),
  directorAudit: (options) => ipcRenderer.invoke('director:audit', options),
  directorReviewNow: () => ipcRenderer.invoke('director:review-now'),
  directorResolve: (payload) => ipcRenderer.invoke('director:resolve', payload),
  directorLedger: (limit) => ipcRenderer.invoke('director:ledger', limit),
  directorClear: (payload) => ipcRenderer.invoke('director:clear', payload),
  directorHistory: () => ipcRenderer.invoke('director:history'),
  directorHistoryGet: (id) => ipcRenderer.invoke('director:history-get', id),
  directorHistoryDedupe: () => ipcRenderer.invoke('director:history-dedupe'),
  directorHistoryDelete: (ids) => ipcRenderer.invoke('director:history-delete', ids),
  directorInspect: (taskId, part) => ipcRenderer.invoke('director:inspect', { taskId, part }),
  directorInstructionAck: (payload) => ipcRenderer.invoke('director:instruction-ack', payload),
  directorSpawnAck: (payload) => ipcRenderer.invoke('director:spawn-ack', payload),
  directorRunBlocked: (payload) => ipcRenderer.invoke('director:run-blocked', payload),
  directorUserMessage: (payload) => ipcRenderer.invoke('director:user-message', payload),
  directorTyping: (active) => ipcRenderer.invoke('director:typing', active),
  onDirectorInbox: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:inbox', listener);
    return () => ipcRenderer.removeListener('director:inbox', listener);
  },
  onDirectorInstruction: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:instruction', listener);
    return () => ipcRenderer.removeListener('director:instruction', listener);
  },
  onDirectorSpawn: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:spawn', listener);
    return () => ipcRenderer.removeListener('director:spawn', listener);
  },
  // 总监对任务本身的操作（置顶/重命名/导出/删除）由界面执行。
  onDirectorTaskAction: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:task-action', listener);
    return () => ipcRenderer.removeListener('director:task-action', listener);
  },
  directorTaskAck: (payload) => ipcRenderer.invoke('director:task-ack', payload),
  onDirectorHistory: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('director:history-changed', listener);
    return () => ipcRenderer.removeListener('director:history-changed', listener);
  },
  // Long-term memory: readable, editable, and time-aware per agent.
  agentsMemorySnapshot: (id) => ipcRenderer.invoke('agents:memory-snapshot', id),
  agentsMemorySave: (id, input) => ipcRenderer.invoke('agents:memory-save', id, input),
  agentsMemoryDelete: (id, memoryId) => ipcRenderer.invoke('agents:memory-delete', id, memoryId),
  agentsMemoryReview: (id, memoryId, decision) =>
    ipcRenderer.invoke('agents:memory-review', id, memoryId, decision),
  agentsMemoryRecheck: (id, memoryId) =>
    ipcRenderer.invoke('agents:memory-recheck', id, memoryId),
  agentsMemoryProposal: (id, memoryId, accept) =>
    ipcRenderer.invoke('agents:memory-proposal', id, memoryId, accept),
  agentsMemoryEvents: (id) => ipcRenderer.invoke('agents:memory-events', id),
  agentsMemoryConfig: (id, patch) => ipcRenderer.invoke('agents:memory-config', id, patch),
  onAgentMemoryEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('agent:memory-event', listener);
    return () => ipcRenderer.removeListener('agent:memory-event', listener);
  },

  // Knowledge base
  getPathForFile: (file) => webUtils.getPathForFile(file),
  kbSnapshot: () => ipcRenderer.invoke('kb:snapshot'),
  kbSetConfig: (patch) => ipcRenderer.invoke('kb:set-config', patch),
  kbPickFiles: () => ipcRenderer.invoke('kb:pick-files'),
  kbAddFiles: (filePaths, categoryId) => ipcRenderer.invoke('kb:add-files', filePaths, categoryId),
  kbCreateCategory: (name, kind, includes) => ipcRenderer.invoke('kb:create-category', name, kind, includes),
  kbRenameCategory: (id, name) => ipcRenderer.invoke('kb:rename-category', id, name),
  kbSetCategoryIncludes: (id, includes) => ipcRenderer.invoke('kb:set-category-includes', id, includes),
  kbDeleteCategory: (id) => ipcRenderer.invoke('kb:delete-category', id),
  kbReorderCategories: (ids) => ipcRenderer.invoke('kb:reorder-categories', ids),
  kbMoveDocument: (docId, categoryId) => ipcRenderer.invoke('kb:move-document', docId, categoryId),
  kbDeleteDocument: (docId) => ipcRenderer.invoke('kb:delete-document', docId),
  kbExportDocument: (docId) => ipcRenderer.invoke('kb:export-document', docId),
  kbSearch: (query, options) => ipcRenderer.invoke('kb:search', query, options),
  onKbEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('kb:event', listener);
    return () => ipcRenderer.removeListener('kb:event', listener);
  },

  // Conversation warehouse (independent from the knowledge base)
  warehouseSnapshot: () => ipcRenderer.invoke('warehouse:snapshot'),
  warehousePickFiles: () => ipcRenderer.invoke('warehouse:pick-files'),
  warehouseAddFiles: (filePaths, origin) => ipcRenderer.invoke('warehouse:add-files', filePaths, origin),
  warehouseAddBlobs: (entries, origin) => ipcRenderer.invoke('warehouse:add-blobs', entries, origin),
  warehouseDelete: (id) => ipcRenderer.invoke('warehouse:delete', id),
  warehouseDeleteMany: (ids) => ipcRenderer.invoke('warehouse:delete-many', ids),
  warehouseOpen: (id) => ipcRenderer.invoke('warehouse:open', id),
  warehouseReveal: (id) => ipcRenderer.invoke('warehouse:reveal', id),
  warehouseOpenRoot: () => ipcRenderer.invoke('warehouse:open-root'),
  warehouseThumbnail: (id) => ipcRenderer.invoke('warehouse:thumbnail', id),
  warehouseReadText: (ids, options) =>
    ipcRenderer.invoke('warehouse:read-text', ids, options),
  onWarehouseEvent: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('warehouse:event', listener);
    return () => ipcRenderer.removeListener('warehouse:event', listener);
  },

  // 对话 history: sessions and transcripts, kept in the data root.
  chatsLoad: () => ipcRenderer.invoke('chats:load'),
  chatsSave: (state) => ipcRenderer.invoke('chats:save', state),

  // Workspaces: one folder per workspace, conversations live under it.
  workspacePickFolder: () => ipcRenderer.invoke('workspace:pick-folder'),
  workspaceLoad: () => ipcRenderer.invoke('workspace:load'),
  workspaceSave: (state) => ipcRenderer.invoke('workspace:save', state),
  workspaceTree: (request) => ipcRenderer.invoke('workspace:tree', request),
  workspaceReadFile: (request) => ipcRenderer.invoke('workspace:read-file', request),
  workspaceOpenFile: (request) => ipcRenderer.invoke('workspace:open-file', request),
  workspaceReveal: (request) => ipcRenderer.invoke('workspace:reveal', request),
  workspaceProbe: (request) => ipcRenderer.invoke('workspace:probe', request),
  workspaceCreateFolder: (request) => ipcRenderer.invoke('workspace:create-folder', request),
  workspaceMove: (request) => ipcRenderer.invoke('workspace:move', request),
  workspaceRename: (request) => ipcRenderer.invoke('workspace:rename', request),
  workspaceDelete: (request) => ipcRenderer.invoke('workspace:delete', request),
  workspaceProperties: (request) => ipcRenderer.invoke('workspace:properties', request),
  workspaceWatch: (request) => ipcRenderer.invoke('workspace:watch', request),
  workspaceUnwatch: (workspaceId) => ipcRenderer.invoke('workspace:unwatch', workspaceId),
  // Summary + charts over one workspace's tasks, transcript excerpts and usage.
  workspaceVisualize: (request) => ipcRenderer.invoke('workspace:visualize', request),
  workspaceVizCancel: (requestId) => ipcRenderer.send('workspace:viz-cancel', requestId),
  // Rows read from CSV/Excel/SQLite/JSON files inside the workspace folder.
  workspaceVizTables: (request) => ipcRenderer.invoke('workspace:viz-tables', request),
  workspaceVizTableRows: (request) => ipcRenderer.invoke('workspace:viz-table-rows', request),
  // Remote workspaces over SSH; credentials stay in the main process.
  workspaceRemoteConnect: (request) => ipcRenderer.invoke('workspace:remote-connect', request),
  workspaceRemoteList: (request) => ipcRenderer.invoke('workspace:remote-list', request),
  workspaceRemoteOpen: (request) => ipcRenderer.invoke('workspace:remote-open', request),
  workspaceRemoteClose: (request) => ipcRenderer.invoke('workspace:remote-close', request),
  workspacePickKeyFile: () => ipcRenderer.invoke('workspace:pick-key-file'),
  onWorkspaceChanged: (callback) => {
    const listener = (_event, payload) => callback(payload);
    ipcRenderer.on('workspace:changed', listener);
    return () => ipcRenderer.removeListener('workspace:changed', listener);
  },

  /** Re-reads tools/agents from disk; the renderer reloads itself after. */
  reloadRuntime: () => ipcRenderer.invoke('app:reload-runtime'),

  // Unified app storage root
  storageInfo: () => ipcRenderer.invoke('storage:info'),
  storagePickRoot: () => ipcRenderer.invoke('storage:pick-root'),
  storageMigrateRoot: (targetPath) => ipcRenderer.invoke('storage:migrate-root', targetPath),
  storageOpenRoot: () => ipcRenderer.invoke('storage:open-root'),

  // Language packs under <dataRoot>/locales
  localesList: () => ipcRenderer.invoke('locales:list'),
  localesRead: (file) => ipcRenderer.invoke('locales:read', file),
  localesOpenFolder: (example) => ipcRenderer.invoke('locales:open-folder', example),
});
