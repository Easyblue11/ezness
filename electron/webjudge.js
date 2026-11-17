/**
 * 自动联网: decide whether this turn needs a live web search.
 *
 * One fresh model call with no app system prompt and no tools, given only the
 * last few turns so pronouns like「那它呢」can be rewritten into a standalone
 * query. Obvious greetings and acknowledgements skip the call entirely.
 *
 * Failure policy: if the model answers with something unparseable, times out,
 * or the endpoint errors, the turn searches anyway. A broken judge must never
 * silently turn the user's 联网 setting off.
 */

const { streamChat } = require('./chat');

const JUDGE_TIMEOUT_MS = 10000;
/** Enough for {"search":true,"query":"…"}; reasoning models are not capped by this. */
const JUDGE_MAX_TOKENS = 120;
const RECENT_LIMIT = 6;
const RECENT_CHARS = 600;

const JUDGE_SYSTEM = [
  '你是 Ezness 的联网判定器。判断回答用户「最后一条消息」之前，是否需要先检索网页。',
  '',
  '需要联网（search=true）：',
  '- 实时或易变的事实：新闻、价格、天气、股价、汇率、赛程、航班、政策变化；',
  '- 最新版本、发布、文档、公告、活动；',
  '- 用户明确要求「查一下 / 搜一下 / 给我链接 / 最新消息」；',
  '- 你不确定的具体事实：人物、公司、地点、事件、日期、数字。',
  '',
  '不需要联网（search=false）：',
  '- 寒暄、感谢、闲聊、情绪支持；',
  '- 写作、翻译、润色、改写、总结、分类；',
  '- 解释通用概念与原理，编程语法、算法、代码调试；',
  '- 数学计算，或基于用户已经给出的材料、上文内容作答；',
  '- 创意续写、头脑风暴。',
  '',
  '拿不准时选择 search=false，不要为了保险而联网。',
  '',
  '如果发生联网，把检索词改写成脱离上下文也能搜的完整问题；用上文补全代词和指代，保留关键名称、版本号和限定词。检索词不超过 40 个字，不要加引号。',
  '',
  '只输出一个 JSON 对象，不要输出其他内容：',
  '{"search": true 或 false, "query": "检索词；search=false 时为空字符串"}',
].join('\n');

const NO_SEARCH_PATTERNS = [
  /^\s*$/,
  // Greetings, thanks, acknowledgements and short continuations.
  /^(你好|您好|hi|hello|hey|嗨|哈喽|在吗|在不在|早上好|下午好|晚上好|晚安|谢谢|谢谢你|多谢|感谢|thanks|thank you|thx|好的|好|嗯|哦|噢|ok|okay|收到|明白了|知道了|行|可以|没问题|继续|接着|接着说|继续说|然后呢|展开说说|详细说说|说下去|写下去|继续写)[\s!！。.~～?？,，、…]*$/i,
  /^[\p{Emoji_Presentation}\s]+$/u,
];

function shouldSkipSearch(text) {
  const value = String(text ?? '').trim();
  if (!value) return true;
  return NO_SEARCH_PATTERNS.some((pattern) => pattern.test(value));
}

/** Pull the first JSON object out of an answer; fenced code is fine. */
function parseDecision(text) {
  const raw = String(text ?? '');
  const start = raw.indexOf('{');
  const end = raw.lastIndexOf('}');
  if (start === -1 || end <= start) return null;
  try {
    const parsed = JSON.parse(raw.slice(start, end + 1));
    if (typeof parsed?.search !== 'boolean') return null;
    return {
      search: parsed.search,
      query: String(parsed.query ?? '').trim().slice(0, 200),
    };
  } catch {
    return null;
  }
}

/**
 * Resolve to { search, query, source, usage?, fallback? }.
 * Throws only when the request itself fails; callers decide the fallback.
 */
async function judgeWebSearch({ provider, text, recent = [], signal }) {
  const value = String(text ?? '').trim();
  if (shouldSkipSearch(value)) {
    return { search: false, query: '', source: 'rule' };
  }

  const timeout = AbortSignal.timeout(JUDGE_TIMEOUT_MS);
  const merged = signal ? AbortSignal.any([signal, timeout]) : timeout;

  const history = [];
  for (const turn of (Array.isArray(recent) ? recent : []).slice(-RECENT_LIMIT)) {
    const role = turn?.role === 'assistant' ? 'assistant' : turn?.role === 'user' ? 'user' : null;
    const content = String(turn?.content ?? '').replace(/\s+/g, ' ').trim().slice(0, RECENT_CHARS);
    if (role && content) history.push({ role, content });
  }

  const { text: answer, usage } = await streamChat(
    provider,
    [
      { role: 'system', content: JUDGE_SYSTEM },
      ...history,
      // The judge only needs the question, not a whole pasted document; the
      // answer model still receives the full text later.
      { role: 'user', content: value.slice(0, 4000) },
    ],
    { signal: merged, onDelta: () => {}, maxTokens: JUDGE_MAX_TOKENS },
  );

  const decision = parseDecision(answer);
  return {
    // An unparseable answer is treated as "search": the cost of a redundant
    // search is lower than silently answering with stale facts.
    search: decision ? decision.search : true,
    query: decision?.query || value,
    source: 'model',
    usage,
    ...(decision ? {} : { fallback: true }),
  };
}

module.exports = { judgeWebSearch, shouldSkipSearch, parseDecision, JUDGE_SYSTEM, JUDGE_TIMEOUT_MS };
