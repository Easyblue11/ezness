/**
 * 总监对话的「按上下文存档」。
 *
 * 清空对话时不再把整段聊天存成一条，而是先按话题切段：相邻的用户消息如果
 * 和当前段落的中心向量差得太远，就认为换了一个不相关的话题，另起一条存档。
 *
 * 优先用知识库配置的向量模型（Ollama embedding）算余弦；没有配置、服务不可用
 * 或模型本身分不开中文话题时，退回本地的词频向量（中文二元组 + 英文单词）。
 * 两条路都不依赖总监自己的大模型，所以清空不会被模型额度或网络卡住。
 *
 * 切分只发生在用户消息上：助手回复、工具步骤和总监自己插进对话的汇报都跟随
 * 当前段落，不单独决定话题边界。
 */

const uiText = require('../ui-text');

const MIN_TOKENS = 4;
const MIN_TOKENS_LEXICAL = 12;
const LEXICAL_THRESHOLD = 0.12;
const EMBEDDING_THRESHOLD = 0.36;

// 高频虚词/客套话二元组，它们在所有话题里都会出现，容易把不相关的段落粘在一起。
const STOP_GRAMS = new Set([
  '我们', '你们', '他们', '她们', '这个', '那个', '这些', '那些', '一个', '一下',
  '可以', '就是', '不是', '没有', '什么', '怎么', '现在', '然后', '但是', '因为',
  '所以', '如果', '还是', '已经', '需要', '应该', '你好', '谢谢', '好的', '行吧',
  '的话', '时候', '东西', '事情', '问题', '帮我', '给我', '我要', '我想', '你看',
]);

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'you', 'with', 'this', 'that', 'have', 'from', 'are',
  'was', 'but', 'not', 'can', 'will', 'your', 'please', 'just',
]);

/** 中文二元组 + 英文单词；去掉高频虚词。 */
function tokens(text) {
  const value = String(text ?? '').toLowerCase();
  const latin = (value.match(/[a-z0-9_]{2,}/g) ?? []).filter((word) => !STOP_WORDS.has(word));
  const cjk = value.match(/[一-鿿]/g) ?? [];
  const grams = [];
  for (let i = 0; i < cjk.length - 1; i += 1) {
    const gram = cjk[i] + cjk[i + 1];
    if (!STOP_GRAMS.has(gram)) grams.push(gram);
  }
  if (cjk.length === 1) grams.push(cjk[0]);
  return [...latin, ...grams];
}

/** 单位词频向量。 */
function vectorize(text) {
  const vector = new Map();
  for (const token of tokens(text)) {
    vector.set(token, (vector.get(token) ?? 0) + 1);
  }
  let sum = 0;
  for (const count of vector.values()) sum += count * count;
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (const [token, count] of vector) vector.set(token, count / norm);
  }
  return vector;
}

function unit(values) {
  const vector = Float64Array.from(values);
  let sum = 0;
  for (let i = 0; i < vector.length; i += 1) sum += vector[i] * vector[i];
  const norm = Math.sqrt(sum);
  if (norm > 0) {
    for (let i = 0; i < vector.length; i += 1) vector[i] /= norm;
  }
  return vector;
}

function cloneVector(vector) {
  return vector instanceof Map ? new Map(vector) : Float64Array.from(vector);
}

function addVector(into, vector) {
  if (vector instanceof Map) {
    for (const [token, weight] of vector) {
      into.set(token, (into.get(token) ?? 0) + weight);
    }
    return;
  }
  for (let i = 0; i < vector.length; i += 1) into[i] += vector[i];
}

/** 单位向量和中心向量的余弦；中心向量未归一化，所以除以它的模。 */
function similarity(vector, centroid) {
  let dot = 0;
  if (vector instanceof Map) {
    for (const [token, weight] of vector) dot += weight * (centroid.get(token) ?? 0);
  } else {
    for (let i = 0; i < vector.length; i += 1) dot += vector[i] * centroid[i];
  }
  if (dot === 0) return 0;

  let norm = 0;
  if (centroid instanceof Map) {
    for (const weight of centroid.values()) norm += weight * weight;
  } else {
    for (let i = 0; i < centroid.length; i += 1) norm += centroid[i] * centroid[i];
  }
  return norm > 0 ? dot / Math.sqrt(norm) : 0;
}

