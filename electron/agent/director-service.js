/**
 * 工作总监 · 服务
 *
 * The director is a supervisor, not a second agent: one worker per task, and
 * the director watches the board. Everything that can be decided by a rule is
 * decided here, in code, because the director has to keep warning the user
 * even when the model is down or out of budget:
 *
 *   patrol      a cheap tick that notices stalls, failures and silent runs
 *   reports     template text in the inbox, debounced and rate-limited
 *   delegation  permission cards from monitored tasks, decided by ask level
 *   queue       instructions held while the user is in the task or typing
 *   acceptance  the director checks its own instructions, one rework maximum
 *
 * The model is only called for judgement: an opinion on a card, an answer to a
 * worker's question, a coverage check, or acceptance. If it is unavailable the
 * service falls back to a template or escalates to the user — never to a
 * silent approval.
 *
 * Files under <data root>/agent/director:
 *   inbox.json        reports / alerts / confirmations, unread flag
 *   instructions.json what the director told a worker, and where it stands
 *   memory.json       durable notes, keyed by title
 *   ledger.jsonl      append-only "what the director did" trail
 *   patterns.json     repeated work fingerprints + advice bookkeeping
 */

const fs = require('node:fs/promises');
const fsSync = require('node:fs');
const path = require('node:path');
const { execFile } = require('node:child_process');
const { randomUUID, createHash } = require('node:crypto');
const { streamChat } = require('../chat');
const { AgentSession } = require('./session');
const director = require('./director');
const workPatterns = require('./work-patterns');

/**
 * 巡视节奏。15 秒够快，能在“模型/网络卡住”变成用户眼里的死等之前发现；
 * 这一轮只读内存，不叫模型，成本可以忽略。
 */
const TICK_MS = 15 * 1000;
const STALL_MS = 15 * 60 * 1000;
/** 停住这么久就不再重复提醒，把“要不要继续等”交回用户。 */
const STALL_GIVEUP_MS = 60 * 60 * 1000;
/**
 * 运行中连续这么久没有任何流事件（连思考/manual 都没有），先怀疑卡住。
 * 用户要求：员工在跑但一直不回报时，不能干等，至少每 2 分钟看一次执行状态。
 */
const RUN_SILENT_MS = 2 * 60 * 1000;
/** 模型判断也拿不到、或者一直说等：到这个点必须给用户一个提醒。 */
const RUN_SILENT_ALERT_MS = 8 * 60 * 1000;
/** 同一个运行两次“卡住判断”之间至少隔这么久，避免每 15 秒叫一次模型。 */
const RUN_JUDGE_COOLDOWN_MS = 3 * 60 * 1000;
/** 项目脉搏：有活干的项目每 6 分钟看一次；只是“看一眼”，不代表每次都要开口。 */
const PROJECT_PULSE_MS = 6 * 60 * 1000;
/** 同一个项目两次主动汇报至少隔 5 分钟，避免刷屏。 */
const PROJECT_REPORT_MIN_MS = 5 * 60 * 1000;
/** 状态没变化时最多隔这么久提醒一次；不能每 6 分钟复读同一套话。 */
const PROJECT_UNCHANGED_REMIND_MS = 20 * 60 * 1000;
/** 项目明显超出预估的参照线。 */
const PROJECT_OVERDUE_FACTOR = 1.5;
/** 给“开发完成、准备调试”的调试计划留的时间。 */
const DEBUG_PLAN_TIMEOUT_MS = 20 * 1000;
/** 一次审计请求 10 分钟内复用同一条消息，连点不再连发。 */
const AUDIT_DEDUPE_MS = 10 * 60 * 1000;
const REPORT_DEBOUNCE_MS = 4 * 1000;
const COOLDOWN_MS = 30 * 60 * 1000;
/** While the user is composing to the director, nothing may be delivered. */
const TYPING_HOLD_MS = 5 * 1000;
const DELIVERY_STALE_MS = 20 * 1000;
/** 指令排了这么久还没送出去，就说明是真卡住了，必须开口问用户。 */
const BLOCKED_ALERT_MS = 2 * 60 * 1000;
/** 启动后给界面一分钟把任务板推上来，再判断旧指令是不是还有家。 */
const RECONCILE_GRACE_MS = 60 * 1000;
/** 重启后最多补收多久以内的半路指令；更早的只悄悄收掉，不再补发汇总。 */
const ORPHAN_SETTLE_MAX_AGE_MS = 6 * 60 * 60 * 1000;
/** 排队等并发名额是正常的，等太久才提醒。 */
const QUEUED_ALERT_MS = 10 * 60 * 1000;
/** 渲染层的任务板里连续缺席这么久，就认为任务/空间已被删除。 */
const TASK_FORGET_MS = 90 * 1000;
const INBOX_TTL = 7 * 24 * 60 * 60 * 1000;
const MAX_INBOX = 300;
const MAX_LEDGER = 5000;
const MAX_MEMORY = 200;
const MAX_INSTRUCTIONS = 200;
const AUTO_APPROVAL_WINDOW = 60 * 60 * 1000;
const AUTO_APPROVAL_LIMIT = 30;
const MAX_AI_IN_FLIGHT = 2;
/** 一次模型调用最多等这么久。界面上的按钮不能永远转圈：等不到就给用户一句话。 */
const ASK_TIMEOUT_MS = 60 * 1000;
/** 派出去的任务：有员工完成、有人还在跑，超过这个时长就考虑再拆。 */
const SLOW_DISPATCH_MS = 5 * 60 * 1000;
/** 一张“我验不了”的卡放这么久还没人点，总监自己按现状收尾。 */
const HOLD_SETTLE_MS = 10 * 60 * 1000;
/** 等界面把员工任务建出来的时间；过期就报告失败，避免整个分配悬着。 */
const DISPATCH_ACK_MS = 45 * 1000;
/**
 * 验收员的时间上限。8 分钟对“找到真实入口、跑一遍、再核对关键点”偏紧，
 * 验收员经常因为到点没跑完而只能写“未验证”；给到 10 分钟。
 */
const VERIFY_BUDGET_MINUTES = 10;
/**
 * 验收分级：改动小、验收点少的单子只给 4 分钟——真实入口跑一遍就够，
 * 给 10 分钟反而会去搭测试环境、扩大范围。改动大的仍然 10 分钟。
 * 需要长跑实测（基准、多轮对弈）的，不塞进验收，按普通任务另派。
 */
const VERIFY_BUDGET_SMALL_MINUTES = 4;
const VERIFY_SMALL_BUILD_MINUTES = 20;
const VERIFY_SMALL_TEXT_CHARS = 240;
/** 一个员工的小项目不再叫模型估时：直接按任务量给区间，省一次往返。 */
const SINGLE_ESTIMATE_MIN_MINUTES = 8;
const SINGLE_ESTIMATE_MAX_MINUTES = 60;
/**
 * 派工指令的长度上限。实测：一条 1007 字的指令让员工跑了 78 分钟、120 次命令，
 * 大部分时间花在建基准、跑 20 局对弈、反复“自证”上，而不是改那几行代码。
 * 超过就退回让总监自己缩短，别把成本转嫁给用户。
 */
const MAX_BUILD_TASK_CHARS = 900;
/** 没有终点的调参指令：员工会一直跑，直到被叫停。 */
const OPEN_ENDED_TASK = /(胜率|通过率|覆盖率)[^。；\n]{0,12}(不到|低于|没到|不足)[^。；\n]{0,16}(继续|不收工|别收工|不要收工)|一直(改|调|优化|测)(到|下去)|不要(收工|停)[^。；\n]{0,8}(继续|直到)/i;

/**
 * 编制的硬时间上限。实测那轮 78 分钟里没有任何中断点——因为编制的
 * budgetMinutes 默认是 0（不限时）。现在每单都有上限：估时的 1.5 倍，
 * 最少 15 分钟、最多 45 分钟；到 75% 让它收口，到 100% 直接叫停交现状。
 */
const BUILD_BUDGET_MIN_MINUTES = 15;
const BUILD_BUDGET_MAX_MINUTES = 45;
const BUILD_BUDGET_FACTOR = 1.5;
/** 没有估时的派工，按这个默认上限兜底。 */
const BUILD_BUDGET_FALLBACK_MINUTES = 30;
/** 用到这个比例就先收口：停止探索，把已经改好的交上来。 */
const WRAP_UP_AT = 0.75;
/** 收口阶段最多给几分钟。 */
const WRAP_UP_MAX_MINUTES = 10;

/**
 * 小活直派的上限。一个“改文案/换图标/加一行”的活，派工要新建会话、
 * 重新摸代码、再走一轮验收，固定开销比活本身大好几倍。这种活直接对
 * 现有任务下指令，保留它自己的上下文。
 */
const SMALL_TASK_MAX_CHARS = 160;
/** 验收标准里至少要能看见一个可观察的结果，否则验收员没法照它判。 */
const OBSERVABLE_CRITERIA = /(启动|运行|打开|点击|访问|返回|输出|日志|端口|URL|命令|截图|看到|显示|报错|状态码|200|退出码)/;
const SMALL_TASK_MARK = /(文案|按钮|标题|颜色|字体|图标|间距|边距|一行|文字|名字|排序|默认值|提示语)/;
const HEAVY_TASK_MARK = /(迁移|重构|重写|架构|数据库|接口|协议|并发|部署|升级依赖|整个|全站|所有页面|批量|多个模块|性能|测试套件|回归|联调)/;

/** 环境卡：同一个空间一天内只探一次，文件变动再刷新。 */
// 工作空间会变（文件被删/被移动），卡放太久会把已经不存在的文件当成事实。
// 15 分钟刷新一次；探测是异步的，不挡派工。
const ENV_CARD_TTL_MS = 15 * 60 * 1000;
const ENV_PROBE_TIMEOUT_MS = 4000;
const ENV_CARD_MAX_ENTRIES = 40;
/** 连续这么多步没有写入任何文件，就停下来收口，不再陪着员工查环境。 */
const PROGRESS_STOP_CALLS = 10;
const PROGRESS_WRAP_MINUTES = 5;
const WRITE_TOOLS = new Set(['write_file', 'edit_file']);
/** 只读但属于“有进展”的动作，不累计。 */
const NEUTRAL_TOOLS = new Set(['todo_write', 'ask_user', 'smoke_check']);
/** 只把“跑命令”算作可能绕圈的信号；读文件、搜代码是大活正常的准备动作。 */
const PROGRESS_TOOLS = new Set(['run_command']);

const FILES = {
  inbox: 'inbox.json',
  instructions: 'instructions.json',
  memory: 'memory.json',
  projects: 'projects.json',
  ledger: 'ledger.jsonl',
  patterns: 'patterns.json',
  environments: 'environments.json',
};

function uid(prefix) {
  return `${prefix}_${randomUUID().slice(0, 12)}`;
}

function clip(value, limit = 1200) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `${text.slice(0, limit)}\n…（已截断）`;
}

/**
 * 保留结尾而不是开头。验收结论、缺口清单一律写在答复最后，按开头截断会把
 * “结论：通过 / 不通过”整段切掉，验收员明明给了结论也会被当成“没结论”。
 */
function clipTail(value, limit = 1200) {
  const text = String(value ?? '');
  return text.length <= limit ? text : `…（前文已截断）\n${text.slice(-limit)}`;
}

function oneLine(value, limit = 160) {
  return String(value ?? '').replace(/\s+/g, ' ').trim().slice(0, limit);
}

/**
 * 开发没完成时，不能提出“先发半成品/已完成的部分”。
 * 模型偶尔还会沿用旧口径，这里直接拦掉，下一段用实际在做的部分重写。
 */
function withoutPartialOffer(value) {
  const text = oneLine(value, 400);
  if (!text) return '';
  return /先发|半成品|已完成的部分|已经拿到的部分|已拿到的部分|要不要先.{0,10}(发|看)/.test(text)
    ? ''
    : text;
}

function formatSize(bytes) {
  const size = Number(bytes) || 0;
  if (size < 1024) return `${size} B`;
  if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)} KB`;
  return `${(size / 1024 / 1024).toFixed(1)} MB`;
}

/**
 * 把工人的收尾答复压成一小段 Markdown：保留换行、列表和表格，
 * 只收拾多余空行和尾部空格；超长时尽量在整行处断开，别把表格切碎。
 */
function markdownTail(value, limit = 420) {
  const lines = String(value ?? '')
    .replace(/\r\n?/g, '\n')
    .split('\n')
    .map((line) => line.replace(/[ \t]+$/g, ''));
  // 表格必须另起一段才能被 GFM 识别：紧跟在普通文字后面时补一个空行。
  const padded = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index];
    const next = lines[index + 1] ?? '';
    const startsTable =
      /^\s*\|/.test(line) && /^\s*\|?[\s:|-]+\|[\s:|-]*$/.test(next);
    if (startsTable && padded.length > 0 && padded[padded.length - 1].trim()) {
      padded.push('');
    }
    padded.push(line);
  }
  const text = padded.join('\n').replace(/\n{3,}/g, '\n\n').trim();
  if (!text) return '';
  if (text.length <= limit) return text;
  const cut = text.slice(0, limit);
  const lineBreak = cut.lastIndexOf('\n');
  let body = (lineBreak > limit * 0.6 ? cut.slice(0, lineBreak) : cut).trim();
  // 断在表格行中间就丢掉那半行，免得渲染出一行缺格的残表。
  const kept = body.split('\n');
  const last = kept[kept.length - 1] ?? '';
  if (last.trimStart().startsWith('|') && !last.trimEnd().endsWith('|')) {
    kept.pop();
    body = kept.join('\n').trim();
  }
  return `${body}\n\n…（已截断）`;
}

function idOf(value) {
  return String(value ?? '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 128);
}

/**
 * 单个任务的项目档案键。idOf 会把冒号去掉，所以这里统一写成
 * “task + 任务 id”，创建和查找才不会各算各的。
 */
function taskProjectId(taskId) {
  const id = idOf(taskId);
  return id ? `task${id}` : '';
}

/**
 * 事务账只回答两件事：任务这边出了什么状况，总监这边做了什么。
 * side=task 记任务侧，side=director 记总监的处置。
 */
const LEDGER_KIND = {
  'run:start': { side: 'task', label: '任务开始' },
  'run:end': { side: 'task', label: '任务结束' },
  'run:wrapup': { side: 'director', label: '到点收口' },
  'run:progress': { side: 'director', label: '无进展收口' },
  'run:budget': { side: 'director', label: '超时叫停' },
  'inbox:alert': { side: 'task', label: '任务异常' },
  'inbox:confirm': { side: 'task', label: '需要你拍板' },
  'inbox:report': { side: 'director', label: '汇报' },
  'permission:auto': { side: 'director', label: '代批一步' },
  'question:auto': { side: 'director', label: '代答工人' },
  'instruction:queue': { side: 'director', label: '准备指令' },
  'instruction:deliver': { side: 'director', label: '下发指令' },
  'instruction:accepted': { side: 'director', label: '工人接手' },
  'instruction:discarded': { side: 'director', label: '指令作废' },
  'instruction:blocked': { side: 'director', label: '指令卡住' },
  'instruction:stale': { side: 'director', label: '重启后收尾旧指令' },
  'task:pin': { side: 'director', label: '置顶/取消置顶' },
  'task:rename': { side: 'director', label: '重命名任务' },
  'task:delete': { side: 'director', label: '删除任务' },
  'task:export': { side: 'director', label: '导出任务' },
  'accept:hold': { side: 'director', label: '等用户验收' },
  'accept:quick': { side: 'director', label: '按文件状态收口' },
  'task:forget': { side: 'director', label: '记下任务已删' },
  'accept:pass': { side: 'director', label: '验收通过' },
  'accept:rework': { side: 'director', label: '要求返工' },
  'accept:auto': { side: 'director', label: '没拿到结论，先收尾' },
  'accept:stopped': { side: 'director', label: '叫停这一轮' },
  'accept:escalate': { side: 'director', label: '两次没过' },
  'confirm:answer': { side: 'director', label: '转达答复' },
  'memory:save': { side: 'director', label: '记下经验' },
  'dispatch:spawn': { side: 'director', label: '分配任务' },
  'project:reconcile': { side: 'director', label: '项目对账' },
  'dispatch:ack': { side: 'task', label: '员工开工' },
  'dispatch:done': { side: 'director', label: '分配收尾' },
  'dispatch:split': { side: 'director', label: '拆分慢任务' },
  'model:offer': { side: 'director', label: '请用户换模型' },
  'model:choose': { side: 'director', label: '换模型重试' },
  'inbox:advice': { side: 'director', label: '效率建议' },
  'inbox:audit': { side: 'director', label: '审计结论' },
  'advice:ack': { side: 'director', label: '建议已读' },
  'advice:ignore': { side: 'director', label: '建议暂不采用' },
};

/**
 * 哪些账目代表“用户亲自介入”：答确认卡、换模型重试。
 * 总监自己拍板、自己代答的不算——那正是要看它能不能少麻烦用户。
 */
const USER_STEP_KINDS = new Set(['confirm:answer', 'model:choose']);

/** 旧账没有 side/label，读出来时补齐，界面不分新旧。 */
function enrichLedgerEntry(entry) {
  if (!entry || typeof entry !== 'object') return entry;
  const meta = LEDGER_KIND[entry.kind] ?? { side: 'task', label: entry.kind };
  return {
    ...entry,
    side: entry.side === 'director' || entry.side === 'task' ? entry.side : meta.side,
    label: entry.label || meta.label,
  };
}

/** CJK bigrams plus latin words; good enough to tell "same request" apart. */
function tokens(value) {
  const text = String(value ?? '').toLowerCase();
  const latin = text.match(/[a-z0-9_]{2,}/g) ?? [];
  const cjk = text.match(/[一-鿿]/g) ?? [];
  const grams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) grams.push(cjk[i] + cjk[i + 1]);
  if (cjk.length === 1) grams.push(cjk[0]);
  return new Set([...latin, ...grams]);
}

function similarity(a, b) {
  const left = tokens(a);
  const right = tokens(b);
  if (left.size === 0 || right.size === 0) return 0;
  let shared = 0;
  for (const token of left) if (right.has(token)) shared += 1;
  return shared / Math.min(left.size, right.size);
}

/** 总监发给用户的文件引用：只存路径，不复制文件。 */
function normalizeDeliveredFile(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const workspaceId = String(raw.workspaceId ?? '').trim();
  const filePath = String(raw.path ?? '').trim();
  if (!workspaceId || !filePath) return null;
  return {
    workspaceId,
    path: filePath.slice(0, 1000),
    name: oneLine(raw.name, 160) || filePath.split(/[\\/]/).pop() || filePath,
    kind: raw.kind === 'directory' ? 'directory' : 'file',
    size: Math.max(0, Number(raw.size) || 0),
    project: Boolean(raw.project),
  };
}

function normalizeFiles(raw) {
  return Array.isArray(raw)
    ? raw.slice(0, 20).map(normalizeDeliveredFile).filter(Boolean)
    : [];
}

function normalizeInboxItem(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  if (!id) return null;
  return {
    id,
    kind: ['report', 'alert', 'confirm', 'question', 'advice', 'audit'].includes(raw.kind)
      ? raw.kind
      : 'report',
    /** 是谁发进对话的：缺省是工作总监；'audit' 是审计组自己的署名。 */
    speaker: raw.speaker === 'audit' ? 'audit' : '',
    title: oneLine(raw.title, 120) || '工作总监',
    // 审计报告是完整正文，不能按普通汇报截断；其余消息仍限 4000 字。
    body: String(raw.body ?? '').slice(0, raw.kind === 'audit' ? 24000 : 4000),
    taskId: String(raw.taskId ?? ''),
    taskTitle: oneLine(raw.taskTitle, 120),
    /** 紧急：卡住、没通过、需要马上看。落盘后也要保留，别一存就丢。 */
    urgent: Boolean(raw.urgent),
    at: Number(raw.at) || 0,
    read: Boolean(raw.read),
    status: ['open', 'resolved', 'dismissed'].includes(raw.status) ? raw.status : 'open',
    resolution: [
      'dismiss',
      'allow',
      'deny',
      'answer',
      'approve',
      'rework',
      'accept',
      'abandon',
      'choose',
      'choose-model',
      'ack',
      'ignore',
    ].includes(raw.resolution)
      ? raw.resolution
      : '',
    actions: Array.isArray(raw.actions)
      ? raw.actions
          .filter((action) => action && typeof action.id === 'string')
          .slice(0, 4)
          .map((action) => ({
            id: action.id,
            label: oneLine(action.label, 40) || action.id,
            style: action.style === 'primary' || action.style === 'danger' ? action.style : 'plain',
          }))
      : [],
    payload: raw.payload && typeof raw.payload === 'object' ? raw.payload : null,
    /** 本次交付的文件（路径引用）；用户点开就能看。 */
    files: normalizeFiles(raw.files),
    /** 总监分配的任务：文件要等用户明确读过才消标记。 */
    needsRead: Boolean(raw.needsRead),
    /** 必读：不因为“对话开着”就自动算读过，要点「知道了」或「先不用」。 */
    mustRead: Boolean(raw.mustRead),
  };
}

/**
 * 一个“项目”是总监自己记在手里的一件事：目标、预估、已经拍过的板、当前阶段。
 * 派工是一次项目；给某个已有任务连续下指令，也可以按任务记成一个项目。
 * 时间预估按 AI 编程的实际速度算，不按人类工时。
 */
function normalizeProject(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = idOf(raw.id);
  if (!id) return null;
  return {
    id,
    kind: raw.kind === 'task' ? 'task' : 'dispatch',
    title: oneLine(raw.title, 120) || '未命名项目',
    goal: clip(raw.goal ?? '', 1200),
    workspaceId: String(raw.workspaceId ?? ''),
    taskIds: Array.isArray(raw.taskIds)
      ? [...new Set(raw.taskIds.map(idOf).filter(Boolean))].slice(0, 40)
      : [],
    startedAt: Number(raw.startedAt) || Date.now(),
    /** 按 AI 编程速度估的时长；0 = 还没估。 */
    estimateMs: Math.max(0, Number(raw.estimateMs) || 0),
    estimateNote: oneLine(raw.estimateNote, 160),
    estimateAt: Number(raw.estimateAt) || 0,
    /** 验收预计时长；0 = 还没估。编制和验收各有一个检查点。 */
    verifyEstimateMs: Math.max(0, Number(raw.verifyEstimateMs) || 0),
    /** 按派工时刻算出的两个检查点；到点由总监判断要不要重新分配。 */
    buildEtaAt: Number(raw.buildEtaAt) || 0,
    verifyEtaAt: Number(raw.verifyEtaAt) || 0,
    buildCheckedAt: Number(raw.buildCheckedAt) || 0,
    verifyCheckedAt: Number(raw.verifyCheckedAt) || 0,
    /** 项目“编制完毕、验收中”那条状态消息只发一次。 */
    buildingAnnouncedAt: Number(raw.buildingAnnouncedAt) || 0,
    /** 最近一次因为空出槽位去补位的时间，避免反复补。 */
    lastBackfillAt: Number(raw.lastBackfillAt) || 0,
    /** 完工后的整体衔接检查只做一次。 */
    integrationCheckedAt: Number(raw.integrationCheckedAt) || 0,
    /** 总监对领导的承诺/判断，按时间追加；下次判断时带上，不用从零想。 */
    decisions: Array.isArray(raw.decisions)
      ? raw.decisions
          .map((entry) => ({
            at: Number(entry?.at) || 0,
            text: oneLine(entry?.text, 300),
          }))
          .filter((entry) => entry.text)
          .slice(-12)
      : [],
    lastPulseAt: Number(raw.lastPulseAt) || 0,
    lastReportAt: Number(raw.lastReportAt) || 0,
    lastReport: oneLine(raw.lastReport, 300),
    /** 上次汇报时的项目状态；状态没变就不重复播报。 */
    lastReportFingerprint: String(raw.lastReportFingerprint ?? ''),
    lastFingerprint: String(raw.lastFingerprint ?? ''),
    /** 开发完成的那条“可以进入调试了”只发一次。 */
    debugNotifiedAt: Number(raw.debugNotifiedAt) || 0,
    /** 派工时写下的计划：几个人、估多久、有没有契约。收口时跟实际对账。 */
    plan:
      raw.plan && typeof raw.plan === 'object'
        ? {
            parallelism: Math.max(1, Number(raw.plan.parallelism) || 1),
            estimateMinutes: Math.max(0, Number(raw.plan.estimateMinutes) || 0),
            verifyMinutes: Math.max(0, Number(raw.plan.verifyMinutes) || 0),
            contract: Boolean(raw.plan.contract),
            at: Number(raw.plan.at) || 0,
          }
        : null,
    /** 收口时的实际值：用了几分钟、几个人、返工几轮。 */
    actual:
      raw.actual && typeof raw.actual === 'object'
        ? {
            minutes: Math.max(0, Number(raw.actual.minutes) || 0),
            parallelism: Math.max(1, Number(raw.actual.parallelism) || 1),
            rounds: Math.max(0, Number(raw.actual.rounds) || 0),
            at: Number(raw.actual.at) || 0,
          }
        : null,
    status: raw.status === 'done' ? 'done' : 'active',
    finishedAt: Number(raw.finishedAt) || 0,
    updatedAt: Number(raw.updatedAt) || Date.now(),
  };
}

function normalizeInstruction(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const id = String(raw.id ?? '').trim();
  const taskId = String(raw.taskId ?? '').trim();
  const text = String(raw.text ?? '').trim();
  if (!id || !taskId || !text) return null;
  const states = ['queued', 'delivered', 'accepted', 'rework', 'escalated', 'discarded', 'held'];
  return {
    id,
    taskId,
    taskTitle: oneLine(raw.taskTitle, 120),
    // 员工指令 = 任务 + 原话 + 协作约定 + 契约。契约常常写到 2–3 千字，
    // 2000 的上限会把接口表切掉，员工只能猜路径和字段名。整段留够。
    text: clip(text, 8000),
    /**
     * 用户/总监真正要办的事。派工的指令正文会包一层员工规则（里面提到
     * “删除”“终止进程”），验收时不能拿那层壳去判断“这是不是删除类任务”。
     */
    intent: clip(raw.intent ?? '', 1000),
    criteria: clip(raw.criteria ?? '', 1200),
    source: raw.source === 'user' ? 'user' : 'director',
    attempts: Math.max(1, Math.min(5, Number(raw.attempts) || 1)),
    /** 验证/审查类任务的时间上限；到点自动叫停，交已有证据。0 = 不限。 */
    budgetMinutes: Math.max(0, Math.min(120, Number(raw.budgetMinutes) || 0)),
    /** 编制这一单原本分到的时间；返工/重做按它算，而不是按收口阶段的短预算。 */
    originalBudgetMinutes: Math.max(0, Math.min(120, Number(raw.originalBudgetMinutes) || 0)),
    /** 已经因为这个预算叫停过，避免每 15 秒重复叫停。 */
    budgetStoppedAt: Number(raw.budgetStoppedAt) || 0,
    /** 已经发过收口指令的时间；一次预算只收口一次。 */
    budgetWarnedAt: Number(raw.budgetWarnedAt) || 0,
    /** 到点收口时新下发的收口指令 id，用来合并汇报、不重复发交付卡。 */
    wrapUpInstructionId: idOf(raw.wrapUpInstructionId),
    /** 这条是收口指令：交付时要说“到点收口”，不是“已完成”。 */
    isWrapUp: Boolean(raw.isWrapUp),
    /** 领导的原话，照它判断范围；返工和验收都要能看到。 */
    userText: clip(raw.userText ?? '', 2000),
    /**
     * 这次派工的接口契约；验收员按它核对边界有没有被改掉。
     * 契约是并行员工之间唯一的硬边界，宁可多花几百 token 也不能截断：
     * 一次截断会让两个人各猜一套字段名，后面花整轮验收去对账。
     */
    contract: clip(raw.contract ?? '', 4000),
    /** 指令所属工作空间；投递时任务还没同步到、或者任务只有 id 时用它兜底。 */
    workspaceId: idOf(raw.workspaceId),
    /** 由派工回执建立（同一份计划可能分几批，不算重复入口）。 */
    fromDispatch: Boolean(raw.fromDispatch),
    state: states.includes(raw.state) ? raw.state : 'queued',
    createdAt: Number(raw.createdAt) || 0,
    deliveredAt: Number(raw.deliveredAt) || 0,
    /** Set when a run actually started; a delivery without it is a dead handoff. */
    startedAt: Number(raw.startedAt) || 0,
    finishedAt: Number(raw.finishedAt) || 0,
    failures: Number(raw.failures) || 0,
    /** 卡住时已经问过用户一次；同一条指令不重复刷。 */
    alertedAt: Number(raw.alertedAt) || 0,
    /** 这条指令是上一次进程留下的（从磁盘读回来的），不是这次新下的。 */
    restored: Boolean(raw.restored),
    note: oneLine(raw.note, 300),
    /** 返工期间先攒着，最终验收时一起交给用户。 */
    files: normalizeFiles(raw.files),
    /** 总监分配给员工时，同一次分配共用这个 id。 */
    dispatchId: idOf(raw.dispatchId),
    dispatchTitle: oneLine(raw.dispatchTitle, 120),
    /** 员工标识，例如「员工1」；用户悬浮任务上看得到。 */
    employeeName: oneLine(raw.employeeName, 40),
    /** 派工时选的 Agent，按员工审计时用。 */
    agentId: oneLine(raw.agentId, 80),
    dispatchSize: Math.max(0, Math.min(20, Number(raw.dispatchSize) || 0)),
    /**
     * 这条指令是编制还是验收。派工产生的编制指令走“交付→验收员验收”的新流程；
     * 验收员自己的指令只用于交结论，不再递归验收。
     */
    role: raw.role === 'verify' ? 'verify' : 'build',
    /** 验收指令对应的编制指令 / 任务 / 分配。 */
    parentInstructionId: idOf(raw.parentInstructionId),
    parentTaskId: idOf(raw.parentTaskId),
    parentDispatchId: idOf(raw.parentDispatchId),
    /** 返工轮次：0 是第一次编制，1..N 是第几次返工。 */
    round: Math.max(0, Math.min(9, Number(raw.round) || 0)),
    /** 已交付给用户、等验收员结论；这期间不能算“已验证”。 */
    verificationPending: Boolean(raw.verificationPending),
    /** 用户看到这一版的时间；同一条交付消息只发一次。 */
    deliveredToUserAt: Number(raw.deliveredToUserAt) || 0,
    verifiedAt: Number(raw.verifiedAt) || 0,
    /** 用户在总监等待期间直接改过这个任务：验收结论可能已经过期。 */
    userEditedAt: Number(raw.userEditedAt) || 0,
    /** 验收员给出的结构化结论。 */
    verdict: ['pass', 'fail', 'unverified'].includes(raw.verdict) ? raw.verdict : '',
    /**
     * 这个员工依赖的前置员工名字。前置还没收口时，验收往后排，
     * 免得拿半截接口去验（典型：前端先于后端被验，然后被判不通过）。
     */
    dependsOn: Array.isArray(raw.dependsOn)
      ? [...new Set(raw.dependsOn.map((name) => oneLine(name, 30)).filter(Boolean))].slice(0, 6)
      : [],
    /** 编制已交付，但在等前置员工收口，验收员还没派。 */
    verificationWaiting: Boolean(raw.verificationWaiting),
    /** 结论没读清时已经补派过一轮验收；只补一次。 */
    verifyRetryUsed: Boolean(raw.verifyRetryUsed),
    /** 系统先做的交付核对：桩/测试产物/缺入口/没有运行证据。 */
    deliveryAudit: raw.deliveryAudit && typeof raw.deliveryAudit === 'object'
      ? {
          level: ['ok', 'warn', 'bad'].includes(raw.deliveryAudit.level)
            ? raw.deliveryAudit.level
            : 'ok',
          problems: Array.isArray(raw.deliveryAudit.problems)
            ? raw.deliveryAudit.problems.map((item) => oneLine(item, 200)).filter(Boolean).slice(0, 6)
            : [],
          warnings: Array.isArray(raw.deliveryAudit.warnings)
            ? raw.deliveryAudit.warnings.map((item) => oneLine(item, 200)).filter(Boolean).slice(0, 6)
            : [],
          entry: oneLine(raw.deliveryAudit.entry, 160),
          runProof: Boolean(raw.deliveryAudit.runProof),
          checkedAt: Number(raw.deliveryAudit.checkedAt) || 0,
        }
      : null,
    /** 这次验收要盯的关键点；由总监在派验收员时写死。 */
    verifyPoints: Array.isArray(raw.verifyPoints)
      ? raw.verifyPoints.map((point) => oneLine(point, 160)).filter(Boolean).slice(0, 6)
      : [],
    /** 上一轮验收没过的点；返工和下一轮验收只看这些。 */
    verifyGaps: Array.isArray(raw.verifyGaps)
      ? raw.verifyGaps.map((gap) => oneLine(gap, 200)).filter(Boolean).slice(0, 8)
      : [],
    /** 验收员明确说没测到的部分；局部验收的边界。 */
    untested: Array.isArray(raw.untested)
      ? raw.untested.map((item) => oneLine(item, 120)).filter(Boolean).slice(0, 3)
      : [],
    /** 这次分配是否已经汇总汇报过，避免重复发消息。 */
    dispatchReported: Boolean(raw.dispatchReported),
    /** 已经拆过一次慢任务的时间戳；一次分配只拆一次。 */
    splitAt: Number(raw.splitAt) || 0,
    /** 验收结论，一句话；汇总时用。 */
    resultNote: oneLine(raw.resultNote, 300),
    /** 模型没给出判断、也没有用户确认：这条是“未验证”，不是“通过”。 */
    unverified: Boolean(raw.unverified),
    /** 这一轮工人留下的答复。会话日志随任务删除后就靠它回答“到底做没做”。 */
    evidence: clip(raw.evidence ?? '', 4000),
  };
}

function formatMemoryTime(ts) {
  const date = new Date(Number(ts) || 0);
  const pad = (value) => String(value).padStart(2, '0');
  return `${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}`;
}

function normalizeMemory(raw) {
  if (!raw || typeof raw !== 'object') return null;
  const title = oneLine(raw.title, 100);
  const body = String(raw.body ?? '').trim();
  if (!title || !body) return null;
  const archiveId = String(raw.archiveId ?? '').trim();
  const entry = {
    id: String(raw.id ?? '').trim() || uid('mem'),
    title,
    body: clip(body, 4000),
    tags: Array.isArray(raw.tags)
      ? raw.tags.map((tag) => oneLine(tag, 24)).filter(Boolean).slice(0, 8)
      : [],
    at: Number(raw.at) || Date.now(),
    updatedAt: Number(raw.updatedAt) || Number(raw.at) || Date.now(),
  };
  // 清空对话留下的“存档索引”记忆：正文只是粗摘要，细节要能顺着它
  // 用 director_recall 读回 history 里的原始对话。
  if (archiveId) {
    entry.archiveId = archiveId;
    entry.archiveTitle = oneLine(raw.archiveTitle, 120) || title;
    entry.from = Number(raw.from) || 0;
    entry.to = Number(raw.to) || 0;
    entry.count = Number(raw.count) || 0;
  }
  return entry;
}

async function readJson(dir, name, fallback) {
  try {
    const raw = await fs.readFile(path.join(dir, name), 'utf8');
    return JSON.parse(raw);
  } catch {
    return fallback;
  }
}

async function writeJson(dir, name, value) {
  await fs.mkdir(dir, { recursive: true });
  const file = path.join(dir, name);
  const temp = `${file}.tmp`;
  await fs.writeFile(temp, JSON.stringify(value, null, 2), 'utf8');
  await fs.rename(temp, file);
}

/**
 * 一次分配里的一个员工。总监只给要做什么和验收标准；Agent / 网络 / 仓库 /
 * 知识库这些能力开关也由总监指定，界面按这些字段建任务。
 */
function normalizeEmployee(raw, index) {
  if (!raw || typeof raw !== 'object') return null;
  const task = String(raw.task ?? '').trim();
  if (!task) return null;
  const web = ['off', 'auto', 'always'].includes(raw.web) ? raw.web : 'auto';
  const kbCategoryIds = Array.isArray(raw.kbCategoryIds)
    ? [...new Set(raw.kbCategoryIds.map(String).filter(Boolean))].slice(0, 20)
    : [];
  return {
    employeeId: idOf(raw.employeeId) || uid('emp'),
    name: oneLine(raw.name, 30) || `员工${index + 1}`,
    task: clip(task, 3000),
    criteria: clip(raw.criteria ?? '', 800),
    agentId: idOf(raw.agentId),
    web,
    useWarehouse: Boolean(raw.useWarehouse),
    kbCategoryIds,
    model: oneLine(raw.model, 200),
    budgetMinutes: Math.max(0, Math.min(120, Number(raw.budgetMinutes) || 0)),
    /** 验收员和编制员工走同一套任务创建流程，靠这个字段区分后续处理。 */
    role: raw.role === 'verify' ? 'verify' : 'build',
    parentInstructionId: idOf(raw.parentInstructionId),
    parentTaskId: idOf(raw.parentTaskId),
    parentDispatchId: idOf(raw.parentDispatchId),
    verifyPoints: Array.isArray(raw.verifyPoints)
      ? raw.verifyPoints.map((point) => oneLine(point, 160)).filter(Boolean).slice(0, 6)
      : [],
    /** 前置员工的名字：前置没交付/没验收完，这个员工的验收先等着。 */
    dependsOn: Array.isArray(raw.dependsOn)
      ? [...new Set(raw.dependsOn.map((name) => oneLine(name, 30)).filter(Boolean))].slice(0, 6)
      : [],
    /** 这个员工声明只会改哪些文件/目录；同一个文件不能有两个写手。 */
    files: Array.isArray(raw.files)
      ? [...new Set(raw.files.map((item) => oneLine(item, 120)).filter(Boolean))].slice(0, 12)
      : [],
    /**
     * 派工时声明的改动范围（字符串）。files 在交付后会被整轮扫描结果覆盖，
     * 验收要看“这个人改了什么”，不能拿整轮扫描（会带上别人的改动）。
     */
    declaredFiles: Array.isArray(raw.declaredFiles)
      ? [...new Set(raw.declaredFiles.map((item) => oneLine(item, 120)).filter(Boolean))].slice(0, 12)
      : [],
  };
}

/** 编制这一单最多能跑多久：按估时给 1.5 倍，夹在 15–45 分钟之间。 */
function planBuildBudget(estimateMinutes) {
  const estimate = Number(estimateMinutes) || 0;
  if (estimate <= 0) return BUILD_BUDGET_FALLBACK_MINUTES;
  return Math.max(
    BUILD_BUDGET_MIN_MINUTES,
    Math.min(BUILD_BUDGET_MAX_MINUTES, Math.round(estimate * BUILD_BUDGET_FACTOR)),
  );
}

/**
 * 这一单该验多久：小改动 4 分钟，其余 10 分钟。
 * 判不准就按 10 分钟——宁可多给，不要因为到点没跑完把结论写成“未验证”。
 */
function planVerifyBudget(instruction) {
  const buildMinutes =
    Number(instruction?.originalBudgetMinutes) || Number(instruction?.budgetMinutes) || 0;
  const text = String(instruction?.userText || instruction?.text || '');
  const points = Array.isArray(instruction?.verifyPoints) ? instruction.verifyPoints : [];
  // 多人一起改、交付了多个文件/目录，或者验收点不止一个：这不是“小活”，
  // 4 分钟连启动、跑一遍、写结论都不够。实测一轮 3 人改造，两个验收员都在
  // 4 分钟被叫停，结论没写完，整单只能记“未验证”。
  // 多人协作、或者写明了接口契约的，都不是“小活”。不用交付文件数判断：
  // 那一列是整轮扫描的结果，并行时每个人都会看到别人的改动，不可靠。
  const multiSurface = Number(instruction?.dispatchSize) > 1 || Boolean(instruction?.contract);
  const small =
    !multiSurface &&
    ((buildMinutes > 0 && buildMinutes <= VERIFY_SMALL_BUILD_MINUTES) ||
      (text.length > 0 && text.length <= VERIFY_SMALL_TEXT_CHARS && points.length <= 1));
  return small ? VERIFY_BUDGET_SMALL_MINUTES : VERIFY_BUDGET_MINUTES;
}

/**
 * 是不是“小活”：短、明确、只动界面/文案，不涉及架构、接口、数据。
 * 只用来把明显不该派工的活拦下来，判不准就照常派工。
 */
function isSmallTask(text) {
  const body = String(text ?? '').trim();
  if (!body || body.length > SMALL_TASK_MAX_CHARS) return false;
  if (HEAVY_TASK_MARK.test(body)) return false;
  return SMALL_TASK_MARK.test(body);
}

/**
 * 从“删掉/清理 X”里取出 X。只认删除动词后面那一小句，避免把
 * “确认只剩 index.html、app.js、style.css”里的文件名也当成删除目标。
 * 抽不出来就返回空数组，调用方照常走验收。
 */
function cleanupTargets(text) {
  const result = [];
  const body = String(text ?? '');
  const clauses = body.matchAll(/(?:删掉|删除|清理|移除|清掉|清空)\s*([^。；;\n]{0,140})/g);
  for (const clause of clauses) {
    const tokens = clause[1].match(/[^\s，,。；;）)「」"'“”]+/g) ?? [];
    for (const token of tokens) {
      const clean = token
        .replace(/^[`"'“”]+|[`"'“”]+$/g, '')
        .replace(/[\\/]+$/, '');
      if (!clean || clean.length > 120) continue;
      if (clean.includes('..') || path.isAbsolute(clean)) continue;
      // 「409/400」这种状态码也会被相对路径规则放进来：没有字母的 token
      // 不是文件路径。放过去会被当成“已经不在”，普通功能指令假通过。
      if (!/[A-Za-z_]/.test(clean)) continue;
      // 删除目标必须是“像路径的东西”，不能是句子片段。中文里“删除，以及
      // 全部/未完成/已完成三个筛选按钮”这种话也带斜杠；按旧规则会被当成
      // 一个相对路径，而它当然不存在——于是普通功能指令被当成“清理完成”
      // 直接收口，连验收员都不派。这里只认 ASCII 的文件名/相对路径；
      // 中文文件名的删除判不准就交给验收，宁可慢一点，不能假通过。
      const dotEntry = /^\.[A-Za-z0-9_.-]+$/.test(clean);
      const relativePath =
        /[\\/]/.test(clean) && !/^[a-z]:/i.test(clean) && /^[A-Za-z0-9_.\-\\/]+$/.test(clean);
      const fileName = /^[\w.-]+\.[a-z0-9]{1,8}$/i.test(clean);
      if (dotEntry || relativePath || fileName) result.push(clean);
    }
  }
  return [...new Set(result)];
}

/** 员工收到的指令正文：任务、协作约定，以及别越界。 */
function composeEmployeeText(dispatch, employee) {
  // 验收员只交结论：不派活、不改文件，正文里也不混入“交付物”的说法。
  if (employee.role === 'verify') {
    return [
      employee.task,
      '',
      `时间上限：最多 ${employee.budgetMinutes || VERIFY_BUDGET_MINUTES} 分钟。到点先停下来，把“哪一项没测到”写清楚，不要继续搭环境。`,
      '',
      '只读、只跑、只判断；不要改源码，不要新建交付文件。',
    ].join('\n');
  }
  const lines = [
    `你是这次「${dispatch.title || '分配'}」里的「${employee.name}」。`,
    '',
    `你负责的部分：${employee.task}`,
  ];
  // 领导的原话比总监的转述准。原话放在最上面，员工照它理解范围，
  // 不要在转述里被二次发挥。
  if (dispatch.userText) {
    lines.push('', `领导的原话（以这个为准，不要自行扩大范围）：${clip(dispatch.userText, 2000)}`);
  }
  if (dispatch.shared) {
    lines.push('', `协作约定（所有员工共同遵守）：${dispatch.shared}`);
  }
  if (dispatch.contract) {
    lines.push(
      '',
      '接口契约（所有人按它实现，不许擅自修改）：',
      dispatch.contract,
      '如果你认为必须改契约，停下来写一行「需要授权：要改接口的哪一条、为什么」，不要自己改。',
    );
    if (/…（已截断）\s*$/.test(dispatch.contract)) {
      lines.push(
        '',
        '注意：这份契约在保存时因超长被截断，末尾可能缺内容。缺的部分如果影响你负责的接口，先停下写「需要授权：…」，不要自己补一套字段名。',
      );
    }
  }
  if (dispatch.envCard) {
    lines.push('', dispatch.envCard);
  }
  const declared = Array.isArray(employee.files) ? employee.files.filter(Boolean) : [];
  if (declared.length > 0) {
    lines.push(
      '',
      `只许改这些文件：${declared.join('、')}。要动别的文件，先停下来说明原因，不要顺手改。`,
    );
  }
  if (employee.budgetMinutes > 0) {
    lines.push(
      '',
      `时间上限：最多 ${employee.budgetMinutes} 分钟。到点先停下来，把已经拿到的证据、结论和“哪一项没测到”写清楚；不要继续搭环境或扩大范围。`,
    );
  }
  lines.push(
    '',
    '只做你负责的这一块，不要改动其他员工负责的部分。完成后用一句话说明结果和验证情况；有交付文件就说明路径。',
    '只做上面点明的改动；没点名就不要另建基准测试、新旧对弈、回归套件或截图报告，也不要自己加胜率/覆盖率门槛。自测一次就停，完整验收由验收员负责。',
    '',
    '省时间的做法：',
    '- 动手前先把这次要写的文件列全，然后一次性写完；不要写完一个就停一轮。互不依赖的读取、命令、请求，同一轮一起发出。',
    '- 自测只做一轮：用 smoke_check（command + port + steps），它会启动、等端口、发请求并核对状态码/正文/JSON、清理、关掉；restart 复查落盘。失败就按报错修，再测一次；同一个问题不要连写多个探针，也不要写 verify*.js 这类临时脚本。',
    '',
    '交付标准（必须做到，做不到就如实说没做到）：',
    '- 交的是能按真实入口跑起来的程序，不是测试产物：在回复里写清启动命令、实际看到的输出（端口/HTTP 状态/窗口/命令退出码）。只写“已完成/文件已创建”不算交付。',
    '- 不许用桩、mock、模拟服务器、改 PYTHONPATH 或临时脚本顶替真实实现；测试脚本可以留，但不能是程序能跑的前提。',
    '- 自测脚本、探针、浏览器临时配置和截图放到系统临时目录（%TEMP%），用完删掉；除非任务点名要测试文件，否则项目里只留交付文件，不要留 tests/、.ezness/ 或截图。',
    '- 先交能跑通的最小版本，再谈性能优化；不要为了“更强”把启动时间拖到几十分钟。',
    '',
    '遇到这几种情况不要自己决定，停下来在回复里单独写一行「需要授权：…」说明要做什么、为什么、不做会怎样：需要终止或重启进程、要删明显属于用户的原件、目标文件被占用删不掉、需要更高的权限或越出工作空间。没删掉的东西照实列出来，不要写成已完成。',
    '停自己起的服务只停它的 PID（taskkill /PID <pid> /T /F），或交给 smoke_check 自动清理；禁止 taskkill /F /IM node.exe、Stop-Process -Name node 这类按进程名杀全机的命令——Ezness 自己就运行在 node 上，会一起被杀掉。',
  );
  return lines.join('\n');
}

/**
 * 这一轮是不是模型/供应商那边的问题？只有这种失败才值得让用户换模型；
 * 工具报错、任务自己被拒之类的不该弹模型选择。
 */
function looksLikeModelProblem(error) {
  const text = String(error ?? '').trim();
  if (!text) return false;
  return /模型|供应商|provider|api[\s_-]?key|密钥|未配置|未接入|没有可用|欠费|余额|限流|rate.?limit|quota|401|403|429|5\d\d|超时|timeout|ECONN|ENOTFOUND|ETIMEDOUT|fetch failed|网络|连接失败|context length|上下文.{0,4}(超|length)|token.{0,8}(超|limit)|不可用|not found|模型不存在/i.test(
    text,
  );
}

/**
 * 删除/终止这类不可逆动作。只看「这条指令真正要办的事」(intent)，不看正文：
 * 派工的正文外面裹着员工规则，里面常写“不要删除文件”“清理时注意”，
 * 拿整段正文判断会把正常的代码任务误判成删除类。
 *
 * 「清理」不在此列：单说清理可能只是整理，而模型不可用时任何任务都不会
 * 自动通过（见 accept），所以不必靠这个词兜底。
 */
function looksDestructive(text, intent = '') {
  const target = String(intent ?? '').trim() || String(text ?? '');
  return /(删掉|删除|删干净|全部删|清空|清掉|抹掉|移除|rm\s+-[rf]|rmdir|del\s+\/|unlink|kill\s+\d|终止进程|停掉|drop\s+table)/i.test(
    target,
  );
}

/**
 * 一段话里有没有“真的否定”。中文里“无不合格项”“没有失败”“失败 0 次”
 * 都是肯定，按词面匹配会把通过判成没验成。
 */
function hasRealNegative(text) {
  const raw = String(text ?? '');
  const re = /不通过|未通过|没通过|未测到|没测到|无法启动|跑不起来|不可用|不能用|不合格|失败/g;
  let match;
  while ((match = re.exec(raw))) {
    const before = raw.slice(Math.max(0, match.index - 8), match.index);
    const after = raw.slice(match.index + match[0].length, match.index + match[0].length + 8);
    if (/(?:无|没有|没|未发现|不存在|零|0)\s*$/.test(before)) continue;
    if (/^\s*(?:0|零)\s*(?:个|项|条|次|处)?/.test(after)) continue;
    return true;
  }
  return false;
}

/** 验收结论只认第一行；返回 true=通过、false=不通过、null=没看懂。 */
function parseVerdict(reply) {
  const raw = String(reply ?? '').trim();
  if (!raw) return null;
  const first = raw.split('\n').map((line) => line.trim()).find(Boolean) ?? '';
  const cleaned = first
    .replace(/^[#>*\-\s]+/, '')
    .replace(/^(验收结论|结论|判定|结果)\s*[:：]\s*/, '')
    .trim();
  if (/^(?:未验证|没验成|无法验证)/.test(cleaned)) return null;
  if (hasRealNegative(cleaned)) return false;
  if (/通过|可用|无问题|没问题|合格/.test(cleaned)) return true;
  return null;
}

/**
 * 验收范围只取这个员工声明改的文件。交付后的 files 是整轮扫描：
 * 并行时每个人都会看到别人的改动，验收员照着它跑就会验到无关的东西。
 * 路径写法对不上时退回整轮扫描，宁可多给也不能把证据丢掉。
 */
/**
 * 工作区里不该留的东西：员工自测留下的脚本目录、浏览器配置、临时日志。
 * 只列清单，不删——删文件前要领导点头。只扫根目录一层，避免误伤项目里的
 * 正常文件（例如项目自己的 tests/ 目录不算残留）。
 */
const LEFTOVER_DIRS = new Set(['.ezness', 'edge-profile', 'chrome-profile', 'puppeteer-profile']);
const LEFTOVER_FILE = /\.(log|tmp)$|^selftest\.out\.txt$/i;

function leftoverArtifacts(root) {
  if (!root) return [];
  let entries;
  try {
    entries = fsSync.readdirSync(root, { withFileTypes: true });
  } catch {
    return [];
  }
  return entries
    .filter(
      (entry) =>
        (entry.isDirectory() && LEFTOVER_DIRS.has(entry.name)) ||
        (entry.isFile() && LEFTOVER_FILE.test(entry.name)),
    )
    .map((entry) => `${entry.name}${entry.isDirectory() ? '/' : ''}`)
    .sort()
    .slice(0, 8);
}

function scopeFilesToDeclared(files, declared) {
  const list = (Array.isArray(files) ? files : []).filter(Boolean);
  const names = (Array.isArray(declared) ? declared : [])
    .map((item) => String(item).replace(/\\/g, '/').replace(/^\.\//, '').replace(/\/+$/, '').trim())
    .filter(Boolean);
  if (list.length === 0 || names.length === 0) return list;
  const hit = list.filter((file) => {
    const p = String(file.path ?? '').replace(/\\/g, '/').replace(/^\.\//, '');
    if (!p) return false;
    return names.some((name) => {
      // 扫描塌缩成整个项目目录时，只要目录里装着声明的文件就算命中。
      if (file.kind === 'directory') return p === '.' || name === p || name.startsWith(`${p}/`);
      return p === name || p.startsWith(`${name}/`) || name.startsWith(`${p}/`);
    });
  });
  return hit.length > 0 ? hit : list;
}

/** 把多轮返工产出的文件并在一起，按工作空间 + 相对路径去重。 */
function mergeDeliveredFiles(...lists) {
  const out = [];
  const seen = new Set();
  for (const list of lists) {
    for (const file of Array.isArray(list) ? list : []) {
      const key = `${file?.workspaceId ?? ''}:${file?.path ?? ''}`;
      if (!key || seen.has(key)) continue;
      seen.add(key);
      out.push(file);
      if (out.length >= 20) return out;
    }
  }
  return out;
}

// 只跳依赖/缓存目录：dist、build、out 里也可能就是用户要的成品，不能当成噪声。
const SCAN_SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.next',
  '.nuxt',
  '__pycache__',
  '.venv',
  'venv',
  '.cache',
  '.idea',
  '.vscode',
  '.gradle',
  '.pytest_cache',
  // 我们自己让验收员/员工放临时探针的地方，不是交付物。
  '.ezness',
]);
const SCAN_MAX_ENTRIES = 6000;
const SCAN_MAX_FILES = 60;
/** 超过这个数量就当成“整个项目”，发根目录，而不是刷一屏文件。 */
const SEND_MAX_FILES = 20;

/**
 * 项目清单。根目录有这些文件，说明这是一个完整项目；这一轮又改了 3 个以上
 * 文件时，直接把项目文件夹交给用户，而不是把一堆程序文件逐个列出来。
 */
const PROJECT_MARKERS = new Set([
  'package.json',
  'pnpm-workspace.yaml',
  'pyproject.toml',
  'setup.py',
  'requirements.txt',
  'Cargo.toml',
  'go.mod',
  'pom.xml',
  'build.gradle',
  'build.gradle.kts',
  'composer.json',
  'Gemfile',
  'CMakeLists.txt',
  'tsconfig.json',
  'vite.config.ts',
  'vite.config.js',
  'next.config.js',
  'next.config.mjs',
  'index.html',
]);

async function hasProjectMarker(root) {
  for (const name of PROJECT_MARKERS) {
    try {
      const stat = await fs.stat(path.join(root, name));
      if (stat.isFile()) return true;
    } catch {
      /* 没有这个清单就继续找 */
    }
  }
  return false;
}

/** 只给“能一眼看完”的文件算内容指纹；大文件跳过，别为了清单把磁盘读满。 */
const HASH_MAX_BYTES = 256 * 1024;

async function fileFingerprint(full, size) {
  if (size > HASH_MAX_BYTES) return '';
  try {
    const buf = await fs.readFile(full);
    return createHash('sha1').update(buf).digest('hex').slice(0, 12);
  } catch {
    return '';
  }
}

/**
 * 这一轮实际产出的文件：只认运行期间被改写的文件，不复制、不搬动。
 * 远程工作空间在别的机器上，拿不到 stat，直接跳过。
 */
async function collectRunFiles(task, since) {
  const root = String(task?.workspacePath ?? '');
  const workspaceId = String(task?.workspaceId ?? '');
  if (!root || !workspaceId || !Number.isFinite(since) || since <= 0) return [];
  let realRoot;
  try {
    realRoot = await fs.realpath(root);
    if (!(await fs.stat(realRoot)).isDirectory()) return [];
  } catch {
    return [];
  }
  const files = [];
  let visited = 0;
  // 运行结束的钩子不能卡住汇报；大项目扫到预算就收手，已经找到的文件照常交付。
  const deadline = Date.now() + 1200;
  const walk = async (dir) => {
    if (visited >= SCAN_MAX_ENTRIES || files.length >= SCAN_MAX_FILES) return;
    if (Date.now() > deadline) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (visited >= SCAN_MAX_ENTRIES || files.length >= SCAN_MAX_FILES) return;
      if (Date.now() > deadline) return;
      visited += 1;
      if (entry.name.startsWith('.') && entry.isDirectory()) continue;
      if (SCAN_SKIP_DIRS.has(entry.name)) continue;
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile()) continue;
      let stat;
      try {
        stat = await fs.stat(full);
      } catch {
        continue;
      }
      // 容错 2s：有的文件系统时间精度低，刚写的文件 mtime 会略早。
      if (stat.mtimeMs + 2000 < since) continue;
      files.push({
        workspaceId,
        path: path.relative(realRoot, full).split(path.sep).join('/'),
        name: entry.name,
        kind: 'file',
        size: stat.size,
        // 内容指纹：交付的是这一版、验收员读到的也是这一版，不是只有 mtime 对得上。
        hash: await fileFingerprint(full, stat.size),
        project: false,
      });
    }
  };
  await walk(realRoot);
  if (files.length === 0) return [];
  const segments = files.map((file) => String(file.path).split('/'));
  // 交付都落在同一个子目录（pm/ 这种）时，文件夹就是它，不是整个工作空间；
  // 否则交付卡上只剩一个“.”，领导点进去还得自己找。工作空间根上偶尔有
  // 自测产物（零散文件），主体仍在一个子目录时也按子目录算。
  const topCounts = new Map();
  for (const parts of segments) {
    const top = parts.length > 1 ? parts[0] : '';
    topCounts.set(top, (topCounts.get(top) || 0) + 1);
  }
  const sameTop =
    segments.every((parts) => parts.length > 1) &&
    segments.every((parts) => parts[0] === segments[0][0]);
  let commonTop = sameTop ? segments[0][0] : '';
  if (!commonTop) {
    const dirs = [...topCounts.entries()]
      .filter(([top]) => top)
      .sort((a, b) => b[1] - a[1]);
    if (dirs.length > 0 && dirs[0][1] >= files.length * 0.8 && files.length >= 3) {
      commonTop = dirs[0][0];
    }
  }
  // 根目录本身就是项目根（有 package.json 这类清单）时，不要缩到子目录。
  const projectFolder = (useCommonTop = true) => [
    {
      workspaceId,
      path: (useCommonTop && commonTop) || '.',
      name: (useCommonTop && commonTop) || path.basename(realRoot),
      kind: 'directory',
      size: 0,
      project: true,
    },
  ];
  if (files.length > SEND_MAX_FILES) return projectFolder();
  // 完整项目优先发文件夹：根目录有项目清单，且这一轮改了好几个文件；
  // 或者文件散在多个顶层目录里（src/、tests/、docs/…）。
  if (files.length >= 3 && (await hasProjectMarker(realRoot))) return projectFolder(false);
  const tops = new Set(files.map((file) => String(file.path).split('/')[0]));
  if (files.length >= 4 && tops.size >= 2) return projectFolder();
  return files;
}

class DirectorService {
  /**
   * @param {object} options
   * @param {string} options.dir             director state directory
   * @param {string} options.sessionDir      agent session directory
   * @param {() => object} options.getState  current director state
   * @param {() => Promise<object|null>} options.getProvider
   * @param {(taskId, callId, decision) => boolean} options.resolveRun
   * @param {(channel: string, payload: unknown) => void} options.broadcast
   * @param {(report: object) => void} [options.onUsage]
   * @param {(taskId: string, since: number) => object|null} [options.usageFor]
   */
  constructor(options) {
    this.dir = options.dir;
    this.sessionDir = options.sessionDir;
    this.getState = options.getState;
    this.getProvider = options.getProvider;
    this.resolveRun = options.resolveRun;
    this.broadcast = options.broadcast ?? (() => {});
    this.onUsage = options.onUsage ?? (() => {});
    this.usageFor =
      typeof options.usageFor === 'function' ? options.usageFor : () => null;
    /** 已有哪些预制能力：只用来让模型别推荐已经存在的东西。 */
    this.listPresets =
      typeof options.listPresets === 'function' ? options.listPresets : () => ({ tools: [], agents: [] });

    this.inbox = [];
    this.instructions = [];
    this.memory = [];
    /** 总监手里的项目档案：派工或连续任务，key 是 dispatchId / task:<id>。 */
    this.projects = new Map();
    /** 正在生成“可以进入调试了”的项目，避免两个收口路径同时各发一条。 */
    this.debugPending = new Set();
    /** 整体衔接检查的节流；完工后只查一轮，别每 15 秒问一次模型。 */
    this.lastIntegrationAt = 0;
    this.ledger = [];
    /** 重复工作的指纹；只在本地统计，结果才可能进收件箱。 */
    this.patterns = [];
    /** 最近发出的必读建议时间（每天限额用）。 */
    this.adviceLog = [];
    /** 正在判断的指纹，避免两轮同时结束就重复提问。 */
    this.patternReviews = new Set();
    /** 用户点「让总监给建议」时，同一时间只跑一次。 */
    this.reviewingNow = false;
    this.tasks = new Map();
    /** 每个工作空间探测一次的环境事实卡，按 workspaceId 存，避免每个员工重新摸一遍。 */
    this.envCards = new Map();
    /** 正在探测的空间；同一空间不并发探两次。 */
    this.envBuilding = new Set();
    /** 分管空间本身的 id/名称/本地路径；没有任务时也要能看空间里有什么。 */
    this.spaces = new Map();
    this.runs = new Map();
    this.pendingDelivery = new Map();
    this.reportTimers = new Map();
    this.pendingReports = new Map();
    this.lastReportAt = new Map();
    this.lastAlertAt = new Map();
    this.autoApprovals = new Map();
    /** 已经广播给界面、还在等任务建立的回执。dispatchId → 待建员工。 */
    this.spawns = new Map();
    /** 交给界面的任务操作（导出/删除），等界面回执。 */
    this.pendingOps = new Map();

    /** 这一进程是什么时候把旧状态读进来的：早于它的指令属于上一次进程。 */
    this.loadedAt = 0;
    this.syncedAt = 0;
    this.typingAt = 0;
    this.interactive = 0;
    this.timer = null;
    this.saveTimers = new Map();
    this.aiInFlight = 0;
    this.stopped = false;
    this.ticking = false;
  }

  /* ------------------------------------------------------------------ */
  /* lifecycle + storage                                                */
  /* ------------------------------------------------------------------ */

  async start() {
    await this.load();
    if (this.timer) clearInterval(this.timer);
    this.timer = setInterval(() => {
      this.tick().catch(() => undefined);
    }, TICK_MS);
    if (this.timer.unref) this.timer.unref();
  }

  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    for (const timer of this.reportTimers.values()) clearTimeout(timer);
    this.reportTimers.clear();
    for (const timer of this.saveTimers.values()) clearTimeout(timer);
    this.saveTimers.clear();
    await this.flush();
  }

  async load() {
    const inbox = await readJson(this.dir, FILES.inbox, []);
    this.inbox = (Array.isArray(inbox) ? inbox : [])
      .map(normalizeInboxItem)
      .filter(Boolean)
      .slice(-MAX_INBOX);
    const instructions = await readJson(this.dir, FILES.instructions, []);
    this.instructions = (Array.isArray(instructions) ? instructions : [])
      .map(normalizeInstruction)
      .filter(Boolean)
      .slice(-MAX_INSTRUCTIONS);
    for (const instruction of this.instructions) instruction.restored = true;
    // A delivery whose run never started (app closed mid-handshake) goes back
    // to the queue instead of being counted as done forever.
    for (const instruction of this.instructions) {
      if (instruction.state === 'delivered' && !instruction.deliveredAt) {
        instruction.state = 'queued';
      }
    }
    const memory = await readJson(this.dir, FILES.memory, []);
    this.memory = (Array.isArray(memory) ? memory : [])
      .map(normalizeMemory)
      .filter(Boolean)
      .slice(-MAX_MEMORY);
    const environments = await readJson(this.dir, FILES.environments, []);
    this.envCards = new Map();
    for (const card of Array.isArray(environments) ? environments : []) {
      const id = idOf(card?.workspaceId);
      if (id && card?.at) this.envCards.set(id, card);
    }
    const projects = await readJson(this.dir, FILES.projects, []);
    this.projects = new Map();
    for (const entry of Array.isArray(projects) ? projects : []) {
      const project = normalizeProject(entry);
      if (project) this.projects.set(project.id, project);
    }
    const patterns = workPatterns.normalizeState(await readJson(this.dir, FILES.patterns, {}));
    this.patterns = patterns.patterns;
    this.adviceLog = patterns.advice;
    try {
      const text = await fs.readFile(path.join(this.dir, FILES.ledger), 'utf8');
      this.ledger = text
        .split('\n')
        .map((line) => line.trim())
        .filter(Boolean)
        .slice(-MAX_LEDGER)
        .map((line) => {
          try {
            return enrichLedgerEntry(JSON.parse(line));
          } catch {
            return null;
          }
        })
        .filter(Boolean);
    } catch {
      this.ledger = [];
    }
    this.loadedAt = Date.now();
  }

  scheduleSave(kind) {
    if (this.stopped) return;
    if (this.saveTimers.has(kind)) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete(kind);
      this.saveKind(kind).catch(() => undefined);
    }, 500);
    if (timer.unref) timer.unref();
    this.saveTimers.set(kind, timer);
  }

  async saveKind(kind) {
    if (kind === 'inbox') await writeJson(this.dir, FILES.inbox, this.inbox);
    if (kind === 'instructions') {
      await writeJson(this.dir, FILES.instructions, this.instructions);
    }
    if (kind === 'memory') await writeJson(this.dir, FILES.memory, this.memory);
    if (kind === 'projects') {
      await writeJson(this.dir, FILES.projects, [...this.projects.values()]);
    }
    if (kind === 'patterns') {
      await writeJson(this.dir, FILES.patterns, { patterns: this.patterns, advice: this.adviceLog });
    }
    if (kind === 'environments') {
      await writeJson(this.dir, FILES.environments, [...this.envCards.values()]);
    }
  }

  async flush() {
    await Promise.all([
      this.saveKind('inbox'),
      this.saveKind('instructions'),
      this.saveKind('memory'),
      this.saveKind('projects'),
      this.saveKind('patterns'),
      this.saveKind('environments'),
    ]);
    await this.writeLedger();
  }

  async writeLedger() {
    await fs.mkdir(this.dir, { recursive: true });
    const body = this.ledger.map((entry) => JSON.stringify(entry)).join('\n');
    const file = path.join(this.dir, FILES.ledger);
    const temp = `${file}.tmp`;
    await fs.writeFile(temp, body ? `${body}\n` : '', 'utf8');
    await fs.rename(temp, file);
  }

  ledgerPush(entry) {
    const kind = oneLine(entry.kind, 40);
    const meta = LEDGER_KIND[kind] ?? { side: 'task', label: kind };
    const item = {
      at: Date.now(),
      kind,
      side: meta.side,
      label: meta.label,
      taskId: String(entry.taskId ?? ''),
      title: oneLine(entry.title, 120),
      text: clip(entry.text ?? '', 600),
    };
    this.ledger.push(item);
    if (this.ledger.length > MAX_LEDGER) this.ledger = this.ledger.slice(-MAX_LEDGER);
    this.scheduleLedger();
  }

  scheduleLedger() {
    if (this.stopped) return;
    if (this.saveTimers.has('ledger')) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete('ledger');
      this.writeLedger().catch(() => undefined);
    }, 1000);
    if (timer.unref) timer.unref();
    this.saveTimers.set('ledger', timer);
  }

  /* ------------------------------------------------------------------ */
  /* board                                                              */
  /* ------------------------------------------------------------------ */

  /** The renderer owns the task list; it pushes a compact board here. */
  sync(list = [], spaces = []) {
    const now = Date.now();
    this.syncedAt = now;
    // 空间清单：任务全删光时总监仍然要知道每个分管空间的路径，才能看里面还剩什么。
    const nextSpaces = new Map();
    for (const raw of Array.isArray(spaces) ? spaces : []) {
      const spaceId = idOf(raw?.id);
      if (!spaceId) continue;
      nextSpaces.set(spaceId, {
        id: spaceId,
        name: oneLine(raw?.name, 120),
        path: String(raw?.path ?? ''),
      });
    }
    if (nextSpaces.size > 0) this.spaces = nextSpaces;
    const seen = new Set();
    for (const raw of Array.isArray(list) ? list : []) {
      const id = idOf(raw?.id);
      if (!id) continue;
      const previous = this.tasks.get(id) ?? {};
      const running = this.runs.get(id);
      this.tasks.set(id, {
        id,
        title: oneLine(raw?.title ?? previous.title, 120) || '未命名任务',
        space: oneLine(raw?.space ?? previous.space, 120),
        workspaceId: String(raw?.workspaceId ?? previous.workspaceId ?? ''),
        workspacePath: String(raw?.workspacePath ?? previous.workspacePath ?? ''),
        busy: Boolean(running) || Boolean(raw?.busy),
        status: running ? 'running' : oneLine(raw?.status, 20) || previous.status || 'idle',
        askLevel: Number.isInteger(raw?.askLevel) ? raw.askLevel : previous.askLevel,
        runStartedAt: Number(raw?.runStartedAt) || previous.runStartedAt || 0,
        lastRunStartedAt: Number(raw?.lastRunStartedAt) || previous.lastRunStartedAt || 0,
        lastDurationMs: Number(raw?.lastDurationMs) || previous.lastDurationMs || 0,
        updatedAt: Number(raw?.updatedAt) || previous.updatedAt || now,
        seenAt: now,
      });
      seen.add(id);
    }
    // A running task stays on the board even if the renderer's list is mid-reload.
    for (const taskId of this.runs.keys()) {
      if (!this.tasks.has(taskId)) {
        this.tasks.set(taskId, {
          id: taskId,
          title: '任务',
          space: '',
          workspaceId: '',
          busy: true,
          status: 'running',
          updatedAt: now,
          seenAt: now,
        });
      }
    }
    // 会话或整个空间被删掉之后，渲染层不会再推它。留在这里只会一直显示
    // "运行中"，排队的指令也永远等一个已经不存在的任务。缺席够久就清掉。
    for (const [taskId, task] of this.tasks) {
      if (seen.has(taskId)) continue;
      if (now - (task.seenAt ?? now) <= TASK_FORGET_MS) continue;
      this.forgetTask(taskId, { reason: '任务或工作空间已被删除' });
    }
    for (const [id, task] of this.tasks) {
      if (now - task.seenAt > 30 * 24 * 60 * 60 * 1000) this.tasks.delete(id);
    }
    this.reconcileStale(seen);
    this.reconcileDeliveredInstructions();
    this.drain();
  }

  /**
   * 同一任务上可能堆着几条 delivered 的旧指令：新指令覆盖旧指令时，旧的没有
   * 收尾，验收时又容易认错人。这里只保留最新的一条（正在跑的那条），其余
   * 标记为被替代；改动后再让分配重新判断能不能收尾。
   */
  reconcileDeliveredInstructions() {
    const groups = new Map();
    for (const instruction of this.instructions) {
      if (instruction.state !== 'delivered' || instruction.source === 'user') continue;
      const list = groups.get(instruction.taskId) || [];
      list.push(instruction);
      groups.set(instruction.taskId, list);
    }
    let changed = false;
    const touched = new Set();
    for (const [taskId, list] of groups) {
      if (list.length < 2) continue;
      list.sort(
        (a, b) =>
          (b.startedAt || b.deliveredAt || b.createdAt) -
          (a.startedAt || a.deliveredAt || a.createdAt),
      );
      const keep = list[0];
      for (const stale of list.slice(1)) {
        stale.state = 'discarded';
        stale.finishedAt = Date.now();
        stale.note = '被更新的指令替代，未验收';
        if (!stale.resultNote) stale.resultNote = '被后续指令替代';
        if (stale.dispatchId) touched.add(stale.dispatchId);
        this.ledgerPush({
          kind: 'instruction:superseded',
          taskId,
          title: stale.taskTitle,
          text: `由 ${keep.id} 替代`,
        });
        changed = true;
      }
    }
    // 重启前已经开始跑、现在却没有对应 run 的指令：这一轮已经不会再有任何
    // run:end，也会被验收，就永远卡在 delivered，把分配汇总一起堵死。
    // 界面起来一分钟以后还没有跑起来的，按“未验证”收尾，让汇总能正常发出去。
    // 停了好几天的旧指令只悄悄收掉：现在再补一条“分结束了”只会翻出陈年旧账。
    const settled = [];
    if (this.loadedAt && Date.now() - this.loadedAt >= RECONCILE_GRACE_MS) {
      const now = Date.now();
      for (const instruction of this.instructions) {
        if (instruction.state !== 'delivered' || !instruction.startedAt) continue;
        if (instruction.source === 'user' || !instruction.restored) continue;
        if (this.runs.has(instruction.taskId)) continue;
        const stale = now - instruction.startedAt > ORPHAN_SETTLE_MAX_AGE_MS;
        instruction.state = stale ? 'discarded' : 'accepted';
        instruction.finishedAt = now;
        if (stale) {
          instruction.note = '停机太久，按过期收尾';
          if (!instruction.resultNote) instruction.resultNote = '停机太久，未验证';
        } else {
          instruction.unverified = true;
          instruction.resultNote = '进程重启后没等到这一轮的收尾（未验证）';
          settled.push(instruction);
          if (instruction.dispatchId) touched.add(instruction.dispatchId);
        }
        // 验收员没跑完：原任务不能一直停在“验收中”，如实记未验证。
        if (instruction.role === 'verify') {
          const parent = this.instructions.find(
            (item) => item.id === instruction.parentInstructionId,
          );
          if (parent && parent.verificationPending) {
            parent.verificationPending = false;
            parent.state = 'escalated';
            parent.unverified = true;
            parent.verdict = 'unverified';
            parent.finishedAt = now;
            parent.resultNote = stale
              ? '验收员停机太久，未验证'
              : '验收员重启后没跑完，未验证';
            if (parent.dispatchId) touched.add(parent.dispatchId);
          }
        }
        this.ledgerPush({
          kind: stale ? 'instruction:expired' : 'instruction:orphan',
          taskId: instruction.taskId,
          title: instruction.taskTitle,
          text: stale ? '停机太久，旧指令按过期收尾' : '重启后没有对应的运行记录，按未验证收尾',
        });
        changed = true;
      }
    }
    if (!changed) return;
    this.scheduleSave('instructions');
    for (const dispatchId of touched) this.maybeFinishDispatch(dispatchId);
    if (settled.length > 0 && !settled.some((item) => item.dispatchId)) {
      this.addInbox({
        kind: 'report',
        title: '上次没跑完的验收我收尾了',
        body: `重启前还有 ${settled.length} 条指令停在半路，这一轮等不到结果了。我按“未验证”记下，没当成通过；你看到哪条不对，我再让它补。`,
        taskId: settled[0].taskId,
        taskTitle: settled[0].taskTitle,
      });
    }
  }

  /**
   * 重启前留下的指令：如果它指向的任务已经不在看板上，就别再一条条问用户了
   * （那会是几十张“这条指令没能执行”的卡）。收尾一次，留一条汇总。
   * 进程启动后新产生的指令不在这里处理，仍然走 askBlocked 问用户。
   */
  reconcileStale(seen) {
    if (!this.loadedAt) return;
    // 界面刚起来时任务板可能是空的，给它一分钟加载。
    if (Date.now() - this.loadedAt < RECONCILE_GRACE_MS) return;
    const dropped = [];
    for (const instruction of this.instructions) {
      if (!['queued', 'delivered', 'rework'].includes(instruction.state)) continue;
      if (seen.has(instruction.taskId)) continue;
      if (this.tasks.has(instruction.taskId)) continue;
      if (!instruction.restored) continue;
      instruction.state = 'discarded';
      instruction.note = '重启后任务已经不存在，已放弃';
      instruction.finishedAt = Date.now();
      dropped.push(instruction);
    }
    if (dropped.length === 0) return;
    this.scheduleSave('instructions');
    this.ledgerPush({
      kind: 'instruction:stale',
      text: `重启后收尾了 ${dropped.length} 条没有对应任务的旧指令`,
    });
    this.addInbox({
      kind: 'report',
      title: '重启后收尾了旧指令',
      body: [
        `有 ${dropped.length} 条指令对应的任务在重启后已经不存在了，我没有再执行，已标记为放弃：`,
        ...dropped.slice(0, 10).map(
          (item) => `- ${item.taskTitle || item.taskId}：${clip(item.text, 80)}`,
        ),
      ].join('\n'),
      taskId: '',
    });
  }

  /**
   * 任务已经不存在了：把它从看板、运行表、队列里一起收掉。否则它会一直
   * 挂着"运行中"，它名下的指令也永远不会被送去执行。
   */
  forgetTask(taskId, { reason = '' } = {}) {
    const id = idOf(taskId);
    if (!id) return;
    const note = oneLine(reason, 200) || '任务已删除';
    this.runs.delete(id);
    this.tasks.delete(id);
    this.pendingDelivery.delete(id);
    const touched = new Set();
    for (const item of this.instructions) {
      if (item.taskId !== id) continue;
      if (!['queued', 'delivered', 'rework', 'held'].includes(item.state)) continue;
      item.state = 'discarded';
      item.note = note;
      item.finishedAt = Date.now();
      if (item.dispatchId) touched.add(item.dispatchId);
    }
    this.scheduleSave('instructions');
    this.ledgerPush({ kind: 'task:forget', taskId: id, text: note });
    for (const dispatchId of touched) this.maybeFinishDispatch(dispatchId);
  }

  /**
   * 任务本身的操作：置顶/取消置顶、重命名、导出 Markdown、删除。
   * 任务数据在渲染层（workspaces.json），所以这里只校验和广播；删除必须
   * 先过用户的确认卡，绝不自己动手。
   */
  taskAction({ action = '', taskIds = [], all = false, title = '' } = {}) {
    const state = this.getState();
    if (!state.enabled) return { ok: false, error: '工作总监未启用' };
    const name = oneLine(title, 120);
    const wanted = [
      ...new Set((Array.isArray(taskIds) ? taskIds : []).map(idOf).filter(Boolean)),
    ];
    // 只管分管范围里的任务：未分管的空间连任务名都不该进总监视野。
    const available = [...this.tasks.values()].filter(
      (task) => idOf(task.id) && this.monitored(task.id),
    );
    const targets = all ? available : available.filter((task) => wanted.includes(task.id));
    if (targets.length === 0) {
      return {
        ok: false,
        error: wanted.some((id) => this.tasks.has(id))
          ? '这些任务不在你的分管范围里。先让用户把对应工作空间加进分管范围。'
          : '没有找到这些任务。先用 director_board 看任务 id。',
      };
    }
    const ids = targets.map((task) => task.id);

    if (action === 'rename') {
      if (!name) return { ok: false, error: '重命名需要给出新的标题' };
      this.broadcast('director:task-action', { action: 'rename', taskIds: ids, title: name });
      this.ledgerPush({ kind: 'task:rename', text: `${ids.length} 个任务 → ${name}` });
      return { ok: true, count: ids.length, message: `已重命名为「${name}」。` };
    }
    if (action === 'pin' || action === 'unpin') {
      this.broadcast('director:task-action', { action, taskIds: ids });
      const label = action === 'pin' ? '置顶' : '取消置顶';
      this.ledgerPush({ kind: 'task:pin', text: `${label} ${ids.length} 个任务` });
      return { ok: true, count: ids.length, message: `已${label} ${ids.length} 个任务。` };
    }
    if (action === 'export') {
      const opId = uid('taskop');
      this.pendingOps.set(opId, { action: 'export', taskIds: ids });
      this.broadcast('director:task-action', { opId, action: 'export', taskIds: ids });
      return {
        ok: true,
        pending: true,
        count: ids.length,
        message: '已交给界面导出；完成后会作为文件卡片发出来。',
      };
    }
    if (action === 'delete') {
      // 删任务是工作空间里的日常整理，不是高危；只有会毁掉正在进行的工作、
      // 或者一次删一大片时，才值得打断用户。观察级别不动手。
      const running = targets.filter((task) => task.busy);
      const bulk = targets.length >= 5;
      const wholeBoard = Boolean(all) && targets.length > 1;
      const risky = running.length > 0 || bulk || wholeBoard;

      if (state.mode === 'observe') {
        return {
          ok: false,
          error: `现在是观察级别：我看得出你要删 ${ids.length} 个任务，但我不动手。切到代跑，或者你自己删。`,
        };
      }

      if (risky || state.mode !== 'run') {
        const preview = targets
          .slice(0, 20)
          .map((task) => `- ${task.title}（${task.space || '未知空间'}）`)
          .join('\n');
        const rest = targets.length > 20 ? `\n…还有 ${targets.length - 20} 个` : '';
        const why = running.length > 0
          ? `其中 ${running.length} 个任务还在跑，删掉会中断正在做的工作。`
          : wholeBoard
            ? '这是看板上的全部任务。'
            : bulk
              ? `一次删 ${ids.length} 个，数量偏多。`
              : '';
        this.addConfirm('', {
          title: `要删除 ${ids.length} 个任务`,
          body: [
            why,
            `选了 ${ids.length} 个任务：`,
            `${preview}${rest}`,
            '',
            '任务本身和里面的对话记录会一起删掉，删了找不回来。工作空间和里面的文件不会动。',
            '确认后界面立刻删除；不想删就点「先不动」。',
          ].filter(Boolean).join('\n'),
          actions: [
            { id: 'confirm', label: `删除 ${ids.length} 个任务`, style: 'danger' },
            { id: 'dismiss', label: '先不动' },
          ],
          payload: { kind: 'task-op', action: 'delete', taskIds: ids },
          urgent: true,
        });
        return {
          ok: true,
          pending: true,
          count: ids.length,
          message: state.mode === 'run'
            ? '这批删除风险高，已经列出来等你点头。'
            : '现在是建议级别，列出来等你点头。',
        };
      }

      this.broadcastTaskDelete(ids);
      this.ledgerPush({ kind: 'task:delete', text: `总监删除 ${ids.length} 个任务` });
      return {
        ok: true,
        count: ids.length,
        message: `已删除 ${ids.length} 个任务：${targets
          .slice(0, 5)
          .map((task) => task.title)
          .join('、')}${targets.length > 5 ? ' 等' : ''}。工作空间和文件没有动。`,
      };
    }
    return { ok: false, error: `不认识的任务操作：${action}` };
  }

  /**
   * 叫停某个任务正在跑的这一轮。和用户按「停止」同一条路（界面 agentAbort），
   * 只中断这一轮，任务、对话和已经写出的文件都留着；排队中的指令随后开始。
   */
  interruptTask(taskId) {
    const id = idOf(taskId);
    if (!id) return { ok: false, error: '需要 taskId。' };
    if (!this.tasks.has(id)) return { ok: false, error: '没有这个任务。' };
    if (!this.monitored(id)) return { ok: false, error: '这个任务不在你的分管范围里。' };
    const run = this.runs.get(id);
    if (!run) return { ok: false, error: '这个任务现在没有在跑。' };
    this.broadcast('director:task-action', { action: 'stop', taskIds: [id] });
    this.ledgerPush({
      kind: 'task:stop',
      taskId: id,
      title: this.tasks.get(id)?.title,
      text: '总监叫停当前这一轮',
    });
    return { ok: true, taskId: id };
  }

  /** 把删除交给界面执行；任务数据在渲染层，主进程不碰文件。 */
  broadcastTaskDelete(ids) {
    const opId = uid('taskop');
    this.pendingOps.set(opId, { action: 'delete', taskIds: ids });
    this.broadcast('director:task-action', { opId, action: 'delete', taskIds: ids });
    return opId;
  }

  /** 界面执行完任务操作后的回执：删本地看板、发文件卡片或汇总。 */
  taskAck({ opId = '', ok = true, deleted = [], files = [], error = '' } = {}) {
    const key = String(opId ?? '');
    const op = this.pendingOps.get(key) ?? null;
    if (op) this.pendingOps.delete(key);
    if (!op) return { ok: true };
    if (!ok) {
      this.addInbox({
        kind: 'alert',
        title: '任务操作没有完成',
        body: `这次「${op.action === 'delete' ? '删除任务' : '导出任务'}」没有做成：${oneLine(error, 300) || '界面没有返回原因'}`,
        taskId: '',
        urgent: true,
      });
      this.ledgerPush({ kind: 'task:forget', text: `任务操作失败：${oneLine(error, 200)}` });
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (op.action === 'delete') {
      for (const id of op.taskIds) this.forgetTask(id, { reason: '用户确认删除任务' });
      const titles = (Array.isArray(deleted) ? deleted : [])
        .map((item) => oneLine(typeof item === 'string' ? item : item?.title, 120))
        .filter(Boolean);
      const count = titles.length || op.taskIds.length;
      this.addInbox({
        kind: 'report',
        title: '任务已删除',
        body: [
          `删掉了 ${count} 个任务：`,
          ...titles.slice(0, 20).map((title) => `- ${title}`),
          '工作空间和里面的文件没有动。',
        ].join('\n'),
        taskId: '',
      });
      this.ledgerPush({ kind: 'task:delete', text: `删除了 ${count} 个任务` });
    }

    if (op.action === 'export' && Array.isArray(files) && files.length > 0) {
      const items = files
        .map((file) => {
          const filePath = String(file?.path ?? '');
          if (!filePath) return null;
          const task = this.tasks.get(idOf(file?.taskId));
          return {
            workspaceId: task?.workspaceId ?? '',
            path: filePath,
            name: String(file?.name || path.basename(filePath)),
          };
        })
        .filter(Boolean);
      if (items.length > 0) {
        this.addInbox({
          kind: 'report',
          title: `已导出 ${items.length} 个任务的 Markdown`,
          body: items.map((item) => `- ${item.name}`).join('\n'),
          taskId: '',
          files: items,
          needsRead: true,
        });
        this.ledgerPush({ kind: 'task:export', text: `导出 ${items.length} 个任务` });
      }
    }
    this.scheduleSave('inbox');
    this.broadcastSummary();
    return { ok: true };
  }

  taskOf(taskId) {
    return this.tasks.get(idOf(taskId)) ?? null;
  }

  /**
   * 任务的工作空间根目录。界面同步过来的任务只带 workspaceId，不带
   * workspacePath；只认 task.workspacePath 的话，本地任务会被当成远程空间，
   * 文件核对、交付预检、删除后状态检查全都会静默跳过。路径以空间表为准。
   */
  workspaceRootOf(task) {
    if (!task) return '';
    const direct = String(task.workspacePath ?? '').trim();
    if (direct) return direct;
    return String(this.spaces.get(idOf(task.workspaceId))?.path ?? '').trim();
  }

  /**
   * 领导同一条原话最近是不是已经被一个现有任务接住了。
   * 总监偶尔会同时走 director_instruct 和 director_dispatch，或者给刚派出的
   * 员工再补一条“现在执行”：两路都发就是两个员工做同一件事，后一条还会
   * 顶掉前一条，把已经开始的那一轮叫停。按 userText 认这条消息。
   */
  recentSameUserText(userText, { excludeDispatchId = '', withinMs = 2 * 60 * 1000 } = {}) {
    const needle = String(userText ?? '').replace(/\s+/g, ' ').trim();
    if (needle.length < 8) return null;
    const now = Date.now();
    return (
      [...this.instructions]
        .reverse()
        .find(
          (item) =>
            String(item.userText ?? '').replace(/\s+/g, ' ').trim() === needle &&
            item.createdAt >= now - withinMs &&
            !['discarded', 'escalated'].includes(item.state) &&
            item.role !== 'verify' &&
            !item.askOnly &&
            !(excludeDispatchId && item.dispatchId === excludeDispatchId),
        ) ?? null
    );
  }

  spaceAccess(taskId) {
    const task = this.taskOf(taskId);
    if (!task) return 'off';
    return director.accessFor(this.getState(), task.workspaceId);
  }

  monitored(taskId) {
    return this.spaceAccess(taskId) !== 'off';
  }

  writable(taskId) {
    return this.spaceAccess(taskId) === 'write';
  }

  /**
   * 正在执行的员工任务（同一次分配可能拆出多个）。
   * 验收员也算一个工位：一个人要么在编制、要么在验收，所以这里一起占名额。
   */
  runningDispatchTaskIds() {
    const ids = new Set();
    for (const taskId of this.runs.keys()) {
      if (
        this.instructions.some(
          (item) =>
            item.taskId === taskId &&
            ['delivered', 'rework'].includes(item.state) &&
            (item.dispatchId || item.role === 'verify'),
        )
      ) {
        ids.add(taskId);
      }
    }
    return ids;
  }

  /** 某次分配里的全部指令。 */
  dispatchGroup(dispatchId) {
    const id = String(dispatchId ?? '');
    if (!id) return [];
    return this.instructions.filter((item) => item.dispatchId === id);
  }

  /** 这个任务归属的最近一次分配；补发的指令靠它归队，避免各发各的汇报。 */
  dispatchOfTask(taskId) {
    const id = idOf(taskId);
    if (!id) return '';
    const item = [...this.instructions]
      .reverse()
      .find((entry) => entry.taskId === id && entry.dispatchId);
    return item?.dispatchId ?? '';
  }

  /* ------------------------------------------------------------------ */
  /* projects                                                           */
  /* ------------------------------------------------------------------ */

  /** 拿一个项目；没有就按当前信息建一份。编制和验收各记一个预计时间。 */
  ensureProject({
    id,
    kind = 'dispatch',
    title,
    goal = '',
    workspaceId = '',
    estimateMinutes = 0,
    verifyMinutes = 0,
  }) {
    const key = idOf(id);
    if (!key) return null;
    let project = this.projects.get(key);
    const startedAt = Date.now();
    if (!project) {
      project = normalizeProject({
        id: key,
        kind,
        title: title || '未命名项目',
        goal,
        workspaceId,
        startedAt,
        estimateMs: Math.max(0, Number(estimateMinutes) || 0) * 60 * 1000,
        estimateAt: Number(estimateMinutes) > 0 ? startedAt : 0,
      });
      this.projects.set(key, project);
      this.scheduleSave('projects');
    }
    if (title) project.title = oneLine(title, 120) || project.title;
    // 目标只记第一次：后面补发的指令是执行细节，不能把项目目标改掉。
    if (goal && !project.goal) project.goal = clip(goal, 1200);
    if (workspaceId) project.workspaceId = String(workspaceId);
    if (Number(estimateMinutes) > 0 && !project.estimateMs) {
      project.estimateMs = Number(estimateMinutes) * 60 * 1000;
      project.estimateAt = Date.now();
      project.estimateNote = project.estimateNote || '总监按 AI 编程速度估的';
    }
    // 新建时 estimateMs 已经写进去了，不能靠“刚刚才赋值”来判断要不要算检查点。
    if (project.estimateMs > 0 && !project.buildEtaAt) {
      project.buildEtaAt = project.startedAt + project.estimateMs;
    }
    // 验收预计：总监给了就照用；没给按编制的 40% 估，最少 5 分钟。
    if (!project.verifyEstimateMs) {
      const minutes =
        Number(verifyMinutes) > 0
          ? Number(verifyMinutes)
          : Math.max(5, Math.ceil((Number(estimateMinutes) || 0) * 0.4));
      project.verifyEstimateMs = minutes * 60 * 1000;
      project.verifyEtaAt =
        (project.buildEtaAt || project.startedAt + project.estimateMs || startedAt) +
        project.verifyEstimateMs;
    }
    project.updatedAt = Date.now();
    return project;
  }

  projectOfInstruction(instruction) {
    if (!instruction) return null;
    if (instruction.dispatchId) return this.projects.get(idOf(instruction.dispatchId)) ?? null;
    return this.projects.get(taskProjectId(instruction.taskId)) ?? null;
  }

  addProjectTask(projectId, taskId) {
    const project = this.projects.get(idOf(projectId));
    const id = idOf(taskId);
    if (!project || !id) return;
    if (!project.taskIds.includes(id)) {
      project.taskIds.push(id);
      project.taskIds = project.taskIds.slice(-40);
    }
    project.updatedAt = Date.now();
    this.scheduleSave('projects');
  }

  addProjectDecision(projectId, text) {
    const project = this.projects.get(idOf(projectId));
    if (!project) return;
    const line = oneLine(text, 300);
    if (!line) return;
    project.decisions.push({ at: Date.now(), text: line });
    project.decisions = project.decisions.slice(-12);
    project.updatedAt = Date.now();
    this.scheduleSave('projects');
  }

  finishProject(projectId) {
    const project = this.projects.get(idOf(projectId));
    if (!project || project.status === 'done') return;
    // 任务型项目没有派工汇总，收口前也走同一个“可以进入调试了”的判断。
    void this.announceDebugReady(project.id).catch(() => undefined);
    this.reconcileProject(project);
    project.status = 'done';
    project.finishedAt = Date.now();
    project.updatedAt = Date.now();
    this.scheduleSave('projects');
  }

  /**
   * 收口对账：计划几个人/多久，实际几个人/多久，返工几轮。
   * 这不是给用户看的报表，是总监下一次估时和决定拆不拆的依据。
   * 只在真正有编制的派工上做；验收员的一次性检查不单独记账。
   */
  reconcileProject(project) {
    if (!project || project.kind !== 'dispatch' || project.actual) return;
    const group = this.dispatchGroup(project.id);
    const builds = group.filter((item) => item.role !== 'verify');
    if (builds.length === 0) return;
    const names = new Set(builds.map((item) => item.employeeName || item.taskId));
    // 早期记录里 plan.estimateMinutes 可能是 0（当时没把估时带进派工回执），
    // 用项目档案上的 estimateMs 兜底，别在台账里写“计划 0 分钟”。
    const planMinutes =
      Math.max(0, Number(project.plan?.estimateMinutes) || 0) ||
      Math.max(0, Math.round((Number(project.estimateMs) || 0) / 60000));
    const planVerify =
      Math.max(0, Number(project.plan?.verifyMinutes) || 0) ||
      Math.max(0, Math.round((Number(project.verifyEstimateMs) || 0) / 60000));
    project.actual = {
      minutes: Math.max(1, Math.round((Date.now() - project.startedAt) / 60000)),
      parallelism: Math.max(1, names.size || 1),
      rounds: builds.reduce((max, item) => Math.max(max, Number(item.round) || 0), 0),
      at: Date.now(),
    };
    if (!project.plan) return;
    project.plan.estimateMinutes = planMinutes || project.plan.estimateMinutes;
    project.plan.verifyMinutes = planVerify || project.plan.verifyMinutes;
    this.ledgerPush({
      kind: 'project:reconcile',
      title: project.title,
      text:
        `计划 ${project.plan.parallelism} 人 ${project.plan.estimateMinutes} 分钟编制` +
        `${project.plan.verifyMinutes > 0 ? ` + ${project.plan.verifyMinutes} 分钟验收` : ''} → ` +
        `实际 ${project.actual.parallelism} 人 ${project.actual.minutes} 分钟，` +
        `返工 ${project.actual.rounds} 轮`,
    });
  }

  projectView() {
    return [...this.projects.values()]
      .filter((project) => project.status === 'active')
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 20)
      .map((project) => ({
        id: project.id,
        title: project.title,
        goal: project.goal,
        startedAt: project.startedAt,
        estimateMs: project.estimateMs,
        elapsedMs: Math.max(0, Date.now() - project.startedAt),
        plan: project.plan,
        actual: project.actual,
        decisions: project.decisions.slice(-5),
        lastReport: project.lastReport,
        taskIds: [...project.taskIds],
      }));
  }

  projectAction({
    action = 'list',
    projectId = '',
    estimateMinutes = 0,
    verifyMinutes = 0,
    note = '',
  } = {}) {
    if (action === 'list') {
      const projects = this.projectView();
      if (projects.length === 0) return { ok: true, message: '现在手里没有进行中的项目。' };
      const lines = projects.map((project) => {
        const used = Math.round(project.elapsedMs / 60000);
        const eta = project.estimateMs > 0 ? Math.round(project.estimateMs / 60000) : 0;
        return `- 「${project.title}」id=${project.id} · 已用 ${used} 分钟${
          eta > 0 ? ` / 预计 ${eta} 分钟` : ' / 还没估时'
        }${project.goal ? ` · 目标：${oneLine(project.goal, 120)}` : ''}`;
      });
      return { ok: true, message: lines.join('\n') };
    }
    const project = this.projects.get(idOf(projectId));
    if (!project) return { ok: false, error: '找不到这个项目；先用 action=list 看 id。' };
    if (action === 'update') {
      const minutes = Math.max(0, Math.min(24 * 60, Number(estimateMinutes) || 0));
      if (minutes > 0) {
        project.estimateMs = minutes * 60 * 1000;
        project.estimateAt = Date.now();
        project.estimateNote = '总监按 AI 编程速度重新估的';
        project.buildEtaAt = project.startedAt + project.estimateMs;
      }
      if (Number(verifyMinutes) > 0) {
        project.verifyEstimateMs =
          Math.max(1, Math.min(24 * 60, Number(verifyMinutes))) * 60 * 1000;
      }
      if (!project.verifyCheckedAt) {
        project.verifyEtaAt =
          (project.buildEtaAt || project.startedAt + project.estimateMs) +
          (project.verifyEstimateMs || 5 * 60 * 1000);
      }
      if (note) this.addProjectDecision(project.id, note);
      project.updatedAt = Date.now();
      this.scheduleSave('projects');
      return {
        ok: true,
        message: `项目「${project.title}」已更新${
          minutes > 0 ? `：预计 ${minutes} 分钟` : ''
        }${note ? `；记下：${note}` : ''}。`,
      };
    }
    if (action === 'remember') {
      this.addProjectDecision(project.id, note);
      return { ok: true, message: `已记到「${project.title}」的档案里。` };
    }
    return { ok: false, error: '未知操作' };
  }

  /**
   * 模型没给派工估时的时候，按 AI 编程的实际速度粗估一次。
   * 这不是硬截止，只是给总监一个“这笔活大概多长”的参照。
   */
  async estimateProject(projectId, { title = '', employees = [], shared = '' } = {}) {
    const project = this.projects.get(idOf(projectId));
    if (!project || project.estimateMs > 0) return project;
    // 单员工的小活不值得再叫一次模型估时：按任务量给个区间，省一次往返，
    // 也让“派工”这一步更快开始。多人并行才需要模型判断重叠和等待。
    if (employees.length === 1) {
      const taskText = String(employees[0]?.task ?? '');
      const minutes = Math.max(
        SINGLE_ESTIMATE_MIN_MINUTES,
        Math.min(
          SINGLE_ESTIMATE_MAX_MINUTES,
          Math.round(SINGLE_ESTIMATE_MIN_MINUTES + taskText.length / 120),
        ),
      );
      project.estimateMs = minutes * 60 * 1000;
      project.estimateNote = '按任务量粗估（单员工，不再叫模型估时）';
      project.estimateAt = Date.now();
      project.buildEtaAt = project.startedAt + project.estimateMs;
      if (!project.verifyCheckedAt) {
        project.verifyEtaAt =
          project.buildEtaAt + (project.verifyEstimateMs || 5 * 60 * 1000);
      }
      project.updatedAt = Date.now();
      this.scheduleSave('projects');
      return project;
    }
    const reply = await this.ask({
      system:
        '你是工作总监。按 AI 编程的实际速度估一件事要多久，不按人类工时，也不按人类上班节奏。' +
        '并行员工会缩短总时长，但不要假设无限并行。只输出一行 JSON：{"minutes": 数字, "note": "一句依据"}。不要写别的。',
      user: [
        `项目：${title || project.title}`,
        shared ? `协作约定：${clip(shared, 400)}` : '',
        '员工分工：',
        ...employees.slice(0, 8).map((item) => `- ${item.name}：${oneLine(item.task, 160)}`),
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 200,
      timeoutMs: 20 * 1000,
    }).catch(() => null);
    const data = reply ? this.parseJson(reply) : null;
    const rawMinutes = Math.round(Number(data?.minutes) || 0);
    if (rawMinutes > 0) {
      const minutes = Math.max(1, Math.min(24 * 60, rawMinutes));
      project.estimateMs = minutes * 60 * 1000;
      project.estimateNote = oneLine(data?.note, 160) || '总监按 AI 编程速度估的';
      project.estimateAt = Date.now();
      project.buildEtaAt = project.startedAt + project.estimateMs;
    } else if (!project.estimateMs) {
      // 模型完全不可用：给一个粗参照，明确标成粗估，不当承诺。
      project.estimateMs = Math.max(10, 10 + employees.length * 8) * 60 * 1000;
      project.estimateNote = '粗估（模型没回话，按 AI 编程经验给的参照）';
      project.estimateAt = Date.now();
      project.buildEtaAt = project.startedAt + project.estimateMs;
    }
    // 验收的预计跟着编制的预计走；已经开始验收的不要往回拨。
    if (!project.verifyCheckedAt) {
      project.verifyEtaAt =
        (project.buildEtaAt || project.startedAt + project.estimateMs) +
        (project.verifyEstimateMs || 5 * 60 * 1000);
    }
    project.updatedAt = Date.now();
    this.scheduleSave('projects');
    return project;
  }

  /* ------------------------------------------------------------------ */
  /* run hooks                                                          */
  /* ------------------------------------------------------------------ */

  onRunStart({ taskId, requestId, title, workspaceId, workspacePath }) {
    const id = idOf(taskId);
    if (!id || !requestId) return;
    const previous = this.tasks.get(id) ?? {};
    const task = {
      id,
      title: oneLine(previous.title || title || '任务', 120),
      space: previous.space ?? '',
      workspaceId: previous.workspaceId || String(workspaceId ?? ''),
      workspacePath: previous.workspacePath || String(workspacePath ?? ''),
      busy: true,
      status: 'running',
      askLevel: previous.askLevel,
      runStartedAt: Date.now(),
      lastDurationMs: previous.lastDurationMs ?? 0,
      updatedAt: Date.now(),
      seenAt: Date.now(),
    };
    this.tasks.set(id, task);
    const startedAt = Date.now();
    this.runs.set(id, {
      requestId,
      startedAt,
      lastAt: startedAt,
      /** 任何流事件（含思考、工具参数）的最后时间。 */
      lastEventAt: startedAt,
      /** 真正有内容/工具动作的最后时间；只有它才能证明“在干活”。 */
      lastContentAt: startedAt,
      lastToolAt: 0,
      lastThinkingAt: 0,
      outputChars: 0,
      thinkingChars: 0,
      events: 0,
      text: '',
      tool: '',
      /** 这一轮用过哪些工具、各几次：重复工作的指纹靠它。 */
      tools: new Map(),
      /** 最近几次工具调用的指纹（名字+参数）：连着几次一模一样就是死循环。 */
      recentTools: [],
      /** 发现死循环的时间；指纹一换就清掉。 */
      loopDetectedAt: 0,
      loopAlertedAt: 0,
      /** 卡住判断的节流：同一个运行不每 15 秒叫一次模型。 */
      judgeAt: 0,
      stuckAlertedAt: 0,
    });
    this.pendingDelivery.delete(id);
    // 一次运行只对应一条指令。以前会把该任务所有 delivered 都打上 startedAt，
    // 几条遗留指令混在一起，验收时 find() 抓到最早的那条，新指令永远挂在
    // delivered 上，分配也永远收不了尾。只认最新交付的那一条。
    const pending = this.instructions
      .filter(
        (instruction) =>
          instruction.taskId === id &&
          instruction.state === 'delivered' &&
          instruction.source !== 'user',
      )
      .sort((a, b) => (b.deliveredAt || b.createdAt) - (a.deliveredAt || a.createdAt))[0];
    if (pending && !pending.startedAt) {
      pending.startedAt = Date.now();
      this.scheduleSave('instructions');
    }
    this.ledgerPush({ kind: 'run:start', taskId: id, title: task.title, text: '任务开始执行' });
  }

  onRunEvent({ taskId, payload }) {
    const id = idOf(taskId);
    const run = this.runs.get(id);
    if (!run) return;
    const now = Date.now();
    run.lastAt = now;
    run.lastEventAt = now;
    // 又动了：这一段静止期结束，下一次停住可以重新提醒。
    run.stuckAlertedAt = 0;
    run.events = (run.events ?? 0) + 1;
    if (payload?.type === 'delta') {
      const text = String(payload.text ?? '');
      run.text = (run.text + text).slice(-3000);
      run.outputChars = (run.outputChars ?? 0) + text.length;
      run.lastContentAt = now;
    } else if (payload?.type === 'thinking') {
      const text = String(payload.text ?? '');
      run.thinkingChars = (run.thinkingChars ?? 0) + text.length;
      run.lastThinkingAt = now;
      // 思考也是模型在动，但不算“有交付内容”。卡住判断同时看这两个时间。
    } else if (payload?.type === 'step' && payload.step) {
      run.tool = oneLine(payload.step.summary || payload.step.call?.name, 120);
      run.lastToolAt = now;
      run.lastContentAt = now;
      this.countTool(run, payload.step.call?.name);
      this.noteToolFingerprint(run, payload.step.call);
    } else if (payload?.type === 'tool') {
      run.tool = oneLine(payload.summary || payload.call?.name, 120);
      run.lastToolAt = now;
      run.lastContentAt = now;
      // 同一次调用先 running 再 done，只数后一次，别把 5 次重复数成 10 次。
      if (payload.status !== 'running') {
        this.countTool(run, payload.call?.name);
        this.noteToolFingerprint(run, payload.call);
        this.trackProgress(run, payload.call);
      }
    } else if (payload?.type === 'permission') {
      run.lastContentAt = now;
      void this.handlePermission(id, payload);
    } else if (payload?.type === 'question') {
      run.lastContentAt = now;
      void this.handleQuestion(id, payload);
    }
  }

  /**
   * 一个运行的健康度。总监不能只看“状态=运行中”就说“它在干活”：
   * 模型/网络挂住时，界面会停在“正在生成…”，但这里没有任何新事件。
   */
  runHealth(taskId, now = Date.now()) {
    const id = idOf(taskId);
    const run = this.runs.get(id);
    if (!run) return null;
    const lastEventAt = run.lastEventAt || run.lastAt || run.startedAt;
    const lastContentAt = run.lastContentAt || run.startedAt;
    return {
      running: true,
      startedAt: run.startedAt,
      elapsedMs: Math.max(0, now - run.startedAt),
      quietMs: Math.max(0, now - lastEventAt),
      silentMs: Math.max(0, now - lastContentAt),
      sinceThinkingMs: run.lastThinkingAt ? Math.max(0, now - run.lastThinkingAt) : 0,
      outputChars: run.outputChars ?? 0,
      thinkingChars: run.thinkingChars ?? 0,
      events: run.events ?? 0,
      tool: run.tool || '',
      lastToolAt: run.lastToolAt || 0,
      lastEventAt,
      lastContentAt,
      stalled: now - lastEventAt >= RUN_SILENT_MS,
      /** 连续三次一模一样的工具调用；不是“慢”，是在原地打转。 */
      looping: Boolean(run.loopDetectedAt),
      loopMs: run.loopDetectedAt ? Math.max(0, now - run.loopDetectedAt) : 0,
    };
  }

  countTool(run, name) {
    const tool = oneLine(name, 40).replace(/[^\w.:-]/g, '');
    if (!tool || !run?.tools) return;
    run.tools.set(tool, (run.tools.get(tool) ?? 0) + 1);
  }

  /**
   * 记一步工具调用。写过文件之后，连续很多步都在读/跑却不写，基本可以断定
   * 它在拿探针代替交付；这时让它收口，比等时间预算到 75% 更早。
   */
  trackProgress(run, call) {
    const name = String(call?.name ?? '');
    if (!run || !name) return;
    if (WRITE_TOOLS.has(name)) {
      run.wroteAt = Date.now();
      run.stallCalls = 0;
      return;
    }
    if (NEUTRAL_TOOLS.has(name)) {
      run.stallCalls = 0;
      return;
    }
    // 只盯“反复跑命令”：读 12 个文件再动手是大活的正常准备，不该被收口。
    if (!PROGRESS_TOOLS.has(name)) return;
    // 还没开始写之前，跑构建、装依赖都是正常的，不催。
    if (!run.wroteAt) return;
    run.stallCalls = (run.stallCalls ?? 0) + 1;
  }

  envCard(workspaceId) {
    const id = idOf(workspaceId);
    if (!id) return null;
    const card = this.envCards.get(id);
    if (!card) return null;
    return Date.now() - Number(card.at || 0) > ENV_CARD_TTL_MS ? null : card;
  }

  envCardText(workspaceId) {
    const card = this.envCard(workspaceId);
    if (!card) return '';
    const lines = [
      `环境卡（${new Date(card.at).toLocaleString('zh-CN', { hour12: false })} 探测时的快照，直接用，不要再自己 netstat / 查版本）：`,
      `- 系统：${card.platform || process.platform}；根目录：${card.root || '未知'}`,
      card.runtimes?.length ? `- 运行时：${card.runtimes.join(' / ')}` : '',
      card.topLevel?.length ? `- 顶层：${card.topLevel.join('、')}` : '',
      card.entries?.length ? `- 项目文件：${card.entries.join('、')}` : '',
      card.ports?.length
        ? `- 已在监听的端口：${card.ports
            .map((item) => `${item.port}(${item.process || '未知进程'}${item.pid ? ` pid ${item.pid}` : ''})`)
            .join('、')}`
        : '- 已在监听的端口：无',
      card.suggested ? `- 建议启动：${card.suggested}` : '',
      '- 端口是探测那一刻的快照，可能已经变了；起服务前用 smoke_check 再查一次。被别的程序占着就换一个空闲端口，不要 curl 别人的服务当自己的证据。',
      '- 卡和实际不符时以实际为准，并在回复里写一行「环境卡修正：…」。',
    ];
    return lines.filter(Boolean).join('\n');
  }

  /** 探一次本空间的运行环境。异步、限时，不阻塞派工。 */
  ensureEnvCard(workspaceId, { force = false } = {}) {
    const id = idOf(workspaceId);
    if (!id) return;
    if (!force && this.envCard(id)) return;
    if (this.envBuilding.has(id)) return;
    const root = String(this.spaces.get(id)?.path ?? '').trim();
    if (!root || !fsSync.existsSync(root)) return;
    this.envBuilding.add(id);
    void this.buildEnvCard(id, root)
      .then((card) => {
        if (!card) return;
        this.envCards.set(id, card);
        this.scheduleSave('environments');
      })
      .catch(() => undefined)
      .finally(() => this.envBuilding.delete(id));
  }

  async buildEnvCard(workspaceId, root) {
    const run = (command, args = []) =>
      new Promise((resolve) => {
        execFile(
          command,
          args,
          {
            cwd: root,
            timeout: ENV_PROBE_TIMEOUT_MS,
            windowsHide: true,
            maxBuffer: 1024 * 1024,
            // npm/python 在 Windows 上是 .cmd/.exe 包装，execFile 直接调不到。
            shell: process.platform === 'win32',
          },
          (error, stdout, stderr) => resolve(error ? '' : String(stdout || stderr || '').trim()),
        );
      });
    const win = process.platform === 'win32';
    const [node, npm, python, git, netstat, tasklist, entries] = await Promise.all([
      run('node', ['--version']),
      run('npm', ['--version']),
      run(win ? 'python' : 'python3', ['--version']),
      run('git', ['--version']),
      win ? run('netstat', ['-ano', '-p', 'tcp']) : run('ss', ['-ltnp']),
      win ? run('tasklist', ['/FO', 'CSV', '/NH']) : Promise.resolve(''),
      fs.readdir(root, { withFileTypes: true }).catch(() => []),
    ]);

    const runtimes = [];
    if (node) runtimes.push(`node ${node.replace(/^v/i, '')}`);
    if (npm) runtimes.push(`npm ${npm}`);
    if (python) runtimes.push(python.replace(/\s+/g, ' ').slice(0, 60));
    if (git) runtimes.push(git.replace(/^git version\s*/i, 'git '));

    const names = entries.map((item) => (item.isDirectory() ? `${item.name}/` : item.name));
    const topLevel = names
      .filter((name) => !/^(node_modules\/|\.git\/|\.ezness\/|__pycache__\/)/i.test(name))
      .slice(0, ENV_CARD_MAX_ENTRIES);
    const known = [
      'package.json',
      'requirements.txt',
      'pyproject.toml',
      'Pipfile',
      'go.mod',
      'Cargo.toml',
      'pom.xml',
      'index.html',
      'app.py',
      'main.py',
      'server.py',
      'server.js',
      'app.js',
      'README.md',
    ].filter((name) => entries.some((item) => item.name === name && !item.isDirectory()));

    const ports = [];
    if (win) {
      const pidName = new Map();
      for (const line of tasklist.split(/\r?\n/)) {
        const cells = line.match(/"([^"]*)"/g);
        if (!cells || cells.length < 2) continue;
        const pid = Number(cells[1].replace(/"/g, ''));
        if (pid) pidName.set(pid, cells[0].replace(/"/g, ''));
      }
      for (const line of netstat.split(/\r?\n/)) {
        const match = line.match(/^\s*TCP\s+\S*:(\d+)\s+\S+\s+LISTENING\s+(\d+)/i);
        if (!match) continue;
        const port = Number(match[1]);
        const pid = Number(match[2]);
        if (!port || ports.some((item) => item.port === port)) continue;
        ports.push({ port, pid, process: pidName.get(pid) || '' });
      }
    } else {
      for (const line of netstat.split(/\r?\n/)) {
        if (!/\bLISTEN\b/.test(line)) continue;
        const match = line.match(/\S*:(\d+)\s+\S+/);
        if (!match) continue;
        const port = Number(match[1]);
        const owner = line.match(/users:\(\("([^"]+)",pid=(\d+)/);
        if (!port || ports.some((item) => item.port === port)) continue;
        ports.push({ port, pid: owner ? Number(owner[2]) : 0, process: owner?.[1] || '' });
      }
    }
    // 常见的开发端口排在前面；系统端口和临时端口靠后，避免把 40000+
    // 的随机端口挤出卡片。
    const portRank = (item) =>
      item.port >= 3000 && item.port <= 9999 ? 0 : item.port >= 10000 && item.port <= 29999 ? 1 : 2;
    ports.sort((a, b) => portRank(a) - portRank(b) || a.port - b.port);

    let suggested = '';
    if (known.includes('package.json')) {
      try {
        const pkg = JSON.parse(await fs.readFile(path.join(root, 'package.json'), 'utf8'));
        const scripts = pkg?.scripts ?? {};
        suggested = scripts.dev ? 'npm run dev' : scripts.start ? 'npm start' : 'npm run build';
      } catch {
        suggested = 'npm start';
      }
    } else if (known.includes('app.py')) suggested = 'python app.py';
    else if (known.includes('main.py')) suggested = 'python main.py';
    else if (known.includes('server.js')) suggested = 'node server.js';
    else if (known.includes('app.js')) suggested = 'node app.js';
    else if (known.includes('index.html')) suggested = '直接打开 index.html（静态页）';
    if (known.includes('requirements.txt') && suggested.startsWith('python')) {
      suggested = `pip install -r requirements.txt && ${suggested}`;
    }

    return {
      workspaceId,
      root,
      platform: win ? 'Windows' : process.platform,
      at: Date.now(),
      runtimes,
      topLevel,
      entries: known,
      ports: ports.slice(0, 30),
      suggested,
    };
  }

  /**
   * 死循环指纹：工具名 + 参数。同一个调用连着出现 3 次，基本可以断定它在
   * 原地打转（读同一个文件、跑同一条命令、改同一个地方又改回去）。
   * 只记最近 8 次；指纹一变就把“发现死循环”清掉。
   */
  noteToolFingerprint(run, call) {
    if (!run || !call?.name) return;
    let args = '';
    try {
      args = JSON.stringify(call.args ?? call.arguments ?? {});
    } catch {
      args = '';
    }
    const fingerprint = `${oneLine(call.name, 60)}:${clip(args, 240)}`;
    run.recentTools = [...(run.recentTools || []), fingerprint].slice(-8);
    const tail = run.recentTools.slice(-3);
    const looping = tail.length === 3 && tail.every((item) => item === tail[0]);
    if (looping) {
      if (!run.loopDetectedAt) run.loopDetectedAt = Date.now();
    } else {
      run.loopDetectedAt = 0;
      run.loopAlertedAt = 0;
    }
  }

  async onRunEnd({ taskId, requestId, ok, error, aborted }) {
    const id = idOf(taskId);
    const run = this.runs.get(id);
    if (!run || run.requestId !== requestId) return;
    // 这一轮到底花了多少回合/命令：交付卡要如实写出来，不能只给一个总时长。
    const toolCalls = [...(run.tools?.values() ?? [])].reduce((sum, count) => sum + count, 0);
    const stats = {
      elapsedMs: Math.max(0, Date.now() - run.startedAt),
      toolCalls,
      commands: run.tools?.get('run_command') ?? 0,
      writes: (run.tools?.get('write_file') ?? 0) + (run.tools?.get('edit_file') ?? 0),
    };
    for (const item of this.instructions) {
      if (item.taskId === id && item.state === 'delivered' && !item.runStats) {
        item.runStats = stats;
      }
    }
    this.runs.delete(id);
    const task = this.tasks.get(id) ?? { id, title: '任务', space: '', workspaceId: '' };
    task.busy = false;
    task.status = aborted ? 'aborted' : ok ? 'done' : 'failed';
    task.lastDurationMs = Math.max(0, Date.now() - run.startedAt);
    task.lastRunStartedAt = run.startedAt;
    task.runStartedAt = 0;
    task.updatedAt = Date.now();
    this.tasks.set(id, task);

    this.ledgerPush({
      kind: 'run:end',
      taskId: id,
      title: task.title,
      text: ok ? '完成' : aborted ? '被停止' : `失败：${oneLine(error, 200)}`,
    });

    // Only accept a run that actually started after our instruction went out;
    // otherwise the user's own turn would be judged against our criteria.
    // 同一任务可能留下几条 delivered 的旧指令（新指令覆盖旧指令时没有收尾）。
    // 必须认“这一轮实际跑的那条”：startedAt 最接近本次 run.startedAt，而不是
    // 数组里最早的那条；否则会把旧指令验收掉，新指令永远挂着，分配不收尾、
    // 总监也不发最后一句。
    const candidates = this.instructions
      .filter(
        (item) =>
          item.taskId === id &&
          item.state === 'delivered' &&
          item.startedAt &&
          item.source !== 'user',
      )
      .sort((a, b) => b.startedAt - a.startedAt);
    const pending = candidates[0];
    // 被新指令覆盖的旧指令：收掉，让分配能正常收尾。保留正在验收的这条。
    // 旧的可能连 startedAt 都没有（onRunStart 现在只认最新的一条），也要一起
    // 收掉；否则投递看门狗会把它当成“死掉的交付”重新发出去，再跑一轮。
    if (pending) {
      const superseded = this.instructions.filter(
        (item) =>
          item.taskId === id &&
          item.state === 'delivered' &&
          item !== pending &&
          item.source !== 'user',
      );
      for (const stale of superseded) {
        stale.state = 'discarded';
        stale.finishedAt = Date.now();
        stale.note = '被更新的指令替代，未验收';
        if (!stale.resultNote) stale.resultNote = '被后续指令替代';
        if (stale.dispatchId) this.maybeFinishDispatch(stale.dispatchId);
        this.ledgerPush({
          kind: 'instruction:superseded',
          taskId: id,
          title: stale.taskTitle,
          text: `由 ${pending.id} 替代`,
        });
      }
      if (superseded.length > 0) this.scheduleSave('instructions');
    }
    // 这一轮真正写出来的文件。总监分配的任务等到验收再一起发；用户自己跑的
    // 任务结束就发。两者都只传路径，不复制。
    const files = await collectRunFiles(task, run.startedAt).catch(() => []);
    // 模型/供应商起不来时，验收和自动返工都没有意义（用的还是同一个坏模型）。
    // 直接把选择权交给用户：换一个模型，我再让它重试。
    const modelProblem = !ok && !aborted && looksLikeModelProblem(error);
    let offered = null;
    if (pending) {
      if (modelProblem) {
        pending.state = 'discarded';
        pending.note = '模型出错，等用户换模型';
        pending.resultNote = oneLine(error, 200);
        pending.finishedAt = Date.now();
        this.scheduleSave('instructions');
        if (pending.role === 'verify') {
          // 验收没跑起来：原任务如实记“未验证”，别让它一直挂着“验收中”。
          const parent = this.instructions.find(
            (item) => item.id === pending.parentInstructionId,
          );
          pending.verdict = 'unverified';
          if (parent) {
            this.markVerificationUncertain(parent, {
              reason: `验收没跑起来（模型问题）：${oneLine(error, 160)}`,
            });
          }
        } else {
          offered = this.offerModelChoice({
            taskId: id,
            reason: error,
            instructionId: pending.id,
          });
        }
      } else if (pending.role === 'verify') {
        // 验收员自己不再被验收：它交的是结论，总监读结论。
        await this.finishVerification(pending, { ok, error, aborted, files }).catch(() => undefined);
      } else if (pending.dispatchId) {
        // 派工任务：工人一停，先把这一版交给用户，再安排验收员。
        await this.handleBuildDelivered(pending, { ok, error, aborted, files, task }).catch(
          () => undefined,
        );
      } else {
        await this.accept(pending, { ok, error, aborted, files }).catch(() => undefined);
      }
    } else if (modelProblem) {
      offered = this.offerModelChoice({ taskId: id, reason: error });
    } else if (!aborted && (ok || !error)) {
      // 用户直接进任务里跑了一轮：如果总监正等着这个任务返工/收尾，
      // 先看看用户改的东西是不是已经把它带到位了，别让返工把用户的修改覆盖掉。
      const userTail = await this.sessionTail(id).catch(() => '');
      void this.reviewUserEdit({ taskId: id, tail: userTail, files }).catch(() => undefined);
    }

    // 派工的任务不逐条汇报：员工各发一条太吵，等全部结束只发一条汇总。
    // 只有“总监下的指令”才并进分配汇总；用户自己在这个任务里跑的一轮照常汇报。
    const dispatched = Boolean(
      pending &&
        (pending.dispatchId || pending.role === 'verify' || this.dispatchOfTask(id)),
    );
    if ((ok || !aborted) && !offered?.ok && !dispatched) {
      const tail = await this.sessionTail(id);
      this.queueReport({
        taskId: id,
        title: task.title,
        ok,
        error: oneLine(error, 300),
        tail,
        urgent: !ok,
        // 总监驱动的这一轮已经在验收消息里交付，别重复发。
        files: pending ? [] : files,
      });
    }
    // 重复工作只在本地记账；真的重复了才花一次模型判断，决定要不要必读上报。
    if (!aborted) void this.recordRunPattern({ taskId: id, task, run, files, ok }).catch(() => undefined);
    this.drain();
  }

  /* ------------------------------------------------------------------ */
  /* repeated work → must-read advice (suggestion only)                  */
  /* ------------------------------------------------------------------ */

  /** 这一轮用户真正让做的事（总监下的指令也算），只用来比对相似度。 */
  async runIntent(taskId, since = 0) {
    try {
      const messages = await this.sessionMessages(taskId);
      const floor = Math.max(0, Number(since) || 0) - 5 * 1000;
      const last = [...messages].reverse().find((message) => {
        if (message.role !== 'user' || !String(message.content ?? '').trim()) return false;
        const at = Number(message.createdAt) || 0;
        // 老会话没有时间戳时不做时间过滤，取最后一条用户发言即可。
        return !floor || !at || at >= floor;
      });
      return last ? clip(String(last.content).replace(/^【工作总监】\s*/, ''), 400) : '';
    } catch {
      return '';
    }
  }

  /**
   * Fold a finished run into the pattern book. Pure local work: no model, no
   * writes outside patterns.json. A pure conversation (no tools, no files) is
   * not a capability and is skipped.
   */
  async recordRunPattern({ taskId, task, run, files = [], ok }) {
    const tools = [...(run.tools ?? new Map()).entries()]
      .map(([name, count]) => ({ name, count }))
      .sort((a, b) => b.count - a.count);
    if (tools.length === 0 && files.length === 0) return null;
    const intent = await this.runIntent(taskId, run.startedAt);
    const usage = this.taskUsage(taskId, run.startedAt) ?? {};
    const record = workPatterns.normalizeRun({
      id: uid('run'),
      at: Date.now(),
      taskId,
      taskTitle: task?.title,
      space: task?.space || task?.workspaceId || '',
      intent,
      tools,
      toolTotal: tools.reduce((sum, tool) => sum + tool.count, 0),
      files: files.map((file) => ({ name: file.name, kind: file.kind })),
      ok,
      durationMs: Math.max(0, Date.now() - run.startedAt),
      inputTokens: usage.inputTokens ?? 0,
      outputTokens: usage.outputTokens ?? 0,
      requests: usage.requests ?? 0,
      cost: usage.cost ?? 0,
    });
    if (!record) return null;
    const attached = workPatterns.attachRun(this.patterns, record);
    this.patterns = workPatterns.prune(attached.patterns);
    this.scheduleSave('patterns');
    const pattern = this.patterns.find((entry) => entry.key === attached.pattern.key) ?? null;
    if (pattern) void this.reviewWorkPattern(pattern).catch(() => undefined);
    return pattern;
  }

  patternOf(key) {
    const wanted = String(key ?? '');
    if (!wanted) return null;
    return this.patterns.find((pattern) => pattern.key === wanted) ?? null;
  }

  /** Ask the model once whether this repeated shape is a generic capability. */
  async reviewWorkPattern(pattern) {
    if (!pattern || this.stopped) return null;
    if (this.patternReviews.has(pattern.key)) return null;
    if (!workPatterns.candidateReason(pattern)) return null;
    const gate = workPatterns.canAdvise(pattern, { advice: this.adviceLog });
    if (!gate.ok) return null;
    this.patternReviews.add(pattern.key);
    try {
      const verdict = await this.judgeWorkPattern(pattern);
      // 模型没答上来（忙、没配置、解析失败）不算“已判断”，下次再来。
      if (!verdict) return null;
      pattern.judgedAt = Date.now();
      pattern.judgedRuns = pattern.runs.length;
      if (!verdict.worth) {
        this.scheduleSave('patterns');
        return null;
      }
      this.raiseAdvice(pattern, verdict);
      return verdict;
    } finally {
      this.patternReviews.delete(pattern.key);
    }
  }

  async judgeWorkPattern(pattern) {
    const stats = workPatterns.statsOf(pattern);
    let presets = { tools: [], agents: [] };
    try {
      presets = this.listPresets() ?? presets;
    } catch {
      /* 名单只是给模型参考，拿不到就不提 */
    }
    const toolNames = Array.isArray(presets.tools) ? presets.tools.slice(0, 40) : [];
    const agentNames = Array.isArray(presets.agents) ? presets.agents.slice(0, 40) : [];
    const evidence = workPatterns.evidenceLines(pattern, 8).join('\n');
    const system = [
      '你是工作总监手下的「审计组」。你只能提建议：不改文件、不建 Agent、不写代码、不调用任何工具。',
      '程序统计到一组重复出现的工作。判断它是不是“通用型能力”：换一份文件、换一个项目还会再做，做成预制（Agent、自定义工具、提示词模板）能明显省时间，或者明显省 token。',
      '一次性的、做完就结束的活，worth=false。已经存在同样能力的，worth=false。',
      '如果值得，建议要具体：说清楚该把哪一步固化、预期每次省什么；必须用给出的真实数字推理，不要编造。',
      '只输出一个 JSON 对象，不要代码块：',
      '{"worth":true,"title":"≤16字","reason":"为什么算重复的一句理由","saving":"每次大概省什么（时间或 token，基于数据）","how":["建议1","建议2"],"form":"agent|tool|prompt"}',
      'worth 为 false 时只需 {"worth":false}。',
    ].join('\n');
    const user = [
      `这一类活近 30 天出现 ${stats.count} 次，跨 ${Math.max(stats.tasks, stats.spaces)} 个任务。`,
      `合计 ${workPatterns.formatDuration(stats.totalMs)}、${workPatterns.formatTokens(
        stats.totalTokens,
      )} tok；平均每次 ${workPatterns.formatDuration(stats.avgMs)}、${workPatterns.formatTokens(
        stats.avgTokens,
      )} tok。`,
      `常用动作：${workPatterns.toolSummary(pattern) || '（无）'}`,
      `产出：${workPatterns.fileSummary(pattern) || '（没有文件）'}`,
      `最多的一次里同一个动作重复 ${stats.repeat} 次。`,
      '',
      '每次的样子：',
      evidence || '（没有更多细节）',
      '',
      `用户的原话（每种活取一条）：`,
      ...[...new Set(pattern.runs.map((run) => run.intent).filter(Boolean))].slice(0, 4).map((text) => `- ${text}`),
      '',
      `已经有的预制能力：Agent：${agentNames.join('、') || '（无）'}；自定义工具：${toolNames.join('、') || '（无）'}`,
    ].join('\n');
    // 用户点按钮时正赶上两个验收在跑，别立刻回“没答上来”：等一下名额再问。
    const text = await this.ask({ system, user, maxTokens: 500, retries: 2 });
    const data = this.parseJson(text);
    if (!data || typeof data !== 'object') return null;
    if (data.worth !== true) return { worth: false };
    const title = oneLine(data.title, 24);
    const reason = oneLine(data.reason, 200);
    const saving = oneLine(data.saving, 200);
    const how = Array.isArray(data.how)
      ? data.how.map((step) => oneLine(step, 120)).filter(Boolean).slice(0, 3)
      : [];
    const form = ['agent', 'tool', 'prompt'].includes(data.form) ? data.form : 'prompt';
    // 模型没给出可执行的建议就当作不建议，别发一张空卡片。
    if (!title || !saving || how.length === 0) return { worth: false };
    return { worth: true, title, reason, saving, how, form };
  }

  /** The must-read card. Suggestion only: no action ever creates anything. */
  raiseAdvice(pattern, verdict) {
    const stats = workPatterns.statsOf(pattern);
    const formLabel = { agent: 'Agent', tool: '自定义工具', prompt: '提示词模板' }[verdict.form] ?? '预制';
    const body = [
      verdict.reason ? `${verdict.reason}` : '',
      `\n**证据**\n${workPatterns.evidenceLines(pattern, 5).join('\n')}`,
      `\n**建议（${formLabel}）**\n${verdict.how.map((step, index) => `${index + 1}. ${step}`).join('\n')}`,
      `\n**预计**\n${verdict.saving}`,
      `\n审计组只提建议，不会自己动手：改不改、怎么预制，都等你决定。`,
    ]
      .filter(Boolean)
      .join('\n');
    const item = this.addInbox({
      kind: 'advice',
      speaker: 'audit',
      title: verdict.title,
      body,
      taskId: '',
      taskTitle: '',
      mustRead: true,
      actions: [
        { id: 'ack', label: '知道了', style: 'primary' },
        { id: 'ignore', label: '先不用' },
      ],
      payload: {
        kind: 'advice',
        adviceKey: pattern.key,
        form: verdict.form,
        runs: stats.count,
        tasks: Math.max(stats.tasks, stats.spaces),
        totalMs: stats.totalMs,
        totalTokens: stats.totalTokens,
      },
    });
    if (!item) return null;
    pattern.adviceAt = Date.now();
    pattern.adviceRuns = pattern.runs.length;
    pattern.adviceTitle = verdict.title;
    pattern.adviceBody = item.body;
    pattern.dismissed = 0;
    this.adviceLog.push(pattern.adviceAt);
    this.adviceLog = this.adviceLog.slice(-200);
    this.scheduleSave('patterns');
    return item;
  }

  /**
   * 内容审计：重复投入了多少、能回收多少、哪些已经提过建议。
   * 全是本地统计，打开就出图，不等模型。
   */
  auditView({ announce = false } = {}) {
    const base = workPatterns.auditOf(this.patterns);
    const view = {
      ok: true,
      ...base,
      ...this.auditDetails(base, Date.now()),
    };
    // 审计的正式产出是一份报告：弹窗里能看，也会以「审计组」名义发进对话。
    view.report = this.auditReport(view, Date.now());
    // 用户点「开始审计」时，审计组直接把报告发进总监对话；
    // 弹窗里刷新统计时不重复发。
    if (announce) this.announceAudit(view);
    return view;
  }

  /**
   * 把审计事实写成一份正式报告。数字全部来自本地统计，模型不参与编数。
   * 这份报告是审计的交付物，不是一段“建议你去做个 Agent”的提示。
   */
  auditReport(view, now = Date.now()) {
    const totals = view?.totals ?? {};
    const tasks = Array.isArray(view?.tasks) ? view.tasks : [];
    const agents = Array.isArray(view?.agents) ? view.agents : [];
    const projects = Array.isArray(view?.projects) ? view.projects : [];
    const tools = Array.isArray(view?.tools) ? view.tools : [];
    const repeated = Array.isArray(view?.items) ? view.items : [];
    const sum = (list, key) => list.reduce((total, item) => total + (Number(item?.[key]) || 0), 0);
    const minutes = (ms) => workPatterns.formatDuration(Math.max(0, Number(ms) || 0));
    const tokens = (count) => workPatterns.formatTokens(Math.max(0, Number(count) || 0));
    const stamp = new Date(now).toLocaleString('zh-CN', { hour12: false });

    const accepted = sum(tasks, 'accepted');
    const unverified = sum(tasks, 'unverified');
    const failed = sum(tasks, 'failed');
    const rework = sum(tasks, 'rework');
    const held = sum(tasks, 'held');
    const userSteps = Number(view?.userSteps) || 0;
    const instructions = sum(tasks, 'instructions');
    const passed = Math.max(0, accepted - unverified);
    const taskTokens = sum(tasks, 'tokens');
    const taskCost = sum(tasks, 'cost');
    const doneProjects = projects.filter((project) => project.status === 'done');
    const overProjects = projects.filter((project) => project.overMs > 0);

    const lines = [];
    lines.push('# 内容审计报告');
    lines.push('');
    lines.push(`- 出具时间：${stamp}`);
    lines.push(`- 审计窗口：近 ${Number(view?.windowDays) || 30} 天`);
    lines.push(
      `- 审计范围：${tasks.length} 个任务 · ${instructions} 条指令 · ${projects.length} 个项目 · ${agents.length} 个员工 · ${tools.length} 类能力`,
    );
    lines.push('- 审计方式：只读检查运行记录、验收结果、项目档案和重复投入；不改文件、不改能力。');
    lines.push('');

    lines.push('## 一、总体结论');
    const conclusion =
      failed > 0
        ? `有 ${failed} 条指令没通过验收，${unverified} 条未验证，${held} 条等你确认；交付质量是当前最需要处理的问题。`
        : unverified > 0 || held > 0
          ? `没有“没通过”的指令，但有 ${unverified} 条未验证、${held} 条等你确认；结论要谨慎看待，不能当成全部通过。`
          : tasks.length > 0
            ? '已收口的指令都有明确验收结论，没有发现“跑完就算过”的情况。'
            : '还没有可审计的指令记录。';
    lines.push(`- ${conclusion}`);
    lines.push(
      `- 验收分布：通过 ${passed} · 未验证 ${unverified} · 没通过 ${failed} · 返工 ${rework} · 等你确认 ${held}。`,
    );
    lines.push(
      userSteps > 0
        ? `- 需要你亲自拍板：${userSteps} 次（答确认卡、换模型）。这个数越低，说明流程越能自己收口。`
        : '- 需要你亲自拍板：0 次。这一窗口里的确认都是总监自己处理的。',
    );
    if (taskTokens > 0 || taskCost > 0) {
      lines.push(
        `- 记录到的消耗：${tokens(taskTokens)} tok${taskCost > 0 ? ` · ¥${taskCost.toFixed(4)}` : ''}。`,
      );
    }
    if (projects.length > 0) {
      lines.push(
        `- 项目：${projects.length} 个，已收口 ${doneProjects.length} 个，超出预估 ${overProjects.length} 个。`,
      );
    }
    const repeatedText =
      Number(totals.repeated) > 0
        ? `重复投入 ${minutes(totals.reclaimMs)}、${tokens(totals.reclaimTokens)} tok，占全部投入的 ${Number(totals.share) || 0}%。`
        : '没有发现达到“重复投入”标准的同类工作。';
    lines.push(`- ${repeatedText}`);
    lines.push('');

    lines.push('## 二、项目审计');
    if (projects.length === 0) {
      lines.push('- 还没有项目档案。');
    } else {
      for (const project of projects.slice(0, 8)) {
        const state = project.status === 'done' ? '已收口' : '进行中';
        const estimate =
          project.estimateMs > 0
            ? `用时 ${minutes(project.elapsedMs)} / 预估 ${minutes(project.estimateMs)}${
                project.overMs > 0 ? `（超 ${minutes(project.overMs)}）` : ''
              }`
            : `用时 ${minutes(project.elapsedMs)} / 未估时`;
        const problems = [
          project.unverified > 0 ? `未验证 ${project.unverified}` : '',
          project.failed > 0 ? `没通过 ${project.failed}` : '',
          project.held > 0 ? `等你确认 ${project.held}` : '',
        ]
          .filter(Boolean)
          .join(' · ');
        const planLine =
          project.plan && project.actual
            ? ` · 计划 ${project.plan.parallelism} 人 ${project.plan.estimateMinutes} 分钟编制` +
              `${project.plan.verifyMinutes > 0 ? ` + ${project.plan.verifyMinutes} 分钟验收` : ''}` +
              ` → 实际 ${project.actual.parallelism} 人 ${project.actual.minutes} 分钟`
            : project.plan
              ? ` · 计划 ${project.plan.parallelism} 人 ${project.plan.estimateMinutes} 分钟编制`
              : '';
        lines.push(
          `- 「${project.title}」：${state} · ${project.employees} 个员工 · 通过 ${project.accepted}${
            problems ? ` · ${problems}` : ''
          } · ${estimate}${planLine}`,
        );
      }
    }
    lines.push('');

    lines.push('## 三、任务审计');
    const taskRank = [...tasks].sort(
      (a, b) =>
        b.failed - a.failed ||
        b.unverified - a.unverified ||
        b.rework - a.rework ||
        b.tokens - a.tokens ||
        b.runMs - a.runMs,
    );
    if (taskRank.length === 0) lines.push('- 还没有任务记录。');
    for (const task of taskRank.slice(0, 8)) {
      const bits = [
        `${task.instructions} 条指令`,
        `通过 ${task.accepted}`,
        task.unverified > 0 ? `未验证 ${task.unverified}` : '',
        task.failed > 0 ? `没通过 ${task.failed}` : '',
        task.rework > 0 ? `返工 ${task.rework}` : '',
        task.held > 0 ? `等你确认 ${task.held}` : '',
        task.interventions > 0 ? `你拍板 ${task.interventions} 次` : '',
        `用时 ${minutes(task.runMs)}`,
        task.tokens > 0 ? `${tokens(task.tokens)} tok` : '',
        task.files > 0 ? `${task.files} 个文件` : '',
      ].filter(Boolean);
      lines.push(`- 「${task.title}」：${bits.join(' · ')}。`);
    }
    lines.push('');

    lines.push('## 四、员工 / Agent 审计');
    if (agents.length === 0) lines.push('- 记录里还没有可归到具体员工或 Agent 的指令。');
    for (const agent of agents.slice(0, 8)) {
      const bits = [
        `${agent.tasks} 个任务`,
        `${agent.instructions} 条指令`,
        `通过 ${agent.accepted}`,
        agent.unverified > 0 ? `未验证 ${agent.unverified}` : '',
        agent.failed > 0 ? `没通过 ${agent.failed}` : '',
        agent.rework > 0 ? `返工 ${agent.rework}` : '',
        `最长一轮 ${minutes(agent.runMs)}`,
      ].filter(Boolean);
      lines.push(`- ${agent.name}：${bits.join(' · ')}。`);
    }
    lines.push('');

    lines.push('## 五、能力使用');
    if (tools.length === 0) lines.push('- 没有足够的工具调用记录。');
    else {
      lines.push(
        `- ${tools
          .slice(0, 6)
          .map((tool) => `${tool.name} ${tool.calls} 次（${tool.tasks} 个任务）`)
          .join('；')}。`,
      );
    }
    lines.push('');

    lines.push('## 六、重复投入明细');
    if (repeated.length === 0) {
      lines.push('- 同一类活至少做 3 次、跨 2 个任务，才会记为重复投入；目前没有达到标准的。');
    } else {
      for (const item of repeated.slice(0, 6)) {
        lines.push(
          `- 「${item.title}」：${item.runs} 次 · 跨 ${item.tasks} 个任务 · 可回收 ${minutes(item.reclaimMs)}${
            item.reclaimTokens > 0 ? `、${tokens(item.reclaimTokens)} tok` : ''
          }${item.adviceAt > 0 ? ' · 已给过建议' : ''}。`,
        );
      }
    }
    lines.push('');

    lines.push('## 七、审计建议');
    const advice = [];
    if (failed > 0) {
      advice.push(`先处理 ${failed} 条没通过验收的指令：让总监按缺口返工，或明确按现状收尾，不要留在“看起来跑完了”的状态。`);
    }
    if (unverified > 0 || held > 0) {
      advice.push(`把 ${unverified + held} 条未验证/等你确认的结果补一次验收；审计报告不能替代验收。`);
    }
    if (userSteps > 0) {
      advice.push(
        `有 ${userSteps} 次需要你亲自拍板（答卡/换模型）：能按规则直接定的应该由总监当场做，把这些卡再压掉一轮，别让每件小事都绕回你这里。`,
      );
    }
    if (overProjects.length > 0) {
      advice.push(`有 ${overProjects.length} 个项目超出 AI 速度预估，下一次派工把估时拆细，或把慢任务拆给空闲员工。`);
    }
    if (rework > 0) {
      advice.push(`返工 ${rework} 次，优先看返工原因是不是验收标准写得不够具体。`);
    }
    if (Number(totals.repeated) > 0) {
      advice.push('重复投入最高的一类，可以让总监评估预制为 Agent 或固定流程；审计只给建议，不替你改能力。');
    }
    if (advice.length === 0) {
      advice.push('这次没有发现需要立刻处理的问题；保持当前验收和派工口径即可。');
    }
    for (const line of advice) lines.push(`- ${line}`);
    lines.push('');
    lines.push(
      '> 本报告只读，不会改动文件或能力。需要有人动手处理时，直接告诉工作总监，由他派人执行。',
    );

    return {
      title: `审计报告 · ${stamp}`,
      at: now,
      windowDays: Number(view?.windowDays) || 30,
      markdown: lines.join('\n'),
    };
  }

  /**
   * 审计的“逐项”部分：不只按重复指纹看，还按任务、员工、能力看。
   * 数字都在本地算，模型只负责最后写结论。
   */
  auditDetails(base, now = Date.now()) {
    const stamp = (value) => Number(value) || 0;
    const tasks = new Map();
    const agents = new Map();
    for (const item of this.instructions) {
      const task = this.taskOf(item.taskId);
      const key = item.taskId;
      const entry =
        tasks.get(key) ?? {
          taskId: key,
          title: task?.title || item.taskTitle || key,
          space: task?.space || '',
          instructions: 0,
          accepted: 0,
          unverified: 0,
          failed: 0,
          rework: 0,
          held: 0,
          runMs: 0,
          cost: 0,
          tokens: 0,
          files: 0,
          lastAt: 0,
        };
      entry.instructions += 1;
      if (item.state === 'accepted') {
        entry.accepted += 1;
        if (item.unverified) entry.unverified += 1;
      }
      if (item.state === 'escalated') {
        entry.failed += 1;
        if (item.unverified) entry.unverified += 1;
      }
      if (item.state === 'held') entry.held += 1;
      if (item.attempts > 1) entry.rework += 1;
      entry.runMs = Math.max(entry.runMs, stamp(task?.lastDurationMs));
      entry.files = Math.max(entry.files, item.files.length);
      entry.lastAt = Math.max(entry.lastAt, stamp(item.finishedAt || item.createdAt));
      tasks.set(key, entry);

      const agentKey = item.agentId || item.employeeName || '';
      if (agentKey) {
        const agent =
          agents.get(agentKey) ?? {
            id: item.agentId || '',
            name: item.employeeName || item.agentId || '员工',
            tasks: new Set(),
            instructions: 0,
            accepted: 0,
            unverified: 0,
            failed: 0,
            rework: 0,
            runMs: 0,
            files: 0,
            lastAt: 0,
          };
        agent.tasks.add(item.taskId);
        agent.instructions += 1;
        if (item.state === 'accepted') agent.accepted += 1;
        if (item.unverified) agent.unverified += 1;
        if (item.state === 'escalated') agent.failed += 1;
        if (item.attempts > 1) agent.rework += 1;
        agent.runMs = Math.max(agent.runMs, stamp(task?.lastDurationMs));
        agent.files = Math.max(agent.files, item.files.length);
        agent.lastAt = Math.max(agent.lastAt, stamp(item.finishedAt || item.createdAt));
        agents.set(agentKey, agent);
      }
    }
    for (const entry of tasks.values()) {
      const usage = this.taskUsage(entry.taskId, 0);
      if (usage) {
        entry.cost = usage.cost || 0;
        entry.tokens = (usage.inputTokens || 0) + (usage.outputTokens || 0);
      }
    }
    for (const entry of agents.values()) entry.tasks = entry.tasks.size;

    // 用户介入次数：答卡、换模型这种必须他亲自做的事，按任务归到审计里。
    const windowDays = Number(base?.windowDays) || 30;
    const since = now - windowDays * 24 * 60 * 60 * 1000;
    let userSteps = 0;
    const stepsByTask = new Map();
    for (const item of this.ledger) {
      if (!item || Number(item.at) < since) continue;
      if (!USER_STEP_KINDS.has(item.kind)) continue;
      userSteps += 1;
      if (item.taskId) stepsByTask.set(item.taskId, (stepsByTask.get(item.taskId) || 0) + 1);
    }
    for (const [taskId, count] of stepsByTask) {
      const entry = tasks.get(taskId);
      if (entry) entry.interventions = count;
    }
    for (const entry of tasks.values()) entry.interventions = entry.interventions || 0;

    // 能力/工具：从重复工作的指纹里汇总，失败率没有本地记录就不编。
    const tools = new Map();
    for (const pattern of this.patterns) {
      for (const run of pattern.runs ?? []) {
        for (const tool of run.tools ?? []) {
          const entry = tools.get(tool.name) ?? {
            name: tool.name,
            calls: 0,
            runs: 0,
            tasks: new Set(),
          };
          entry.calls += tool.count;
          entry.runs += 1;
          entry.tasks.add(run.taskId);
          tools.set(tool.name, entry);
        }
      }
    }
    const toolRows = [...tools.values()]
      .map((entry) => ({ ...entry, tasks: entry.tasks.size }))
      .sort((a, b) => b.calls - a.calls)
      .slice(0, 30);

    const projects = [...this.projects.values()]
      .filter((project) => !String(project.id).startsWith('dspv_'))
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 30)
      .map((project) => {
        const list =
          project.kind === 'dispatch'
            ? this.dispatchGroup(project.id)
            : this.instructions.filter((item) => item.taskId === project.taskIds[0]);
        const latest = new Map();
        for (const item of list) {
          const key = item.employeeName || item.taskId;
          const previous = latest.get(key);
          if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
        }
        const final = [...latest.values()];
        const elapsedMs =
          project.status === 'done'
            ? Math.max(0, (project.finishedAt || project.updatedAt) - project.startedAt)
            : Math.max(0, now - project.startedAt);
        return {
          id: project.id,
          title: project.title,
          status: project.status,
          employees: final.length,
          accepted: final.filter((item) => item.state === 'accepted').length,
          failed: final.filter((item) => item.state === 'escalated' && !item.unverified).length,
          unverified: final.filter((item) => item.unverified).length,
          held: final.filter((item) => item.state === 'held').length,
          estimateMs: project.estimateMs,
          elapsedMs,
          overMs: project.estimateMs > 0 ? Math.max(0, elapsedMs - project.estimateMs) : 0,
          startedAt: project.startedAt,
          plan: project.plan,
          actual: project.actual,
        };
      });

    const detail = [
      `按任务看：${tasks.size} 个任务有总监下的指令。`,
      `按员工看：${agents.size} 个员工有记录。`,
      projects.length
        ? `按项目看：${projects.length} 个项目，${projects.filter((item) => item.status === 'done').length} 个已收口，${projects.filter((item) => item.overMs > 0).length} 个超出预估。`
        : '按项目看：还没有项目档案。',
      toolRows.length
        ? `常用能力：${toolRows.slice(0, 3).map((entry) => `${entry.name}×${entry.calls}`).join('、')}。`
        : '',
    ]
      .filter(Boolean)
      .join('\n');

    return {
      tasks: [...tasks.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 40),
      agents: [...agents.values()].sort((a, b) => b.lastAt - a.lastAt).slice(0, 30),
      tools: toolRows,
      projects,
      userSteps,
      detail,
      // 旧字段只放重复工作的结论；逐项明细单独给，界面按自己的排版展示。
      summary: base.summary,
    };
  }

  /** 审计组自己的消息：署名「审计组」，不算总监说的话。 */
  announceAudit(view) {
    const now = Date.now();
    // 连点“内容审计”不该连发三份一样的报告：10 分钟内复用同一条。
    const recent = [...this.inbox]
      .reverse()
      .find((item) => item.kind === 'audit' && now - (item.at || 0) < AUDIT_DEDUPE_MS);
    if (recent) return recent;
    const report = view?.report ?? this.auditReport(view, now);
    return this.addInbox({
      kind: 'audit',
      speaker: 'audit',
      title: report.title,
      body: report.markdown,
      taskId: '',
      taskTitle: '',
      payload: {
        kind: 'audit-report',
        at: report.at,
        windowDays: report.windowDays,
      },
    });
  }

  /** 「复盘」按钮：用户主动要，不受冷却和每日限额影响。 */
  async reviewNow() {
    if (!this.getState().enabled) {
      return { ok: false, error: '工作总监现在是关着的：先打开，审计组才能看。' };
    }
    if (this.reviewingNow) {
      return { ok: false, error: '上一次审计还在看，等它出结果再点。' };
    }
    const candidates = this.patterns
      .map((pattern) => ({ pattern, stats: workPatterns.statsOf(pattern) }))
      .filter(({ pattern, stats }) => stats.count > 0 && workPatterns.candidateReason(pattern))
      .sort((a, b) => {
        const left = a.stats.avgMs * Math.max(0, a.stats.count - 1);
        const right = b.stats.avgMs * Math.max(0, b.stats.count - 1);
        return right - left || b.stats.count - a.stats.count || b.stats.lastAt - a.stats.lastAt;
      });
    if (candidates.length === 0) {
      return { ok: false, error: '还没有足够重复的工作：同一类活至少 3 次、跨 2 个任务才会复盘。' };
    }
    // 已经提过或判断过、又没有新证据的，先跳过；不然连点两下就是两张一样的卡片，
    // 或者拿同样的问题再问一遍模型。
    const stale = ({ pattern }) =>
      (pattern.adviceAt > 0 && pattern.runs.length <= (pattern.adviceRuns || 0)) ||
      (pattern.judgedAt > 0 && pattern.runs.length - (pattern.judgedRuns || 0) < 1);
    const fresh = candidates.filter((entry) => !stale(entry));
    if (fresh.length === 0) {
      return {
        ok: false,
        error: `这 ${candidates.length} 类重复工作我都看过了，还没有新的证据。等这类活再多做几次，我再来复盘。`,
      };
    }

    this.reviewingNow = true;
    const looked = [];
    try {
      // 只看最靠前的一类，模型一句“不够通用”就等于这次点击毫无反应。
      // 用户主动要，就多看几类，至少给一句看得懂的话。
      for (const { pattern } of fresh.slice(0, 3)) {
        const title = workPatterns.titleOf(pattern);
        const verdict = await this.judgeWorkPattern(pattern);
        if (!verdict) {
          // 答不上来不记 judgedAt：下次还能再问。
          this.scheduleSave('patterns');
          return {
            ok: false,
            checked: looked,
            error: `${looked.length > 0 ? `已看过「${looked.join('」「')}」，` : ''}我这边没拿到能用的答复，这次没看成。稍后再点一次。`,
          };
        }
        pattern.judgedAt = Date.now();
        pattern.judgedRuns = pattern.runs.length;
        if (verdict.worth) {
          const item = this.raiseAdvice(pattern, verdict);
          if (!item) {
            return { ok: false, checked: looked, error: '建议没有发出去，稍后再试。' };
          }
          return {
            ok: true,
            id: item.id,
            title: item.title,
            body: item.body,
            key: pattern.key,
            checked: [...looked, title],
          };
        }
        looked.push(title);
      }
      this.scheduleSave('patterns');
      return {
        ok: false,
        checked: looked,
        error: `我看过 ${looked.length} 类重复工作（${looked.join('、')}），都还不够通用，先不预制。换个更典型的活再做几次，我再来复盘。`,
      };
    } finally {
      this.reviewingNow = false;
    }
  }

  /** The director's own conversation: hold deliveries while it is answering. */
  setInteractive(active) {
    this.interactive = Math.max(0, this.interactive + (active ? 1 : -1));
    if (!active) this.drain();
  }

  noteTyping(active) {
    if (active) this.typingAt = Date.now();
  }

  noteUserMessage({ taskId, text }) {
    const id = idOf(taskId);
    if (!id) return;
    // The human is steering this task now. Queued instructions that say the
    // same thing are dropped; the rest wait until the turn is over and the
    // human has left.
    const queued = this.instructions.filter(
      (item) => item.taskId === id && item.state === 'queued',
    );
    for (const instruction of queued) {
      if (similarity(text, instruction.text) >= 0.55) {
        instruction.state = 'discarded';
        instruction.finishedAt = Date.now();
        instruction.note = '和用户刚下的指令重复，已丢弃';
        this.ledgerPush({
          kind: 'instruction:discarded',
          taskId: id,
          title: this.taskOf(id)?.title,
          text: '被用户指令覆盖',
        });
      }
    }
    this.scheduleSave('instructions');
    if (queued.length > 0 && queued.every((item) => item.state !== 'queued')) return;
    if (queued.length > 0 && this.getState().mode === 'run' && this.monitored(id)) {
      void this.judgeCoverage(id, text, queued);
    }
  }

  async judgeCoverage(taskId, userText, queued) {
    const reply = await this.ask({
      system:
        '你是工作总监。判断用户刚刚下发的指令，是否已经覆盖了你排在队列里的指令。' +
        '只回答一行 JSON：{"covered": true 或 false, "ids": ["被覆盖的指令 id"]}。' +
        '语义相同、或用户的新指令包含了原指令的意图，就算覆盖；只是提到同一件事不算。',
      user: [
        `任务：${this.taskOf(taskId)?.title ?? ''}`,
        `用户的指令：${clip(userText, 800)}`,
        '你的排队指令：',
        ...queued
          .filter((item) => item.state === 'queued')
          .map((item) => `- ${item.id}：${clip(item.text, 500)}`),
      ].join('\n'),
      maxTokens: 300,
    });
    if (!reply) return;
    const parsed = this.parseJson(reply);
    if (!parsed || parsed.covered !== true || !Array.isArray(parsed.ids)) return;
    for (const id of parsed.ids) {
      const instruction = this.instructions.find(
        (item) => item.id === id && item.taskId === taskId && item.state === 'queued',
      );
      if (!instruction) continue;
      instruction.state = 'discarded';
      instruction.finishedAt = Date.now();
      instruction.note = '和用户刚下的指令重复，已丢弃';
      this.ledgerPush({
        kind: 'instruction:discarded',
        taskId,
        title: this.taskOf(taskId)?.title,
        text: '被用户指令覆盖',
      });
    }
    this.scheduleSave('instructions');
  }

  /* ------------------------------------------------------------------ */
  /* permission / question delegation                                   */
  /* ------------------------------------------------------------------ */

  async handlePermission(taskId, payload) {
    const state = this.getState();
    const access = this.spaceAccess(taskId);
    if (!state.enabled || access === 'off') return;
    if (director.ownerOf(state, taskId) === 'human') return;
    const task = this.taskOf(taskId);
    const summary = oneLine(payload?.summary || payload?.call?.name, 200);
    const danger = Boolean(
      payload?.danger || payload?.doubleConfirm || (Array.isArray(payload?.secrets) && payload.secrets.length > 0),
    );

    if (state.mode === 'observe') {
      this.addInbox({
        kind: 'alert',
        title: '任务在等你批准',
        body: `「${task?.title ?? '任务'}」需要确认：${summary}\n原因：${oneLine(payload?.reason, 200)}`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }

    if (state.mode === 'suggest') {
      const opinion = await this.ask({
        system:
          '你是工作总监，只给意见，不替用户决定。用两三句话说清楚：这一步该批准还是拒绝，为什么。' +
          '不要复述任务，不要写步骤。',
        user: [
          `任务：${task?.title ?? ''}`,
          `操作：${summary}`,
          `触发原因：${oneLine(payload?.reason, 300)}`,
          danger ? '风险：高（危险操作、删除或需要凭据）' : '风险：常规',
        ].join('\n'),
        maxTokens: 300,
      });
      this.addInbox({
        kind: 'alert',
        title: '需要你批准（我建议）',
        body: `「${task?.title ?? '任务'}」需要确认：${summary}${
          opinion ? `\n\n我的意见：${opinion}` : ''
        }`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }

    // 代跑: the director decides, except where a mistake cannot be undone.
    if (access !== 'write') {
      // 只读 spaces are watched, not driven: report, never resolve.
      this.addInbox({
        kind: 'alert',
        title: '任务在等你批准',
        body: `「${task?.title ?? '任务'}」需要确认：${summary}\n这个空间只让我看，我不替你批。`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }
    if (danger) {
      this.raiseConfirm(taskId, payload, summary, '这一步风险高，我不替你批');
      return;
    }
    if (!this.mayAutoApprove(taskId)) {
      this.raiseConfirm(taskId, payload, summary, '这一小时自动批准次数过多，交给你');
      return;
    }

    const allowed = this.resolveRun(taskId, payload?.call?.id, { allow: true });
    if (!allowed) {
      this.raiseConfirm(taskId, payload, summary, '没能把决定送回任务，请你处理');
      return;
    }
    this.recordApproval(taskId);
    this.ledgerPush({
      kind: 'permission:auto',
      taskId,
      title: task?.title,
      text: `批准：${summary}`,
    });
    // One report per ten minutes per task: the ledger has every approval, the
    // inbox should not turn a busy task into a wall of identical notices.
    const key = `${taskId}:auto`;
    if (Date.now() - (this.lastAlertAt.get(key) ?? 0) > 10 * 60 * 1000) {
      this.lastAlertAt.set(key, Date.now());
      this.addInbox({
        kind: 'report',
        title: '我替你批准了一步',
        body: `「${task?.title ?? '任务'}」：${summary}`,
        taskId,
        taskTitle: task?.title,
      });
    }
  }

  async handleQuestion(taskId, payload) {
    const state = this.getState();
    const access = this.spaceAccess(taskId);
    if (!state.enabled || access === 'off') return;
    if (director.ownerOf(state, taskId) === 'human') return;
    const task = this.taskOf(taskId);
    const question = oneLine(payload?.question, 400);
    const options = Array.isArray(payload?.options) ? payload.options.map((item) => oneLine(item, 80)) : [];

    if (state.mode === 'observe') {
      this.addInbox({
        kind: 'alert',
        title: '任务在等你回答',
        body: `「${task?.title ?? '任务'}」提问：${question}`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }

    if (state.mode === 'suggest') {
      const opinion = await this.ask({
        system: '你是工作总监，只给意见，不替用户回答。用两三句话给出你推荐的选择和理由。',
        user: [`任务：${task?.title ?? ''}`, `问题：${question}`, options.length ? `选项：${options.join(' / ')}` : '']
          .filter(Boolean)
          .join('\n'),
        maxTokens: 300,
      });
      this.addInbox({
        kind: 'alert',
        title: '需要你回答（我建议）',
        body: `「${task?.title ?? '任务'}」提问：${question}${opinion ? `\n\n我的意见：${opinion}` : ''}`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }

    if (access !== 'write') {
      this.addInbox({
        kind: 'alert',
        title: '任务在等你回答',
        body: `「${task?.title ?? '任务'}」提问：${question}\n这个空间只让我看，我不替你答。`,
        taskId,
        urgent: true,
        taskTitle: task?.title,
      });
      return;
    }

    const reply = await this.ask({
      system:
        '你是工作总监，替用户回答工人的提问。只回答一行 JSON：' +
        '{"answer": "给工人的答复", "ask_user": false}。' +
        '如果你没有足够信息、或涉及删除、凭据、付费、对外发送，就把 ask_user 设为 true，answer 留空。',
      user: [
        `任务：${task?.title ?? ''}`,
        `问题：${question}`,
        options.length ? `选项：${options.join(' / ')}` : '',
        `最近的进展：${clip(this.runs.get(taskId)?.text ?? '', 600)}`,
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 400,
    });
    const parsed = reply ? this.parseJson(reply) : null;
    if (!parsed || parsed.ask_user === true || !String(parsed.answer ?? '').trim()) {
      this.addConfirm(taskId, {
        title: '工人在等你回答',
        body: `「${task?.title ?? '任务'}」提问：${question}`,
        actions: [
          { id: 'answer', label: '我去回答', style: 'primary' },
          { id: 'dismiss', label: '先放着' },
        ],
        payload: { kind: 'question', callId: payload?.call?.id, question, options },
      });
      return;
    }
    const allowed = this.resolveRun(taskId, payload?.call?.id, {
      allow: true,
      answer: oneLine(parsed.answer, 600),
    });
    if (!allowed) return;
    this.ledgerPush({
      kind: 'question:auto',
      taskId,
      title: task?.title,
      text: `回答：${question} → ${oneLine(parsed.answer, 300)}`,
    });
    this.addInbox({
      kind: 'report',
      title: '我替你回答了一个问题',
      body: `「${task?.title ?? '任务'}」：${question}\n\n我回答：${oneLine(parsed.answer, 300)}`,
      taskId,
      taskTitle: task?.title,
    });
  }

  raiseConfirm(taskId, payload, summary, why) {
    const task = this.taskOf(taskId);
    this.addConfirm(taskId, {
      title: '任务需要你决定',
      body: `「${task?.title ?? '任务'}」：${summary}\n${why}`,
      actions: [
        { id: 'allow', label: '批准', style: 'primary' },
        { id: 'deny', label: '拒绝', style: 'danger' },
      ],
      payload: {
        kind: 'permission',
        callId: payload?.call?.id,
        requestId: payload?.requestId ?? this.runs.get(taskId)?.requestId,
        danger: Boolean(payload?.danger),
        doubleConfirm: Boolean(payload?.doubleConfirm),
      },
      urgent: true,
    });
  }

  mayAutoApprove(taskId) {
    const now = Date.now();
    const stamps = (this.autoApprovals.get(taskId) ?? []).filter(
      (at) => now - at < AUTO_APPROVAL_WINDOW,
    );
    this.autoApprovals.set(taskId, stamps);
    return stamps.length < AUTO_APPROVAL_LIMIT;
  }

  recordApproval(taskId) {
    const stamps = this.autoApprovals.get(taskId) ?? [];
    stamps.push(Date.now());
    this.autoApprovals.set(taskId, stamps.slice(-AUTO_APPROVAL_LIMIT));
  }

  /* ------------------------------------------------------------------ */
  /* reports + inbox                                                    */
  /* ------------------------------------------------------------------ */

  queueReport({ taskId, title, ok, error, tail, urgent = false, files = [] }) {
    const state = this.getState();
    if (!state.enabled || !this.monitored(taskId)) return;
    // The user is looking at this very task; a report would only repeat what
    // is already on their screen.
    if (director.ownerOf(state, taskId) === 'human') return;

    const now = Date.now();
    const last = this.lastReportAt.get(taskId) ?? 0;
    if (!urgent && now - last < COOLDOWN_MS) return;

    const previous = this.pendingReports.get(taskId);
    const merged = {
      taskId,
      title,
      ok: previous ? previous.ok && ok : ok,
      error: error || previous?.error || '',
      tail: tail || previous?.tail || '',
      urgent: urgent || Boolean(previous?.urgent),
      files: mergeDeliveredFiles(previous?.files, files),
    };

    if (this.reportTimers.has(taskId)) {
      this.pendingReports.set(taskId, merged);
      return;
    }
    this.pendingReports.set(taskId, merged);
    const timer = setTimeout(() => {
      this.reportTimers.delete(taskId);
      const report = this.pendingReports.get(taskId);
      this.pendingReports.delete(taskId);
      if (!report) return;
      this.commitReport(report);
    }, REPORT_DEBOUNCE_MS);
    if (timer.unref) timer.unref();
    this.reportTimers.set(taskId, timer);
  }

  commitReport(report) {
    const now = Date.now();
    this.lastReportAt.set(report.taskId, now);
    const task = this.taskOf(report.taskId);
    // 领导只看结论：一句话 + 最有用的那一小截，细节去任务里看。
    // 保留工人答复里的换行和 Markdown：表格、列表、加粗要能原样画出来。
    const body = report.ok
      ? `「${report.title}」完成。${report.tail ? `\n\n${markdownTail(report.tail)}` : ''}`
      : `「${report.title}」异常结束。${report.error ? `\n\n${oneLine(report.error, 300)}` : ''}`;
    this.addInbox({
      kind: report.ok ? 'report' : 'alert',
      title: report.ok ? '任务完成' : '任务异常结束',
      body,
      taskId: report.taskId,
      taskTitle: task?.title ?? report.title,
      urgent: report.urgent,
      files: report.files,
    });
  }

  addInbox(item) {
    const now = Date.now();
    const entry = normalizeInboxItem({
      id: uid('msg'),
      kind: item.kind ?? 'report',
      speaker: item.speaker,
      title: item.title,
      body: item.body,
      taskId: item.taskId,
      taskTitle: item.taskTitle,
      urgent: Boolean(item.urgent),
      at: now,
      read: false,
      status: 'open',
      actions: item.actions ?? [],
      payload: item.payload ?? null,
      files: item.files ?? [],
      needsRead: Boolean(item.needsRead),
      mustRead: Boolean(item.mustRead),
    });
    if (!entry) return null;
    this.inbox.push(entry);
    this.inbox = this.inbox
      .filter((candidate) => now - candidate.at < INBOX_TTL)
      .slice(-MAX_INBOX);
    this.scheduleSave('inbox');
    this.ledgerPush({
      kind: `inbox:${entry.kind}`,
      taskId: entry.taskId,
      title: entry.taskTitle,
      // 账上要能看出问题本身，不能只留一句标题。
      text: entry.body && entry.body !== entry.title ? `${entry.title}：${entry.body}` : entry.title,
    });
    this.broadcastSummary();
    return entry;
  }

  addConfirm(taskId, { title, body, actions, payload, urgent, files = [], needsRead = false }) {
    const task = this.taskOf(taskId);
    return this.addInbox({
      kind: 'confirm',
      title,
      body,
      taskId,
      taskTitle: task?.title,
      actions,
      payload,
      urgent,
      files,
      needsRead,
    });
  }

  /** 浮在对话右侧的箭头只数真正待操作的：必读建议也算，直到用户表态。 */
  mustReadCount() {
    return this.inbox.filter((item) => item.mustRead && item.status === 'open').length;
  }

  broadcastSummary() {
    const summary = this.summary();
    this.broadcast('director:inbox', summary);
  }

  summary() {
    return {
      // 必读条目即使对话开着也保持未读，直到用户点「知道了」或「先不用」。
      unread: this.inbox.filter((item) => item.status === 'open' && (!item.read || item.mustRead)).length,
      confirms: this.inbox.filter((item) => item.kind === 'confirm' && item.status === 'open').length,
      mustRead: this.mustReadCount(),
      at: Date.now(),
    };
  }

  inboxView() {
    return {
      ...this.summary(),
      // 最近一次派工收口的时间。界面用它收掉总监写过的旧计划：
      // 只看收件箱里的汇总条目不够——用户清空对话后汇总被剪掉，计划就永远挂着。
      planDoneAt: Math.max(0, ...[...this.projects.values()].map((item) => Number(item.finishedAt) || 0)),
      items: [...this.inbox].reverse().slice(0, 80),
    };
  }

  /**
   * 用户清空总监对话时调用：收件箱里只留下还没处理、仍需要点按钮的条目。
   * 否则下一次刷新会把已经清掉的汇报重新灌回对话。
   */
  pruneForClear() {
    const before = this.inbox.length;
    this.inbox = this.inbox.filter(
      (item) =>
        item.status === 'open' &&
        !item.resolution &&
        Array.isArray(item.actions) &&
        item.actions.length > 0,
    );
    if (this.inbox.length !== before) this.scheduleSave('inbox');
    this.broadcastSummary();
    return this.inbox.map((item) => item.id);
  }

  markRead(ids) {
    const wanted = Array.isArray(ids) && ids.length > 0 ? new Set(ids.map(String)) : null;
    for (const item of this.inbox) {
      if (wanted && !wanted.has(item.id)) continue;
      // 自动标读（面板打开）不能吃掉必读；必读只能由用户表态结束。
      if (!wanted && item.mustRead && item.status === 'open') continue;
      item.read = true;
    }
    this.scheduleSave('inbox');
    this.broadcastSummary();
    return this.inboxView();
  }

  async resolveInbox({ id, action, value }) {
    const item = this.inbox.find((entry) => entry.id === String(id ?? ''));
    if (!item) return { ok: false, error: '这条消息已经不存在' };
    const taskId = item.taskId;
    const callId = item.payload?.callId;

    // 效率建议只有两个结果：知道了、先不用。都不会改动任何能力。
    if (action === 'ack' || action === 'ignore') {
      const pattern = this.patternOf(item.payload?.adviceKey);
      if (pattern) {
        if (action === 'ignore') {
          pattern.ignore = (pattern.ignore || 0) + 1;
          if (pattern.ignore >= workPatterns.LIMITS.ignores) {
            pattern.mutedUntil = Date.now() + workPatterns.LIMITS.muteMs;
          }
        } else {
          pattern.ignore = 0;
          pattern.mutedUntil = 0;
        }
        this.scheduleSave('patterns');
      }
      item.status = action === 'ignore' ? 'dismissed' : 'resolved';
      item.resolution = action;
      item.read = true;
      item.mustRead = false;
      this.ledgerPush({
        kind: `advice:${action}`,
        taskId,
        title: item.title,
        text: action === 'ignore' ? '先不用' : '已读',
      });
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'dismiss') {
      item.status = 'dismissed';
      item.resolution = 'dismiss';
      item.read = true;
      item.needsRead = false;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'read') {
      item.needsRead = false;
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'open') {
      return { ok: true, openTask: taskId };
    }

    if (action === 'allow' || action === 'deny') {
      if (!callId) return { ok: false, error: '这个确认已经失效' };
      const allowed = this.resolveRun(taskId, callId, { allow: action === 'allow' });
      if (!allowed) return { ok: false, error: '任务已经不在等待这个确认了' };
      item.status = 'resolved';
      item.resolution = action;
      item.read = true;
      this.ledgerPush({
        kind: `confirm:${action}`,
        taskId,
        title: item.taskTitle,
        text: oneLine(item.body, 200),
      });
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'answer') {
      const answer = String(value ?? '').trim();
      if (!answer) return { ok: false, error: '回答不能为空' };
      if (!callId) return { ok: false, error: '这个问题已经失效' };
      const allowed = this.resolveRun(taskId, callId, { allow: true, answer });
      if (!allowed) return { ok: false, error: '任务已经不在等待这个回答' };
      item.status = 'resolved';
      item.resolution = 'answer';
      item.read = true;
      this.ledgerPush({ kind: 'confirm:answer', taskId, title: item.taskTitle, text: answer });
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'approve' && item.payload?.kind === 'instruction' && item.payload.draft) {
      const draft = item.payload.draft;
      const result = this.enqueue({ ...draft, approved: true });
      if (!result.ok) return result;
      item.status = 'resolved';
      item.resolution = 'approve';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      this.drain();
      return { ok: true };
    }

    if (action === 'approve' && item.payload?.kind === 'dispatch' && item.payload.draft) {
      const result = this.executeDispatch(item.payload.draft);
      if (!result.ok) return result;
      item.status = 'resolved';
      item.resolution = 'approve';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'approve' && item.payload?.kind === 'split' && item.payload.draft) {
      const draft = item.payload.draft;
      const result = this.spawnEmployees(draft);
      if (!result.ok) return result;
      item.status = 'resolved';
      item.resolution = 'approve';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'choose' && item.payload?.kind === 'workspace' && item.payload.draft) {
      if (this.getState().mode === 'observe') {
        return { ok: false, error: '当前是观察级别：只能提醒，不能给员工派任务' };
      }
      const spaceId = String(value ?? '').trim();
      if (!spaceId) return { ok: false, error: '没有选择工作空间' };
      if (director.accessFor(this.getState(), spaceId) !== 'write') {
        return { ok: false, error: '这个工作空间还没有交给总监写入，先在分管范围里授权' };
      }
      const result = this.executeDispatch({ ...item.payload.draft, workspaceId: spaceId });
      if (!result.ok) return result;
      item.status = 'resolved';
      item.resolution = 'choose';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true, dispatchId: result.dispatchId };
    }

    if (action === 'choose-model' && item.payload?.kind === 'model' && item.payload.taskId) {
      const taskId = idOf(item.payload.taskId);
      const model = oneLine(value, 200);
      if (!model) return { ok: false, error: '没有选择模型' };
      // 模型由界面先换好（任务自己的设置），这里只负责让原来的要求再跑一次。
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload.instructionId ?? ''),
      );
      let retried = false;
      if (instruction) {
        if (!['queued', 'delivered', 'rework'].includes(instruction.state)) {
          const result = this.enqueue({
            taskId: instruction.taskId,
            text: instruction.text,
            intent: instruction.intent || instruction.text,
            criteria: instruction.criteria,
            source: 'director',
            attempts: instruction.attempts,
            approved: true,
            dispatch: instruction.dispatchId
              ? {
                  dispatchId: instruction.dispatchId,
                  dispatchTitle: instruction.dispatchTitle,
                  employeeName: instruction.employeeName,
                  dispatchSize: instruction.dispatchSize,
                }
              : null,
          });
          if (!result.ok) return result;
          retried = true;
          instruction.state = 'discarded';
          instruction.note = '已换模型重试';
          this.scheduleSave('instructions');
        }
      } else {
        // 用户自己跑的那一轮：把最后一句用户发言交回界面，让它原样重发。
        const messages = await this.sessionMessages(taskId).catch(() => []);
        const last = [...messages].reverse().find(
          (message) =>
            message.role === 'user' &&
            String(message.content ?? '').trim() &&
            !String(message.content).startsWith('【工作总监】'),
        );
        if (last) retried = true;
        item.payload.retryText = last ? clip(String(last.content), 4000) : '';
      }
      item.status = 'resolved';
      item.resolution = 'choose-model';
      item.read = true;
      this.ledgerPush({
        kind: 'model:choose',
        taskId,
        title: this.taskOf(taskId)?.title,
        text: `换成 ${model}`,
      });
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return {
        ok: true,
        retried,
        retryText: String(item.payload.retryText ?? ''),
      };
    }

    // 删除任务：用户点头之后才交给界面执行。任务数据在界面，主进程不碰文件。
    if (item.payload?.kind === 'task-op' && action === 'confirm') {
      const ids = (Array.isArray(item.payload.taskIds) ? item.payload.taskIds : [])
        .map(idOf)
        .filter(Boolean);
      item.status = 'resolved';
      item.resolution = 'confirm';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      this.broadcastTaskDelete(ids);
      this.ledgerPush({ kind: 'task:delete', text: `用户确认删除 ${ids.length} 个任务` });
      return { ok: true, count: ids.length };
    }

    // 重启前没跑完的删除类指令：继续还是放弃，由用户决定。
    if (item.payload?.kind === 'restored') {
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload?.instructionId ?? ''),
      );
      if (!instruction) return { ok: false, error: '对应的指令已经不在了' };
      item.status = 'resolved';
      item.resolution = action;
      item.read = true;
      if (action === 'resume') {
        instruction.restored = false;
        instruction.alertedAt = 0;
        instruction.state = 'queued';
        instruction.note = '';
        instruction.startedAt = 0;
        instruction.deliveredAt = 0;
        this.pendingDelivery.delete(instruction.taskId);
        this.scheduleSave('instructions');
        this.scheduleSave('inbox');
        this.broadcastSummary();
        this.drain();
        return { ok: true };
      }
      instruction.state = 'discarded';
      instruction.note = '重启后用户选择不继续';
      instruction.finishedAt = Date.now();
      this.scheduleSave('instructions');
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    // 总监说“像卡住了”，领导点了处理：停掉、补指令，或者再等等。
    if (item.payload?.kind === 'stuck-action' && action === 'approve') {
      const taskId = idOf(item.payload?.taskId ?? '');
      const task = this.taskOf(taskId);
      if (!taskId) return { ok: false, error: '对应的任务已经不在了' };
      const wanted = item.payload?.action === 'instruct' ? 'instruct' : 'stop';
      let acted = false;
      if (wanted === 'instruct' && String(item.payload?.instruction ?? '').trim()) {
        const queued = this.enqueue({
          taskId,
          text: String(item.payload.instruction),
          intent: '修复卡住的任务',
          criteria: String(item.payload?.criteria ?? ''),
          source: 'director',
          approved: true,
          attempts: 1,
        });
        if (queued.ok) {
          this.interruptTask(taskId);
          acted = true;
        }
      }
      if (!acted) acted = this.interruptTask(taskId).ok;
      item.status = 'resolved';
      item.resolution = 'approve';
      item.read = true;
      if (acted) {
        this.addInbox({
          kind: 'report',
          title: wanted === 'instruct' ? '卡住的任务已经补上指令' : '卡住的任务已经叫停',
          body: `「${task?.title ?? item.taskTitle ?? '任务'}」我处理了。${
            wanted === 'instruct' ? '新指令会紧接着开始。' : '这一轮停下，排队中的指令会继续。'
          }`,
          taskId,
          taskTitle: task?.title,
        });
      }
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return { ok: true };
    }

    // 超时提醒：领导点“叫停跑得最久的”就真的停；点“继续等”就放宽预期。
    if (item.payload?.kind === 'project-overdue') {
      const project = this.projects.get(idOf(item.payload?.projectId));
      item.status = 'resolved';
      item.resolution = action === 'stop' ? 'stop' : 'dismiss';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      if (!project) return { ok: true };
      if (action === 'stop') {
        const active = this.activeBuildInstructions(project);
        const target =
          active.find((entry) => entry.taskId === idOf(item.payload?.taskId)) ||
          [...active].sort(
            (a, b) => Number(a.startedAt || a.createdAt || 0) - Number(b.startedAt || b.createdAt || 0),
          )[0];
        if (!target) {
          this.addInbox({
            kind: 'report',
            title: '没有可叫停的任务',
            body: `「${project.title}」现在没有还在编制的员工，可能刚交付或已经停了。`,
            taskTitle: project.title,
          });
          return { ok: true };
        }
        const stopped = this.interruptTask(target.taskId);
        this.addInbox({
          kind: 'report',
          title: stopped.ok ? '已经叫停了最久的那一个' : '没叫停成功',
          body: stopped.ok
            ? `「${project.title}」里的「${target.employeeName || '员工'}」已经叫停；它会交回已经做到的部分，我再按现状收尾。`
            : `「${project.title}」里的「${target.employeeName || '员工'}」没停下来：${
                stopped.error || '未知原因'
              }。`,
          taskId: target.taskId,
          taskTitle: project.title,
          urgent: !stopped.ok,
        });
        return { ok: true };
      }
      const elapsed = Date.now() - (project.startedAt || Date.now());
      project.estimateMs = Math.max(Number(project.estimateMs) || 0, Math.round(elapsed * 1.5));
      project.buildEtaAt = (project.startedAt || Date.now()) + project.estimateMs;
      project.estimateNote = '按领导的“继续等”调整了预期';
      this.addProjectDecision(project.id, '领导选择继续等，我放宽了预期');
      this.scheduleSave('projects');
      return { ok: true };
    }

    // 项目偏长：领导点“进入项目”就带他去项目，不交半成品；
    // 点“继续跑”就延长预期，过 6 分钟再按实际进度报一次。
    if (item.payload?.kind === 'project-time') {
      const project = this.projects.get(idOf(item.payload?.projectId));
      if (!project) return { ok: false, error: '这个项目档案已经不在了' };
      item.status = 'resolved';
      item.resolution = action === 'approve' ? 'approve' : 'dismiss';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      if (action === 'approve') {
        const taskId =
          project.taskIds.find((id) => this.tasks.has(id)) || project.taskIds[0] || '';
        project.lastReportAt = Date.now();
        project.lastReport = '领导要进项目看当前进度';
        this.addProjectDecision(project.id, '领导要进项目看当前进度');
        this.scheduleSave('projects');
        return taskId ? { ok: true, openTask: taskId } : { ok: true };
      }
      // 继续跑：把预期放宽到“已用 + 一半”，给项目一个更符合现状的参照。
      const elapsed = Date.now() - project.startedAt;
      project.estimateMs = Math.max(project.estimateMs, Math.round(elapsed * 1.5));
      project.estimateNote = '按领导的“继续跑”调整了预期';
      this.addProjectDecision(project.id, '领导选择继续跑，我放宽了预期');
      this.scheduleSave('projects');
      return { ok: true };
    }

    // 开发完成、准备调试：带领导进项目，并把调试项/预计时间/入口一起说清。
    if (item.payload?.kind === 'project-debug') {
      const project = this.projects.get(idOf(item.payload?.projectId));
      const taskId = idOf(item.payload?.taskId ?? '') || project?.taskIds?.[0] || '';
      item.status = 'resolved';
      item.resolution = action === 'approve' ? 'approve' : 'ack';
      item.read = true;
      this.scheduleSave('inbox');
      this.broadcastSummary();
      if (action === 'approve' && taskId) return { ok: true, openTask: taskId };
      return { ok: true };
    }

    // 删除类任务由用户自己确认通过：不再重跑，直接收尾。
    if (item.payload?.kind === 'accept-hold' && action === 'accept') {
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload?.instructionId ?? ''),
      );
      if (!instruction) return { ok: false, error: '对应的指令已经不在了' };
      instruction.state = 'accepted';
      instruction.finishedAt = Date.now();
      instruction.unverified = false;
      instruction.resultNote = '用户确认通过';
      item.status = 'resolved';
      item.resolution = 'accept';
      item.read = true;
      this.ledgerPush({
        kind: 'accept:pass',
        taskId,
        title: item.taskTitle,
        text: '用户确认通过',
      });
      this.scheduleSave('instructions');
      this.scheduleSave('inbox');
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      this.broadcastSummary();
      return { ok: true };
    }

    // 模型没验、用户看过交付后选择“按现状收尾”：这才算收尾，仍然如实记为
    // “用户收尾”，不伪装成模型验收通过。
    if (item.payload?.kind === 'accept-unverified' && action === 'accept') {
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload?.instructionId ?? ''),
      );
      if (!instruction) return { ok: false, error: '对应的指令已经不在了' };
      instruction.state = 'accepted';
      instruction.finishedAt = Date.now();
      instruction.unverified = false;
      instruction.resultNote = '用户看过交付后按现状收尾（未验证）';
      item.status = 'resolved';
      item.resolution = 'accept';
      item.read = true;
      this.ledgerPush({
        kind: 'accept:user-settled',
        taskId,
        title: item.taskTitle,
        text: '用户按现状收尾（未验证）',
      });
      this.scheduleSave('instructions');
      this.scheduleSave('inbox');
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      this.broadcastSummary();
      return { ok: true };
    }

    if (action === 'rework' || action === 'accept' || action === 'abandon') {
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload?.instructionId ?? '') || entry.id === String(value ?? ''),
      );
      if (!instruction) return { ok: false, error: '对应的指令已经不在了' };
      let queued = null;
      if (action === 'abandon') {
        instruction.state = 'discarded';
        instruction.finishedAt = Date.now();
      } else {
        // “再跑一次”不是把整份任务重发一遍：工人还在同一个任务会话里，
        // 原要求它有。只把上次没过的缺口给它，并给一个时间上限，避免又去
        // 搭一整套测试环境、把全项目重审一遍。
        const gap = String(instruction.resultNote || '')
          .replace(/^未验证[:：]\s*/, '')
          .trim();
        const reworkText = [
          '只补上次验收指出的缺口，不要重做已经通过的部分，也不要把整个项目重新审查一遍。',
          `任务：${oneLine(instruction.intent || instruction.taskTitle || instruction.text, 200)}`,
          gap ? `缺口：${gap}` : '缺口：上一轮没有拿到可验收的结论，请只补这一项并给出证据。',
          `最多 ${VERIFY_BUDGET_MINUTES} 分钟；拿不到证据就写清哪一项没测到，不要继续搭测试环境或扩大范围。`,
          '原要求你已经有了，按它对照着补这一项，不要从头再来。',
        ].join('\n');
        queued = this.enqueue({
          taskId: instruction.taskId,
          text:
            action === 'accept'
              ? `${instruction.text}\n\n验收结论：按现状收尾，不再返工。`
              : action === 'rework'
                ? reworkText
                : instruction.text,
          intent: instruction.intent || instruction.text,
          criteria: instruction.criteria,
          source: 'director',
          attempts: action === 'rework' ? 3 : 1,
          // 验证类返工给硬上限：到点没结论就停，交已有证据，不再无限搭环境。
          budgetMinutes: action === 'rework' ? VERIFY_BUDGET_MINUTES : 0,
          approved: true,
        });
        // 没排进去就不能把卡片标成“已返工”，否则用户以为重跑了，实际什么都没发。
        if (!queued.ok) return { ok: false, error: queued.error || '没能把返工排进队列' };
        instruction.state = 'discarded';
        instruction.finishedAt = Date.now();
      }
      item.status = 'resolved';
      item.resolution = action;
      item.read = true;
      this.ledgerPush({ kind: `accept:${action}`, taskId, title: item.taskTitle, text: '' });
      // 点“再跑一次”之后要立刻回一句：用户等的是“活动起来了”，不是一张变灰的卡片。
      if (action === 'rework') {
        const label = oneLine(item.taskTitle || instruction.taskTitle || '这个任务', 120);
        this.addInbox({
          kind: 'report',
          title: '返工已安排',
          body: queued?.duplicate
            ? `「${label}」这条已经在队列里了，我不重复下发；跑完我直接看结果。`
            : `「${label}」我让他按这一轮的缺口重跑一遍，跑完我直接看结果，有问题再叫他返工。`,
          taskId,
          taskTitle: item.taskTitle,
        });
      }
      this.scheduleSave('inbox');
      this.scheduleSave('instructions');
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      this.broadcastSummary();
      this.drain();
      return { ok: true };
    }

    return { ok: false, error: '未知操作' };
  }

  /* ------------------------------------------------------------------ */
  /* instructions                                                       */
  /* ------------------------------------------------------------------ */

  enqueue({
    taskId,
    text,
    criteria = '',
    source = 'director',
    attempts = 1,
    note = '',
    approved = false,
    files = [],
    /** 员工派工时声明“只改这些”；交付后 files 会被整轮扫描覆盖，这个要单独留。 */
    declaredFiles = [],
    dispatch = null,
    intent = '',
    estimateMinutes = 0,
    budgetMinutes = 0,
    role = 'build',
    round = 0,
    parentInstructionId = '',
    verifyPoints = [],
    dependsOn = [],
    /** 接口契约；返工/补发的指令也要带上，验收员才能按同一边界判。 */
    contract = '',
    /** 指令所属工作空间；没有时用任务自己的。 */
    workspaceId = '',
    askOnly = false,
    /** 领导的原话；派工时原样传给员工，返工/验收都按它判断范围。 */
    userText = '',
    /** 到点收口指令：交付时说“收口”，不说“完成”。 */
    isWrapUp = false,
    /** 这一单原本分到的时间，返工按它算。 */
    originalBudgetMinutes = 0,
  }) {
    const state = this.getState();
    if (!state.enabled) return { ok: false, error: '工作总监未启用' };
    const id = idOf(taskId);
    const task = this.taskOf(id);
    if (!task) return { ok: false, error: '找不到这个任务' };
    if (!this.writable(id)) {
      return { ok: false, error: '这个工作空间不在总监的分管范围内' };
    }
    const body = String(text ?? '').trim();
    if (!body) return { ok: false, error: '指令不能为空' };

    // 同一条指令还在排队/执行/返工/等确认时，再下一次就是重复劳动：
    // 工人会跑两遍，验收会出两张卡。按「任务 + 正文」去重。
    const fingerprint = body.replace(/\s+/g, ' ').trim();
    const duplicate = [...this.instructions]
      .reverse()
      .find(
        (item) =>
          item.taskId === id &&
          ['queued', 'delivered', 'rework', 'held'].includes(item.state) &&
          String(item.text ?? '').replace(/\s+/g, ' ').trim() === fingerprint,
      );
    if (duplicate) {
      return {
        ok: true,
        duplicate: true,
        instruction: duplicate,
        message: `这条指令已经在队列里了（${duplicate.state}，id=${duplicate.id}），没有重复下发。`,
      };
    }

    // 同一条领导原话已经由另一个任务/另一个入口接住：再发就是重复劳动。
    // 总监常见两种重复：先 instruct 再 dispatch；或者给刚派出的员工补一句
    // “现在执行”。后一种会顶掉队列里的第一条指令，把刚开始的 run 叫停，
    // 整次分配也会被误判成“已放弃”。
    if (source === 'director' && role !== 'verify' && !askOnly && round === 0 && userText.trim()) {
      const recent = this.recentSameUserText(userText, {
        excludeDispatchId: dispatch?.dispatchId || '',
      });
      // 同一任务上只拦“还没开始”的那条：工人已经在跑时，领导补一句新的
      // 要求仍然是有效的新指令；这里只防把排队中的第一条顶掉。
      //
      // 跨任务只在“直接下指令”时拦。派工回执里的员工指令不是另一条路：
      // 同一个大活可能分几批派（一批最多 8 人），每一批都带着领导的原话，
      // 跨任务去重会把第二批的指令直接吞掉，员工建了任务却收不到活。
      const repeat =
        recent && recent.taskId === id
          ? recent.state === 'queued'
          : Boolean(recent) && !dispatch?.dispatchId;
      if (repeat) {
        return {
          ok: true,
          duplicate: true,
          instruction: recent,
          message:
            recent.taskId === id
              ? `这条要求已经在队列里了（${recent.id}），工人会按它执行，不要重复下发。`
              : `这条要求刚才已经交给「${
                  this.taskOf(recent.taskId)?.title || recent.taskTitle || '另一个任务'
                }」了（${recent.id}），不要再开一份；等它的结果。`,
        };
      }
    }

    // The level is the user's standing instruction about who decides:
    // observe never instructs, suggest asks before anything goes out.
    if (source === 'director' && !approved) {
      if (state.mode === 'observe') {
        return { ok: false, error: '当前是观察级别：只能提醒，不能给工人下指令' };
      }
      if (state.mode === 'suggest') {
        this.addConfirm(id, {
          title: '我建议给工人下一条指令',
          body: `「${task.title}」：${clip(body, 500)}${criteria ? `\n验收：${clip(criteria, 200)}` : ''}`,
          actions: [
            { id: 'approve', label: '同意下发', style: 'primary' },
            { id: 'dismiss', label: '不用' },
          ],
          payload: {
            kind: 'instruction',
            // intent 要一起带上：用户同意后重新入队时，删除类判断靠它，
            // 不能退化成拿包裹了员工规则的正文去猜。
            draft: {
              taskId: id,
              text: body,
              intent: String(intent ?? '').trim(),
              criteria,
              source: 'director',
              attempts,
            },
          },
        });
        return { ok: true, pending: true, message: '已提交给你确认，同意后才会下发' };
      }
    }
    // 总监给某个员工任务补发的指令，仍然算那次分配的一部分：否则每个员工
    // 都会单独发一条“任务完成”，用户得一条条看。
    let dispatchMeta = dispatch;
    // 只问一句、不改代码的询问任务不归到原来的项目里，免得又触发一轮交付和验收。
    if (!dispatchMeta && source !== 'user' && !askOnly) {
      const owner = [...this.instructions]
        .reverse()
        .find((item) => item.taskId === id && item.dispatchId);
      if (owner) {
        dispatchMeta = {
          dispatchId: owner.dispatchId,
          dispatchTitle: owner.dispatchTitle,
          employeeName: owner.employeeName,
          dispatchSize: owner.dispatchSize,
        };
        for (const item of this.instructions) {
          if (item.dispatchId === owner.dispatchId) item.dispatchReported = false;
        }
      }
    }

    // 已经收口的派工，再补一条“把临时文件删掉”这类维护指令，不重开项目：
    // 否则项目会从 done 回到 active，原来的验收结论和计划/实际对账全被这一条
    // 小活覆盖。维护指令单独走，验收也只核目标状态。
    const maintenance = cleanupTargets(body).length > 0;
    if (dispatchMeta && maintenance) {
      const ownerProject = this.projects.get(idOf(dispatchMeta.dispatchId));
      if (ownerProject?.status === 'done') dispatchMeta = null;
    }

    // 给已有任务下的第一条指令也开一个项目档案：总监下次判断时知道
    // 这件事的目标、估时、已经拍过的板和当前阶段，不用每次从零想。
    // 验收员是一次性检查，不是项目里的工作量：不建项目档案。只问不改的
    // 集成询问也一样，不新建项目。已收口项目上的维护指令也不新建项目。
    if (source === 'director' && role !== 'verify' && !askOnly && !maintenance) {
      const projectId = dispatchMeta?.dispatchId || taskProjectId(id);
      const project = this.ensureProject({
        id: projectId,
        kind: dispatchMeta?.dispatchId ? 'dispatch' : 'task',
        title: dispatchMeta?.dispatchTitle || task.title,
        goal: userText || body,
        workspaceId: task.workspaceId,
        estimateMinutes,
      });
      if (project) {
        this.addProjectTask(projectId, id);
        // 收口后又补了活：项目重新进入进行中，别让总监以为它已经结束。
        if (project.status === 'done') {
          project.status = 'active';
          project.finishedAt = 0;
          project.lastFingerprint = '';
          project.lastReportFingerprint = '';
          // 又开了新活：上一轮的“可以调试了”不能挡住这一轮的调试交接。
          project.debugNotifiedAt = 0;
          // 时间和超时基线按这一轮重算。原来只把状态改回 active，startedAt /
          // buildEtaAt / overdueAlerts 还是上一轮的——新活刚排上队 5 秒就被判成
          // “已经跑了 35 分钟、超时 29 分钟”，还拿一张卡去问用户要不要叫停。
          project.startedAt = Date.now();
          project.estimateMs = 0;
          project.estimateNote = '';
          project.estimateAt = 0;
          project.buildEtaAt = 0;
          project.verifyEtaAt = 0;
          project.buildCheckedAt = 0;
          project.verifyCheckedAt = 0;
          project.overdueAlerts = 0;
          project.overdueReportedAt = 0;
          project.lastPulseAt = 0;
          project.updatedAt = Date.now();
        }
        if (!project.estimateMs) {
          void this.estimateProject(projectId, {
            title: project.title,
            employees: [{ name: dispatchMeta?.employeeName || '执行', task: body }],
          }).catch(() => undefined);
        }
      }
    }

    // 总监补发的编制指令也必须有上限：director_instruct 原来不带预算，那一单
    // 就是“不限时”——收口提醒和硬叫停都不会触发。按项目/这一单的量给默认值。
    if (role !== 'verify' && !askOnly && !budgetMinutes) {
      const project = this.projects.get(dispatchMeta?.dispatchId || taskProjectId(id));
      const fromProject = project?.estimateMs ? Math.round(project.estimateMs / 60000) : 0;
      budgetMinutes = planBuildBudget(fromProject || estimateMinutes);
    }

    const instruction = normalizeInstruction({
      id: uid('ins'),
      taskId: id,
      taskTitle: task.title,
      text: body,
      intent: intent || body,
      criteria,
      source,
      attempts,
      budgetMinutes,
      originalBudgetMinutes: originalBudgetMinutes || budgetMinutes,
      userText,
      isWrapUp,
      state: 'queued',
      createdAt: Date.now(),
      note,
      files,
      declaredFiles,
      role,
      round,
      parentInstructionId,
      verifyPoints,
      dependsOn,
      contract,
      workspaceId: workspaceId || task.workspaceId || '',
      /**
       * 这条指令是不是派工回执建的。直接下发的指令即使挂到了某个派工
       * 项目上（任务本来就在项目里），也仍然是“另一条路”，不能当成
       * 同一份计划的另一批；领导原话的去重要按这个区分。
       */
      fromDispatch: Boolean(dispatch?.dispatchId),
      ...(dispatchMeta ?? {}),
    });
    if (instruction) instruction.restored = false;
    this.instructions.push(instruction);
    if (this.instructions.length > MAX_INSTRUCTIONS) {
      this.instructions = this.instructions.slice(-MAX_INSTRUCTIONS);
    }
    this.scheduleSave('instructions');
    this.ledgerPush({
      kind: 'instruction:queue',
      taskId: id,
      title: task.title,
      text: body,
    });
    this.drain();
    return { ok: true, instruction };
  }

  drain() {
    const state = this.getState();
    if (!state.enabled || this.stopped) return;
    if (Date.now() - this.typingAt < TYPING_HOLD_MS) {
      this.scheduleDrain(TYPING_HOLD_MS);
      return;
    }
    if (this.interactive > 0) return;

    const now = Date.now();
    // 总监下发的任务同时跑多少，是标题右侧配置里的数字。超出的排队等着。
    let dispatchRunning = this.runningDispatchTaskIds().size;
    const maxDispatch = Math.max(1, Number(state.maxDispatch) || 4);
    for (const instruction of this.instructions) {
      if (instruction.state !== 'queued') continue;
      const taskId = instruction.taskId;
      if (!this.writable(taskId)) {
        // 空间不在分管范围、或者任务已经被删掉：这不是"等一下就好"，必须开口。
        this.askBlocked(instruction, '这个任务已经不存在，或者它的工作空间不在我的分管范围里');
        continue;
      }
      if (this.runs.has(taskId)) continue;
      if (
        (instruction.dispatchId || instruction.role === 'verify') &&
        dispatchRunning >= maxDispatch
      ) {
        // 验收员排队是正常的：有编制员工退出就会轮到它，不用惊动用户。
        if (instruction.role !== 'verify') {
          this.askBlocked(
            instruction,
            `同时在跑的员工已经到上限（${maxDispatch} 个），这一条一直在排队`,
            QUEUED_ALERT_MS,
          );
        }
        continue;
      }
      if (this.tasks.get(taskId)?.busy) continue;
      // 重启前没跑完的删除类指令不自动续跑：先问用户，别让一次重启
      // 把昨天没执行的“删掉”重新送出去。
      if (instruction.restored && looksDestructive(instruction.text, instruction.intent)) {
        this.askRestored(instruction);
        continue;
      }
      const delivery = this.pendingDelivery.get(taskId);
      if (delivery && now - delivery < DELIVERY_STALE_MS) continue;
      // Never talk over the human: while they are in the task, the director
      // waits (or asks), because two writers would fight over one worker.
      if (director.ownerOf(state, taskId) === 'human') continue;

      // 首次派工时环境卡可能还在探测。下发这一刻再补一次：员工拿到的
      // 指令里始终带着最新的卡片，不用自己重摸一遍环境。
      const envCard =
        instruction.role === 'verify'
          ? ''
          : this.envCardText(
              this.tasks.get(taskId)?.workspaceId || instruction.workspaceId,
            );
      if (envCard && !String(instruction.text).includes('环境卡（')) {
        instruction.text = `${instruction.text}\n\n${envCard}`;
      }
      instruction.state = 'delivered';
      instruction.deliveredAt = now;
      // 这一轮是当前进程重新送出去的，之后卡住就正常问用户。
      instruction.restored = false;
      this.pendingDelivery.set(taskId, now);
      this.scheduleSave('instructions');
      this.ledgerPush({
        kind: 'instruction:deliver',
        taskId,
        title: instruction.taskTitle,
        text: instruction.text,
      });
      this.broadcast('director:instruction', {
        instruction,
        task: this.tasks.get(taskId) ?? null,
      });
      return;
    }
  }

  /** 重启前没跑完的删除类指令：自动续跑风险太大，先让用户点头。 */
  askRestored(instruction) {
    if (!instruction || instruction.alertedAt) return;
    const open = this.inbox.some(
      (item) => item.status === 'open' && item.payload?.instructionId === instruction.id,
    );
    if (open) return;
    instruction.alertedAt = Date.now();
    const task = this.taskOf(instruction.taskId);
    this.addConfirm(instruction.taskId, {
      title: '重启前有条删除类指令没跑完',
      body: [
        `「${task?.title ?? instruction.taskTitle ?? '任务'}」这条指令是上次关应用前没执行的：`,
        `指令内容：${clip(instruction.text, 500)}`,
        '删除不可逆，重启后我没有自动续跑。要继续就点「继续执行」；不想做了点「放弃」。',
      ].join('\n'),
      actions: [
        { id: 'resume', label: '继续执行', style: 'primary' },
        { id: 'abandon', label: '放弃', style: 'danger' },
      ],
      payload: { kind: 'restored', instructionId: instruction.id },
      urgent: true,
    });
    this.ledgerPush({
      kind: 'instruction:blocked',
      taskId: instruction.taskId,
      title: instruction.taskTitle,
      text: '重启前的删除类指令，等用户确认是否继续',
    });
    this.scheduleSave('instructions');
  }

  /**
   * 一条指令排不出去的时候，不能装作没看见。问用户一次：再试、还是放弃。
   * 同一个任务/空间的权限问题，用户自己去「分管范围」改好后点「再试一次」即可。
   */
  askBlocked(instruction, reason, after = BLOCKED_ALERT_MS) {
    if (!instruction || instruction.alertedAt) return;
    const now = Date.now();
    // 上一次进程留下的指令交给 reconcileStale 统一收尾，别一张张问。
    if (instruction.restored) {
      if (now - this.loadedAt < RECONCILE_GRACE_MS) return;
      if (!this.tasks.has(instruction.taskId)) return;
    }
    const since = Number(instruction.createdAt) || now;
    if (now - since < after) return;
    const open = this.inbox.some(
      (item) =>
        item.status === 'open' &&
        item.payload?.instructionId === instruction.id,
    );
    if (open) return;
    instruction.alertedAt = now;
    const task = this.taskOf(instruction.taskId);
    const detail = task
      ? reason
      : '这个任务已经不存在了（会话或工作空间被删掉），我没法把指令送进去';
    this.addConfirm(instruction.taskId, {
      title: '这条指令没能执行，需要你定一下',
      body: [
        `「${instruction.taskTitle || task?.title || '任务'}」${detail}。`,
        `指令内容：${clip(instruction.text, 300)}`,
        '要我重试就点「再试一次」；如果缺的是写权限，先去「分管范围」把那个空间交给我，再点重试。不想做了就点「放弃」。',
      ].join('\n'),
      actions: [
        { id: 'rework', label: '再试一次', style: 'primary' },
        { id: 'abandon', label: '放弃', style: 'danger' },
      ],
      payload: { instructionId: instruction.id, blocked: detail },
      urgent: true,
    });
    this.ledgerPush({
      kind: 'instruction:blocked',
      taskId: instruction.taskId,
      title: instruction.taskTitle,
      text: detail,
    });
    this.scheduleSave('instructions');
  }

  scheduleDrain(delay) {
    if (this.stopped) return;
    if (this.saveTimers.has('drain')) return;
    const timer = setTimeout(() => {
      this.saveTimers.delete('drain');
      this.drain();
    }, Math.max(500, delay));
    if (timer.unref) timer.unref();
    this.saveTimers.set('drain', timer);
  }

  instructionAck({ id, ok, error }) {
    const instruction = this.instructions.find((entry) => entry.id === String(id ?? ''));
    if (!instruction) return { ok: false, error: '这条指令已经不存在' };
    this.pendingDelivery.delete(instruction.taskId);
    if (ok) {
      instruction.deliveredAt = Date.now();
      this.ledgerPush({
        kind: 'instruction:accepted',
        taskId: instruction.taskId,
        title: instruction.taskTitle,
        text: '',
      });
    } else {
      instruction.state = 'queued';
      instruction.failures = (instruction.failures ?? 0) + 1;
      instruction.note = oneLine(error, 200);
      if (instruction.failures >= 3) {
        instruction.state = 'escalated';
        this.addConfirm(instruction.taskId, {
          title: '指令没能下发',
          body: `「${instruction.taskTitle}」连续 ${instruction.failures} 次没能开始执行。${instruction.note}`,
          actions: [
            { id: 'rework', label: '再试一次', style: 'primary' },
            { id: 'abandon', label: '放弃', style: 'danger' },
          ],
          payload: { instructionId: instruction.id },
          urgent: true,
        });
      }
    }
    this.scheduleSave('instructions');
    this.drain();
    return { ok: true };
  }

  /* ------------------------------------------------------------------ */
  /* dispatch: split a job across employees                             */
  /* ------------------------------------------------------------------ */

  /**
   * 把一件事拆给若干员工。总监只写任务和验收标准；每个员工是不是用 Agent、
   * 能不能联网/查仓库/查知识库，也在这里定，界面按这些字段建任务。
   *
   * 建议级别先给用户确认；观察级别不允许派工；代跑直接派。
   */
  dispatch({
    workspaceId,
    title,
    employees = [],
    shared = '',
    contract = '',
    userText = '',
    approved = false,
    estimateMinutes = 0,
    verifyMinutes = 0,
    force = false,
  }) {
    const state = this.getState();
    if (!state.enabled) return { ok: false, error: '工作总监未启用' };
    if (state.mode === 'observe') {
      return { ok: false, error: '当前是观察级别：只能提醒，不能给员工派任务' };
    }
    const list = (Array.isArray(employees) ? employees : [])
      .map((item, index) => normalizeEmployee(item, index))
      .filter(Boolean);
    if (list.length === 0) return { ok: false, error: '没有可以派给员工的任务' };
    // 长篇流程会让员工把时间花在自证上：先让总监把指令压短再派。
    for (const employee of list) {
      if (employee.role === 'verify') continue;
      const task = String(employee.task ?? '');
      if (task.length > MAX_BUILD_TASK_CHARS) {
        return {
          ok: false,
          error: `「${employee.name}」的指令有 ${task.length} 字，太长了。请压到 600 字以内、最多 3 步（做什么 → 只改哪些文件 → 按真实入口自测一次）。基准测试、对弈 N 局、截图、CDP、回归套件都不要写进编制指令——这些不是开发，会让一个按钮的活跑半小时。`,
        };
      }
      const endless = task.match(OPEN_ENDED_TASK);
      if (endless) {
        return {
          ok: false,
          error: `「${employee.name}」的指令里有开放式循环（“${endless[0]}”），员工会一直跑到被叫停。请给一个明确的终点：改完就交。要调参，单独拆成一个有预算、有终点的项目，先问用户要不要做。`,
        };
      }
      // 验收点必须能执行：有启动命令、有能看到的输出，或者能对着契约核对。
      // “功能正常”这种标准，验收员给多少时间都验不出东西。这里不改退回：
      // 总监多半会原样再派一次；直接把“按真实入口跑一次”补在后面更有效。
      const criteria = String(employee.criteria ?? '').trim();
      if (criteria.length > 0 && criteria.length <= 8 && !OBSERVABLE_CRITERIA.test(criteria)) {
        employee.criteria = `${criteria}（按真实入口启动一次，命令和输出写进证据）`;
      }
    }
    if (list.length > director.MAX_EMPLOYEES_PER_DISPATCH) {
      return {
        ok: false,
        error: `一次最多派 ${director.MAX_EMPLOYEES_PER_DISPATCH} 个员工，请合并或分两批。`,
      };
    }

    const buildList = list.filter((employee) => employee.role !== 'verify');

    // 小活不派工：改文案、换图标这种活，派工要新建会话、重新摸代码、再走一轮
    // 验收，固定开销比活本身贵好几倍。工作空间里已经有现成任务时，直接对它下
    // 指令——它保留自己的上下文，比新员工摸一遍代码更快也更准。
    const smallWork =
      buildList.length === 1 &&
      (isSmallTask(buildList[0].task) || cleanupTargets(buildList[0].task).length > 0);
    if (!force && smallWork) {
      const space = String(workspaceId ?? '').trim();
      const idle = [...this.tasks.values()].find(
        (task) =>
          task.workspaceId === space &&
          !task.busy &&
          task.status === 'idle' &&
          !this.runs.has(task.id),
      );
      if (idle) {
        return {
          ok: false,
          error:
            `这是小活（${oneLine(buildList[0].task, 60)}），一般不用派工：新建会话、重新摸代码的固定开销比活本身还大。` +
            `直接用 director_instruct 对任务「${idle.title}」（taskId=${idle.id}）下指令，把领导的原话原样带上；它有自己的上下文，做完就交。` +
            '确实要另起任务，就带 force=true 再派一次。',
          smallTaskTaskId: idle.id,
        };
      }
    }

    // 多人并行必须先把接口定下来，否则每个人按自己的想象写边界，
    // 错配只能在验收时发现，代价是一整轮返工。
    if (buildList.length >= 2 && !String(contract ?? '').trim()) {
      return {
        ok: false,
        error:
          `这次要派 ${buildList.length} 个人并行，但没有接口契约。先在 contract 里写死边界：目录怎么分、函数/路由/字段叫什么、谁产出谁能读。` +
          '契约会原样发给每个人，并作为验收的第 1 个点；两个人各按各的想象写接口，返工一轮的代价比写契约大得多。',
      };
    }

    // 同一个文件不能有两个写手：写进同一份文件的两个员工会互相覆盖，
    // 而且谁也说不清最后是谁的版本。
    const declared = [];
    for (const employee of buildList) {
      for (const file of employee.files) {
        const path = file.replace(/^[.\\/]+/, '').replace(/\\/g, '/').toLowerCase();
        if (!path) continue;
        const other = declared.find(
          (entry) =>
            entry.path === path ||
            entry.path.startsWith(`${path}/`) ||
            path.startsWith(`${entry.path}/`),
        );
        if (other) {
          return {
            ok: false,
            error: `「${other.name}」和「${employee.name}」都要改 ${file}。同一个文件只能有一个写手；要并行就拆到不同文件/目录，或者让一个人接力。`,
          };
        }
        declared.push({ path, name: employee.name });
      }
    }

    // 同一条领导原话已经被现有任务接住（先 instruct 再 dispatch 是最常见的
    // 重复）：再开一份就是两个员工做同一件事，后一条还会顶掉前一条。入口
    // 这里直接退回，避免建了任务却没有指令、或者两个员工互相踩。
    //
    // 只看“直接下指令”接住的那条。已经派出去的另一批不算重复：一个大活
    // 超过 8 个人时要分几批，几批带的是同一句领导原话，那是计划的延续，
    // 不是重发；拦掉第二批等于把复杂任务砍成半截。
    const recent = this.recentSameUserText(userText);
    if (recent && !recent.fromDispatch) {
      return {
        ok: false,
        error:
          `这条要求刚才已经交给「${
            this.taskOf(recent.taskId)?.title || recent.taskTitle || '现有任务'
          }」了（${recent.id}），不要再派新员工；等它的结果。` +
          '同一条领导原话只走一条路：已经在任务里排队/执行，就不要再 dispatch。',
      };
    }

    const spaceId = String(workspaceId ?? '').trim();
    // 探测环境是异步的；员工指令要到下一个 tick 才下发，通常已经拿到了。
    if (spaceId) this.ensureEnvCard(spaceId);
    const draft = {
      workspaceId: spaceId,
      title: oneLine(title, 120) || '未命名分配',
      employees: list,
      shared: clip(shared, 1200),
      /** 所有人共同遵守的接口/边界；多人并行时必填。 */
      contract: clip(contract, 4000),
      /** 领导的原话，原样传给员工，减少转述失真。 */
      userText: clip(userText, 2000),
      /** 总监按 AI 编程速度估的分钟数；0 = 交给后台模型再估。 */
      estimateMinutes: Math.max(0, Math.min(24 * 60, Number(estimateMinutes) || 0)),
      /** 验收预计分钟数；0 = 按编制的 40% 粗估（最少 5 分钟）。 */
      verifyMinutes: Math.max(0, Math.min(24 * 60, Number(verifyMinutes) || 0)),
    };

    // 不知道放在哪个空间时，不猜也不在正文里让用户报 id：直接出一张
    // 工作空间选择卡，列出全部空间（含在线空间），选完自动派工。
    if (!spaceId || director.accessFor(state, spaceId) !== 'write') {
      this.addConfirm('', {
        title: '用哪个工作空间？',
        body: [
          `「${draft.title}」`,
          ...list.map(
            (employee) =>
              `- ${employee.name}：${oneLine(employee.task, 120)}${
                employee.agentId ? `（Agent：${employee.agentId}）` : ''
              }`,
          ),
          draft.shared ? `\n协作约定：${oneLine(draft.shared, 200)}` : '',
          spaceId ? '\n指定的工作空间没有交给我写入，请重新选一个。' : '\n选一个工作空间，我就按上面的分工派工。',
        ]
          .filter(Boolean)
          .join('\n'),
        actions: [{ id: 'dismiss', label: '先不派' }],
        payload: { kind: 'workspace', draft },
      });
      return {
        ok: true,
        pending: true,
        message: '已经请用户从工作空间列表里选一个；选好后会自动派工，不要重复提交。',
      };
    }

    if (state.mode === 'suggest' && !approved) {
      this.addConfirm('', {
        title: '我建议把这件拆给员工',
        body: [
          `「${draft.title}」`,
          ...list.map(
            (employee) =>
              `- ${employee.name}：${oneLine(employee.task, 120)}${
                employee.agentId ? `（Agent：${employee.agentId}）` : ''
              }`,
          ),
          draft.shared ? `\n协作约定：${oneLine(draft.shared, 200)}` : '',
        ]
          .filter(Boolean)
          .join('\n'),
        actions: [
          { id: 'approve', label: '同意派工', style: 'primary' },
          { id: 'dismiss', label: '不用' },
        ],
        payload: { kind: 'dispatch', draft },
      });
      return { ok: true, pending: true, message: '已提交给你确认，同意后才会建任务。' };
    }

    return this.executeDispatch(draft);
  }

  executeDispatch(draft) {
    const state = this.getState();
    const max = Math.max(1, Number(state.maxDispatch) || 4);
    const dispatchId = uid('dsp');
    const payload = {
      dispatchId,
      title: draft.title,
      workspaceId: draft.workspaceId,
      shared: draft.shared,
      contract: draft.contract || '',
      userText: draft.userText || '',
      // 估时跟着 spawn 回执走：spawnAck 要用它写项目计划，收口时才有得对账。
      estimateMinutes: draft.estimateMinutes,
      verifyMinutes: draft.verifyMinutes,
      employees: draft.employees.map((employee) => ({
        ...employee,
        // 超过并发上限的先排队，界面照样把任务建出来。
        concurrency: max,
      })),
      at: Date.now(),
    };
    this.spawns.set(dispatchId, { ...payload, announcedAt: Date.now() });
    const project = this.ensureProject({
      id: dispatchId,
      kind: 'dispatch',
      title: draft.title,
      goal: draft.userText || draft.shared || draft.title,
      workspaceId: draft.workspaceId,
      estimateMinutes: draft.estimateMinutes,
      verifyMinutes: draft.verifyMinutes,
    });
    if (project) project.contract = String(draft.contract || '');
    if (project && !project.estimateMs) {
      void this.estimateProject(dispatchId, {
        title: draft.title,
        employees: draft.employees,
        shared: draft.shared,
      }).catch(() => undefined);
    }
    this.broadcast('director:spawn', payload);
    this.ledgerPush({
      kind: 'dispatch:spawn',
      title: draft.title,
      text: draft.employees
        .map((employee) => `${employee.name}：${oneLine(employee.task, 100)}`)
        .join('；'),
    });
    return {
      ok: true,
      dispatchId,
      employees: payload.employees.map((employee) => employee.name),
      message: `已派出 ${payload.employees.length} 个员工，任务正在建立，空闲后自动开始。`,
    };
  }

  /**
   * 界面把员工任务建好后回执。每条回执都变成一条普通指令，后面的投递、
   * 验收、返工全部复用现成的队列，不需要另写一套。
   */
  spawnAck({ dispatchId, items = [] }) {
    const id = String(dispatchId ?? '');
    const spawn = this.spawns.get(id);
    if (!spawn) return { ok: false, error: '这次分配已经收尾或不存在' };
    // 验收员的一次性检查不是项目：不建档案、不参与项目对账和跨项目检查。
    // 以前给 dspv_ 建了项目，开工 0.6 秒就被脉搏收口，台账里多出一条
    // “计划 1 人 0 分钟 → 实际 1 人 1 分钟”的假记录。
    const verifyOnly = spawn.employees.every((employee) => employee.role === 'verify');
    const project = verifyOnly
      ? null
      : this.ensureProject({
          id,
          kind: 'dispatch',
          title: spawn.title,
          goal: spawn.userText || '',
          workspaceId: spawn.workspaceId,
          estimateMinutes: spawn.estimateMinutes,
          verifyMinutes: spawn.verifyMinutes,
        });
    if (project && !project.plan) {
      project.plan = {
        parallelism: Math.max(
          1,
          spawn.employees.filter((employee) => employee.role !== 'verify').length,
        ),
        estimateMinutes: Math.max(0, Number(spawn.estimateMinutes) || 0),
        verifyMinutes: Math.max(0, Number(spawn.verifyMinutes) || 0),
        contract: Boolean(spawn.contract),
        at: Date.now(),
      };
      this.scheduleSave('projects');
    }
    const byEmployee = new Map(spawn.employees.map((employee) => [employee.employeeId, employee]));
    let created = 0;
    for (const item of Array.isArray(items) ? items : []) {
      const employee = byEmployee.get(String(item?.employeeId ?? ''));
      if (!employee) continue;
      if (!item.ok) {
        this.addInbox({
          kind: 'alert',
          title: '员工任务没能建立',
          body: `「${spawn.title}」里的「${employee.name}」没有建成：${oneLine(item.error, 200) || '未知原因'}`,
          taskId: '',
          urgent: true,
        });
        continue;
      }
      const taskId = idOf(item.taskId);
      if (!taskId) continue;
      // 主进程的任务板由界面推送；新任务先按回执登记，验收时才有地方查。
      this.tasks.set(taskId, {
        id: taskId,
        title: oneLine(item.title, 120) || `${employee.name} · ${oneLine(employee.task, 40)}`,
        space: oneLine(item.space, 120),
        workspaceId: String(item.workspaceId ?? spawn.workspaceId),
        workspacePath: String(item.workspacePath ?? ''),
        busy: false,
        status: 'idle',
        askLevel: undefined,
        updatedAt: Date.now(),
        seenAt: Date.now(),
      });
      // 验收员不属于项目的工作量：不登记成项目任务，也不挂派工号，
      // 它只把结论交回给对应的那条编制指令。
      const isVerify = employee.role === 'verify';
      if (!isVerify) this.addProjectTask(id, taskId);
      // 编制也必须有时限：没有预算的单子会一直跑到员工自己停，实测出现过
      // 78 分钟、120 条命令的一轮。按项目估时给 1.5 倍，夹在 15–45 分钟。
      const project = this.projects.get(id);
      const estimateMinutes = project?.estimateMs
        ? Math.round(project.estimateMs / 60000)
        : 0;
      const budget = isVerify
        ? employee.budgetMinutes || VERIFY_BUDGET_MINUTES
        : employee.budgetMinutes || planBuildBudget(estimateMinutes);
      const result = this.enqueue({
        taskId,
        text: composeEmployeeText(
          { ...spawn, envCard: this.envCardText(spawn.workspaceId) },
          employee,
        ),
        intent: employee.task,
        criteria: employee.criteria,
        source: 'director',
        approved: true,
        budgetMinutes: budget,
        userText: spawn.userText || '',
        role: isVerify ? 'verify' : 'build',
        declaredFiles: isVerify ? [] : employee.files,
        parentInstructionId: isVerify ? employee.parentInstructionId : '',
        verifyPoints: isVerify ? employee.verifyPoints : [],
        dependsOn: isVerify ? [] : employee.dependsOn,
        dispatch: isVerify
          ? null
          : {
              dispatchId: id,
              dispatchTitle: spawn.title,
              employeeName: employee.name,
              dispatchSize: spawn.employees.length,
              agentId: employee.agentId,
            },
      });
      if (result.ok) {
        created += 1;
        // 契约和原话跟着指令走：返工、验收都要按同一个边界核对。
        if (result.instruction) {
          result.instruction.contract = spawn.contract || '';
          result.instruction.userText = spawn.userText || result.instruction.userText || '';
        }
      } else {
        this.addInbox({
          kind: 'alert',
          title: '员工任务没能开始',
          body: `「${spawn.title}」里的「${employee.name}」排队失败：${result.error}`,
          taskId,
          urgent: true,
        });
      }
    }
    this.spawns.delete(id);
    this.ledgerPush({
      kind: 'dispatch:ack',
      title: spawn.title,
      text: `已建立 ${created} 个员工任务`,
    });
    this.drain();
    return { ok: true, created };
  }

  /** 界面迟迟没有回执：别让整次分配悬着。 */
  expireSpawns() {
    const now = Date.now();
    for (const [id, spawn] of this.spawns) {
      if (now - spawn.announcedAt < DISPATCH_ACK_MS) continue;
      this.spawns.delete(id);
      this.addInbox({
        kind: 'alert',
        title: '分配没有建立起来',
        body: `「${spawn.title}」的员工任务等了 ${Math.round(
          DISPATCH_ACK_MS / 1000,
        )} 秒还没建出来。可能是界面刚重载，或工作空间已经被删除。`,
        urgent: true,
      });
    }
  }

  /** 一次分配里所有员工都结束了吗？结束就只发一条汇总，文件一起交付。 */
  maybeFinishDispatch(dispatchId) {
    const group = this.dispatchGroup(dispatchId);
    if (group.length === 0) return;
    // 还有员工在跑：这条分配不能收口。指令被替换/叫停时状态会先变成
    // discarded，但 worker 可能下一秒又起来；这时收口会把正在跑的那一轮
    // 记成“已放弃”，后面的真实结果挂在一个已经 done 的项目上。
    if (group.some((item) => this.runs.has(item.taskId))) return;
    // 有人收口了，先把一直在等前置的验收员放出去；它们不算这次分配的工作量。
    this.maybeStartWaitingVerifications(dispatchId);
    // 同一个员工可能被补过指令（改了口径、返工），只认最新那一轮：
    // 前几轮的 'rework' 是历史记录，不能再拿来卡住整次分配的收口。
    const latest = new Map();
    for (const item of group) {
      const key = item.employeeName || item.taskId;
      const previous = latest.get(key);
      if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
    }
    const final = [...latest.values()];
    // held 也算“跑完了”：删除类任务要等领导点头，但不能因此把整次分配的
    // 汇总一直压着。汇总里如实写“等你确认”，领导后来点头只更新这一条。
    if (
      final.some(
        (item) =>
          !['accepted', 'escalated', 'discarded', 'held'].includes(item.state) ||
          item.verificationPending,
      )
    ) {
      return;
    }

    const title = group[0].dispatchTitle || '分配的任务';
    const failed = final.filter((item) => item.state === 'escalated' && !item.unverified);
    // 自动按现状收尾的也算“未验证”：标题要如实标出来，别让领导以为全都验过了。
    const unverified = final.filter((item) => item.unverified);
    const held = final.filter((item) => item.state === 'held');
    const lines = final.map((item) => {
      const name = item.employeeName || '员工';
      return `- ${name}：${this.dispatchStatusLabel(item)}${
        item.resultNote ? ` · ${oneLine(item.resultNote, 200)}` : ''
      }`;
    });
    const files = mergeDeliveredFiles(...group.map((item) => item.files));
    const needsAttention = failed.length > 0 || unverified.length > 0 || held.length > 0;
    const reportTitle =
      failed.length > 0
        ? '分配结束，有员工没通过验收'
        : held.length > 0
          ? '分配结束，有员工等你确认'
          : unverified.length > 0
            ? '分配结束，有员工未验证'
            : '分配的任务全部完成';
    const payload = {
      // 派工已经收口：哪怕有员工没验证或等你确认，这一轮也不再占着界面上的
      // 待办；有问题的员工单独写在汇总里。只有“没通过”才留着计划让人看。
      kind: failed.length > 0 ? 'dispatch-summary' : 'plan-done',
      dispatchId: group[0].dispatchId,
      summary: true,
    };
    // 已经发过就原地更新，不再发第二条：领导后来点了确认，改的是同一条汇总。
    const existing = this.inbox.find(
      (item) => item.payload?.summary === true && item.payload?.dispatchId === group[0].dispatchId,
    );
    const leftover = leftoverArtifacts(this.workspaceRootOf(this.taskOf(group[0].taskId)));
    const body = `「${title}」\n${lines.join('\n')}${
      leftover.length ? `\n（测试残留：${leftover.join('、')}，要清理的话说一声）` : ''
    }`;
    if (existing) {
      existing.title = reportTitle;
      existing.body = body;
      existing.kind = needsAttention ? 'alert' : 'report';
      existing.urgent = needsAttention;
      existing.files = files;
      existing.needsRead = files.length > 0;
      existing.payload = payload;
      this.scheduleSave('inbox');
      this.broadcastSummary();
    } else {
      this.addInbox({
        kind: needsAttention ? 'alert' : 'report',
        title: reportTitle,
        body,
        taskId: group[0].taskId,
        taskTitle: title,
        urgent: needsAttention,
        files,
        // 总监分配的任务：文件等用户读过才算交付完成。
        needsRead: files.length > 0,
        // 没有员工没通过 → 这次分配收口了，界面可以把总监的旧计划收掉。
        payload,
      });
    }
    for (const item of group) item.dispatchReported = true;
    this.ledgerPush({
      kind: 'dispatch:done',
      title,
      text: lines.join('；'),
    });
    // 项目档案收口：这次分配的总时长、未验证/等你确认的数量都留在档里。
    const project = this.projects.get(idOf(group[0].dispatchId));
    if (project) {
      // 收口前先判断是不是“开发完成、准备调试”；这一步会异步生成调试清单，
      // 项目状态在这里同步收口，不影响它把消息发完。
      void this.announceDebugReady(project.id).catch(() => undefined);
      // 计划/实际必须在这里对账：大多数派工是从这条路收口的，不走 finishProject。
      this.reconcileProject(project);
      project.status = 'done';
      project.finishedAt = Date.now();
      project.updatedAt = Date.now();
      this.addProjectDecision(
        project.id,
        `收口：${final.length} 个员工，${unverified.length} 个未验证，${held.length} 个等你确认`,
      );
      this.scheduleSave('projects');
    }
    this.scheduleSave('instructions');
    // 整次分配收口 = 一个工位空出来了：看看别的项目要不要补位。
    this.noteSlotFreed(group[0].dispatchId);
  }

  /**
   * 一张“我验不了”的卡放太久没人点，而任务早就不在等它了：总监不能一直
   * 举着这张卡。按现状收尾（如实记未验证），整次分配结束时再一起报。
   * 删除类（accept-hold）不走这条：那种必须领导点头。
   */
  settleStaleHolds(now = Date.now()) {
    let changed = false;
    for (const item of this.inbox) {
      if (item.status !== 'open') continue;
      if (item.payload?.kind !== 'accept-unverified') continue;
      if (item.payload?.autoSettle === false) continue;
      if (now - (item.at || 0) < HOLD_SETTLE_MS) continue;
      const instruction = this.instructions.find(
        (entry) => entry.id === String(item.payload?.instructionId ?? ''),
      );
      if (!instruction || instruction.state !== 'escalated') {
        item.status = 'resolved';
        item.resolution = 'accept';
        item.read = true;
        changed = true;
        continue;
      }
      if (this.runs.has(instruction.taskId) || this.tasks.get(instruction.taskId)?.busy) continue;
      instruction.state = 'accepted';
      instruction.finishedAt = now;
      instruction.unverified = true;
      instruction.resultNote = '等不到人：按现状收尾（未验证）';
      item.status = 'resolved';
      item.resolution = 'accept';
      item.read = true;
      this.ledgerPush({
        kind: 'accept:auto',
        taskId: instruction.taskId,
        title: item.taskTitle,
        text: instruction.resultNote,
      });
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      changed = true;
    }
    if (changed) {
      this.scheduleSave('inbox');
      this.scheduleSave('instructions');
      this.broadcastSummary();
    }
  }

  /**
   * 有人先完成、有人明显慢：让模型判断剩下的活能不能再拆给新员工。
   * 代跑级别直接派；建议级别先问用户；观察级别只提醒。
   */
  async maybeSplitSlowDispatch() {
    const state = this.getState();
    if (!state.enabled || state.mode === 'observe') return;
    const groups = new Map();
    for (const instruction of this.instructions) {
      if (!instruction.dispatchId) continue;
      if (!['queued', 'delivered', 'rework', 'accepted', 'escalated'].includes(instruction.state)) {
        continue;
      }
      const group = groups.get(instruction.dispatchId) ?? [];
      group.push(instruction);
      groups.set(instruction.dispatchId, group);
    }
    const now = Date.now();
    for (const [dispatchId, group] of groups) {
      if (group.every((item) => item.splitAt > 0)) continue;
      const active = group.filter((item) =>
        ['queued', 'delivered', 'rework'].includes(item.state),
      );
      // 还在验收的不算“完成”：先验完再说要不要把剩下的活拆出去。
      const finished = group.filter(
        (item) =>
          ['accepted', 'escalated'].includes(item.state) && !item.verificationPending,
      );
      if (active.length === 0 || finished.length === 0) continue;
      const since = Math.min(...group.map((item) => item.createdAt || now));
      if (now - since < SLOW_DISPATCH_MS) continue;
      const running = this.runningDispatchTaskIds().size;
      const room = Math.max(0, Math.max(1, Number(state.maxDispatch) || 4) - running);
      const roomTotal = Math.max(0, 8 - group.length);
      const slots = Math.min(room, roomTotal, 3);
      if (slots <= 0) continue;

      const plan = await this.planSplit(group, slots).catch(() => null);
      if (!plan || plan.employees.length === 0) continue;
      const draft = {
        dispatchId,
        title: group[0].dispatchTitle || '分配的任务',
        workspaceId: this.taskOf(group[0].taskId)?.workspaceId ?? '',
        shared: plan.shared,
        employees: plan.employees,
      };
      for (const item of group) item.splitAt = now;
      this.scheduleSave('instructions');

      if (state.mode === 'suggest') {
        this.addConfirm('', {
          title: '有员工偏慢，我建议再拆一步',
          body: [
            `「${draft.title}」还有 ${active.length} 个员工在跑，别的已经完成。`,
            ...draft.employees.map(
              (employee) => `- 新增 ${employee.name}：${oneLine(employee.task, 120)}`,
            ),
          ].join('\n'),
          actions: [
            { id: 'approve', label: '同意再派人', style: 'primary' },
            { id: 'dismiss', label: '不用' },
          ],
          payload: { kind: 'split', draft },
        });
        continue;
      }

      this.spawnEmployees(draft);
    }
  }

  /** 让模型把剩余工作拆成几个可并行的员工任务；只返回 JSON。 */
  async planSplit(group, slots) {
    const reply = await this.ask({
      system:
        '你是工作总监。一次分配里有的员工已经完成，有的还在跑且偏慢。' +
        '判断剩下的活能不能再拆给新员工并行做，能拆就拆。' +
        '不要派新员工去改正在被别的员工改的同一批文件；要帮就做不重叠的部分，或者只做验收/取证。' +
        '只回答一行 JSON：{"split": true, "shared": "协作约定，可空", "employees": [{"name":"员工X","task":"具体做什么","criteria":"验收标准"}]}。' +
        `最多 ${slots} 个新员工。不能拆、或者拆了会互相踩，就回答 {"split": false}。不要写别的。`,
      user: [
        `分配：${group[0].dispatchTitle || '未命名'}`,
        '已经完成的：',
        ...group
          .filter((item) => item.state === 'accepted')
          .map((item) => `- ${item.employeeName}：${item.resultNote || '已完成'}`),
        '还在跑的：',
        ...group
          .filter((item) => ['queued', 'delivered', 'rework'].includes(item.state))
          .map((item) => `- ${item.employeeName}：${oneLine(item.text, 220)}`),
      ].join('\n'),
      maxTokens: 600,
    });
    const parsed = reply ? this.parseJson(reply) : null;
    if (!parsed || parsed.split !== true || !Array.isArray(parsed.employees)) return null;
    const employees = parsed.employees
      .map((item, index) => normalizeEmployee(item, group.length + index))
      .filter(Boolean)
      .slice(0, slots);
    return { employees, shared: clip(parsed.shared ?? '', 1000) };
  }

  /** 慢任务拆分 / 续派：和第一次派工走同一条广播和回执。 */
  spawnEmployees({ dispatchId, title, workspaceId, shared, employees }) {
    const state = this.getState();
    if (!state.enabled) return { ok: false, error: '工作总监未启用' };
    if (!workspaceId) return { ok: false, error: '找不到这次分配的工作空间' };
    if (director.accessFor(state, workspaceId) !== 'write') {
      return { ok: false, error: '这个工作空间不在总监的分管范围内（需要写权限）' };
    }
    const list = (Array.isArray(employees) ? employees : [])
      .map((item, index) => normalizeEmployee(item, index))
      .filter(Boolean);
    if (list.length === 0) return { ok: false, error: '没有可以派出的新员工' };
    const payload = {
      dispatchId,
      title,
      workspaceId,
      shared,
      employees: list,
      at: Date.now(),
    };
    this.spawns.set(dispatchId, { ...payload, announcedAt: Date.now() });
    this.broadcast('director:spawn', payload);
    const group = this.dispatchGroup(dispatchId);
    // 新员工也属于同一次分配，汇总时一起算。
    for (const item of group) {
      item.dispatchSize = Math.max(item.dispatchSize, group.length + list.length);
      item.splitAt = Date.now();
    }
    this.scheduleSave('instructions');
    this.ledgerPush({
      kind: 'dispatch:split',
      title,
      text: list.map((employee) => `${employee.name}：${oneLine(employee.task, 100)}`).join('；'),
    });
    return { ok: true, dispatchId };
  }

  /**
   * 任务这一轮没跑起来（模型/供应商出错、超时、欠费、没配模型）：把原因和
   * 选择权一起交给用户，换完模型再按原来的要求重试。只报"失败了"是不行的。
   */
  offerModelChoice({ taskId, reason = '', instructionId = '' }) {
    const state = this.getState();
    if (!state.enabled) return { ok: false, error: '工作总监未启用' };
    const id = idOf(taskId);
    const task = this.taskOf(id);
    if (!task) return { ok: false, error: '找不到这个任务' };
    if (!this.monitored(id)) return { ok: false, error: '这个工作空间没有对总监开放' };
    // 总监主动调用时不知道是哪条指令：找这个任务里最近一条还没收尾的。
    let retryId = String(instructionId ?? '');
    if (!retryId) {
      const latest = [...this.instructions]
        .reverse()
        .find(
          (entry) =>
            entry.taskId === id &&
            entry.source !== 'user' &&
            (['delivered', 'rework', 'escalated'].includes(entry.state) ||
              (entry.state === 'discarded' && /模型/.test(entry.note ?? ''))),
        );
      retryId = latest?.id ?? '';
    }
    // 同一个任务只留一张，别让连续失败刷屏。
    const open = this.inbox.find(
      (item) =>
        item.status === 'open' &&
        item.payload?.kind === 'model' &&
        item.payload?.taskId === id,
    );
    if (open) {
      if (retryId) open.payload.instructionId = retryId;
      return { ok: true, pending: true, message: '已经在等用户选模型了，不要重复弹。' };
    }
    const detail = oneLine(reason, 300);
    const item = this.addConfirm(id, {
      title: '任务没跑起来：换一个模型？',
      body: [
        `「${task.title}」这一轮没有跑起来。`,
        detail ? `原因：${detail}` : '没有留下具体原因。',
        '选一个模型，我就按原来的要求让它重试；也可以先不管。',
      ].join('\n'),
      actions: [{ id: 'dismiss', label: '先不管' }],
      payload: {
        kind: 'model',
        taskId: id,
        instructionId: retryId,
        reason: detail,
      },
    });
    this.ledgerPush({
      kind: 'model:offer',
      taskId: id,
      title: task.title,
      text: detail || '模型没有跑起来',
    });
    return {
      ok: true,
      pending: true,
      itemId: item?.id,
      message: '已经让用户选模型了；选好后我会按原来的要求重试，不要重复提交。',
    };
  }

  /**
   * 删除类任务：不看模型脸色，也不替用户拍板。把文件、原因和三个选择一并
   * 交给他，等他自己确认。
   */
  holdAcceptance(instruction, { files = [], tail = '', reason = '', check = '' } = {}) {
    const task = this.taskOf(instruction.taskId);
    instruction.state = 'held';
    instruction.finishedAt = Date.now();
    instruction.files = files;
    instruction.unverified = true;
    instruction.resultNote = '删除类任务：等用户确认';
    this.ledgerPush({
      kind: 'accept:hold',
      taskId: instruction.taskId,
      title: task?.title ?? instruction.taskTitle,
      text: reason || '删除类任务不做自动验收',
    });
    const evidence = clip(String(tail ?? '').trim(), 800);
    this.addConfirm(instruction.taskId, {
      title: '删除类任务：结果在这，等你点头',
      body: [
        `「${task?.title ?? instruction.taskTitle}」跑完了${reason ? `（${reason}）` : ''}。`,
        check ? `\n可核对的事实：\n${check}\n` : '',
        evidence ? `\n工人的回复：\n${markdownTail(evidence)}\n` : '',
        '删除不可逆，我这边没拿到判断，不能替你判“通过”。',
        '清点一下：该删的删了没有、不该删的还在不在。没问题就点「确认通过」，要补就点「再跑一次」。',
      ].join('\n'),
      actions: [
        { id: 'accept', label: '确认通过', style: 'primary' },
        { id: 'rework', label: '再跑一次' },
        { id: 'abandon', label: '放弃', style: 'danger' },
      ],
      payload: { kind: 'accept-hold', instructionId: instruction.id },
      urgent: true,
      files,
    });
    // 整个分配不因为一个删除类任务在等确认就压着不汇总：汇总里写清楚
    // “等你确认”，领导后来点头只更新那一条。
    if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
    this.scheduleSave('instructions');
  }

  /**
   * 模型不可用、或者这一轮有硬伤（没正常结束、交付文件找不到），读不出结论：
   * 不自动通过，也不把“算不算完成”甩给用户——验收是总监的活。
   * 如实记“未验证”，把可核对的事实报出来；要补验是总监再派一轮，不是领导动手。
   * （删除类任务仍走 holdAcceptance：那是不可逆操作的安全确认，不是验收。）
   */
  reportUnverified(instruction, { files = [], tail = '', check = '', reason = '', ok = true } = {}) {
    const task = this.taskOf(instruction.taskId);
    const title = task?.title ?? instruction.taskTitle ?? '任务';
    instruction.state = 'escalated';
    instruction.finishedAt = Date.now();
    instruction.files = files;
    instruction.unverified = true;
    instruction.verdict = 'unverified';
    instruction.resultNote = oneLine(
      reason ? `未验证：${reason}` : '未验证（我没拿到结论）',
      200,
    );
    this.ledgerPush({
      kind: 'accept:unverified',
      taskId: instruction.taskId,
      title,
      text: reason || '我没拿到验收判断',
    });
    const evidence = clip(String(tail ?? '').trim(), 700);
    this.updateDeliveryMessage(instruction, {
      title: `「${title}」没验成，记作未验证`,
      note: [
        `这一轮${ok ? '正常结束了' : '没有正常结束'}，但我没拿到明确结论${
          reason ? `（${reason}）` : ''
        }。`,
        '我没有把它算成通过，也不会让你替我验。',
        check ? `\n可核对的事实：\n${check}` : '',
        evidence ? `\n工人的回复：\n${markdownTail(evidence)}` : '',
      ]
        .filter(Boolean)
        .join('\n'),
      urgent: false,
      status: 'unverified',
    });
    if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
    this.scheduleSave('instructions');
  }

  /**
   * 不依赖模型的确定性核对：交付文件在磁盘上到底有没有、是不是空文件。
   * 模型不可用时这是给用户的可查事实；模型可用时也一起喂给它，别让它只凭
   * 工人的自述下结论。
   * 返回 { text, total, found, unknown }：unknown=路径不可核对（远程空间）。
   */
  async checkDeliveredFiles(instruction, files) {
    const task = this.taskOf(instruction.taskId);
    const root = this.workspaceRootOf(task);
    if (!root) {
      return {
        text: files.length
          ? `这一轮记录了 ${files.length} 个交付文件，但任务没有本地路径（可能是远程空间），无法核对磁盘。`
          : '这一轮没有记录到交付文件。',
        total: files.length,
        found: 0,
        unknown: files.length > 0,
      };
    }
    const base = path.resolve(root);
    const lines = [];
    let found = 0;
    let empty = 0;
    for (const file of files.slice(0, 12)) {
      const rel = String(file?.path ?? '').trim();
      if (!rel) continue;
      let present = false;
      let size = 0;
      try {
        const target = path.resolve(base, rel);
        if (target === base || target.startsWith(base + path.sep)) {
          const info = await fs.stat(target);
          present = true;
          size = info.isDirectory() ? 0 : info.size;
        }
      } catch {
        present = false;
      }
      if (present) found += 1;
      if (present && size === 0 && String(file?.kind ?? '') !== 'directory') empty += 1;
      lines.push(
        present
          ? `✅ ${rel}${size > 0 ? `（${formatSize(size)}）` : '（目录）'}`
          : `❌ ${rel}：磁盘上找不到`,
      );
    }
    if (lines.length === 0) {
      return { text: '这一轮没有记录到交付文件。', total: 0, found: 0, unknown: false };
    }
    const notes = [
      `交付文件：磁盘上找到 ${found}/${lines.length} 个${
        empty > 0 ? `，其中 ${empty} 个是空文件` : ''
      }。`,
    ];
    if (found < lines.length) notes.push('缺少的文件可能被工人写在别处，或者根本没写出来。');
    return {
      text: `${notes.join('')}\n${lines.join('\n')}`,
      total: lines.length,
      found,
      unknown: false,
    };
  }

  /**
   * 交付预检：在叫验收员之前，先用确定性规则看一眼“这到底是不是能跑的程序”。
   *
   * 这不是替代验收，而是把最伤人的两种假交付提前拦下来：
   *   1. 用桩/mock/模拟服务器顶替真实实现（五子棋那次服务就是用 PYTHONPATH
   *      注入的桩包在跑，页面上却显示“学了 7 局”）；
   *   2. 只有文件、没有入口，或者工人自己都没跑过。
   *
   * 只有“桩/注入/缺入口”算 bad，会挡住“通过”；“没看到运行证据”只是 warn，
   * 交给验收员补跑，不直接判死。
   */
  async auditDeliverable(instruction, { files = [], tail = '' } = {}) {
    const task = this.taskOf(instruction.taskId);
    const root = this.workspaceRootOf(task);
    // 这里不能走 normalizeFiles：它要求每条文件都带 workspaceId，而预检
    // 只需要相对路径。带 workspaceId 的文件也能照常处理。
    const list = (Array.isArray(files) ? files : [])
      .map((file) => ({
        path: String(file?.path ?? '').trim(),
        kind: file?.kind === 'directory' ? 'directory' : 'file',
      }))
      .filter((file) => file.path && file.kind !== 'directory');
    const rels = list.map((file) => file.path);
    const problems = [];
    const warnings = [];
    const codeFiles = rels.filter((rel) =>
      /\.(py|js|mjs|cjs|ts|tsx|jsx|html|vue|svelte|go|rs|java|cs)$/i.test(rel),
    );
    const entryPattern =
      /(^|[\\/])(app|main|server|index|run|start|cli)\.(py|js|mjs|cjs|ts|tsx|jsx|html|vue|svelte|go|rs|java|cs)$|(^|[\\/])package\.json$/i;
    const deliveredEntries = rels.filter((rel) => entryPattern.test(rel));
    const isTestPath = (rel) =>
      /(^|[\\/])(tests?|spec|specs|__tests__|__mocks__|\.ezness)([\\/]|$)/i.test(rel);
    const hardMarkers = /验证用临时桩|stubdata|\.ezness[\\/]stub|mock[_ -]?server|PYTHONPATH\s*[:=]/i;
    // 只认真正的大写标记（TODO/FIXME）和中文占位词。这里不能用大小写不敏感：
    // 一个待办应用里到处是 todoList、new-todo、todo.done，不区分大小写会把
    // 正常实现判成“还有 TODO 占位”。也不认裸的 placeholder——HTML 的
    // placeholder 属性和 input.placeholder 都是正常代码。
    const softMarkers = /\b(?:TODO|FIXME|XXX)\b|NotImplemented|占位实现|先这样/;
    const textTail = String(tail ?? '');

    // 1) 工人自己承认用了桩/环境注入：这条最硬，直接 bad。
    //    但“无桩、无 mock、无改 PYTHONPATH”这种反向声明不是使用证据——先把
    //    被否定的说法剔掉再判断，否则会把合规交付误判成测试产物。
    const negated = /(?:无|没有?|未|不|非|not|no|never)[^。；，,;\n]{0,8}(?:PYTHONPATH|桩包?|桩数据|stubs?|mocks?|模拟服务器?)/gi;
    const positiveTail = textTail.replace(negated, ' ');
    if (/PYTHONPATH/i.test(positiveTail) && /stub|桩|mock|模拟/i.test(positiveTail)) {
      problems.push('工人的答复里写了用 PYTHONPATH/桩包启动，交付的不是真实实现');
    }
    if (/stubdata|验证用临时桩/i.test(positiveTail)) {
      problems.push('工人的答复里提到临时桩数据，交付的不是真实实现');
    }

    // 2) 读交付的源码，查桩标记和占位实现。测试目录里的 mock 是正常的，跳过。
    if (root) {
      const base = path.resolve(root);
      for (const rel of rels.slice(0, 12)) {
        if (isTestPath(rel)) continue;
        const target = path.resolve(base, rel);
        if (target !== base && !target.startsWith(base + path.sep)) continue;
        let info;
        try {
          info = await fs.stat(target);
        } catch {
          continue;
        }
        if (!info.isFile() || info.size > 512 * 1024) continue;
        let content = '';
        try {
          content = await fs.readFile(target, 'utf8');
        } catch {
          continue;
        }
        if (hardMarkers.test(content)) {
          problems.push(`${rel} 里有桩/模拟服务/环境注入的标记`);
        } else if (softMarkers.test(content) && /\.(py|js|ts|tsx|jsx)$/i.test(rel)) {
          warnings.push(`${rel} 里还有 TODO/占位实现`);
        }
      }
    }

    // 3) 入口：交付里有代码，却找不到任何可启动的入口，且项目根目录也没有。
    let diskEntry = '';
    if (root) {
      const base = path.resolve(root);
      for (const rel of [
        'package.json',
        'app.py',
        'main.py',
        'server.js',
        'server.ts',
        'index.html',
        'index.js',
        'index.ts',
        'src/index.js',
        'src/index.ts',
        'src/main.js',
        'src/main.ts',
        'src/main.tsx',
        'src/App.tsx',
      ]) {
        try {
          const info = await fs.stat(path.join(base, rel));
          if (info.isFile()) {
            diskEntry = rel;
            break;
          }
        } catch {
          // 继续找下一个
        }
      }
    }
    const entry = deliveredEntries[0] || diskEntry;
    if (codeFiles.length > 0 && !entry) {
      problems.push('交付里有代码，但找不到可启动的入口（app.py / main.py / package.json scripts / index.html）');
    }

    // 4) 运行证据：只写“做完了/文件已创建”不够。
    const runProof =
      /(npm run|npm start|python\s+\S+\.py|python3\s+\S+\.py|flask run|uvicorn|node\s+\S+\.js|curl\s|HTTP\/1\.[01]|localhost:\d+|127\.0\.0\.1:\d+|端口\s*\d+|退出码\s*[:=]?\s*0|exit code\s*[:=]?\s*0|pytest|测试通过|启动成功|浏览器打开|截图)/i.test(
        textTail,
      );
    if (codeFiles.length > 0 && !runProof) {
      warnings.push('工人的答复里没有实际运行入口的证据（启动命令 + 输出）');
    }

    return {
      level: problems.length > 0 ? 'bad' : warnings.length > 0 ? 'warn' : 'ok',
      problems: [...new Set(problems)].slice(0, 6),
      warnings: [...new Set(warnings)].slice(0, 6),
      entry,
      runProof,
      checkedAt: Date.now(),
    };
  }

  /** Acceptance is evidence-based; one rework, then the user decides. */
  /* ------------------------------------------------------------------ */
  /* 编制交付 → 派验收员 → 验收结论 → 返工（派工任务专用）               */
  /* ------------------------------------------------------------------ */

  /** 返工轮数上限：总监设置里可改，默认 2 轮。 */
  reworkLimit() {
    const value = Number(this.getState().reworkRounds);
    return Number.isFinite(value) ? Math.max(0, Math.min(5, Math.round(value))) : 2;
  }

  /** 验收员要盯的关键点：优先用总监/标准里写明的，否则给几个通用的。 */
  verifyPointsFor(instruction) {
    const contractPoint = instruction.contract
      ? '实现符合接口契约：路由/函数/字段名和契约一致，没有擅自改动边界'
      : '';
    if (Array.isArray(instruction.verifyPoints) && instruction.verifyPoints.length > 0) {
      return [contractPoint, ...instruction.verifyPoints].filter(Boolean).slice(0, 3);
    }
    // 删除/清理类指令只核目标状态；不要拿“真实实现/跑一遍入口”去验一条 dir，
    // 那会把验收员引到和本次改动无关的整站回归上。
    if (cleanupTargets(instruction.text).length > 0) {
      const targets = cleanupTargets(instruction.text);
      return [
        `目标已删除/清理：${targets.join('、')} 在工作空间里不再存在`,
        '工作空间里没有因为这次删除而少掉别的东西',
      ].slice(0, 2);
    }
    // 验收点必须能执行：有启动命令、有能看到的输出、或者能对着契约核对。
    // “功能正常”这种点，给多少时间都验不出东西。
    const points = String(instruction.criteria || '')
      .split(/[；;\n]/)
      .map((point) => oneLine(point, 160))
      .filter(Boolean)
      .filter((point) => !/^(能跑|可用|正常|完成|实现|没问题|功能正常|代码写完)$/.test(point.trim()))
      .slice(0, 2);
    // 五子棋那次的教训：文件都在、界面也能开，但服务是用 PYTHONPATH 注入的
    // 桩包在跑。只看“文件存在”会把测试产物当成交付，必须单独列一条。
    const defaults = [
      '交付的是真实实现：不是桩、模拟服务器或测试脚本顶替',
      '按说明启动真实入口并实际跑过一次，不是只看文件存在',
      '原要求里的核心功能实际可用（能跑就跑一遍冒烟）',
    ];
    // 验收点越少越容易收口。契约优先，再放原要求里的点（最多 2 个），最后补通用点。
    return [...new Set([contractPoint, ...points.slice(0, 2), ...defaults].filter(Boolean))].slice(0, 3);
  }

  /** 验收员的任务正文：只验不改、限时、结构化结论。 */
  composeVerifierText(instruction, { files = [], tail = '', points = [], previousFindings = '' } = {}) {
    const title = instruction.taskTitle || this.taskOf(instruction.taskId)?.title || '任务';
    // 验收员要知道“这次改了什么”，否则只能按整站回归去猜，既慢又抓不住重点。
    const changedLine = files.length
      ? `本次改动：${files
          .slice(0, 10)
          .map((file) =>
            file.kind === 'directory'
              ? `${file.path === '.' ? file.name : file.path}（整个目录）`
              : file.path,
          )
          .join('、')}`
      : '';
    const fileLines = files
      .slice(0, 10)
      .map(
        (file) =>
          `- ${file.name}：${file.path}${file.kind === 'directory' ? '（目录）' : ''}${
            file.hash ? ` @${file.hash}` : ''
          }`,
      )
      .join('\n');
    const audit = instruction.deliveryAudit;
    const auditLines = audit
      ? [
          `交付预检：${audit.level === 'bad' ? '发现问题' : audit.level === 'warn' ? '有疑点' : '通过'}`,
          ...audit.problems.map((item) => `- 问题：${item}`),
          ...audit.warnings.map((item) => `- 疑点：${item}`),
        ]
      : [];
    return [
      `验收：${title}`,
      '',
      '你是验收员。只验收，不修改任何文件，不开始编制，不修复问题。',
      `原要求：${clip(instruction.userText || instruction.intent || instruction.text, 2000)}`,
      instruction.criteria ? `验收标准：${clip(instruction.criteria, 1200)}` : '',
      instruction.contract
        ? `接口契约（实现必须符合；被擅自改掉就是不合格）：\n${clip(instruction.contract, 4000)}`
        : '',
      instruction.verifyGaps?.length
        ? `上一轮没过的点：${instruction.verifyGaps.join('；')}`
        : '',
      changedLine,
      '',
      '只验下面这些关键点（最多 3 个），不做与本次改动无关的全量回归：',
      ...points.map((point, index) => `${index + 1}. ${point}`),
      '',
      auditLines.length ? auditLines.join('\n') : '',
      '',
      tail ? `工人的自述/证据：\n${clipTail(tail, 1600)}` : '',
      previousFindings
        ? `上一轮验收员已经查到、但没来得及写结论的发现（逐条核对是否成立，不要重新做全量检查）：\n${clip(previousFindings, 1600)}`
        : '',
      fileLines ? `交付文件：\n${fileLines}` : '',
      this.envCardText(instruction.workspaceId) || '',
      '工作区里可以读文件、跑程序、看界面；不要改源码，不要新建交付文件。',
      '要写临时脚本或存结果，放到系统临时目录（%TEMP%），用完删掉；不要往项目目录里写任何文件，也不要留下 .ezness 之类的痕迹。',
      '不要用 PowerShell here-string、内联长脚本或临时浏览器驱动；能用一条普通命令核对的（dir/type/grep），不要搭一套环境。',
      '',
      '先读这次改动的文件和它的调用点，只验受影响的路径；不要重跑项目里和这次改动无关的历史功能。',
      '项目里已经有测试或启动入口的（package.json 的 test 脚本、tests/、README 里的启动命令），先用它；没有再自己搭一条最小冒烟。',
      '要起服务验接口时用 smoke_check：把创建、冲突、参数校验、清理写成 steps（expect_status / expect_contains / expect_json），需要验证落盘就加 restart + after_restart；一次调用就能拿到 PASS/FAIL 证据。不要再写 verify*.js、backtest.js 这类临时脚本。',
      '停自己起的服务只停它的 PID（taskkill /PID <pid> /T /F），或交给 smoke_check 自动清理；禁止 taskkill /F /IM node.exe、Stop-Process -Name node 这类按进程名杀全机的命令——Ezness 自己就运行在 node 上，会一起被杀掉。',
      '改动碰到启动、路由、公共库、数据模型这类被多处使用的东西时，必须跑一次项目基线（真实启动 + 主入口/主接口），不能只验改的那一个点。',
      '先看工人的证据。证据里已经有启动命令和实际输出，就照它核对，不要从装环境、跑基准、对弈或全量回归重新开始——' +
        '那些不是验收，只会把时间耗光。只有证据缺失或明显对不上时，才自己跑一条命令补证。',
      '必须实际启动真实入口跑一次（或核对工人给出的启动命令和输出），把命令和看到的输出写进证据；只看文件存在不算通过。',
      '端口被占、又确认不了是本项目刚交付的实例时，记“未验证”，不要换一个端口另起一个来充当证据。',
      '如果程序必须靠桩、mock、模拟服务器或 PYTHONPATH 注入才能跑，判不通过：这是测试产物，不是交付。',
      `禁止重跑基准套件、新旧对弈、N 局比赛、截图巡检或完整回归。目标 3–5 分钟收口，最多 ${planVerifyBudget(instruction)} 分钟。`,
      '',
      '第一行必须先写结论，原样写下面这行（不要加 #、加粗符号或 ✅/❌），再写证据：',
      '结论：通过 / 不通过 / 未验证',
      '结论后面只能跟「通过」「不通过」「未验证」三个词之一；不要写「可用」「无问题」「没问题」——系统只认这三个词。最后一行再原样重复一遍结论。',
      '系统只读你回复正文里写的内容，不读思考过程。每轮回复都先把当前结论写进正文第一行；只写在思考里等于没写。到预算点时正文还没有结论，这一轮就作废，已经查到的问题也会丢掉。',
      '关键点：',
      '- <点>：通过/不通过/未测到（证据）',
      '没测到的：<哪一项，为什么>',
    ]
      .filter((line) => line !== '')
      .join('\n');
  }

  /**
   * 这个编制任务还在等哪些前置员工？
   * 只认同一次分配里的编制指令；名字对不上（模型写错/历史数据）不算依赖，
   * 否则会永远等一个不存在的员工。
   */
  waitingDependencies(instruction) {
    const names = Array.isArray(instruction?.dependsOn) ? instruction.dependsOn : [];
    if (names.length === 0 || !instruction.dispatchId) return [];
    const group = this.dispatchGroup(instruction.dispatchId).filter(
      (item) => item.id !== instruction.id && item.role !== 'verify',
    );
    const waiting = [];
    for (const name of names) {
      const dep = [...group].reverse().find((item) => item.employeeName === name);
      if (!dep) continue;
      const settled =
        ['accepted', 'escalated', 'discarded', 'held'].includes(dep.state) &&
        !dep.verificationPending;
      if (!settled) waiting.push(name);
    }
    return [...new Set(waiting)];
  }

  /** 前置收口后，把一直在等的验收员派出去。 */
  maybeStartWaitingVerifications(dispatchId) {
    const id = idOf(dispatchId);
    if (!id) return;
    // 这里会派验收员；验收员失败又会回头收口，别在同一轮里递归。
    if (this.startingWaiting) return;
    const group = this.dispatchGroup(id);
    if (group.length === 0) return;
    this.startingWaiting = true;
    let changed = false;
    try {
      for (const item of group) {
        if (!item.verificationWaiting || item.role === 'verify') continue;
        if (this.waitingDependencies(item).length > 0) continue;
        item.verificationWaiting = false;
        changed = true;
        // 前置已经收口（通过/不通过/放弃都算收口）：现在可以按完整交付验了。
        if (!item.verificationPending) continue;
        const spawned = this.spawnVerifier(item, {
          files: item.files,
          tail: item.evidence || '',
        });
        if (!spawned.ok) {
          this.markVerificationUncertain(item, {
            reason: `前置完成后验收员没能建立：${spawned.error || '未知原因'}`,
          });
        }
      }
    } finally {
      this.startingWaiting = false;
    }
    if (changed) this.scheduleSave('instructions');
  }

  /** 给某个编制任务派一个验收员；验收员占的就是刚空出来的那个槽位。 */
  spawnVerifier(instruction, { files = [], tail = '', previousFindings = '', budgetMinutes = 0 } = {}) {
    const task = this.taskOf(instruction.taskId);
    const workspaceId = String(task?.workspaceId || '').trim();
    if (!workspaceId) return { ok: false, error: '找不到这个任务的工作空间' };
    const points = this.verifyPointsFor(instruction);
    instruction.verifyPoints = points;
    // 只看这名员工声明改的范围；整轮扫描会把同批别人的改动也算成“本次改动”。
    const scopedFiles = scopeFilesToDeclared(files, instruction.declaredFiles);
    const employee = {
      employeeId: uid('emp'),
      name: '验收员',
      task: this.composeVerifierText(instruction, {
        files: scopedFiles,
        tail,
        points,
        previousFindings,
      }),
      criteria: instruction.criteria || instruction.intent || instruction.text,
      agentId: '',
      web: 'off',
      useWarehouse: false,
      kbCategoryIds: [],
      model: '',
      budgetMinutes: Number(budgetMinutes) > 0 ? Math.min(Number(budgetMinutes), 30) : planVerifyBudget(instruction),
      role: 'verify',
      parentInstructionId: instruction.id,
      parentTaskId: instruction.taskId,
      parentDispatchId: instruction.dispatchId || '',
      verifyPoints: points,
    };
    const result = this.spawnEmployees({
      dispatchId: uid('dspv'),
      title: `验收 · ${task?.title || instruction.taskTitle || '任务'}`,
      workspaceId,
      shared: '',
      employees: [employee],
    });
    if (result.ok) {
      this.ledgerPush({
        kind: 'verify:spawn',
        taskId: instruction.taskId,
        title: instruction.taskTitle,
        text: `已派验收员，关键点 ${points.length} 个`,
      });
    }
    return result;
  }

  /**
   * 删除/清理类指令的验收就是一个文件状态检查：目标已经不在了就算完成。
   * 为一条 dir 命令起一个 4 分钟的验收会话，是把协调成本花在了比活本身还贵的地方。
   */
  quickStateVerdict(instruction, task) {
    // 只对“这条活本来就是清理”的指令走捷径。功能指令正文里出现“清空表单”
    // 这类词很常见，不能因此跳过验收员（实测前端员就这样被假判通过）。
    const lead = String(instruction.intent || '').trim() || String(instruction.text || '').trim();
    if (!/^\s*(?:删除|删掉|删|清理|清掉|清空|移除)/.test(lead)) {
      return null;
    }
    const targets = cleanupTargets(`${instruction.text || ''}\n${instruction.criteria || ''}`);
    if (targets.length === 0) return null;
    const root = this.workspaceRootOf(task);
    if (!root) return null;
    const remaining = targets.filter((rel) => fsSync.existsSync(path.join(root, rel)));
    if (remaining.length > 0) return null;
    return {
      note: `已核对：${targets.join('、')} 已经不在工作空间里了（只读检查，没派验收员）。`,
    };
  }

  /** 编制完成后先把这一版交给用户；验收结论回来再更新同一条。 */
  deliverBuildToUser(instruction, { task = null, failed = false } = {}) {
    const title = instruction.taskTitle || task?.title || '任务';
    const files = normalizeFiles(instruction.files);
    const path = this.workspaceRootOf(task);
    const details = instruction.evidence ? clip(instruction.evidence, 900) : '';
    const head = failed
      ? `这一轮没跑完：${instruction.resultNote || '员工中途停下了'}`
      : instruction.isWrapUp
        ? '到点收口：这一版是时间用完时交上来的，没做完的部分由验收员核并写进结论。'
        : instruction.round > 0
          ? `返工完成，已经重新交给验收员。这是第 ${instruction.round} 轮返工后的版本。`
          : '工人已经交付这一版，我安排了验收员在验。';
    const audit = instruction.deliveryAudit;
    const auditLine =
      audit && audit.level === 'bad'
        ? `\n⚠️ 我核对到这一版不像能交付的程序：${audit.problems.slice(0, 3).join('；')}。验收会按真实运行来判，不会直接算完成。`
        : audit && audit.level === 'warn'
          ? `\n我还没看到实际运行入口的证据${audit.warnings[0] ? `（${audit.warnings[0]}）` : ''}，验收会补跑。`
          : '';
    const stats = instruction.runStats;
    const statLine = stats
      ? `\n这一轮用了 ${
          stats.elapsedMs < 60000 ? '不到 1' : Math.round(stats.elapsedMs / 60000)
        } 分钟，${stats.toolCalls} 次工具调用（命令 ${stats.commands} 次，写文件 ${stats.writes} 次）。`
      : '';
    const body = [
      head,
      details ? `\n它说做完了这些：\n${clip(details, 700)}` : '',
      auditLine,
      statLine,
      files.length
        ? `\n交付文件：\n${files
            .slice(0, 10)
            .map((file) =>
              file.kind === 'directory'
                ? `- 项目文件夹：${file.path === '.' ? file.name : file.path}`
                : `- ${file.name}：${file.path}`,
            )
            .join('\n')}`
        : '',
      path ? `\n项目路径：${path}` : '',
      failed
        ? '\n这一轮没有结果，我按未验证记；要我重跑一遍就说一声。'
        : '\n版本说明：这是阶段版，验收没结束前文件可能还会变；验收结果我回来补在同一条里。',
    ]
      .filter(Boolean)
      .join('\n');
    const payload = {
      kind: 'delivery',
      instructionId: instruction.id,
      dispatchId: instruction.dispatchId || '',
      round: instruction.round,
      status: failed ? 'failed' : 'verifying',
    };
    const reportTitle = failed
      ? `「${title}」这一轮没跑完`
      : instruction.round > 0
        ? `「${title}」返工完成 · 重新验收中`
        : `「${title}」已交付 · 验收中`;
    const existing = this.inbox.find(
      (item) =>
        item.payload?.kind === 'delivery' &&
        item.payload?.instructionId === instruction.id,
    );
    if (existing) {
      existing.title = reportTitle;
      existing.body = body;
      existing.kind = failed ? 'alert' : 'report';
      existing.urgent = Boolean(failed);
      existing.files = files;
      existing.needsRead = files.length > 0;
      existing.payload = payload;
      this.scheduleSave('inbox');
      this.broadcastSummary();
    } else {
      this.addInbox({
        kind: failed ? 'alert' : 'report',
        title: reportTitle,
        body,
        taskId: instruction.taskId,
        taskTitle: title,
        urgent: Boolean(failed),
        files,
        needsRead: files.length > 0,
        payload,
      });
    }
    instruction.deliveredToUserAt = instruction.deliveredToUserAt || Date.now();
  }

  /** 验收结果回来时，更新用户已经拿到的那一条，不再另起一条。 */
  updateDeliveryMessage(instruction, { title, note = '', urgent = false, status = '' } = {}) {
    const child = instruction.taskTitle || this.taskOf(instruction.taskId)?.title || '任务';
    const existing = this.inbox.find(
      (item) =>
        item.payload?.kind === 'delivery' &&
        item.payload?.instructionId === instruction.id,
    );
    const suffix = note ? `\n\n${note}` : '';
    if (existing) {
      existing.title = title || existing.title;
      existing.body = `${existing.body.split('\n\n验收结论：')[0]}${suffix}`.slice(0, 4000);
      existing.kind = urgent ? 'alert' : 'report';
      existing.urgent = Boolean(urgent);
      existing.payload = {
        ...(existing.payload || {}),
        kind: 'delivery',
        instructionId: instruction.id,
        dispatchId: instruction.dispatchId || '',
        round: instruction.round,
        status: status || existing.payload?.status || '',
      };
      this.scheduleSave('inbox');
      this.broadcastSummary();
      return;
    }
    this.addInbox({
      kind: urgent ? 'alert' : 'report',
      title: title || `「${child}」验收有结果了`,
      body: note || '验收结果已经回来。',
      taskId: instruction.taskId,
      taskTitle: child,
      urgent: Boolean(urgent),
      payload: {
        kind: 'delivery',
        instructionId: instruction.id,
        dispatchId: instruction.dispatchId || '',
        round: instruction.round,
        status,
      },
    });
  }

  /** 编制任务跑完：先交付，再派验收员；验收员派不出去就退回模型验收。 */
  async handleBuildDelivered(instruction, { ok, error, aborted, files, task }) {
    const tail = await this.sessionTail(instruction.taskId).catch(() => '');
    const evidence = clip(String(tail ?? '').trim(), 4000);
    if (evidence) instruction.evidence = evidence;
    instruction.files = mergeDeliveredFiles(instruction.files, files || []);

    if (aborted) {
      instruction.verificationPending = false;
      instruction.finishedAt = Date.now();
      // 到点收口：这一轮是被收口指令顶掉的，不单独给用户发一张“没跑完”的卡，
      // 让收口指令交上来的那一版成为唯一的交付。
      if (instruction.wrapUpInstructionId) {
        instruction.state = 'discarded';
        instruction.unverified = true;
        instruction.resultNote = '到点收口：换成收口指令交付这一版';
        this.scheduleSave('instructions');
        this.refreshDispatchProgress(instruction.dispatchId);
        if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
        return;
      }
      instruction.unverified = Boolean(instruction.budgetStoppedAt);
      instruction.state = instruction.budgetStoppedAt ? 'accepted' : 'discarded';
      instruction.resultNote = instruction.budgetStoppedAt
        ? '超过验证上限，已叫停（未验证）'
        : '被叫停，未验收';
      this.scheduleSave('instructions');
      this.deliverBuildToUser(instruction, { task, failed: !instruction.budgetStoppedAt });
      this.refreshDispatchProgress(instruction.dispatchId);
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      return;
    }

    if (!ok) {
      instruction.verificationPending = false;
      instruction.state = 'escalated';
      instruction.unverified = false;
      instruction.finishedAt = Date.now();
      instruction.resultNote = `员工没跑完：${oneLine(error, 160)}`;
      this.scheduleSave('instructions');
      this.deliverBuildToUser(instruction, { task, failed: true });
      this.refreshDispatchProgress(instruction.dispatchId);
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      return;
    }

    // 0) 交付预检：先看这版是不是能跑的真实现。结果给验收员，也给用户。
    instruction.deliveryAudit = await this.auditDeliverable(instruction, {
      files: instruction.files,
      tail: evidence,
    }).catch(() => null);

    // 1) 先交付：用户现在就能看这一版，标注“验收中/未验证”。
    instruction.state = 'accepted';
    instruction.verificationPending = true;
    instruction.unverified = true;
    instruction.verdict = '';
    instruction.finishedAt = Date.now();
    instruction.resultNote = instruction.round > 0 ? '返工完成，重新验收中' : '已交付，验收中';
    this.deliverBuildToUser(instruction, { task });
    this.scheduleSave('instructions');

    // 删除/清理这类指令：目标不在工作空间里就直接收口，不再为一条 dir
    // 命令派一个 4 分钟的验收会话。
    const quick = this.quickStateVerdict(instruction, task);
    if (quick) {
      instruction.state = 'accepted';
      instruction.verificationPending = false;
      instruction.unverified = false;
      instruction.verdict = 'pass';
      instruction.finishedAt = Date.now();
      instruction.resultNote = quick.note;
      this.updateDeliveryMessage(instruction, {
        title: `「${instruction.taskTitle || task?.title || '任务'}」已完成`,
        note: quick.note,
        status: 'done',
      });
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(instruction.dispatchId);
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      return;
    }

    // 编制真的完成了，验收的预计时间从这一刻重新算，别让开工时的旧闹钟提前响。
    const project = this.projects.get(idOf(instruction.dispatchId));
    if (project) {
      project.verifyEtaAt = Date.now() + (project.verifyEstimateMs || 5 * 60 * 1000);
      project.verifyCheckedAt = 0;
      this.scheduleSave('projects');
    }

    // 2) 有前置依赖、前置还没收口：先不验。典型场景是前端依赖后端接口，
    //    后端还没交就验前端，只会得到“接口不存在”的假缺口，白跑一轮。
    const waiting = this.waitingDependencies(instruction);
    if (waiting.length > 0) {
      instruction.verificationWaiting = true;
      instruction.resultNote = `已交付，等 ${waiting.join('、')} 完成后一起验收`;
      this.updateDeliveryMessage(instruction, {
        title: `「${instruction.taskTitle || task?.title || '任务'}」已交付 · 等前置完成`,
        note: `它依赖的 ${waiting.join('、')} 还没收口。现在验只会拿半截接口判错，所以我等前置完成后再派验收。`,
        status: 'verifying',
      });
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(instruction.dispatchId);
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      return;
    }

    // 3) 再派验收员。派不出去就退回原来的模型验收，别把任务悬着。
    const spawned = this.spawnVerifier(instruction, {
      files: instruction.files,
      tail: evidence,
    });
    if (!spawned.ok) {
      instruction.verificationPending = false;
      instruction.note = `验收员没能建立：${spawned.error || '未知原因'}`;
      await this.accept(instruction, { ok: true, error: '', aborted: false, files: instruction.files });
      return;
    }
    this.refreshDispatchProgress(instruction.dispatchId);
    if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
  }

  /**
   * 用户直接进任务里改过并离开：如果总监正等着返工/收尾，先审一下用户改完的
   * 东西是否已经满足了原来的缺口。满足就重新验收，不满足才继续返工。
   * 只处理总监正在等的任务；用户随便问一句不会触发。
   */
  async reviewUserEdit({ taskId, tail = '', files = [] }) {
    if (!this.getState().enabled) return;
    const id = idOf(taskId);
    if (!id) return;
    const dispatchId = this.dispatchOfTask(id);
    if (!dispatchId) return;
    const latest = [...this.instructions]
      .reverse()
      .find((item) => item.taskId === id && item.role !== 'verify' && item.dispatchId);
    if (!latest) return;

    // 正在验收：先记下来，等验收结论回来时再决定要不要按新版本复核。
    if (latest.verificationPending) {
      latest.userEditedAt = Date.now();
      this.scheduleSave('instructions');
      return;
    }
    if (!['rework', 'escalated'].includes(latest.state)) return;
    const visible = clip(String(tail ?? '').trim(), 1200);
    if (!visible) return;

    const reply = await this.ask({
      system:
        '你是工作总监。用户直接进任务里操作并结束了这一轮。判断用户改完的东西是否已经补上之前验收指出的缺口。' +
        '只输出一行 JSON：{"done":true} 或 {"done":false,"gap":"还差什么"}。不要写别的。' +
        '拿不准就回 {"done":false,"gap":"没看出已经补上，需要继续"}。',
      user: [
        `原要求：${clip(latest.intent || latest.text, 800)}`,
        `验收标准：${clip(latest.criteria, 400)}`,
        `上次缺口：${clip((latest.verifyGaps || []).join('；') || latest.resultNote, 500)}`,
        `用户这一轮最后留下的内容：\n${visible}`,
      ].join('\n'),
      maxTokens: 300,
      timeoutMs: 20 * 1000,
    }).catch(() => null);
    const data = reply ? this.parseJson(reply) : null;
    if (!data) return;

    latest.files = mergeDeliveredFiles(latest.files, files || []);
    if (data.done === true) {
      latest.state = 'accepted';
      latest.verificationPending = true;
      latest.unverified = true;
      latest.verdict = '';
      latest.finishedAt = Date.now();
      latest.resultNote = '你直接改过，按你的版本重新验收';
      this.updateDeliveryMessage(latest, {
        title: `「${latest.taskTitle || '任务'}」你改过的版本重新验收中`,
        note: '你直接在这个任务里补过，我没有再返工；现在按你的版本重新安排验收。',
        status: 'verifying',
      });
      const spawned = this.spawnVerifier(latest, { files: latest.files, tail: visible });
      if (!spawned.ok) {
        latest.verificationPending = false;
        latest.resultNote = `验收员没能建立：${spawned.error || '未知原因'}`;
      }
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(dispatchId);
      if (latest.dispatchId) this.maybeFinishDispatch(latest.dispatchId);
      return;
    }

    const gap = oneLine(data.gap, 300) || '用户改过之后还没看出缺口被补上';
    latest.verifyGaps = [gap];
    latest.state = 'rework';
    this.enqueueRework(latest, [gap]);
    this.scheduleSave('instructions');
    this.refreshDispatchProgress(dispatchId);
    if (latest.dispatchId) this.maybeFinishDispatch(latest.dispatchId);
  }

  /**
   * 验收员没来得及写结论时，从它的正文和思考里捞已经查到的判断。
   * 只用来“别丢证据”，不参与通过/不通过的判决。
   */
  async salvageFindingsFor(taskId) {
    try {
      return this.salvageFindings(await this.sessionMessages(taskId));
    } catch {
      return [];
    }
  }

  salvageFindings(messages) {
    const picked = [];
    const signal =
      /(?:FAIL|不通过|不符合|不一致|违反|缺失|未实现|没有实现|越界|契约|应(?:该)?返回|实际返回|返回\s*\d{3}|404|409)/i;
    const noise =
      /^(?:PASS|ok\b|✓|✗|\/\/|#|```|const |let |var |function |import |require\(|await |return |curl |node |python |powershell|cmd |cd |dir |type |grep |git )/i;
    for (const message of Array.isArray(messages) ? messages : []) {
      if (message?.role !== 'assistant') continue;
      for (const text of [message.content, message.thinking]) {
        for (const rawLine of String(text ?? '').split('\n')) {
          const line = rawLine.replace(/^[-*•\d.\s]+/, '').trim();
          if (line.length < 12 || line.length > 260) continue;
          if (/[:：]\s*$/.test(line)) continue; // 「FAIL 项：」这类只是标题，不是发现
          if (noise.test(line) || !signal.test(line)) continue;
          const clean = oneLine(line, 180);
          if (!picked.includes(clean)) picked.push(clean);
        }
      }
    }
    return picked.slice(-6);
  }

  /** 从验收员的收尾答复里读结构化结论。 */
  parseVerdict(text) {
    const raw = String(text ?? '');
    // 先读写着“结论”的那一行，按人话判断语气：
    // 「## 结论：3 个关键点全部通过」「结论：交付预检通过，无不合格项。」
    // 原来只认冒号后紧跟“通过”，于是明明通过了却被记成“没有验成”。
    const linesAll = raw.split('\n').map((line) => line.trim());
    const conclusionLine = linesAll.find((line) => /结\s*论/.test(line));
    let afterConclusion = conclusionLine
      ? conclusionLine.replace(/^[\s#*>*-]*/, '').replace(/^.*?结\s*论\s*[:：]?\s*/, '')
      : '';
    // 「## 结论」单独一行、判决写在下一行是常见写法（实测里就有）。
    // 只看同一行会把“三个关键点全部通过”读丢，白重派一轮验收。
    if (conclusionLine && !afterConclusion) {
      const at = linesAll.indexOf(conclusionLine);
      const next = linesAll
        .slice(at + 1)
        .find((line) => line && !/^#{1,6}\s/.test(line) && !/^[-*>]+$/.test(line));
      if (next) afterConclusion = next.replace(/^[\s#*>*-]*/, '');
    }
    let verdict = '';
    if (afterConclusion) {
      if (hasRealNegative(afterConclusion)) verdict = 'fail';
      else if (/未验证|没验成|无法验证/.test(afterConclusion)) verdict = 'unverified';
      else if (/通过|可用|无问题|没问题|合格/.test(afterConclusion)) verdict = 'pass';
    }
    if (!verdict) {
      verdict = /^\s*不通过/.test(raw) ? 'fail' : /^\s*通过/.test(raw) ? 'pass' : '';
    }
    // 没有“结论”行、或者结论行读不出来时，再看全文的明确表述：
    // 「三个关键点全部通过」「无不合格项」按通过处理；只要出现真的否定
    // （不通过/未测到/无法启动……）就不猜，交给人。
    if (!verdict) {
      const negative = hasRealNegative(raw);
      const positive =
        /(?:全部|所有|各项|三项|三个|关键点)[^。\n]{0,12}(?:通过|无问题|没问题|合格)/.test(raw) ||
        /结\s*论\s*[:：]\s*(?:交付)?可用/.test(raw);
      if (!negative && positive) verdict = 'pass';
    }
    const gaps = raw
      .split('\n')
      .map((line) => oneLine(line.replace(/^[-*]\s*/, ''), 200))
      // “结论：不通过”本身不是缺口：它只是判决，缺口在下面几行。
      .filter((line) => !/^[#*\s]*验收?结论\s*[:：]/.test(line))
      .filter((line) => /不通过|未测到|没测到|跑不起来|缺少|无法/.test(line))
      .slice(0, 8);
    // 摘要只取“结论”之后的几行。按开头取会把工人的自述当成验收结论，
    // 用户看到的就会是“验收员在复述工人说的话”。
    const lines = raw
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean);
    const verdictAt = lines.findIndex((line) => /^[#*\s]*验收?结论\s*[:：]/.test(line));
    const after = verdictAt >= 0 ? lines.slice(verdictAt + 1) : lines;
    const note = oneLine(
      after
        .filter((line) => !/^关键点\s*[:：]?$/.test(line))
        .slice(0, 3)
        .join(' '),
      300,
    );
    // “没测到的”是局部验收的边界，必须跟着结论一起交出来，不能吞掉。
    const untested = raw
      .split('\n')
      .map((line) => line.replace(/^[-*\s]+/, '').trim())
      .filter((line) => /^(?:没测到|未测到|未覆盖|没覆盖)/.test(line))
      .map((line) =>
        oneLine(line.replace(/^(?:没测到|未测到|未覆盖|没覆盖)\s*[:：]?\s*/, ''), 120),
      )
      .filter(Boolean)
      .slice(0, 3);
    return { verdict, gaps, note, untested };
  }

  /** 验收员跑完：不递归验收，只把结论落到编制任务上。 */
  async finishVerification(verification, { ok, error, aborted, files }) {
    // 验收结论可能夹在报告中间（后面还有“没测到的”），所以多取一些，
    // 并且保留结尾；只取开头会把结论整段切掉。
    const tail = await this.sessionTail(verification.taskId, { limit: 12000 }).catch(() => '');
    let evidence = clipTail(String(tail ?? '').trim(), 6000);
    const parsed = this.parseVerdict(String(tail ?? ''));
    // 验收员可能把发现写在思考里、正文还没写结论就被预算叫停。
    // 把已经查到的判断捞出来，交给用户/下一轮验收，别让整轮白跑。
    const findings =
      parsed.verdict && parsed.verdict !== 'unverified'
        ? []
        : await this.salvageFindingsFor(verification.taskId);
    if (findings.length) {
      evidence = [evidence, `未写结论前已发现：\n${findings.map((item) => `- ${item}`).join('\n')}`]
        .filter(Boolean)
        .join('\n\n');
    }
    verification.state = 'accepted';
    verification.finishedAt = Date.now();
    verification.evidence = evidence || verification.evidence;
    verification.verdict = parsed.verdict;
    verification.resultNote = parsed.note || (ok ? '验收员交回了结论' : `验收员没跑完：${oneLine(error, 160)}`);
    this.scheduleSave('instructions');

    const parent = this.instructions.find(
      (item) => item.id === verification.parentInstructionId,
    );
    if (!parent) {
      this.addInbox({
        kind: 'alert',
        title: '验收结论找不到对应的任务',
        body: `验收员交了结论，但原来的编制任务已经不在了：${clip(evidence, 500)}`,
        urgent: true,
      });
      return;
    }
    parent.verificationPending = false;

    if (aborted || !ok) {
      // 到时被叫停，但结论已经写出来了：证据在，就按结论收口，别让它白验一轮。
      // 只有“没有明确结论”才算未验证。
      if (aborted && parsed.verdict && parsed.verdict !== 'unverified' && evidence) {
        parsed.note = [parsed.note, '验收员到时被叫停，结论在叫停前已经给出']
          .filter(Boolean)
          .join('；');
      } else {
        this.markVerificationUncertain(parent, {
          reason: aborted ? '验收员被叫停，没来得及给结论' : `验收员没跑完：${oneLine(error, 160)}`,
          findings,
        });
        return;
      }
    }

    // 用户在验收期间直接改过这个任务：这一轮结论对应的是旧版本，不能拿它收口。
    // 清掉标记，按新版本重新派一次验收；改一次只复核一次，不会无限循环。
    if (
      Number(parent.userEditedAt) > 0 &&
      Number(parent.userEditedAt) >= Number(verification.startedAt || 0)
    ) {
      parent.userEditedAt = 0;
      parent.state = 'accepted';
      parent.verificationPending = true;
      parent.unverified = true;
      parent.verdict = '';
      parent.finishedAt = Date.now();
      parent.resultNote = '你在验收期间改过，按新版本再验一次';
      this.updateDeliveryMessage(parent, {
        title: `「${parent.taskTitle || '任务'}」你改过的版本复核中`,
        note: '你在验收期间直接改过这个任务，上一轮结论对应的是旧版本；我按新版本再验一次。',
        status: 'verifying',
      });
      // 不复读上一轮验收员的话：它验的是旧版本，带过去会污染新结论。
      const respawned = this.spawnVerifier(parent, { files: parent.files, tail: '' });
      if (!respawned.ok) {
        this.markVerificationUncertain(parent, {
          reason: `复核的验收员没能建立：${respawned.error || '未知原因'}`,
        });
        return;
      }
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(parent.dispatchId);
      if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
      return;
    }

    if (parsed.verdict === 'pass') {
      // 验收员说通过，但系统预检发现是桩/模拟/缺入口：这份“通过”不可信。
      // 处理归系统：在返工额度内直接打回重做一次，不问用户；到上限才如实报告。
      const audit = parent.deliveryAudit;
      if (audit && audit.level === 'bad') {
        const problems = audit.problems.length > 0 ? audit.problems : ['交付预检没通过'];
        parent.verdict = 'unverified';
        parent.verifiedAt = 0;
        parent.verifyGaps = problems.slice(0, 5);
        const limit = this.reworkLimit();
        if (parent.round >= limit) {
          this.escalateTestProduct(parent, problems, '');
          return;
        }
        parent.state = 'rework';
        parent.unverified = true;
        parent.finishedAt = Date.now();
        parent.resultNote = `预检发现是测试产物，已打回重做：${problems.slice(0, 3).join('；')}`;
        const queued = this.enqueueRework(parent, problems, { redo: true });
        if (!queued.ok) {
          this.escalateTestProduct(parent, problems, `返工没排上：${oneLine(queued.error, 120)}`);
          return;
        }
        this.updateDeliveryMessage(parent, {
          title: `「${parent.taskTitle || '任务'}」像测试产物，已打回重做`,
          note: [
            '验收员给了“通过”，但我核对交付时发现：',
            ...problems.map((item) => `- ${item}`),
            `这不像能交付的程序，我按真实实现打回重做（第 ${parent.round + 1}/${limit} 轮），不用你处理。`,
          ].join('\n'),
          urgent: false,
          status: 'rework',
        });
        this.scheduleSave('instructions');
        this.refreshDispatchProgress(parent.dispatchId);
        if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
        return;
      }
      parent.state = 'accepted';
      parent.unverified = false;
      parent.verdict = 'pass';
      parent.verifiedAt = Date.now();
      parent.finishedAt = Date.now();
      parent.verifyGaps = [];
      const warning = audit?.warnings?.[0] ? `；预检提醒：${audit.warnings[0]}` : '';
      const untestedNote =
        parsed.untested?.length > 0 ? `；没测到：${parsed.untested.join('；')}` : '';
      parent.untested = parsed.untested || [];
      parent.resultNote = `验收通过${parsed.note ? `：${parsed.note}` : ''}${warning}${untestedNote}`;
      this.updateDeliveryMessage(parent, {
        title: `「${parent.taskTitle || '任务'}」已验证`,
        note: `验收结论：通过。${parsed.note || '验收员按关键点确认可用。'}${
          audit?.warnings?.length ? `\n预检提醒：${audit.warnings.join('；')}` : ''
        }${untestedNote ? `\n没测到的：${parsed.untested.join('；')}` : ''}`,
        status: 'verified',
      });
      this.scheduleSave('instructions');
      if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
      this.refreshDispatchProgress(parent.dispatchId);
      return;
    }

    if (parsed.verdict === 'fail') {
      const gaps = parsed.gaps.length > 0 ? parsed.gaps : [parsed.note || '验收员没写具体缺口'];
      parent.verifyGaps = gaps;
      parent.resultNote = `验收不通过：${gaps.join('；')}`;
      const limit = this.reworkLimit();
      if (parent.round >= limit) {
        parent.state = 'escalated';
        parent.unverified = false;
        parent.verdict = 'fail';
        parent.finishedAt = Date.now();
        this.updateDeliveryMessage(parent, {
          title: `「${parent.taskTitle || '任务'}」返工到上限，仍未通过`,
          note: `验收结论：不通过，已经返工 ${parent.round} 轮，达到上限。\n缺口：${gaps.join('；')}`,
          urgent: true,
          status: 'failed',
        });
        this.addConfirm(parent.taskId, {
          title: '返工到上限，还是没通过',
          body: `「${parent.taskTitle || '任务'}」验收没过的点：\n${gaps.join('\n')}\n\n要我换一种做法再试，还是先按现状收尾？`,
          actions: [
            { id: 'rework', label: '再试一次', style: 'primary' },
            { id: 'abandon', label: '先这样', style: 'danger' },
          ],
          payload: { instructionId: parent.id },
          urgent: true,
        });
        this.scheduleSave('instructions');
        if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
        this.refreshDispatchProgress(parent.dispatchId);
        return;
      }

      parent.state = 'rework';
      parent.finishedAt = Date.now();
      const queued = this.enqueueRework(parent, gaps);
      if (!queued.ok) {
        this.markVerificationUncertain(parent, { reason: `返工没排上：${queued.error}` });
        return;
      }
      this.updateDeliveryMessage(parent, {
        title: `「${parent.taskTitle || '任务'}」验收没通过，返工中`,
        note: `验收结论：不通过。\n缺口：${gaps.join('；')}\n我已经让原来的员工只补这几项（第 ${parent.round + 1}/${limit} 轮）。`,
        urgent: false,
        status: 'rework',
      });
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(parent.dispatchId);
      if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
      return;
    }

    // 验收员正常跑完、也留了证据，只是结论写法我没读懂：再派一轮窄验收。
    // 补验是总监的活，不该让领导说“再验一次”；只补一次，避免来回烧时间。
    if (!parent.verifyRetryUsed && evidence) {
      parent.verifyRetryUsed = true;
      parent.verificationPending = true;
      parent.unverified = false;
      parent.verdict = '';
      parent.resultNote = '验收结论没读清，重新派了一轮验收';
      const respawned = this.spawnVerifier(parent, {
        files: parent.files || [],
        tail: evidence,
        // 上一轮已经查到的，直接交给这一轮核对；不要让它从零再探索一遍。
        previousFindings: findings.join('\n'),
        budgetMinutes: Math.min(planVerifyBudget(parent), 6),
      });
      if (respawned.ok) {
        this.ledgerPush({
          kind: 'verify:retry',
          taskId: parent.taskId,
          title: parent.taskTitle,
          text: '验收结论没读清，按同一版重新派了一轮验收',
        });
        this.updateDeliveryMessage(parent, {
          title: `「${parent.taskTitle || '任务'}」结论没读清，重新验收中`,
          note: '验收员跑完了，但结论里读不出明确的通过/不通过。我没有算通过，已经按同一版再派一轮验收。',
          status: 'verifying',
        });
        this.scheduleSave('instructions');
        this.refreshDispatchProgress(parent.dispatchId);
        if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
        return;
      }
    }

    this.markVerificationUncertain(parent, {
      reason: parsed.note || '验收员没有给出通过/不通过',
      findings,
    });
  }

  /**
   * 验收员卡住、被叫停、或没给结论：如实记未验证，不冒充通过。
   * 不再拿“补验还是按现状”去问用户——验收是总监的职责，不是用户的。
   */
  markVerificationUncertain(parent, { reason = '', findings = [] } = {}) {
    const found = (Array.isArray(findings) ? findings : []).filter(Boolean).slice(0, 6);
    parent.verificationPending = false;
    parent.state = 'escalated';
    parent.unverified = true;
    parent.verdict = 'unverified';
    parent.finishedAt = Date.now();
    parent.resultNote =
      `未验证：${oneLine(reason, 200)}` +
      (found.length ? `｜到点前已发现：${oneLine(found.join('；'), 300)}` : '');
    this.updateDeliveryMessage(parent, {
      title: `「${parent.taskTitle || '任务'}」验收没给出结论`,
      note: [
        `这一轮验收没拿到可判断的证据：${oneLine(reason, 300)}。`,
        found.length
          ? `不过它到点前已经查到这些，我没丢：\n${found.map((item) => `- ${item}`).join('\n')}`
          : '',
        '我没有把它算成通过，也不会让你替我验；版本和已有证据都在项目里，需要就再让它补验。',
      ]
        .filter(Boolean)
        .join('\n'),
      urgent: false,
      status: 'unverified',
    });
    this.addInbox({
      kind: 'report',
      title: '「' + (parent.taskTitle || '任务') + '」没有验成',
      body: [
        `「${parent.taskTitle || '任务'}」这一轮验收没拿到结论：${oneLine(reason, 300) || '验收员没有给出通过/不通过'}。`,
        found.length
          ? `它到点前已经查到这些（未最终确认，已保存）：\n${found.map((item) => `- ${item}`).join('\n')}`
          : '',
        '我按未验证如实记录，没有算成通过。',
        '这是验收环节的问题，不需要你替它验；要补验跟我说一声，我派一个更窄的。',
      ]
        .filter(Boolean)
        .join('\n'),
      taskId: parent.taskId,
      taskTitle: parent.taskTitle,
    });
    this.scheduleSave('instructions');
    if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
    this.refreshDispatchProgress(parent.dispatchId);
  }

  /**
   * 交付是测试产物，而返工额度已经用完：如实记未验证并报告。
   * 同样不问用户“重做还是按现状”——该重做的时候上一段已经自动做了。
   */
  escalateTestProduct(parent, problems, reason = '') {
    const list = Array.isArray(problems) && problems.length > 0 ? problems : ['交付预检没通过'];
    parent.verificationPending = false;
    parent.state = 'escalated';
    parent.unverified = true;
    parent.verdict = 'unverified';
    parent.verifiedAt = 0;
    parent.finishedAt = Date.now();
    parent.verifyGaps = list.slice(0, 5);
    parent.resultNote = `未验证：交付像测试产物（${list.slice(0, 3).join('；')}）${reason ? `；${reason}` : ''}`;
    this.updateDeliveryMessage(parent, {
      title: `「${parent.taskTitle || '任务'}」像测试产物，没有算通过`,
      note: [
        '验收员给了“通过”，但我核对交付时发现：',
        ...list.map((item) => `- ${item}`),
        reason || '已经返工到上限，还是这样。',
        '我没有把它算成通过。要换个做法重做，跟我说一声，我直接安排。',
      ].join('\n'),
      urgent: true,
      status: 'unverified',
    });
    this.addInbox({
      kind: 'report',
      title: `「${parent.taskTitle || '任务'}」交付像测试产物`,
      body: [
        `「${parent.taskTitle || '任务'}」预检发现：`,
        ...list.map((item) => `- ${item}`),
        reason || '返工到上限还是这样，我按未验证记，不算通过。',
      ].join('\n'),
      taskId: parent.taskId,
      taskTitle: parent.taskTitle,
      urgent: true,
    });
    this.scheduleSave('instructions');
    if (parent.dispatchId) this.maybeFinishDispatch(parent.dispatchId);
    this.refreshDispatchProgress(parent.dispatchId);
  }

  /** 返工：同一个任务、同一个员工，只补验收没过的那几项。 */
  /** 上一轮声明的文件现在还在不在。不在就先说清楚，别让返工变成整套重写。 */
  missingDeclaredFiles(instruction) {
    const root = String(this.spaces.get(idOf(instruction?.workspaceId))?.path ?? '').trim();
    if (!root) return [];
    const files = Array.isArray(instruction?.files) ? instruction.files : [];
    return files
      .filter((file) => file?.path && !fsSync.existsSync(path.join(root, file.path)))
      .map((file) => file.path)
      .slice(0, 8);
  }

  enqueueRework(parent, gaps, { redo = false } = {}) {
    const gap = (Array.isArray(gaps) ? gaps : []).join('；') || parent.resultNote || '上一轮验收没通过';
    const missing = this.missingDeclaredFiles(parent);
    // 重做是一次重新实现，不是补小缺口：按这一单原本的时间给，而不是拍一个
    // 12 分钟——时间不够的重做只会再交一个半成品，把返工额度白白用光。
    const budget = redo
      ? Math.max(
          BUILD_BUDGET_MIN_MINUTES,
          Number(parent.originalBudgetMinutes) || Number(parent.budgetMinutes) || 0,
        )
      : 8;
    const text = [
      redo
        ? '这次不是补小缺口：上一版交付是桩/测试产物，按真实实现重做，删掉顶替真实现的桩和临时脚本。'
        : '只补上次验收没过的点，不要重做已经通过的部分，也不要把整个项目重新审查一遍。',
      `任务：${oneLine(parent.intent || parent.taskTitle || parent.text, 200)}`,
      `缺口：${gap}`,
      missing.length
        ? `上一轮声明的这些文件现在不在了：${missing.join('、')}。先确认是被删了还是没写成，不要不知情就把整套重写一遍。`
        : '',
      redo
        ? `最多 ${budget} 分钟：交上来之前按真实入口启动一次，把启动命令和实际输出写清楚；不要另建基准、对弈或回归套件。`
        : `最多 ${budget} 分钟；拿不到证据就写清哪一项没测到，不要继续搭测试环境或扩大范围。`,
      '原要求你已经有了，按它对照着补这一项，不要从头再来。',
    ].join('\n');
    return this.enqueue({
      taskId: parent.taskId,
      text,
      intent: parent.intent || parent.text,
      criteria: parent.criteria,
      // 返工也是同一个项目的一部分：契约和验收点必须跟着走，否则返工后的
      // 验收员看不到接口边界，只能各按各的理解验。
      contract: parent.contract || '',
      verifyPoints: Array.isArray(parent.verifyPoints) ? parent.verifyPoints : [],
      workspaceId: parent.workspaceId || '',
      source: 'director',
      attempts: 3,
      budgetMinutes: budget,
      originalBudgetMinutes:
        parent.originalBudgetMinutes || parent.budgetMinutes || budget,
      userText: parent.userText || '',
      approved: true,
      dispatch: {
        dispatchId: parent.dispatchId,
        dispatchTitle: parent.dispatchTitle,
        employeeName: parent.employeeName,
        dispatchSize: parent.dispatchSize,
        agentId: parent.agentId,
      },
      role: 'build',
      round: parent.round + 1,
      parentInstructionId: parent.id,
      declaredFiles: Array.isArray(parent.declaredFiles) ? parent.declaredFiles : [],
    });
  }

  /** 一条任务在项目汇总里的状态词。 */
  dispatchStatusLabel(item) {
    if (item.verificationPending) return '已交付 · 验收中';
    if (item.state === 'accepted') return item.unverified ? '未验证' : '已验证';
    if (item.state === 'rework') return '返工中';
    if (item.state === 'escalated') return item.unverified ? '未验证' : '没通过';
    if (item.state === 'held') return '等你确认';
    if (item.state === 'discarded') return '已放弃';
    return '编制中';
  }

  /** 项目级状态消息：编制全部结束、验收还没结束时发一条，之后原地更新。 */
  refreshDispatchProgress(dispatchId) {
    const id = idOf(dispatchId);
    if (!id) return;
    const group = this.dispatchGroup(id);
    if (group.length === 0) return;
    const latest = new Map();
    for (const item of group) {
      if (item.role === 'verify') continue;
      const key = item.employeeName || item.taskId;
      const previous = latest.get(key);
      if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
    }
    const items = [...latest.values()];
    if (items.length === 0) return;
    const building = items.some(
      (item) => !item.verificationPending && ['queued', 'delivered', 'rework'].includes(item.state),
    );
    // 还没编制完就先不新开一条“编制完毕”；但已经有这条消息的，要跟着状态原地更新
    // （比如验收发现缺口、退回返工），不能让用户手里拿着过期的进度。
    const existing = this.inbox.find(
      (item) => item.payload?.summary === true && item.payload?.dispatchId === id,
    );
    if (building && !existing) return;

    const project = this.projects.get(id);
    const title = project?.title || group[0].dispatchTitle || '项目';
    const lines = items.map((item) => {
      const name = item.employeeName || this.taskOf(item.taskId)?.title || '员工';
      return `- ${name}：${this.dispatchStatusLabel(item)}${
        item.resultNote ? ` · ${oneLine(item.resultNote, 140)}` : ''
      }`;
    });
    const files = mergeDeliveredFiles(...items.map((item) => item.files));
    const headline = building
      ? '验收发现缺口，已经退回返工'
      : '编制完毕，正在验收';
    const body = [
      `「${title}」`,
      lines.join('\n'),
      '',
      building
        ? '有一部分退回重做了；做完我会重新安排验收，并在这一条里更新。'
        : '编制已经全部结束，验收还在继续；有了结论我会在这条里更新。',
      project?.buildEtaAt
        ? `原计划：编制 ${Math.round(project.estimateMs / 60000)} 分钟，验收再加 ${Math.round(
            project.verifyEstimateMs / 60000,
          )} 分钟。`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
    if (existing) {
      existing.title = `「${title}」${headline}`;
      existing.body = body;
      existing.kind = 'report';
      existing.files = files;
      existing.needsRead = files.length > 0;
      existing.payload = {
        ...(existing.payload || {}),
        kind: 'project-progress',
        dispatchId: id,
        summary: true,
      };
      this.scheduleSave('inbox');
      this.broadcastSummary();
    } else {
      this.addInbox({
        kind: 'report',
        title: `「${title}」${headline}`,
        body,
        taskId: items[0].taskId,
        taskTitle: title,
        files,
        needsRead: files.length > 0,
        payload: { kind: 'project-progress', dispatchId: id, summary: true },
      });
    }
    if (project && !building) {
      project.buildingAnnouncedAt = project.buildingAnnouncedAt || Date.now();
    }
    this.scheduleSave('inbox');
    this.broadcastSummary();
  }

  /** 有槽位空出来：看别的项目要不要补位，别让位置白空着。 */
  noteSlotFreed(dispatchId) {
    const id = idOf(dispatchId);
    if (!id) return;
    setTimeout(() => {
      void this.backfillSlot(id).catch(() => undefined);
    }, 1500);
  }

  async backfillSlot(finishedDispatchId) {
    if (!this.getState().enabled || this.stopped) return;
    const now = Date.now();
    const max = Math.max(1, Number(this.getState().maxDispatch) || 4);
    // 只有真的有空槽才补；别为了补位突破并发。
    if (this.runningDispatchTaskIds().size >= max) return;
    const candidates = [...this.projects.values()]
      .filter(
        (project) =>
          project.status === 'active' &&
          project.kind === 'dispatch' &&
          project.id !== finishedDispatchId &&
          now - (project.lastBackfillAt || 0) > 5 * 60 * 1000,
      )
      .filter((project) => {
        const group = this.dispatchGroup(project.id).filter((item) => item.role !== 'verify');
        const active = group.filter((item) =>
          ['queued', 'delivered', 'rework'].includes(item.state),
        );
        if (active.length === 0) return false;
        const overdue = project.buildEtaAt > 0 && now > project.buildEtaAt;
        const verifying = group.some((item) => item.verificationPending);
        return overdue || verifying || group.some((item) => item.state === 'accepted');
      })
      .sort((a, b) => (a.buildEtaAt || Infinity) - (b.buildEtaAt || Infinity));
    const target = candidates[0];
    if (!target) return;
    const group = this.dispatchGroup(target.id).filter((item) => item.role !== 'verify');
    if (group.length === 0) return;
    const plan = await this.planSplit(group, 1).catch(() => null);
    if (!plan || !Array.isArray(plan.employees) || plan.employees.length === 0) return;
    target.lastBackfillAt = now;
    this.scheduleSave('projects');
    const helper = plan.employees[0];
    const result = this.spawnEmployees({
      dispatchId: target.id,
      title: target.title,
      workspaceId: target.workspaceId,
      shared: plan.shared || '',
      employees: [helper],
    });
    if (!result.ok) return;
    this.addInbox({
      kind: 'report',
      title: '空出来的位置去补位了',
      body: `「${target.title}」偏慢，我把刚空出来的位置派给「${helper.name}」：${oneLine(
        helper.task,
        180,
      )}`,
      taskId: '',
      taskTitle: target.title,
    });
    this.ledgerPush({
      kind: 'backfill',
      title: target.title,
      text: `补位：${helper.name}`,
    });
  }

  /** 到了预计编制/验收时间，主动检查一次，而不是等用户问。 */
  checkProjectCheckpoints(now = Date.now()) {
    for (const project of this.projects.values()) {
      if (project.status !== 'active') continue;
      if (project.buildEtaAt > 0 && !project.buildCheckedAt && now >= project.buildEtaAt) {
        project.buildCheckedAt = now;
        this.addProjectDecision(project.id, '到了预计编制完成时间，检查是否需要重新分配');
        this.scheduleSave('projects');
        void this.pulseProject(project.id, {
          force: true,
          reason: '到了预计编制完成时间',
        }).catch(() => undefined);
      }
      if (project.verifyEtaAt > 0 && !project.verifyCheckedAt && now >= project.verifyEtaAt) {
        project.verifyCheckedAt = now;
        this.addProjectDecision(project.id, '到了预计验收完成时间，检查是否继续返工或交给用户');
        this.scheduleSave('projects');
        void this.pulseProject(project.id, {
          force: true,
          reason: '到了预计验收完成时间',
        }).catch(() => undefined);
      }
      this.checkProjectOverdue(project, now);
    }
  }

  /**
   * 超时不能只靠模型决定要不要开口。原来模型拿到的事实里写着“超时本身不是
   * 汇报理由”，于是一个 22 分钟的项目跑到 78 分钟，中间 52 分钟一句话没有。
   * 这里按硬阈值兜底：超过预计 1.5 倍（至少多 15 分钟）就报一次，最多两次，
   * 把“继续等 / 叫停”直接交给用户。
   */
  checkProjectOverdue(project, now = Date.now()) {
    if (!project || project.status !== 'active') return;
    const eta = Number(project.buildEtaAt) || 0;
    if (eta <= 0) return;
    const alerts = Math.max(0, Number(project.overdueAlerts) || 0);
    if (alerts >= 2) return;
    const estimate = Math.max(60 * 1000, Number(project.estimateMs) || 0);
    const step = Math.max(15 * 60 * 1000, Math.round(estimate * 0.5));
    if (now - eta < step * (alerts + 1)) return;
    // 两条提醒之间至少隔一个步长，不能下一个巡视又报一遍。
    if (now - (Number(project.overdueReportedAt) || 0) < step) return;
    // 只在“还有编制任务在跑”时提醒；验收超时由验收员自己的上限处理。
    const active = this.activeBuildInstructions(project);
    if (active.length === 0) return;

    project.overdueAlerts = alerts + 1;
    project.overdueReportedAt = now;
    this.scheduleSave('projects');
    const elapsed = Math.round((now - (project.startedAt || now)) / 60000);
    const over = Math.round((now - eta) / 60000);
    const rows = active.map((item) => {
      const run = this.runs.get(item.taskId);
      const ranFor = Math.round((now - Number(run?.startedAt || item.startedAt || item.createdAt || now)) / 60000);
      const quiet = run ? Math.round((now - Number(run.lastAt || now)) / 60000) : 0;
      return `- ${item.employeeName || item.taskTitle || '员工'}：已跑 ${ranFor} 分钟${
        quiet >= 3 ? `，最近 ${quiet} 分钟没有新动作` : ''
      }`;
    });
    const slowest = [...active].sort(
      (a, b) => Number(a.startedAt || a.createdAt || 0) - Number(b.startedAt || b.createdAt || 0),
    )[0];
    this.addProjectDecision(project.id, `超时提醒：已跑 ${elapsed} 分钟，超过预计 ${over} 分钟`);
    this.addInbox({
      kind: 'confirm',
      title: '项目超时了，要我怎么处理？',
      body: [
        `「${project.title}」已经跑了 ${elapsed} 分钟，比预计多 ${over} 分钟。`,
        '还在做：',
        ...rows,
        '继续等，还是叫停跑得最久的那个？',
      ].join('\n'),
      taskId: slowest?.taskId ?? '',
      taskTitle: project.title,
      actions: [
        { id: 'approve', label: '继续等' },
        { id: 'stop', label: '叫停跑得最久的', style: 'danger' },
      ],
      payload: { kind: 'project-overdue', projectId: project.id, taskId: slowest?.taskId ?? '' },
      urgent: alerts === 0,
    });
  }

  /** 这个项目里还在编制/返工的指令（不含验收员）。 */
  activeBuildInstructions(project) {
    if (!project) return [];
    const list =
      project.kind === 'dispatch'
        ? this.dispatchGroup(project.id)
        : this.instructions.filter((item) => project.taskIds?.includes(item.taskId));
    return list.filter(
      (item) => item.role !== 'verify' && ['queued', 'delivered', 'rework'].includes(item.state),
    );
  }

  /**
   * 所有项目都完工、验收都有结论之后，做一次整体衔接检查：
   * 只看接口/交接处，不重审每个项目。有疑问就派一条“只回答、不要开始编制”
   * 的询问任务给相关员工；没有疑问就明确收口。
   */
  async maybeIntegrationCheck() {
    const state = this.getState();
    if (!state.enabled || state.mode === 'observe' || this.stopped) return;
    const now = Date.now();
    if (now - this.lastIntegrationAt < 10 * 60 * 1000) return;
    if ([...this.projects.values()].some((project) => project.status === 'active')) return;

    const done = [...this.projects.values()].filter(
      (project) =>
        project.status === 'done' &&
        // 验收员不是项目；旧版本给 dspv_ 建过假项目，不能再算进跨项目检查。
        !String(project.id).startsWith('dspv_') &&
        !project.integrationCheckedAt &&
        now - project.finishedAt < 6 * 60 * 60 * 1000,
    );
    if (done.length === 0) return;
    this.lastIntegrationAt = now;

    const rows = [];
    for (const project of done) {
      const list =
        project.kind === 'dispatch'
          ? this.dispatchGroup(project.id)
          : this.instructions.filter((item) => item.taskId === project.taskIds[0]);
      const latest = new Map();
      for (const item of list) {
        const key = item.employeeName || item.taskId;
        const previous = latest.get(key);
        if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
      }
      for (const item of latest.values()) {
        if (item.state === 'accepted' && !item.unverified) rows.push({ project, item });
      }
    }

    const finish = (issues, note, confident = true) => {
      for (const project of done) {
        project.integrationCheckedAt = now;
        this.addProjectDecision(project.id, note);
      }
      this.scheduleSave('projects');
      // 没拿到模型结论时由调用方单独发提醒，这里不冒充“检查完毕”。
      if (issues > 0 || !confident) return;
      // 没通过验收的任务不算“都验收通过了”。结论只能按真正通过的项说，
      // 否则会在全部任务未验证时仍给用户报“都验收通过了”。
      const verified = rows.length;
      const taskTotal = done.reduce(
        (sum, project) => sum + Math.max(1, project.taskIds.length),
        0,
      );
      this.addInbox({
        kind: 'report',
        title: verified >= 2 ? '整体检查完毕' : '整体检查跳过',
        body:
          verified >= 2
            ? [
                `最近完工的 ${done.length} 个项目里，有 ${verified} 项拿到了通过的验收结论。`,
                '我按这些结论对照了一遍接口和交接处，没有发现需要再问的地方。',
              ].join('\n')
            : [
                `最近完工的 ${done.length} 个项目里只有 ${verified} 项拿到了通过的验收结论（共 ${taskTotal} 项任务），不够做跨项目检查。`,
                verified === 0
                  ? '其余任务都是未验证或已放弃，我不会把它们当成通过。'
                  : '其余任务没有可用结论，我不会把它们当成通过。',
              ].join('\n'),
        payload: { kind: 'integration', checked: done.length, verified },
      });
    };

    if (rows.length < 2) {
      finish(0, `整体检查：只有 ${rows.length} 项有通过的验收结论，跳过跨项目检查`);
      return;
    }

    const reply = await this.ask({
      system:
        '你是工作总监，做最后一次整体衔接检查。只看项目之间的接口、交接处和共用文件，' +
        '不要重新审查每个项目内部是否做完——那些已经验收过了。' +
        '只输出一行 JSON：{"issues":[{"taskId":"相关任务 id","question":"要问员工的一句具体问题"}]}。' +
        '没有问题就回 {"issues":[]}。最多 2 条。不要写别的。',
      user: [
        ...rows.slice(0, 12).map(
          (row) =>
            `- 项目「${row.project.title}」· ${row.item.employeeName || row.item.taskTitle} · 任务 id=${row.item.taskId} · 结论：${oneLine(
              row.item.resultNote || '通过',
              180,
            )}`,
        ),
        '',
        '只问跨项目的接口/交接/共用文件问题；单个项目内部的问题不再问。',
      ].join('\n'),
      maxTokens: 600,
      timeoutMs: 25 * 1000,
    }).catch(() => null);
    const data = reply ? this.parseJson(reply) : null;
    if (!data) {
      // 没拿到模型结论就不说“检查完毕”：如实记未验证，不冒充做过。
      finish(0, '整体检查没拿到模型结论（未验证）', false);
      this.addInbox({
        kind: 'alert',
        title: '整体检查没做成',
        body: '模型没有回话，我没法对照接口和交接处。先记作未验证，没有当成通过。',
        urgent: true,
      });
      return;
    }
    const issues = (Array.isArray(data?.issues) ? data.issues : []).slice(0, 2);
    let sent = 0;
    for (const issue of issues) {
      const taskId = idOf(issue?.taskId);
      const question = oneLine(issue?.question, 300);
      if (!taskId || !question || !this.tasks.has(taskId)) continue;
      const queued = this.enqueue({
        taskId,
        text: [
          '只回答，不要开始编制，也不要改代码。',
          `问题：${question}`,
          '用一两句话回答，然后停下；不需要交付文件。',
        ].join('\n'),
        intent: question,
        source: 'director',
        approved: true,
        attempts: 1,
        askOnly: true,
      });
      if (queued.ok) sent += 1;
    }
    finish(
      sent,
      sent > 0
        ? `整体检查：发现 ${sent} 个衔接疑问，已派只回答的询问`
        : '整体检查完毕，没有新的衔接疑问',
    );
  }

  async accept(instruction, outcome) {
    const task = this.taskOf(instruction.taskId);
    // 这次分配跑出来的文件；返工过的把上一轮的也带上，最后一起交付。
    const files = mergeDeliveredFiles(instruction.files, outcome.files);
    const tail = await this.sessionTail(instruction.taskId);
    // 会话日志会随任务删除一起消失；把这一轮的答复留在指令上，
    // 之后用户问“到底做没做”时不至于只能看到 0 条记录。
    const evidence = clip(String(tail ?? '').trim(), 4000);
    if (evidence) instruction.evidence = evidence;
    // 被叫停的这一轮不算交付：不拿它去验收，也不自动返工。叫停就是不要
    // 这个结果了；再返工等于没停，还会把排在后面的新指令一直压着。
    if (outcome.aborted) {
      // 验证预算到点是我叫停的，不是用户不要结果：把已有的答复和“没测到”
      // 如实交回来，让领导决定要不要再跑，而不是静默收尾。
      if (instruction.budgetStoppedAt) {
        const budget = instruction.budgetMinutes || 8;
        instruction.finishedAt = Date.now();
        instruction.state = 'accepted';
        instruction.files = files;
        instruction.unverified = true;
        instruction.resultNote = `超过 ${budget} 分钟验证上限，已叫停（未验证）`;
        this.ledgerPush({
          kind: 'accept:budget',
          taskId: instruction.taskId,
          title: task?.title,
          text: instruction.resultNote,
        });
        this.addInbox({
          kind: 'report',
          title: '验证到时间了，我先叫停',
          body: [
            `「${task?.title ?? instruction.taskTitle ?? '这个任务'}」跑了 ${budget} 分钟，到了我设的验证上限，我让它先停，不再继续搭环境。`,
            evidence
              ? `\n已经拿到的：\n${markdownTail(clip(tail, 1200))}`
              : '\n这一轮没有留下可读的答复。',
            '\n没测到的：以工人上面没提到的项为准。要不要我换个更窄的验证再跑一次？',
          ].join('\n'),
          taskId: instruction.taskId,
          taskTitle: task?.title,
        });
        this.scheduleSave('instructions');
        if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
        return;
      }
      instruction.finishedAt = Date.now();
      instruction.state = 'discarded';
      instruction.files = files;
      instruction.unverified = false;
      instruction.resultNote = '被叫停，未验收';
      this.ledgerPush({
        kind: 'accept:stopped',
        taskId: instruction.taskId,
        title: task?.title,
        text: '这一轮被叫停，不算交付',
      });
      this.scheduleSave('instructions');
      return;
    }
    // 删除/清理：目标已经不在磁盘上，就是完成。director_instruct 直接下发的
    // 指令没有 dispatchId，不走 handleBuildDelivered；这一步必须在这里再做
    // 一次，否则一条 dir 命令也要等 20 秒模型验收，超时后还要领导点头。
    const quick = outcome.ok ? this.quickStateVerdict(instruction, task) : null;
    if (quick) {
      instruction.state = 'accepted';
      instruction.verificationPending = false;
      instruction.unverified = false;
      instruction.verdict = 'pass';
      instruction.finishedAt = Date.now();
      instruction.files = files;
      instruction.resultNote = quick.note;
      this.ledgerPush({
        kind: 'accept:quick',
        taskId: instruction.taskId,
        title: task?.title,
        text: quick.note,
      });
      this.addInbox({
        kind: 'report',
        title: '清理完成',
        body: `「${task?.title ?? instruction.taskTitle}」我核对过了。\n${quick.note}`,
        taskId: instruction.taskId,
        taskTitle: task?.title,
        files,
      });
      this.scheduleSave('instructions');
      this.refreshDispatchProgress(instruction.dispatchId);
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
      return;
    }

    const criteria = instruction.criteria || instruction.text;
    // 先做不依赖模型的核对：文件在不在磁盘上，以及是不是测试产物。
    const check = await this.checkDeliveredFiles(instruction, files).catch(() => ({
      text: '',
      total: 0,
      found: 0,
      unknown: true,
    }));
    const audit = await this.auditDeliverable(instruction, { files, tail }).catch(() => null);
    if (audit) instruction.deliveryAudit = audit;
    const reply = await this.ask({
      system:
        '你是工作总监，验收工人的交付。只依据给出的证据判断，不要补脑。' +
        '第一行只写「通过」或「不通过」，第二行写一句理由，之后可以列具体缺口。' +
        '如果任务异常结束，或者声称交付的文件在磁盘上找不到，直接判不通过。' +
        '如果交付是桩、mock、模拟服务器或测试脚本顶替的，或者找不到真实入口、工人没实际跑过，也判不通过。',
      user: [
        `任务：${task?.title ?? instruction.taskTitle}`,
        `你下的要求：${clip(instruction.text, 900)}`,
        `验收标准：${clip(criteria, 500)}`,
        `结果：${outcome.ok ? '正常结束' : `异常结束：${oneLine(outcome.error, 300)}`}`,
        `文件核对（磁盘）：\n${clip(check.text, 1200) || '（没有可核对的交付文件）'}`,
        audit && (audit.problems.length || audit.warnings.length)
          ? `交付预检：\n${[...audit.problems, ...audit.warnings]
              .slice(0, 5)
              .map((item) => `- ${item}`)
              .join('\n')}`
          : '',
        `工人的答复：\n${clip(tail, 1400) || '（没有留下可见的答复）'}`,
      ]
        .filter(Boolean)
        .join('\n'),
      maxTokens: 500,
      // 验收是流水线上的一步，不能把整条线卡在等模型上：
      // 一次只等 20 秒，拿不到结论就按现状收尾（如实记未验证）。
      retries: 0,
      timeoutMs: 20 * 1000,
    });

    let verdict = parseVerdict(reply);
    const destructive = looksDestructive(instruction.text, instruction.intent);
    const failReason = outcome.ok ? '' : oneLine(outcome.error, 200);
    // 工人说有交付，但磁盘上一个都找不到：这是确定性证据，不能判通过。
    const filesMissing = !check.unknown && check.total > 0 && check.found === 0;
    if (verdict === true && filesMissing) verdict = null;
    // 模型说通过，但预检发现是桩/模拟/缺入口：按不通过处理，让它只补这一项。
    const auditProblems = audit?.level === 'bad' ? audit.problems : [];
    if (verdict === true && auditProblems.length > 0) verdict = false;

    // 模型没给出明确结论：不自动通过。删除类任务尤其不能拿“正常结束”当
    // “删对了”，要等领导点头（不可逆）；普通任务由系统如实记“未验证”并报出
    // 可核对的事实，不拿“算不算完成”去问领导。
    if (verdict === null) {
      const reason = filesMissing
        ? '交付文件在磁盘上一个都找不到'
        : failReason || (reply ? '验收结论读不出来' : '验收模型 20 秒内没给结论');
      // 这一轮正常结束、文件也都在，只是我这边没拿到验收结论：不拿一张
      // “我验不了”的卡拦住领导。按现状收尾，如实记“未验证”，整次分配
      // 收口时一起报；删除类任务仍然要等领导点头。
      const evidenceClean = outcome.ok && !filesMissing;
      if (!destructive && evidenceClean) {
        instruction.finishedAt = Date.now();
        instruction.state = 'accepted';
        instruction.files = files;
        instruction.unverified = true;
        instruction.resultNote = oneLine(
          check.total > 0
            ? `按现状收尾（未验证）：交付文件 ${check.found}/${check.total} 在磁盘上`
            : '按现状收尾（未验证）：正常结束，验收模型没给结论',
          200,
        );
        this.ledgerPush({
          kind: 'accept:auto',
          taskId: instruction.taskId,
          title: task?.title,
          text: instruction.resultNote,
        });
        this.scheduleSave('instructions');
        this.pulseMilestone(instruction, '有个员工按现状收尾了');
        if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
        return;
      }
      if (destructive) {
        this.holdAcceptance(instruction, { files, tail, reason, check: check.text });
      } else {
        this.reportUnverified(instruction, {
          files,
          tail,
          check: check.text,
          reason,
          ok: outcome.ok,
        });
      }
      return;
    }

    const pass = verdict;
    const reason =
      auditProblems.length > 0
        ? `交付预检不通过：${auditProblems.join('；')}`
        : reply
          ? clip(reply.split('\n').slice(1).join('\n').trim(), 400)
          : pass
            ? '验收通过'
            : '验收不通过';

    instruction.finishedAt = Date.now();
    instruction.resultNote = oneLine(reason, 200);
    if (pass) {
      instruction.state = 'accepted';
      instruction.files = files;
      instruction.unverified = false;
      this.ledgerPush({
        kind: 'accept:pass',
        taskId: instruction.taskId,
        title: task?.title,
        text: reason,
      });
      if (instruction.dispatchId) {
        // 一次分配的员工各发各的会很吵：等全部结束，汇总成一条。
        this.pulseMilestone(instruction, '有个员工验收通过了');
        this.maybeFinishDispatch(instruction.dispatchId);
        this.scheduleSave('instructions');
        return;
      }
      this.addInbox({
        kind: 'report',
        title: '验收通过',
        body: `「${task?.title ?? instruction.taskTitle}」我验收过了。${reason ? `\n${reason}` : ''}`,
        taskId: instruction.taskId,
        taskTitle: task?.title,
        files,
        // 总监分配的任务：这些文件要用户点开/标记已读才算交付完成。
        needsRead: files.length > 0,
      });
      this.scheduleSave('instructions');
      return;
    }

    if (instruction.attempts < 2) {
      this.pulseMilestone(instruction, '验收发现缺口，已让工人只补缺口');
      instruction.state = 'rework';
      instruction.files = files;
      instruction.unverified = false;
      this.ledgerPush({
        kind: 'accept:rework',
        taskId: instruction.taskId,
        title: task?.title,
        text: reason,
      });
      this.addInbox({
        kind: 'alert',
        title: '验收没过，已让工人返工一次',
        body: `「${task?.title ?? instruction.taskTitle}」${reason ? `\n${reason}` : ''}`,
        taskId: instruction.taskId,
        taskTitle: task?.title,
        urgent: true,
      });
      this.enqueue({
        taskId: instruction.taskId,
        // 只补缺口：上一轮已经做对的部分不要重做。工人有会话上下文，
        // 把缺口和原要求一起给它，比让它从头再跑一遍快、也省 token。
        text: [
          '只补验收指出的缺口，不要重做已经通过的部分。',
          '',
          '缺口：',
          reason || '上一轮交付不完整，请对照验收标准补齐。',
          '',
          '原要求（只用来对照，不要从头再来）：',
          instruction.text,
          '',
          '补完说明你改了哪里。',
        ].join('\n'),
        intent: instruction.intent || instruction.text,
        criteria: instruction.criteria,
        source: 'director',
        attempts: instruction.attempts + 1,
        // The original instruction already went through the level's gate.
        approved: true,
        files,
        dispatch: instruction.dispatchId
          ? {
              dispatchId: instruction.dispatchId,
              dispatchTitle: instruction.dispatchTitle,
              employeeName: instruction.employeeName,
              dispatchSize: instruction.dispatchSize,
            }
          : null,
      });
      // 新的返工指令接手；旧的留成“已转返工”，否则这次分配永远等不到收尾。
      if (instruction.dispatchId) {
        instruction.state = 'discarded';
        instruction.note = '已转返工';
      }
    } else {
      instruction.state = 'escalated';
      this.ledgerPush({
        kind: 'accept:escalate',
        taskId: instruction.taskId,
        title: task?.title,
        text: reason,
      });
      this.addConfirm(instruction.taskId, {
        title: '两次验收都没过',
        body: `「${task?.title ?? instruction.taskTitle}」${reason ? `\n${reason}` : ''}`,
        actions: [
          { id: 'rework', label: '再返工一次', style: 'primary' },
          { id: 'accept', label: '按现状收尾' },
          { id: 'abandon', label: '放弃', style: 'danger' },
        ],
        payload: { instructionId: instruction.id },
        urgent: true,
        files,
        needsRead: files.length > 0,
      });
      if (instruction.dispatchId) this.maybeFinishDispatch(instruction.dispatchId);
    }
    this.scheduleSave('instructions');
  }

  /* ------------------------------------------------------------------ */
  /* patrol                                                             */
  /* ------------------------------------------------------------------ */

  /**
   * 连续三次一模一样的工具调用：这不是慢，是在原地打转。代跑级别先叫停，
   * 再把“按缺口重做”的选择交回用户；其余级别只提醒，不动工人的活。
   */
  handleToolLoop(taskId) {
    const id = idOf(taskId);
    const run = this.runs.get(id);
    const health = this.runHealth(id);
    if (!run || !health?.looping || run.loopAlertedAt) return;
    if (!this.monitored(id)) return;
    const state = this.getState();
    if (state.mode === 'observe') return;
    const task = this.taskOf(id);
    const instruction = [...this.instructions]
      .reverse()
      .find(
        (item) =>
          item.taskId === id &&
          item.source !== 'user' &&
          ['delivered', 'rework'].includes(item.state),
      );
    run.loopAlertedAt = Date.now();
    // 同一段静止期别再触发一次“任务停住了”，两条提醒说的是一件事。
    run.stuckAlertedAt = run.loopAlertedAt;
    const tool = oneLine(
      (run.recentTools || []).slice(-1)[0]?.split(':')[0] || run.tool || '同一个工具',
      80,
    );
    const label = task?.title ?? '任务';
    if (state.mode === 'run') {
      this.broadcast('director:task-action', { action: 'stop', taskIds: [id] });
    }
    this.addConfirm(id, {
      title: '员工在同一个步骤上打转',
      body: [
        `「${label}」连续 3 次调用同一个工具、参数也一样：${tool}。`,
        '这不像是在干活，更像在原地打转。',
        state.mode === 'run' ? '我先叫停了这一轮。' : '要不要叫停重来？',
      ].join('\n'),
      actions: [
        { id: 'rework', label: '叫停并重做', style: 'primary' },
        { id: 'abandon', label: '先不管', style: 'danger' },
      ],
      payload: { kind: 'loop', instructionId: instruction?.id ?? '' },
      urgent: true,
    });
    this.ledgerPush({
      kind: 'stuck:loop',
      taskId: id,
      title: label,
      text: `${tool} 连续重复 3 次`,
    });
    this.scheduleSave('inbox');
  }

  /**
   * 一个运行很久没有任何新事件：先让模型看事实做判断，而不是只拿
   * “运行中”当“在干活”。模型不可用时，到硬提醒点直接告诉用户。
   */
  async judgeStuckRun(taskId) {
    const id = idOf(taskId);
    const run = this.runs.get(id);
    const health = this.runHealth(id);
    if (!run || !health || !this.monitored(id)) return;
    const now = Date.now();
    if (health.quietMs < RUN_SILENT_MS) return;
    if (now - (run.judgeAt || 0) < RUN_JUDGE_COOLDOWN_MS) return;
    run.judgeAt = now;

    const task = this.taskOf(id);
    const instruction = [...this.instructions]
      .reverse()
      .find(
        (item) =>
          item.taskId === id &&
          item.source !== 'user' &&
          ['delivered', 'rework'].includes(item.state),
      );
    const quietMinutes = Math.max(1, Math.round(health.quietMs / 60000));
    const silentMinutes = Math.max(1, Math.round(health.silentMs / 60000));
    const lastTool = health.tool ? `最后一步：${health.tool}` : '还没有工具动作';
    const tail = await this.sessionTail(id).catch(() => '');

    const reply = await this.ask({
      system: [
        '你是工作总监，正在看一个跑着的任务。状态写“运行中/正在生成”不等于在干活。',
        '事实里会给你：已经跑了多久、多久没有新事件、多久没有新内容、有没有工具动作、最后一条答复。',
        '模型或网络挂住时，界面会一直停在“正在生成…”，但没有任何新事件；这时不要安慰领导“它在执行”。',
        '按 AI 编程的实际速度判断，不按人类工时。',
        '你要在下面几个动作里选一个：wait（继续等）、stop（叫停这一轮重试）、instruct（补一条更明确的指令并打断）、report（现在向领导汇报）、ask（问领导）。',
        '普通的长思考不要轻易叫停；没有任何新事件、也没有工具动作，才优先怀疑卡住。',
        '只输出一行 JSON：{"action":"wait|stop|instruct|report|ask","message":"对领导说的话，一两句，可空","instruction":"action=instruct 时给工人的具体指令","criteria":"可选验收标准","reason":"你凭什么这么判断"}。不要写别的。',
      ].join('\n'),
      user: [
        `任务：${task?.title ?? '任务'}`,
        `你下的要求：${clip(instruction?.text ?? '', 600) || '（不是你下的指令）'}`,
        `已经跑了 ${Math.round(health.elapsedMs / 60000)} 分钟；${quietMinutes} 分钟没有任何新事件；${silentMinutes} 分钟没有新内容。`,
        `输出内容：${health.outputChars} 字符；思考内容：${health.thinkingChars} 字符；事件 ${health.events} 次。`,
        lastTool,
        tail ? `最后一条答复：\n${clip(tail, 500)}` : '（没有可见答复）',
        `当前级别：${this.getState().mode}`,
      ].join('\n'),
      maxTokens: 400,
      timeoutMs: 20 * 1000,
    }).catch(() => null);

    const decision = reply ? this.parseJson(reply) : null;
    const action = ['wait', 'stop', 'instruct', 'report', 'ask'].includes(decision?.action)
      ? decision.action
      : '';
    const message = oneLine(decision?.message, 300);
    const reason = oneLine(decision?.reason, 200);

    if (action === 'wait') {
      this.ledgerPush({
        kind: 'stuck:wait',
        taskId: id,
        title: task?.title,
        text: reason || `${quietMinutes} 分钟没有新事件，先继续等`,
      });
      return;
    }

    // 模型完全不可用：到了硬提醒点，仍然要告诉用户“像卡住了”，不要静默。
    if (!action) {
      if (
        health.quietMs >= RUN_SILENT_ALERT_MS &&
        !run.stuckAlertedAt
      ) {
        run.stuckAlertedAt = now;
        this.addInbox({
          kind: 'alert',
          // 和老巡视用同一个标题：同一段静止期只留一条，别在 8 分钟和
          // 15 分钟各报一次。
          title: '任务停住了',
          body: `「${task?.title ?? '任务'}」已经 ${quietMinutes} 分钟没有任何新内容，${
            health.tool ? `最后一步是：${health.tool}` : '连工具动作都没有'
          }。这不像是正在干活，可能是模型或网络挂住了。你可以让我叫停重试，或者先去看看。`,
          taskId: id,
          taskTitle: task?.title,
          urgent: true,
        });
      }
      return;
    }

    if (action === 'report' || action === 'ask') {
      if (now - (run.stuckAlertedAt || 0) < PROJECT_REPORT_MIN_MS) return;
      run.stuckAlertedAt = now;
      this.addInbox({
        kind: action === 'ask' ? 'confirm' : 'alert',
        title: action === 'ask' ? '任务可能卡住了，要我怎么处理？' : '任务可能卡住了',
        body:
          message ||
          `「${task?.title ?? '任务'}」已经 ${quietMinutes} 分钟没有任何新内容，看起来像卡住了。`,
        taskId: id,
        taskTitle: task?.title,
        urgent: true,
        actions:
          action === 'ask'
            ? [
                { id: 'approve', label: '叫停重试', style: 'primary' },
                { id: 'dismiss', label: '再等等' },
              ]
            : [],
        payload:
          action === 'ask'
            ? { kind: 'stuck-action', taskId: id, action: 'stop', instructionId: instruction?.id ?? '' }
            : null,
      });
      return;
    }

    if (action === 'stop' || action === 'instruct') {
      const text =
        message ||
        (action === 'stop'
          ? '这个任务已经很久没有新内容，我先叫停这一轮重试。'
          : '这个任务卡住了，我补一条更明确的指令让它继续。');
      const mode = this.getState().mode;
      if (mode === 'observe') {
        this.addInbox({
          kind: 'alert',
          title: '任务可能卡住了',
          body: `${text}（现在是观察级别，我只提醒，不动手。）`,
          taskId: id,
          taskTitle: task?.title,
          urgent: true,
        });
        return;
      }
      if (mode === 'suggest') {
        this.addInbox({
          kind: 'confirm',
          title: '任务可能卡住了，要不要我处理？',
          body: text,
          taskId: id,
          taskTitle: task?.title,
          urgent: true,
          actions: [
            { id: 'approve', label: action === 'stop' ? '叫停重试' : '补指令', style: 'primary' },
            { id: 'dismiss', label: '再等等' },
          ],
          payload: {
            kind: 'stuck-action',
            taskId: id,
            action,
            instruction: clip(decision?.instruction ?? '', 1200),
            criteria: clip(decision?.criteria ?? '', 500),
            instructionId: instruction?.id ?? '',
          },
        });
        return;
      }
      if (action === 'instruct' && String(decision?.instruction ?? '').trim()) {
        const queued = this.enqueue({
          taskId: id,
          text: String(decision.instruction),
          intent: '修复卡住的任务',
          criteria: String(decision?.criteria ?? ''),
          source: 'director',
          approved: true,
          attempts: 1,
        });
        if (queued.ok) {
          this.interruptTask(id);
          this.addInbox({
            kind: 'report',
            title: '我把卡住的任务接上了',
            body: text,
            taskId: id,
            taskTitle: task?.title,
          });
          return;
        }
      }
      const stopped = this.interruptTask(id);
      if (stopped.ok) {
        this.addInbox({
          kind: 'report',
          title: '我把卡住的任务叫停了',
          body: text,
          taskId: id,
          taskTitle: task?.title,
        });
      }
    }
  }

  /** 项目当前还在跑的指令（按员工去重，只留最新一条）。 */
  projectActiveInstructions(project) {
    const list =
      project.kind === 'dispatch'
        ? this.dispatchGroup(project.id)
        : this.instructions.filter((item) => item.taskId === project.taskIds[0]);
    const latest = new Map();
    for (const item of list) {
      const key = item.employeeName || item.taskId;
      const previous = latest.get(key);
      if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
    }
    // 等验收也算还没结束：编制完了，但人还占着这个项目的活。
    return [...latest.values()].filter(
      (item) =>
        ['queued', 'delivered', 'rework', 'held'].includes(item.state) ||
        item.verificationPending,
    );
  }

  /**
   * 还没开发完的部分：优先用这个员工最初领到的活，而不是最后一条修补指令，
   * 这样领导看到的是“还在做哪块功能”，不是一句零碎的现场对话。
   */
  projectActiveLines(snapshot) {
    const project = snapshot?.project;
    const list = project
      ? project.kind === 'dispatch'
        ? this.dispatchGroup(project.id)
        : this.instructions.filter((item) => item.taskId === project.taskIds[0])
      : [];
    const firstByEmployee = new Map();
    for (const item of list) {
      const key = item.employeeName || item.taskId;
      const previous = firstByEmployee.get(key);
      if (!previous || item.createdAt < previous.createdAt) firstByEmployee.set(key, item);
    }
    const rows = Array.isArray(snapshot?.rows) ? snapshot.rows : [];
    const active = new Set((snapshot?.active ?? []).map((item) => item.id));
    return rows
      .filter((row) => active.has(row.item.id))
      .map((row) => {
        const key = row.item.employeeName || row.item.taskId;
        const original = firstByEmployee.get(key);
        const part = oneLine(
          original?.intent || row.item.intent || row.task?.title || row.name,
          180,
        );
        const status = [];
        if (row.health) {
          status.push(`已跑 ${Math.round(row.health.elapsedMs / 60000)} 分钟`);
          if (row.idleMinutes >= 2) status.push(`${row.idleMinutes} 分钟没有新事件`);
          if (row.health.tool) status.push(`最后一步：${row.health.tool}`);
        }
        return {
          name: oneLine(row.name, 40) || '员工',
          part: part || '正在收尾',
          status: status.join('，'),
        };
      });
  }

  /** 一行话版本，给模型汇报的兜底正文用。 */
  projectActiveParts(snapshot) {
    return this.projectActiveLines(snapshot)
      .map((row) => `${row.name}：${row.part}`)
      .join('；');
  }

  projectSnapshot(project, now = Date.now()) {
    const list =
      project.kind === 'dispatch'
        ? this.dispatchGroup(project.id)
        : this.instructions.filter((item) => item.taskId === project.taskIds[0]);
    const latest = new Map();
    for (const item of list) {
      const key = item.employeeName || item.taskId;
      const previous = latest.get(key);
      if (!previous || item.createdAt >= previous.createdAt) latest.set(key, item);
    }
    const final = [...latest.values()];
    const active = this.projectActiveInstructions(project);
    const accepted = final.filter((item) => item.state === 'accepted' && !item.unverified);
    const unverified = final.filter((item) => item.unverified);
    const failed = final.filter((item) => item.state === 'escalated' && !item.unverified);
    const held = final.filter((item) => item.state === 'held');
    const elapsedMs = Math.max(0, now - project.startedAt);
    const estimateMs = Math.max(0, Number(project.estimateMs) || 0);
    let usage = { cost: 0, inputTokens: 0, outputTokens: 0, requests: 0 };
    for (const taskId of new Set([...project.taskIds, ...final.map((item) => item.taskId)])) {
      const one = this.taskUsage(taskId, project.startedAt);
      if (!one) continue;
      usage.cost += one.cost || 0;
      usage.inputTokens += one.inputTokens || 0;
      usage.outputTokens += one.outputTokens || 0;
      usage.requests += one.requests || 0;
    }
    const rows = final.map((item) => {
      const task = this.taskOf(item.taskId);
      const health = this.runHealth(item.taskId, now);
      const name = item.employeeName || task?.title || '员工';
      return {
        item,
        task,
        health,
        name,
        state: item.state,
        idleMinutes: health ? Math.round(health.quietMs / 60000) : 0,
        result: item.resultNote || '',
      };
    });
    return {
      project,
      list: final,
      active,
      accepted,
      unverified,
      failed,
      held,
      rows,
      usage,
      elapsedMs,
      estimateMs,
      overMs: estimateMs > 0 ? Math.max(0, elapsedMs - estimateMs) : 0,
      ratio: estimateMs > 0 ? elapsedMs / estimateMs : 0,
      now,
    };
  }

  /**
   * 项目入口：只读工作空间根目录，找启动命令和入口文件。
   * 不执行任何脚本；远程空间给不出本地入口时如实说明。
   */
  async projectEntryInfo(project) {
    const task = this.taskOf(project.taskIds[0]);
    const workspaceId = String(project.workspaceId || task?.workspaceId || '');
    const root = String(task?.workspacePath || this.spaces.get(idOf(workspaceId))?.path || '')
      .trim();
    if (!root) {
      return {
        workspaceId,
        root: '',
        command: '',
        entryPaths: [],
        kind: 'unknown',
        notes: ['项目在远程空间或还没有本地路径，入口请从任务里打开。'],
      };
    }
    let base = path.resolve(root);
    // 项目常常放在工作空间下的一个子目录里（todo-board/ 这种）。只读根目录
    // 会看不到入口，调试卡上就只剩一个空间路径，领导点进去还得自己找。
    // 交付文件都在同一个子目录下时，入口就在那里。
    const delivered = [];
    let folderHint = '';
    for (const taskId of project.taskIds || []) {
      for (const item of this.instructions) {
        if (item.taskId !== idOf(taskId)) continue;
        for (const file of item.files || []) {
          const rel = String(file?.path ?? '')
            .replace(/\\/g, '/')
            .replace(/^\.?\//, '');
          if (!rel || rel.includes('..')) continue;
          // 交付直接记成文件夹（pm/）时，入口就在这个文件夹里。
          if (file?.kind === 'directory' && rel !== '.' && !folderHint) folderHint = rel;
          delivered.push(rel);
        }
      }
    }
    const dirUnderBase = async (rel) => {
      const candidate = path.resolve(base, rel);
      if (!candidate.startsWith(base + path.sep)) return '';
      return (await fs.stat(candidate).then((stat) => stat.isDirectory()).catch(() => false))
        ? candidate
        : '';
    };
    if (folderHint) {
      const candidate = await dirUnderBase(folderHint);
      if (candidate) base = candidate;
    } else if (delivered.length > 0 && delivered.every((rel) => rel.includes('/'))) {
      const parts = delivered.map((rel) => rel.split('/').slice(0, -1));
      let common = parts[0];
      for (const segs of parts) {
        let i = 0;
        while (i < common.length && i < segs.length && common[i] === segs[i]) i += 1;
        common = common.slice(0, i);
      }
      if (common.length > 0) {
        const candidate = path.resolve(base, common.join('/'));
        if (
          candidate.startsWith(base + path.sep) &&
          (await fs.stat(candidate).then((stat) => stat.isDirectory()).catch(() => false))
        ) {
          base = candidate;
        }
      }
    }
    const names = await fs.readdir(base).catch(() => []);
    const has = (name) => names.includes(name);
    const present = async (rel) => {
      const clean = String(rel ?? '').replace(/\\/g, '/').replace(/^\.?\//, '');
      if (!clean || clean.includes('..')) return false;
      const target = path.resolve(base, clean);
      if (target !== base && !target.startsWith(base + path.sep)) return false;
      try {
        await fs.stat(target);
        return true;
      } catch {
        return false;
      }
    };

    let pkg = null;
    if (has('package.json')) {
      try {
        pkg = JSON.parse(await fs.readFile(path.join(base, 'package.json'), 'utf8'));
      } catch {
        pkg = null;
      }
    }
    const scripts =
      pkg && pkg.scripts && typeof pkg.scripts === 'object' && !Array.isArray(pkg.scripts)
        ? pkg.scripts
        : {};
    const deps = {
      ...(pkg && typeof pkg.dependencies === 'object' ? pkg.dependencies : {}),
      ...(pkg && typeof pkg.devDependencies === 'object' ? pkg.devDependencies : {}),
    };
    let kind = 'unknown';
    if (deps.electron) kind = 'electron';
    else if (has('index.html')) kind = 'web';
    else if (pkg) kind = 'node';
    else if (has('server.js')) kind = 'node';
    else if (has('go.mod')) kind = 'go';
    else if (has('Cargo.toml')) kind = 'rust';
    else if (
      has('manage.py') ||
      has('main.py') ||
      has('app.py') ||
      has('pyproject.toml') ||
      has('requirements.txt')
    ) {
      kind = 'python';
    }

    const pm = has('pnpm-lock.yaml') ? 'pnpm' : has('yarn.lock') ? 'yarn' : 'npm';
    const scriptName = ['dev', 'start', 'preview', 'serve'].find(
      (name) => typeof scripts[name] === 'string' && scripts[name].trim(),
    );
    let command = '';
    if (scriptName) {
      command = `${pm} ${scriptName === 'start' ? 'start' : `run ${scriptName}`}`;
    } else if (kind === 'web') {
      command = '直接打开 index.html';
    } else if (kind === 'python') {
      command = has('manage.py')
        ? 'python manage.py runserver'
        : `python ${has('main.py') ? 'main.py' : 'app.py'}`;
    } else if (kind === 'go') {
      command = 'go run .';
    } else if (kind === 'rust') {
      command = 'cargo run';
    } else if (kind === 'node' && pkg?.main) {
      command = `node ${pkg.main}`;
    } else if (kind === 'node' && has('server.js')) {
      command = 'node server.js';
    }

    const candidates = [
      pkg?.main,
      'src/main.tsx',
      'src/index.tsx',
      'src/main.ts',
      'src/index.js',
      'src/App.tsx',
      'index.html',
      has('manage.py') ? 'manage.py' : '',
      has('main.py') ? 'main.py' : has('app.py') ? 'app.py' : '',
      'main.go',
      'src/main.rs',
      'server.js',
      'app.js',
    ];
    const entryPaths = [];
    for (const candidate of candidates) {
      if (entryPaths.length >= 4) break;
      if (await present(candidate)) {
        const clean = String(candidate).replace(/\\/g, '/').replace(/^\.?\//, '');
        if (clean && !entryPaths.includes(clean)) entryPaths.push(clean);
      }
    }
    return { workspaceId, root: base, command, entryPaths, kind, notes: [] };
  }

  /** 没有模型时的调试清单：按项目类型给具体项，不给一句空话。 */
  debugStepsFor(kind, { entry = {}, points = [] } = {}) {
    const steps = [];
    const first = entry.entryPaths?.[0] || '';
    steps.push(
      first
        ? `打开 ${first}（在 ${entry.root || '项目根目录'} 下），确认能正常进入、控制台没有报错`
        : '按现有启动方式打开项目，确认入口能正常打开，控制台/日志没有报错',
    );
    if (entry.command) steps.push(`用「${entry.command}」启动一次，把主要操作用一遍`);
    // 已经有验收点时直接用它们，不要退回到“登录/账号”这种和项目无关的模板。
    if (points.length > 0) {
      for (const point of points.slice(0, 3)) steps.push(`确认：${point}`);
    } else {
      steps.push('把主要流程完整走一遍：新增、查看、修改、删除这些关键操作');
    }
    steps.push('试异常和边界：空输入、错误格式、重复提交');
    steps.push(
      kind === 'web'
        ? '刷新页面、关掉再打开，确认数据还在；换窄窗口看布局'
        : '关掉再打开，确认数据/状态还在',
    );
    if (kind === 'electron') steps.push('打包后安装运行，检查文件读写、权限和窗口状态');
    if (kind === 'python') steps.push('在干净环境装一遍依赖，再用启动命令运行一次');
    return steps.slice(0, 6);
  }

  /** 开发完成后的调试计划：模型给具体项和 AI 调试时长，失败就本地兜底。 */
  async debugPlan(project, snapshot, entry) {
    const rows = snapshot.rows.map((row) => {
      const part = oneLine(row.item.intent || row.task?.title || '', 100);
      return `${row.name}${part ? `：${part}` : ''}`;
    });
    // 验收点就是最具体的调试项：别再让模型凭空想“登录、账号”这种项目里没有的流程。
    const points = snapshot.rows
      .flatMap((row) => (Array.isArray(row.item.verifyPoints) ? row.item.verifyPoints : []))
      .map((point) => oneLine(point, 120))
      .filter(Boolean);
    const facts = [
      `项目：${project.title}`,
      project.goal ? `目标：${clip(project.goal, 300)}` : '',
      `开发用时：${Math.round(snapshot.elapsedMs / 60000)} 分钟`,
      `完成情况：${snapshot.rows.length} 个员工，已通过 ${snapshot.accepted.length}，未验证 ${snapshot.unverified.length}`,
      rows.length ? `各自做的部分：${rows.join('；')}` : '',
      points.length ? `已经验收过的关键点：${points.slice(0, 6).join('；')}` : '',
      entry.root ? `工作空间：${entry.root}` : '',
      entry.command ? `启动命令：${entry.command}` : '',
      entry.entryPaths.length ? `入口文件：${entry.entryPaths.join('、')}` : '',
    ]
      .filter(Boolean)
      .join('\n');
    const reply = await this.ask({
      system: [
        '你是工作总监。项目开发已经完成，员工都交付了，现在要带领导进入调试。',
        '只根据事实列出 3 到 6 项具体要调试的内容，并按 AI 调试的实际速度估还要多久（分钟）。',
        '不要建议先发半成品，不要把开发工作再说一遍；入口不明确就写“按现有启动方式打开”。',
        '不要写事实里没有的流程（登录、账号、打包），这个项目没有就别提。',
        '只输出一行 JSON：{"minutes":15,"steps":["调试项"],"note":"一句提醒"}。不要写别的。',
      ].join('\n'),
      user: facts,
      maxTokens: 500,
      timeoutMs: DEBUG_PLAN_TIMEOUT_MS,
      retries: 0,
    }).catch(() => null);
    const data = reply ? this.parseJson(reply) : null;
    const steps = Array.isArray(data?.steps)
      ? data.steps
          .map((step) => oneLine(step, 160))
          .filter(Boolean)
          .slice(0, 6)
      : [];
    const rawMinutes = Math.round(Number(data?.minutes) || 0);
    const devMinutes = Math.max(1, Math.round(snapshot.estimateMs / 60000));
    const fallbackMinutes = Math.max(10, Math.min(60, Math.round(devMinutes * 0.5)));
    return {
      steps: steps.length > 0 ? steps : this.debugStepsFor(entry.kind, { entry, points }),
      minutes: Math.max(1, Math.min(24 * 60, rawMinutes || fallbackMinutes)),
      note: oneLine(data?.note, 200),
      fromModel: steps.length > 0 && rawMinutes > 0,
    };
  }

  /**
   * 开发完成、准备调试：主动告诉领导调试项、预计时间、项目入口。
   * 只有所有员工都交付完（没通过/等确认的不算“开发完成”）才发，而且只发一次。
   */
  async announceDebugReady(projectId) {
    const project = this.projects.get(idOf(projectId));
    if (!project || project.status !== 'active') return false;
    if (project.debugNotifiedAt || this.debugPending.has(project.id)) return false;
    const snapshot = this.projectSnapshot(project);
    if (snapshot.active.length > 0) return false;
    if (project.taskIds.some((id) => this.runs.has(id))) return false;
    // 有没通过/等你确认/放弃的，都不能说“开发完成”。
    if (snapshot.rows.some((row) => row.state !== 'accepted')) return false;
    if (snapshot.rows.length === 0) return false;
    // 重启后翻到很早以前就结束的项目，不再补一条“现在可以调试了”。
    const finishedAt = Math.max(
      ...snapshot.rows.map((row) => Number(row.item.finishedAt || row.item.createdAt) || 0),
    );
    if (finishedAt > 0 && Date.now() - finishedAt > 60 * 60 * 1000) {
      project.debugNotifiedAt = Date.now();
      this.scheduleSave('projects');
      return false;
    }

    this.debugPending.add(project.id);
    try {
      const entry = await this.projectEntryInfo(project);
      const plan = await this.debugPlan(project, snapshot, entry);
      const now = Date.now();
      project.debugNotifiedAt = now;
      project.updatedAt = now;
      project.lastReportAt = now;
      project.lastReport = `开发完成，准备调试（约 ${plan.minutes} 分钟）`;
      this.addProjectDecision(project.id, '开发完成，已提醒领导进入调试');
      this.scheduleSave('projects');

      const files = [];
      if (entry.workspaceId && entry.root) {
        files.push({
          workspaceId: entry.workspaceId,
          path: '.',
          name: `${project.title}（项目根目录）`,
          kind: 'directory',
          project: true,
        });
        for (const rel of entry.entryPaths.slice(0, 2)) {
          files.push({
            workspaceId: entry.workspaceId,
            path: rel,
            name: path.basename(rel),
            kind: 'file',
          });
        }
      }
      const lines = [
        `「${project.title}」开发已经完成，可以进入调试了。`,
        entry.root ? `- 项目入口：${entry.root}` : `- 项目入口：${entry.notes[0]}`,
        entry.command ? `- 启动：${entry.command}` : '',
        '- 建议这样调试：',
        ...plan.steps.map((step) => `  - ${step}`),
        `- 预计还要 ${plan.minutes} 分钟（按 AI 调试速度估的${
          plan.fromModel ? '' : '，粗估'
        }）。`,
        snapshot.unverified.length > 0
          ? `- 注意：其中 ${snapshot.unverified.length} 个员工是未验证收尾，调试时重点看。`
          : '',
        plan.note ? `- ${plan.note}` : '',
        '调试中发现的问题直接告诉我，我安排人修。',
      ].filter(Boolean);
      this.addInbox({
        kind: 'confirm',
        title: '开发完成，可以进入调试了',
        body: lines.join('\n'),
        taskId: project.kind === 'task' ? project.taskIds[0] : '',
        taskTitle: project.title,
        actions: [{ id: 'approve', label: '进入调试', style: 'primary' }],
        payload: {
          kind: 'project-debug',
          projectId: project.id,
          taskId: project.taskIds.find((id) => this.tasks.has(id)) || project.taskIds[0] || '',
        },
        files,
      });
      this.ledgerPush({
        kind: 'project:debug',
        taskId: project.kind === 'task' ? project.taskIds[0] : '',
        title: project.title,
        text: `开发完成，准备调试：${plan.steps.join('；')}；预计 ${plan.minutes} 分钟`,
      });
      return true;
    } finally {
      this.debugPending.delete(project.id);
    }
  }

  /** 把当前事实压成一小段，给模型判断“要不要现在开口”。 */
  projectFacts(snapshot, reason = '') {
    const { project, rows, active, accepted, unverified, failed, held, usage, elapsedMs, estimateMs } =
      snapshot;
    const minutes = (ms) => `${Math.max(0, Math.round(ms / 60000))} 分钟`;
    const overdue = estimateMs > 0 && elapsedMs >= estimateMs * PROJECT_OVERDUE_FACTOR;
    const estimate =
      estimateMs > 0
        ? `预计 ${minutes(estimateMs)}（${project.estimateNote || '按 AI 编程速度估的'}），已用 ${minutes(
            elapsedMs,
          )}${overdue ? `，已经明显超出预估 ${minutes(Math.max(0, elapsedMs - estimateMs))}` : ''}`
        : `还没估时，已用 ${minutes(elapsedMs)}`;
    const sinceReport =
      project.lastReportAt > 0 ? minutes(Math.max(0, snapshot.now - project.lastReportAt)) : '';
    return [
      `项目：${project.title}`,
      project.goal ? `目标：${clip(project.goal, 300)}` : '',
      reason ? `触发：${reason}` : '',
      estimate,
      `员工：${rows.length} 个；进行中 ${active.length}；已通过 ${accepted.length}；未验证 ${unverified.length}；没通过 ${failed.length}；等你确认 ${held.length}`,
      ...rows.map((row) => {
        const bits = [`- ${row.name}：${row.state}`];
        const part = oneLine(row.item.intent || row.task?.title || '', 100);
        if (part) bits.push(`负责：${part}`);
        if (row.health) {
          bits.push(`已跑 ${minutes(row.health.elapsedMs)}`);
          bits.push(`最近 ${row.idleMinutes} 分钟没有新事件`);
          if (row.health.outputChars === 0 && row.health.thinkingChars === 0) {
            bits.push('没有输出内容');
          }
          if (row.health.tool) bits.push(`最后一步：${row.health.tool}`);
        }
        if (row.result) bits.push(`结论：${oneLine(row.result, 140)}`);
        return bits.join(' · ');
      }),
      usage.requests > 0
        ? `本轮花费：${usage.outputTokens} tok${usage.cost > 0 ? ` · ¥${usage.cost.toFixed(4)}` : ''}`
        : '',
      project.lastReport
        ? `上次汇报${sinceReport ? `（${sinceReport}前）` : ''}：${project.lastReport}`
        : '',
      project.decisions.length
        ? `已经拍过的板：${project.decisions.slice(-3).map((entry) => entry.text).join('；')}`
        : '',
    ]
      .filter(Boolean)
      .join('\n');
  }

  /** 项目脉搏：有活干就定期看一次，由模型决定说不说、要不要介入。 */
  async pulseProject(projectId, { force = false, reason = '' } = {}) {
    const project = this.projects.get(idOf(projectId));
    if (!project || project.status !== 'active') return;
    const now = Date.now();
    const snapshot = this.projectSnapshot(project, now);
    if (snapshot.active.length === 0 && !snapshot.project.taskIds.some((id) => this.runs.has(id))) {
      this.finishProject(project.id);
      return;
    }
    // 每 6 分钟看一次；同一片里不重复问。
    const bucket = Math.floor(snapshot.elapsedMs / PROJECT_PULSE_MS);
    const fingerprint = [
      bucket,
      snapshot.active.length,
      snapshot.accepted.length,
      snapshot.unverified.length,
      snapshot.failed.length,
      snapshot.held.length,
      snapshot.rows.map((row) => `${row.name}:${row.state}:${row.idleMinutes}`).join(','),
    ].join('|');
    if (!force && now - (project.lastPulseAt || 0) < PROJECT_PULSE_MS) return;
    if (!force && project.lastFingerprint === fingerprint) return;
    project.lastPulseAt = now;
    project.lastFingerprint = fingerprint;
    project.updatedAt = now;
    this.scheduleSave('projects');

    const facts = this.projectFacts(snapshot, reason);
    const reply = await this.ask({
      system: [
        '你是工作总监，像真人领导一样看项目进度。程序已经把事实整理好了，你只负责判断现在要不要开口。',
        '你是在带项目的人，不是定时播报器。不要每次套同一句模板，不要复读“已用 X 分钟 / 超过预估 Y 分钟 / 后面还要开发”这一整段。',
        '先说这次真正的新情况：谁交付了、谁卡住了、你担心什么、你打算怎么办。没有新情况就 silence，哪怕已经超时；超时本身不是汇报理由。',
        '真要提超时，只说领导需要知道的后果和你的建议（拆分/叫停/继续等），不要把员工任务清单再抄一遍。一次一到三行，用你自己的话，先给结论。',
        '估时按 AI 编程的实际速度，不按人类工时。没有开发完时，只说清楚还有哪部分在做，不许提出“先发半成品”或“先发已完成部分”给领导。',
        '开发已经完成、准备进入调试，是必须主动开口的节点：说清有哪些调试、按 AI 调试速度大概还要多久，并把项目入口一起给领导。',
        '动作：silence（不说话）、report（汇报）、ask（问领导/要决定）、stop（叫停最慢的）、instruct（补指令）。',
        '只输出一行 JSON：{"action":"silence|report|ask|stop|instruct","message":"对领导说的话","taskId":"要处理的任务 id，可空","instruction":"action=instruct 时给工人的指令","criteria":"可选","reason":"判断依据"}。不要写别的。',
      ].join('\n'),
      user: facts,
      maxTokens: 400,
      timeoutMs: 20 * 1000,
    }).catch(() => null);
    const decision = reply ? this.parseJson(reply) : null;
    const action = ['silence', 'report', 'ask', 'stop', 'instruct'].includes(decision?.action)
      ? decision.action
      : 'silence';
    let message = withoutPartialOffer(decision?.message);
    // 还有员工在开发时，模型不能说“开发完成/可以调试”。
    if (
      snapshot.active.length > 0 &&
      /开发完成|已完成|做完了|进入调试|可以调试/.test(message)
    ) {
      message = '';
    }
    if (action === 'silence') return;

    if (action === 'report' || action === 'ask') {
      this.reportProject(project, {
        body:
          message ||
          `「${project.title}」还在推进，${snapshot.accepted.length}/${snapshot.rows.length} 个已完成${
            snapshot.active.length > 0
              ? `，${this.projectActiveParts(snapshot) || `${snapshot.active.length} 个员工`}还在做`
              : ''
          }。`,
        // 模型原本想“问”，但话被拦掉（比如又提半成品）时降级成普通汇报。
        ask: action === 'ask' && Boolean(message),
        force: Boolean(force),
      });
      return;
    }

    const target =
      snapshot.rows.find((row) => row.item.taskId === String(decision?.taskId ?? '')) ||
      // 没指定就挑跑得最久、又没有新事件的那个。
      [...snapshot.rows]
        .filter((row) => row.health)
        .sort((a, b) => b.health.quietMs - a.health.quietMs)[0];
    if (!target) return;
    const mode = this.getState().mode;
    if (mode === 'observe') {
      this.reportProject(project, {
        body: message || `「${target.name}」看起来偏慢，但我现在是观察级别，只能提醒。`,
        ask: false,
      });
      return;
    }
    if (mode === 'suggest') {
      this.addConfirm(target.item.taskId, {
        title: '项目偏慢，要不要我处理？',
        body:
          message ||
          `「${project.title}」里「${target.name}」偏慢；${target.idleMinutes} 分钟没有新事件。我建议${
            action === 'stop' ? '叫停重试' : '补一条更明确的指令'
          }。`,
        actions: [
          { id: 'approve', label: action === 'stop' ? '叫停重试' : '补指令', style: 'primary' },
          { id: 'dismiss', label: '再等等' },
        ],
        payload: {
          kind: 'stuck-action',
          taskId: target.item.taskId,
          action,
          instruction: clip(decision?.instruction ?? '', 1200),
          criteria: clip(decision?.criteria ?? '', 500),
          instructionId: target.item.id,
        },
      });
      return;
    }
    if (action === 'instruct' && String(decision?.instruction ?? '').trim()) {
      const queued = this.enqueue({
        taskId: target.item.taskId,
        text: String(decision.instruction),
        intent: '推进偏慢的项目',
        criteria: String(decision?.criteria ?? ''),
        source: 'director',
        approved: true,
      });
      if (queued.ok) {
        this.interruptTask(target.item.taskId);
        this.reportProject(project, {
          body: message || `「${target.name}」偏慢，我补了一条更明确的指令让它继续。`,
          ask: false,
        });
        return;
      }
    }
    if (this.interruptTask(target.item.taskId).ok) {
      this.reportProject(project, {
        body: message || `「${target.name}」偏慢，我先叫停这一轮，准备重派或重试。`,
        ask: false,
      });
    }
  }

  /**
   * 验证/审查类任务的硬预算：到点还没结论就停，别再无限搭测试环境。
   * 只对带 budgetMinutes 的指令生效；停止后由 accept() 把已有证据交回来。
   */
  enforceRunBudgets(now = Date.now()) {
    for (const instruction of this.instructions) {
      if (instruction.state !== 'delivered') continue;
      if (!instruction.budgetMinutes || instruction.budgetStoppedAt) continue;
      const run = this.runs.get(instruction.taskId);
      if (!run) continue;
      // 只对当前这一轮：指令必须是在这次 run 开始前后交付的。
      if (instruction.startedAt && instruction.startedAt > run.startedAt + 5000) continue;
      const elapsed = now - run.startedAt;
      const budgetMs = instruction.budgetMinutes * 60 * 1000;

      // 75%：先收口，不硬切。员工还在同一个会话里，能看到自己刚做过什么，
      // 用几分钟把手上这一版收干净再交，比直接叫停、留一个半成品强。
      const stalled = (run.stallCalls ?? 0) >= PROGRESS_STOP_CALLS;
      if (
        instruction.role !== 'verify' &&
        !instruction.isWrapUp &&
        !instruction.budgetWarnedAt &&
        (stalled || (elapsed >= budgetMs * WRAP_UP_AT && elapsed < budgetMs))
      ) {
        const wrapMinutes = stalled
          ? PROGRESS_WRAP_MINUTES
          : Math.max(
              3,
              Math.min(WRAP_UP_MAX_MINUTES, Math.round(instruction.budgetMinutes * 0.25)),
            );
        const wrap = this.enqueue({
          taskId: instruction.taskId,
          text: [
            stalled
              ? `已经连续 ${PROGRESS_STOP_CALLS} 步没有写入任何文件，也没有新进展。不要再查环境、不要再写探针，现在收口。`
              : `时间用掉 ${Math.round((elapsed / budgetMs) * 100)}% 了（预算 ${instruction.budgetMinutes} 分钟），现在收口。`,
            '不要再新开文件、加测试、扩大范围；只把手上这一版收干净：',
            '1) 把已经改的改完，能跑通的跑通；',
            '2) 按真实入口跑一次，写清启动命令和实际看到的输出；',
            '3) 用三行写清：做完了什么、没做完什么、哪一项没验证。',
            `最多 ${wrapMinutes} 分钟，做完就停。`,
          ].join('\n'),
          intent: instruction.intent || instruction.text,
          criteria: instruction.criteria,
          source: 'director',
          approved: true,
          budgetMinutes: wrapMinutes,
          originalBudgetMinutes:
            instruction.originalBudgetMinutes || instruction.budgetMinutes,
          userText: instruction.userText || '',
          role: 'build',
          round: instruction.round,
          isWrapUp: true,
          dispatch: instruction.dispatchId
            ? {
                dispatchId: instruction.dispatchId,
                dispatchTitle: instruction.dispatchTitle,
                employeeName: instruction.employeeName,
                dispatchSize: instruction.dispatchSize,
                agentId: instruction.agentId,
              }
            : null,
        });
        if (wrap.ok) {
          instruction.budgetWarnedAt = now;
          instruction.wrapUpInstructionId = wrap.instruction?.id || '';
          this.scheduleSave('instructions');
          this.ledgerPush({
            kind: stalled ? 'run:progress' : 'run:wrapup',
            taskId: instruction.taskId,
            title: instruction.taskTitle,
            text: stalled
              ? `连续 ${PROGRESS_STOP_CALLS} 步没有写入，换成收口指令`
              : `用到 ${Math.round((elapsed / budgetMs) * 100)}%，换成收口指令`,
          });
          // 收口指令排在队列里；先停当前这一轮，它才能接上。
          this.interruptTask(instruction.taskId);
        }
        continue;
      }

      if (elapsed < budgetMs) continue;
      if (!this.interruptTask(instruction.taskId).ok) continue;
      instruction.budgetStoppedAt = now;
      this.scheduleSave('instructions');
      this.ledgerPush({
        kind: 'run:budget',
        taskId: instruction.taskId,
        title: instruction.taskTitle,
        text: `超过 ${instruction.budgetMinutes} 分钟上限，已叫停`,
      });
    }
  }

  /** 阶段节点（第一个交付、有人没通过）立刻让总监看一眼，不等 5 分钟。 */
  pulseMilestone(instruction, reason = '') {
    const project = this.projectOfInstruction(instruction);
    if (!project || project.status !== 'active') return;
    void this.pulseProject(project.id, { force: true, reason }).catch(() => undefined);
  }

  /** 上次汇报之后状态有没有真的变化：只变时间、没有新进展，不该再播一遍。 */
  projectReportFingerprint(project) {
    const snapshot = this.projectSnapshot(project);
    return [
      snapshot.active.length,
      snapshot.accepted.length,
      snapshot.unverified.length,
      snapshot.failed.length,
      snapshot.held.length,
      snapshot.rows
        .map((row) => `${row.name}:${row.state}:${row.item.id}`)
        .sort()
        .join(','),
    ].join('|');
  }

  reportProject(project, { body = '', ask = false, force = false } = {}) {
    const now = Date.now();
    if (!force && now - (project.lastReportAt || 0) < PROJECT_REPORT_MIN_MS) return;
    const fingerprint = this.projectReportFingerprint(project);
    const unchanged = project.lastReportFingerprint === fingerprint;
    // 没有新进展就不复读。真的很久没说话，才允许隔 20 分钟提醒一次。
    if (
      !force &&
      unchanged &&
      now - (project.lastReportAt || 0) < PROJECT_UNCHANGED_REMIND_MS
    ) {
      return;
    }
    // 进度正文要能带多行清单，不能压成一行再截 400 字。
    const text = String(body ?? '')
      .replace(/\r/g, '')
      .trim()
      .slice(0, 1600);
    if (!text) return;
    project.lastReportAt = now;
    project.lastReportFingerprint = fingerprint;
    project.lastReport = oneLine(text, 300);
    project.updatedAt = now;
    this.scheduleSave('projects');
    this.addInbox({
      kind: ask ? 'confirm' : 'report',
      title: ask ? '项目进度：要你定一下' : '项目进度',
      body: text,
      taskId: project.kind === 'task' ? project.taskIds[0] : '',
      taskTitle: project.title,
      actions: ask
        ? [
            // 只让领导进来看看当前项目，不再提供“先发半成品”这个选项。
            { id: 'approve', label: '进入项目', style: 'primary' },
            { id: 'dismiss', label: '继续跑' },
          ]
        : [],
      payload: ask ? { kind: 'project-time', projectId: project.id } : null,
    });
  }

  /** 所有活项目过一遍脉搏；每 6 分钟看一次，但说不说、怎么说由模型判断。 */
  async pulseProjects() {
    if (!this.getState().enabled) return;
    const now = Date.now();
    for (const project of this.projects.values()) {
      if (project.status !== 'active') continue;
      const snapshot = this.projectSnapshot(project, now);
      if (snapshot.active.length === 0 && !project.taskIds.some((id) => this.runs.has(id))) {
        this.finishProject(project.id);
        continue;
      }
      // 不再按固定模板每分钟播报。有没有值得说的，交给 pulseProject 的模型判断；
      // reportProject 再用状态指纹挡住“没变化也复读”的情况。
      void this.pulseProject(project.id).catch(() => undefined);
    }
  }

  async tick() {
    if (this.stopped || this.ticking) return;
    const state = this.getState();
    if (!state.enabled) return;
    this.ticking = true;
    try {
      await this.runTick(state);
    } finally {
      this.ticking = false;
    }
  }

  async runTick(state) {
    const now = Date.now();
    this.enforceRunBudgets(now);
    this.expireSpawns();
    this.settleStaleHolds(now);
    // 到了事先说的编制/验收时间就主动看一次，不等用户来问。
    this.checkProjectCheckpoints(now);
    // 全部完工后做一次整体衔接检查；没有可查的就自动跳过。
    void this.maybeIntegrationCheck().catch(() => undefined);
    const slowSplit = this.maybeSplitSlowDispatch().catch(() => undefined);
    const pulse = this.pulseProjects().catch(() => undefined);

    // 每个还在跑的任务都看一遍“多久没有新事件”。这里不阻塞巡视，
    // 模型判断是后台的；模型不可用时由 judgeStuckRun 里的硬提醒兜住。
    for (const taskId of this.runs.keys()) {
      void this.judgeStuckRun(taskId).catch(() => undefined);
      this.handleToolLoop(taskId);
    }

    // 停住的提醒按「这一段没有动静」只发一次：key 带上 run.lastAt，工人只要
    // 有新动作就会换 key；同一段静止期不会每 30 分钟刷一遍。
    for (const [taskId, run] of this.runs) {
      if (!this.monitored(taskId)) continue;
      if (now - run.lastAt < STALL_MS) continue;
      const idleKey = `${taskId}:stall:${run.lastAt}`;
      const title = this.taskOf(taskId)?.title ?? '任务';
      const minutes = Math.round((now - run.lastAt) / 60000);
      // 这轮静止期已经由 judgeStuckRun 提醒过：不重复发。
      if (!run.stuckAlertedAt && !this.lastAlertAt.has(idleKey)) {
        this.lastAlertAt.set(idleKey, now);
        this.addInbox({
          kind: 'alert',
          title: '任务停住了',
          body: `「${title}」已经 ${minutes} 分钟没有新动静${
            run.tool ? `，最后一步是：${run.tool}` : ''
          }。可以去看看，或让我给工人发一条催办。`,
          taskId,
          taskTitle: this.taskOf(taskId)?.title,
          urgent: true,
        });
      }
      // 超过一小时还不动：不再反复提醒，把“继续等还是放弃”交回用户。
      if (
        now - run.lastAt >= STALL_GIVEUP_MS &&
        !this.lastAlertAt.has(`${idleKey}:giveup`)
      ) {
        this.lastAlertAt.set(`${idleKey}:giveup`, now);
        const pending = this.instructions.find(
          (item) =>
            item.taskId === taskId &&
            item.state === 'delivered' &&
            item.startedAt &&
            item.source !== 'user',
        );
        if (pending) {
          pending.state = 'escalated';
          pending.finishedAt = now;
          pending.unverified = true;
          pending.resultNote = `任务停住超过 ${Math.round(STALL_GIVEUP_MS / 60000)} 分钟，未收到结果`;
          this.addConfirm(taskId, {
            title: '任务停住太久，我不再等了',
            body: `「${title}」已经 ${minutes} 分钟没有动静，这条指令我收不回结果，也不再重复提醒。继续等还是放弃，由你决定。`,
            actions: [
              { id: 'rework', label: '再试一次', style: 'primary' },
              { id: 'abandon', label: '放弃', style: 'danger' },
            ],
            payload: { instructionId: pending.id },
            urgent: true,
          });
          this.scheduleSave('instructions');
        } else {
          this.addInbox({
            kind: 'alert',
            title: '任务停住太久',
            body: `「${title}」已经 ${minutes} 分钟没有动静。我不再重复提醒，需要你手动处理。`,
            taskId,
            taskTitle: title,
            urgent: true,
          });
        }
      }
    }

    // Renderer says busy, but no run exists and nothing moved: likely a crash
    // the stream never reported. One alert per stale period, not every cooldown.
    for (const [taskId, task] of this.tasks) {
      if (!task.busy || this.runs.has(taskId)) continue;
      if (!this.monitored(taskId)) continue;
      if (now - (task.updatedAt || 0) < STALL_MS) continue;
      const orphanKey = `${taskId}:orphan:${task.updatedAt || 0}`;
      if (this.lastAlertAt.has(orphanKey)) continue;
      this.lastAlertAt.set(orphanKey, now);
      this.addInbox({
        kind: 'alert',
        title: '任务状态对不上',
        body: `「${task.title}」显示在运行，但已经 ${Math.round(
          (now - task.updatedAt) / 60000,
        )} 分钟没有任何记录。可能是异常退出。`,
        taskId,
        taskTitle: task.title,
        urgent: true,
      });
    }

    // A delivery that never turned into a run (the page was closed between the
    // broadcast and the start) goes back to the queue instead of vanishing.
    let stalled = false;
    for (const instruction of this.instructions) {
      if (instruction.state !== 'delivered' || instruction.startedAt) continue;
      if (!instruction.deliveredAt || now - instruction.deliveredAt < 2 * 60 * 1000) continue;
      instruction.failures = (instruction.failures ?? 0) + 1;
      instruction.deliveredAt = 0;
      stalled = true;
      if (instruction.failures >= 3) {
        instruction.state = 'escalated';
        this.addConfirm(instruction.taskId, {
          title: '指令没能执行',
          body: `「${instruction.taskTitle}」的指令连续 ${instruction.failures} 次没有真正开始。`,
          actions: [
            { id: 'rework', label: '再试一次', style: 'primary' },
            { id: 'abandon', label: '放弃', style: 'danger' },
          ],
          payload: { instructionId: instruction.id },
          urgent: true,
        });
      } else {
        instruction.state = 'queued';
      }
    }
    if (stalled) {
      this.scheduleSave('instructions');
      this.drain();
    }

    // 任务已经不在了，它的提醒 key 也一起清掉，别让这张表无限长。
    for (const key of [...this.lastAlertAt.keys()]) {
      if (!this.tasks.has(key.split(':')[0])) this.lastAlertAt.delete(key);
    }

    this.inbox = this.inbox.filter((item) => now - item.at < INBOX_TTL).slice(-MAX_INBOX);
    this.drain();
    // 拆分/脉搏判断要调模型，放到最后等，不挡巡视本身。
    await Promise.all([slowSplit, pulse]);
  }

  /* ------------------------------------------------------------------ */
  /* ledger + inspect                                                   */
  /* ------------------------------------------------------------------ */

  ledgerView(limit = 100) {
    const size = Math.max(1, Math.min(500, Number(limit) || 100));
    return { items: [...this.ledger].reverse().slice(0, size).map(enrichLedgerEntry) };
  }

  async sessionMessages(taskId) {
    const session = new AgentSession({ dir: this.sessionDir, sessionId: taskId });
    return session.load();
  }

  /** 这个任务从 since 起的真实花费；没有用量账本时返回 null。 */
  taskUsage(taskId, since = 0) {
    try {
      const usage = this.usageFor(idOf(taskId), Math.max(0, Number(since) || 0));
      return usage && typeof usage === 'object' ? usage : null;
    } catch {
      return null;
    }
  }

  /** 运行时长（毫秒）：正在跑的按现在算，跑完的用上一轮。 */
  taskElapsed(task) {
    if (task?.runStartedAt) return Math.max(0, Date.now() - task.runStartedAt);
    return Math.max(0, Number(task?.lastDurationMs) || 0);
  }

  async sessionTail(taskId, { limit = 1200 } = {}) {
    try {
      const messages = await this.sessionMessages(taskId);
      // 只取这一轮最后一条有内容的答复。上一轮的答复留在会话里，
      // 拼进来会让交付卡和验收看到旧结果（新建 hello.txt 的任务里
      // 却写着“已删除 hello.txt”），还会把真正的新答复挤出截断窗口。
      const replies = messages
        .filter((message) => message.role === 'assistant' && String(message.content ?? '').trim())
        .slice(-1)
        .map((message) => String(message.content).trim());
      return clipTail(replies.join('\n\n'), limit);
    } catch {
      return '';
    }
  }

  /**
   * Full vision, on demand. Off spaces stay invisible: the director only sees
   * what the user marked readable, and a write grant implies reading.
   */
  async inspect(taskId, part = 'overview', options = {}) {
    const id = idOf(taskId);
    const task = this.taskOf(id);
    if (!task) return { ok: false, error: '找不到这个任务' };
    if (!this.monitored(id)) {
      return { ok: false, error: '这个工作空间没有对总监开放，无法查看' };
    }
    // 真实文件树：总监自己的 list_files 跑在总监虚拟空间里，看不到任务文件。
    if (part === 'tree') return this.inspectTree(task, options);
    let messages = [];
    try {
      messages = await this.sessionMessages(id);
    } catch {
      messages = [];
    }

    const calls = new Map();
    const tools = [];
    const files = new Set();
    const thinking = [];
    const conversation = [];
    for (const message of messages) {
      if (message.role === 'assistant') {
        if (String(message.content ?? '').trim()) {
          conversation.push({ role: 'assistant', content: clip(message.content, 1200) });
        }
        if (String(message.thinking ?? '').trim()) {
          thinking.push({ content: clip(message.thinking, 1200) });
        }
        for (const call of Array.isArray(message.toolCalls) ? message.toolCalls : []) {
          calls.set(call.id, { name: call.name, args: call.args, result: '', ok: null });
          const path =
            call?.args?.path ?? call?.args?.file ?? call?.args?.target ?? call?.args?.url;
          if (typeof path === 'string' && path.trim()) files.add(path.trim().slice(0, 300));
        }
      } else if (message.role === 'tool') {
        const entry = calls.get(message.toolCallId);
        if (entry) {
          entry.result = clip(message.content, 1600);
          entry.ok = true;
        }
      } else if (message.role === 'user') {
        conversation.push({ role: 'user', content: clip(message.content, 1200) });
      }
    }
    for (const [callId, entry] of calls) {
      tools.push({
        id: callId,
        name: entry.name,
        args: clip(JSON.stringify(entry.args ?? {}), 600),
        result: entry.result,
      });
    }

    // 会话日志会随任务删除一起消失。日志没了不等于没执行：把指令上留存的答复
    // 一并交出来，并明确告诉模型“日志不在了”，别让它把 0 条读成“什么都没做”。
    const sessionMissing = messages.length === 0;
    const recorded = [...this.instructions]
      .filter((item) => item.taskId === id && String(item.evidence ?? '').trim())
      .sort((a, b) => (b.finishedAt || 0) - (a.finishedAt || 0))[0];
    const evidence = recorded ? String(recorded.evidence) : '';

    const data = {
      task: {
        id,
        title: task.title,
        space: task.space,
        status: task.status,
        busy: task.busy,
        updatedAt: task.updatedAt,
        access: this.spaceAccess(id),
        elapsedMs: this.taskElapsed(task),
        usage: this.taskUsage(id, task.runStartedAt || task.lastRunStartedAt || 0),
      },
      counts: {
        messages: messages.length,
        assistant: conversation.filter((item) => item.role === 'assistant').length,
        tools: tools.length,
        files: files.size,
      },
      // 看“有没有在动”不能只看 busy：模型/网络挂住时 busy 仍然是 true。
      health: this.runHealth(id),
      sessionMissing,
      evidence,
      conversation: conversation.slice(-60),
      tools: tools.slice(-60),
      files: [...files].slice(0, 100),
      thinking: thinking.slice(-30),
    };
    if (part === 'overview' || part === 'summary') {
      data.text = this.formatInspection(data);
    }
    return { ok: true, data };
  }

  /**
   * 任务工作空间的真实文件树。总监自己的 list_files 跑在总监虚拟空间里，
   * 那里是空的，不能用它判断“任务空间不可访问”。
   */
  async inspectTree(task, { path: sub = '', depth = 2 } = {}) {
    const root = this.workspaceRootOf(task);
    if (!root) {
      return { ok: false, error: '这个任务没有本地工作空间路径（可能是远程空间），看不到文件树。' };
    }
    return this.listTree(root, sub, depth);
  }

  /**
   * 分管空间本身的文件树。清空空间之前必须先看这里：没有任务时也能知道
   * 根目录还剩什么（CLEANUP_REPORT.md、runtimes/ 这类残留都是这样漏掉的）。
   */
  async spaceTree(workspaceId, { path: sub = '', depth = 2 } = {}) {
    const id = idOf(workspaceId);
    if (!id) return { ok: false, error: '没有给出工作空间 id。' };
    if (director.accessFor(this.getState(), id) === 'off') {
      return { ok: false, error: '这个工作空间没有对总监开放。' };
    }
    const space = this.spaces.get(id) ?? null;
    const root = String(space?.path ?? '').trim();
    if (!root) {
      return { ok: false, error: '还没拿到这个空间的本地路径；界面同步一次（约 30 秒）后再试。' };
    }
    return this.listTree(root, sub, depth);
  }

  /** Shared directory walk: paths must stay inside `root`. */
  async listTree(root, sub = '', depth = 2) {
    const base = path.resolve(root);
    const target = path.resolve(base, String(sub || '.'));
    if (target !== base && !target.startsWith(base + path.sep)) {
      return { ok: false, error: '路径超出工作空间。' };
    }
    const levels = Math.max(1, Math.min(4, Number(depth) || 2));
    const skip = new Set(['node_modules', '.git']);
    const lines = [];
    let truncated = false;
    const walk = async (dir, prefix, level) => {
      if (level > levels || truncated) return;
      let entries = [];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch (error) {
        lines.push(`${prefix}（读不了：${oneLine(error?.message || error, 120)}）`);
        return;
      }
      entries.sort(
        (a, b) =>
          Number(b.isDirectory()) - Number(a.isDirectory()) ||
          String(a.name).localeCompare(String(b.name)),
      );
      for (const entry of entries) {
        if (lines.length >= 300) {
          truncated = true;
          return;
        }
        const child = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          lines.push(`${prefix}${entry.name}/`);
          if (!skip.has(entry.name)) await walk(child, `${prefix}  `, level + 1);
        } else {
          const size = await fs
            .stat(child)
            .then((info) => info.size)
            .catch(() => 0);
          lines.push(`${prefix}${entry.name} (${formatSize(size)})`);
        }
      }
    };
    let exists = true;
    try {
      await fs.stat(target);
    } catch {
      exists = false;
    }
    if (!exists) {
      return { ok: false, error: `这个路径不存在：${target}` };
    }
    await walk(target, '', 1);
    return {
      ok: true,
      data: {
        text: [
          target,
          lines.length > 0 ? lines.join('\n') : '（空目录）',
          truncated ? '…条目太多，只列了前 300 个' : '',
        ]
          .filter(Boolean)
          .join('\n'),
      },
    };
  }

  formatInspection(data) {
    const minutes = Math.round((data.task.elapsedMs || 0) / 60000);
    const usage = data.task.usage;
    const spend = usage
      ? ` · 本轮 ${usage.outputTokens || 0} tok${
          Number.isFinite(usage.cost) ? ` · ¥${(usage.cost || 0).toFixed(4)}` : ''
        }`
      : '';
    const lines = [
      `任务：${data.task.title}（${data.task.space || '未知空间'}）`,
      `状态：${data.task.status} · 消息 ${data.counts.messages} 条 · 工具 ${data.counts.tools} 次 · 文件 ${data.counts.files} 个${
        minutes > 0 ? ` · 已跑 ${minutes} 分钟` : ''
      }${spend}`,
    ];
    if (data.health) {
      const quiet = Math.max(0, Math.round(data.health.quietMs / 60000));
      const silent = Math.max(0, Math.round(data.health.silentMs / 60000));
      lines.push(
        `运行健康：${quiet} 分钟没有新事件 · ${silent} 分钟没有新内容 · 输出 ${data.health.outputChars} 字符 · 思考 ${data.health.thinkingChars} 字符${
          data.health.tool ? ` · 最后一步：${data.health.tool}` : ''
        }${data.health.stalled ? ' · 可能卡住了，不要当成正在干活' : ''}`,
      );
    }
    if (data.sessionMissing) {
      lines.push(
        '',
        data.evidence
          ? '注意：这个任务的会话日志已经不在了（通常随任务删除一起删掉），上面的 0 条记录不代表没执行。以下是这一轮留下的答复：'
          : '注意：这个任务的会话日志已经不在了（通常随任务删除一起删掉），查不到本轮记录，但不能据此断定它没做。',
      );
      if (data.evidence) lines.push(clip(data.evidence, 1500));
    }
    if (data.conversation.length) {
      lines.push('', '最近的对话：');
      for (const item of data.conversation.slice(-6)) {
        lines.push(`${item.role === 'user' ? '用户' : '工人'}：${oneLine(item.content, 300)}`);
      }
    }
    if (data.tools.length) {
      lines.push('', '最近的工具调用：');
      for (const item of data.tools.slice(-8)) {
        lines.push(`- ${item.name} ${oneLine(item.args, 140)}`);
      }
    }
    if (data.files.length) lines.push('', `涉及文件：${data.files.slice(0, 20).join('、')}`);
    return lines.join('\n');
  }

  /* ------------------------------------------------------------------ */
  /* memory                                                             */
  /* ------------------------------------------------------------------ */

  remember({ title, body, tags = [] }) {
    const clean = normalizeMemory({ title, body, tags });
    if (!clean) return { ok: false, error: '标题和内容都不能为空' };
    // 存档索引的标题不参与覆盖：否则用户一句“记住了”就可能盖掉一段历史。
    const existing = this.memory.find((entry) => !entry.archiveId && entry.title === clean.title);
    if (existing) {
      existing.body = clean.body;
      existing.tags = clean.tags;
      existing.updatedAt = Date.now();
    } else {
      this.memory.push(clean);
      if (this.memory.length > MAX_MEMORY) this.memory = this.memory.slice(-MAX_MEMORY);
    }
    this.scheduleSave('memory');
    this.ledgerPush({ kind: 'memory:save', title: clean.title, text: clean.body });
    return { ok: true, entry: existing ?? clean };
  }

  memoriesFor(query, limit = 6) {
    if (this.memory.length === 0) return [];
    const needle = tokens(query);
    const now = Date.now();
    return this.memory
      .map((entry) => {
        let score = 0;
        for (const token of tokens(`${entry.title} ${entry.body} ${entry.tags.join(' ')}`)) {
          if (needle.has(token)) score += 1;
        }
        // A week-old note is still useful; a year-old one needs to earn its place.
        const age = Math.max(0, now - entry.updatedAt) / (30 * 24 * 60 * 60 * 1000);
        return { entry, score: score + Math.max(0, 2 - age) };
      })
      .filter((item) => (needle.size === 0 ? true : item.score > 0))
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((item) => item.entry);
  }

  memorySearch(query, limit = 8) {
    const used = new Set(this.memoriesFor(query, limit).map((entry) => entry.id));
    const rest = [...this.memory].sort((a, b) => b.updatedAt - a.updatedAt);
    const items = [...this.memoriesFor(query, limit), ...rest.filter((entry) => !used.has(entry.id))].slice(
      0,
      limit,
    );
    return { items, total: this.memory.length };
  }

  /**
   * 清空对话时给每个存档建一条“粗记忆”。它只负责两件事：用关键词让
   * 下一轮能匹配到这段历史；带上 archiveId，让模型能用 director_recall
   * 把原始对话完整读回来。正文是摘要，不是记忆的全部。
   */
  rememberArchive({ archiveId, title, summary, from = 0, to = 0, count = 0 }) {
    const id = String(archiveId ?? '').trim();
    if (!id) return { ok: false, error: '缺少存档编号' };
    const cleanTitle = oneLine(title, 100) || '历史对话';
    const body = clip(String(summary ?? '').trim(), 1200);
    if (!body) return { ok: false, error: '摘要为空' };
    const existing = this.memory.find((entry) => entry.archiveId === id);
    if (existing) {
      existing.title = cleanTitle;
      existing.archiveTitle = cleanTitle;
      existing.body = body;
      existing.from = Number(from) || existing.from || 0;
      existing.to = Number(to) || existing.to || 0;
      existing.count = Number(count) || existing.count || 0;
      existing.updatedAt = Date.now();
      this.scheduleSave('memory');
      return { ok: true, entry: existing, updated: true };
    }
    const entry = normalizeMemory({
      title: cleanTitle,
      body,
      tags: ['存档'],
      archiveId: id,
      archiveTitle: cleanTitle,
      from,
      to,
      count,
    });
    if (!entry) return { ok: false, error: '摘要为空' };
    this.memory.push(entry);
    if (this.memory.length > MAX_MEMORY) this.memory = this.memory.slice(-MAX_MEMORY);
    this.scheduleSave('memory');
    return { ok: true, entry, updated: false };
  }

  /** 后台用模型改写摘要/名字时同步更新这条存档记忆。 */
  updateArchiveMemory(archiveId, { title, summary } = {}) {
    const entry = this.memory.find((item) => item.archiveId === String(archiveId ?? '').trim());
    if (!entry) return false;
    const cleanTitle = oneLine(title, 100);
    if (cleanTitle) {
      entry.title = cleanTitle;
      entry.archiveTitle = cleanTitle;
    }
    const body = clip(String(summary ?? '').trim(), 1200);
    if (body) entry.body = body;
    entry.updatedAt = Date.now();
    this.scheduleSave('memory');
    return true;
  }

  /** 用户在「对话历史」里删掉存档 = 删掉对应的记忆。 */
  forgetArchives(ids) {
    const wanted = new Set(
      (Array.isArray(ids) ? ids : []).map((id) => String(id ?? '').trim()).filter(Boolean),
    );
    if (wanted.size === 0) return 0;
    const before = this.memory.length;
    this.memory = this.memory.filter(
      (entry) => !(entry.archiveId && wanted.has(entry.archiveId)),
    );
    const removed = before - this.memory.length;
    if (removed > 0) this.scheduleSave('memory');
    return removed;
  }

  /**
   * 删存档时连它装着的总监事务一起删。按条目本身（时间+类型+任务+正文）
   * 精确匹配，不按时间范围，避免把相邻存档的事务误删。返回删掉的条数。
   */
  async forgetLedger(entries) {
    const list = Array.isArray(entries) ? entries : [];
    if (list.length === 0) return 0;
    const keyOf = (entry) =>
      `${Number(entry?.at) || 0}|${String(entry?.kind ?? '')}|${String(entry?.taskId ?? '')}|${String(
        entry?.text ?? '',
      )}`;
    const wanted = new Set(list.map(keyOf));
    const before = this.ledger.length;
    this.ledger = this.ledger.filter((entry) => !wanted.has(keyOf(entry)));
    const removed = before - this.ledger.length;
    if (removed > 0) await this.writeLedger().catch(() => undefined);
    return removed;
  }

  /** 去重删掉副本时，把记忆指到保留下来的那一份，别让它变成死链。 */
  remapArchives(pairs) {
    if (!(pairs instanceof Map) || pairs.size === 0) return 0;
    let changed = 0;
    const seen = new Set();
    const next = [];
    for (const entry of this.memory) {
      const target = entry.archiveId ? pairs.get(entry.archiveId) : null;
      if (target) {
        entry.archiveId = target;
        changed += 1;
      }
      if (!entry.archiveId) {
        next.push(entry);
        continue;
      }
      // 同一份存档只留一条记忆，避免去重后两份摘要并排出现。
      if (seen.has(entry.archiveId)) {
        changed += 1;
        continue;
      }
      seen.add(entry.archiveId);
      next.push(entry);
    }
    this.memory = next;
    if (changed > 0) this.scheduleSave('memory');
    return changed;
  }

  /**
   * 第二阶段：按 archiveId 把清空前的原始对话分段读回来。
   * offset 是字符位置，读完看 hasMore / nextOffset 继续。
   */
  async recallArchive(archiveId, { offset = 0, limit = 6000 } = {}) {
    const id = String(archiveId ?? '').trim();
    if (!/^[\w-]+$/.test(id)) return { ok: false, error: '存档编号不对' };
    let data;
    try {
      data = JSON.parse(
        await fs.readFile(path.join(this.dir, 'history', `${id}.json`), 'utf8'),
      );
    } catch {
      return { ok: false, error: '这条存档已经不在了（可能被你在对话历史里删掉了）' };
    }
    const messages = Array.isArray(data?.messages) ? data.messages : [];
    const lines = messages
      .filter((message) => message && (message.role || message.director))
      .map((message) => {
        const at = Number(message.createdAt) || 0;
        const stamp = at ? formatMemoryTime(at) : '';
        const who = message.director ? '总监·汇报' : message.role === 'user' ? '用户' : '总监';
        const title = message.director && message.director.title ? `【${message.director.title}】` : '';
        return `${stamp ? `${stamp} ` : ''}${who}：${title}${String(message.content ?? '')}`;
      });
    const full = lines.join('\n\n');
    const start = Math.max(0, Math.min(Number(offset) || 0, full.length));
    const max = Math.min(Math.max(Number(limit) || 6000, 800), 12000);
    let end = Math.min(full.length, start + max);
    if (end < full.length) {
      const cut = full.lastIndexOf('\n', end);
      if (cut > start) end = cut;
    }
    const text = full.slice(start, end);
    const header =
      `存档「${oneLine(data?.title, 120) || id}」：${messages.length} 条对话` +
      `，全文约 ${full.length} 字` +
      (start > 0 ? `，从第 ${start} 字开始` : '');
    return {
      ok: true,
      header,
      text,
      nextOffset: end,
      total: full.length,
      hasMore: end < full.length,
    };
  }

  /* ------------------------------------------------------------------ */
  /* model helpers                                                      */
  /* ------------------------------------------------------------------ */

  async ask({ system, user, maxTokens = 600, retries = 0, timeoutMs = ASK_TIMEOUT_MS }) {
    const tries = Math.max(0, Math.min(3, Number(retries) || 0));
    const waitMs = Math.max(5 * 1000, Math.min(ASK_TIMEOUT_MS, Number(timeoutMs) || ASK_TIMEOUT_MS));
    for (let attempt = 0; attempt <= tries; attempt += 1) {
      if (this.stopped) return null;
      if (!this.getState().enabled) return null;
      if (attempt > 0) {
        // 给限流/网络抖动一点恢复时间，再试一次。
        await new Promise((resolve) => setTimeout(resolve, 600 * attempt));
        if (this.stopped) return null;
      }
      // 并发满了不排队：巡视不能被一次验收堵住，交给下一次重试或用户。
      if (this.aiInFlight >= MAX_AI_IN_FLIGHT) {
        if (attempt < tries) continue;
        return null;
      }
      this.aiInFlight += 1;
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), waitMs);
      try {
        // 总监可以单独选模型（更强/更稳），没选就跟随全局默认。
        const provider = await this.getProvider(this.getState().chatModel || '');
        // 没有模型配置时重试也没用。
        if (!provider) return null;
        const result = await streamChat(
          provider,
          [
            { role: 'system', content: system },
            { role: 'user', content: user },
          ],
          { maxTokens, signal: controller.signal },
        );
        if (result?.usage) {
          this.onUsage?.({ feature: 'director', usage: result.usage, provider });
        }
        const text = clip(String(result?.text ?? '').trim(), 5000);
        if (text) return text;
      } catch {
        // 超时说明模型卡住了，再连着等两轮只会让按钮更久没反应。
        if (controller.signal.aborted) return null;
        // 落到下一轮重试；重试完仍失败就当模型不可用。
      } finally {
        clearTimeout(timer);
        this.aiInFlight -= 1;
      }
    }
    return null;
  }

  parseJson(text) {
    const value = String(text ?? '');
    const start = value.indexOf('{');
    const end = value.lastIndexOf('}');
    if (start === -1 || end <= start) return null;
    try {
      return JSON.parse(value.slice(start, end + 1));
    } catch {
      return null;
    }
  }
}

module.exports = {
  DirectorService,
  TICK_MS,
  STALL_MS,
  STALL_GIVEUP_MS,
  ASK_TIMEOUT_MS,
  REPORT_DEBOUNCE_MS,
  COOLDOWN_MS,
  TYPING_HOLD_MS,
  __test: {
    tokens,
    similarity,
    normalizeInboxItem,
    normalizeInstruction,
    normalizeMemory,
    enrichLedgerEntry,
    collectRunFiles,
    looksLikeModelProblem,
    looksDestructive,
    parseVerdict,
    planVerifyBudget,
    scopeFilesToDeclared,
    leftoverArtifacts,
    cleanupTargets,
    composeEmployeeText,
    markdownTail,
  },
};