function messageText(message) {
  return String(message?.content ?? '').trim();
}

/**
 * @param {Array<object>} messages
 * @param {{ vectors?: number[][], threshold?: number, minTokens?: number }} options
 *   vectors 与 messages 一一对应（已归一化或未归一化均可）；给了就走向量模型。
 * @returns {Array<Array<object>>} 按时间连续的上下文段落。
 */
function clusterMessages(messages, options = {}) {
  const list = Array.isArray(messages) ? messages : [];
  const vectors = Array.isArray(options.vectors) ? options.vectors : null;
  const byEmbedding = Boolean(vectors);
  const threshold =
    Number(options.threshold) > 0
      ? Number(options.threshold)
      : byEmbedding
        ? EMBEDDING_THRESHOLD
        : LEXICAL_THRESHOLD;
  const minTokens =
    Number(options.minTokens) > 0
      ? Number(options.minTokens)
      : byEmbedding
        ? MIN_TOKENS
        : MIN_TOKENS_LEXICAL;

  const groups = [];
  let current = null;
  let centroid = null;
  let hasUserTopic = false;

  for (let index = 0; index < list.length; index += 1) {
    const message = list[index];
    if (!message || (message.role !== 'user' && message.role !== 'assistant')) continue;
    const text = messageText(message);
    const embedded = byEmbedding ? vectors[index] : null;
    const vector =
      byEmbedding && Array.isArray(embedded) && embedded.length > 0
        ? unit(embedded)
        : byEmbedding
          ? new Float64Array(0)
          : vectorize(text);
    const substantive =
      message.role === 'user' && tokens(text).length >= minTokens;

    if (!current) {
      current = [message];
      centroid = cloneVector(vector);
      hasUserTopic = substantive;
      continue;
    }

    // 总监汇报是程序注入的，跟随当前话题；助手回复也从不单独切段。
    if (message.director || !substantive) {
      current.push(message);
      addVector(centroid, vector);
      continue;
    }

    // 这一段还没出现过像样的用户话题（比如开场只有问候/汇报），先并进去。
    if (!hasUserTopic) {
      current.push(message);
      addVector(centroid, vector);
      hasUserTopic = true;
      continue;
    }

    if (similarity(vector, centroid) < threshold) {
      groups.push(current);
      current = [message];
      centroid = cloneVector(vector);
      hasUserTopic = true;
    } else {
      current.push(message);
      addVector(centroid, vector);
    }
  }

  if (current) groups.push(current);
  return groups;
}

/**
 * 词频兜底的事件标题：把这段里像样的用户请求按顺序拼起来，说清大概做了哪些事。
 * （模型可用时，main.js 会让模型写一句更像人话的事件标题。）
 */
function titleForCluster(cluster) {
  const asks = (Array.isArray(cluster) ? cluster : [])
    .filter(
      (message) =>
        message?.role === 'user' &&
        !message.director &&
        tokens(messageText(message)).length >= MIN_TOKENS,
    )
    .map((message) => messageText(message).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const fallback = cluster?.find((message) => message?.role === 'user') ?? cluster?.[0];
  const source = asks.length > 0 ? asks : [messageText(fallback).replace(/\s+/g, ' ').trim()];
  if (!source[0]) return uiText.t('main.work.archive.defaultTitle');
  let title = source[0];
  for (const extra of source.slice(1)) {
    if (title.length >= 54) break;
    if (title.includes(extra)) continue;
    title += ` · ${extra}`;
  }
  return title.length <= 54 ? title : `${title.slice(0, 54)}…`;
}

/**
 * 存档的粗摘要：清空对话时写进总监记忆的那一段，只用来让下一轮能匹配、
 * 判断该不该翻原件。细节不在这里，靠 director_recall 按 archiveId 读回。
 */
function summaryForCluster(cluster) {
  const messages = Array.isArray(cluster) ? cluster : [];
  const asks = messages
    .filter((message) => message?.role === 'user' && !message.director)
    .map((message) => messageText(message).replace(/\s+/g, ' ').trim())
    .filter(Boolean);
  const replies = messages.filter(
    (message) => message?.role === 'assistant' && !message.director,
  );
  const last = replies[replies.length - 1];
  const parts = [];
  if (asks.length > 0) {
    const list = asks.slice(0, 6).map((ask) => (ask.length > 120 ? `${ask.slice(0, 120)}…` : ask));
    parts.push(
      uiText.t('main.work.archive.questions', {
        list: list.join(uiText.t('main.work.list.semicolon')),
      }),
    );
  }
  if (last) {
    const text = messageText(last).replace(/\s+/g, ' ').trim();
    if (text) {
      parts.push(
        uiText.t('main.work.archive.lastReply', {
          text: text.length > 240 ? `${text.slice(0, 240)}…` : text,
        }),
      );
    }
  }
  const summary = parts.join('\n');
  return summary.length > 720 ? `${summary.slice(0, 720)}…` : summary;
}

/**
 * 把原始 JSONL 按段落切开：显示消息和模型会话里的 user/assistant 内容对得上，
 * 就用第一条和最后一条的位置取中间的工具步骤。对不上（比如注入的汇报）就跳过。
 */
function sessionForCluster(session, cluster) {
  if (!Array.isArray(session) || session.length === 0) return [];
  let cursor = 0;
  let start = -1;
  let end = -1;
  for (const message of Array.isArray(cluster) ? cluster : []) {
    if (message?.director || (message?.role !== 'user' && message?.role !== 'assistant')) continue;
    const content = messageText(message);
    if (!content) continue;
    let found = -1;
    for (let i = cursor; i < session.length; i += 1) {
      if (
        session[i]?.role === message.role &&
        String(session[i]?.content ?? '').trim() === content
      ) {
        found = i;
        break;
      }
    }
    if (found < 0) continue;
    if (start < 0) start = found;
    end = found;
    cursor = found + 1;
  }
  return start < 0 ? [] : session.slice(start, end + 1);
}

/**
 * 一个存档 = 一个文件夹：对话本身 + 这段对话时间内总监的事务。
 * 时间范围是闭区间；相邻两段在边界毫秒可能重叠，调用方负责去重。
 */
function transactionsInRange(ledger, from, to) {
  if (!Array.isArray(ledger)) return [];
  const start = Number(from) || 0;
  const end = Number(to) || Number.MAX_SAFE_INTEGER;
  return ledger.filter((item) => {
    const at = Number(item?.at) || 0;
    return at >= start && at <= end;
  });
}

/** 账本条目的身份：删存档/去重时按它精确匹配。 */
function ledgerKey(entry) {
  return `${Number(entry?.at) || 0}|${String(entry?.kind ?? '')}|${String(
    entry?.taskId ?? '',
  )}|${String(entry?.text ?? '')}`;
}

/**
 * 删掉存档后，账本里哪些条目也该跟着消失？
 * 只清“删档最晚时间点之前、又没有任何存活存档认领”的条目：
 * 存活存档里已经有的（keepKeys）和落在存活存档时间段内的（keepRanges）都保留，
 * 晚于 cutoff 的当前事务也不动。老存档没有事务快照时，靠这条兜底。
 */
function orphanLedgerEntries(ledger, { cutoff = 0, keepKeys, keepRanges = [] } = {}) {
  if (!Array.isArray(ledger) || !(Number(cutoff) > 0)) return [];
  const end = Number(cutoff);
  const keep = keepKeys instanceof Set ? keepKeys : new Set();
  const ranges = (Array.isArray(keepRanges) ? keepRanges : []).filter(
    (range) => Array.isArray(range) && range.length === 2,
  );
  return ledger.filter((entry) => {
    const at = Number(entry?.at) || 0;
    if (!(at > 0) || at > end) return false;
    if (keep.has(ledgerKey(entry))) return false;
    if (ranges.some(([from, to]) => at >= Number(from) && at <= Number(to))) return false;
    return true;
  });
}

module.exports = {
  clusterMessages,
  titleForCluster,
  summaryForCluster,
  sessionForCluster,
  transactionsInRange,
  ledgerKey,
  orphanLedgerEntries,
  tokens,
  vectorize,
  MIN_TOKENS,
  LEXICAL_THRESHOLD,
  EMBEDDING_THRESHOLD,
};
