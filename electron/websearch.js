/**
 * Keyless web search for the web switch and the "知识库 + 联网" chat mode.
 *
 * There is no search API configured, so this reads public HTML result pages.
 * The endpoints are user-configurable ("设置 → 网络设置"): every enabled entry
 * is fetched in parallel, its results are checked against the query, and the
 * accepted sets are merged round-robin so no single site dominates the prompt.
 *
 * Every source is best-effort: markup can change and restricted networks can
 * block any of them. Bing also silently degrades long Chinese questions — it
 * drops most of the query and returns e.g. dream dictionaries for
 * "梦泪最近演唱会…" — so results are scored against the query and a poor match is
 * skipped. Callers treat { ok: false } as "no web supplement".
 */

const { appFetch } = require('./app-net');
const uiText = require('./ui-text');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

/** Mirrors src/data/web.ts; used when the renderer sends no entries. */
const DEFAULT_ENTRIES = [
  {
    id: 'bing',
    name: 'Bing',
    url: 'https://www.bing.com/search?q={query}&setlang=zh-Hans',
    parser: 'bing',
    enabled: true,
  },
  {
    id: 'so',
    name: '360 Search',
    url: 'https://www.so.com/s?q={query}',
    parser: 'so',
    enabled: true,
  },
  {
    id: 'baidu',
    name: 'Baidu',
    url: 'https://www.baidu.com/s?wd={query}',
    parser: 'baidu',
    enabled: true,
  },
  {
    id: 'shenma',
    name: 'Shenma',
    url: 'https://m.sm.cn/s?q={query}',
    parser: 'shenma',
    enabled: true,
  },
  {
    id: 'quark',
    name: 'Quark',
    url: 'https://quark.sm.cn/s?q={query}',
    parser: 'quark',
    enabled: false,
  },
  {
    id: 'duckduckgo',
    name: 'DuckDuckGo',
    url: 'https://lite.duckduckgo.com/lite/?q={query}',
    parser: 'duckduckgo',
    enabled: false,
  },
];

function decodeEntities(text) {
  return String(text)
    .replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCharCode(parseInt(code, 16)))
    .replace(/&#(\d+);/g, (_, code) => String.fromCharCode(Number(code)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&nbsp;/g, ' ')
    .replace(/&ensp;/g, ' ')
    .replace(/&emsp;/g, ' ')
    .replace(/&middot;/g, '·')
    .replace(/&hellip;/g, '…')
    .replace(/&mdash;/g, '—')
    .replace(/&ndash;/g, '–')
    .replace(/&rsquo;/g, '’')
    .replace(/&lsquo;/g, '‘')
    .replace(/&amp;/g, '&');
}

function stripTags(html) {
  // Comments first: Baidu embeds card JSON in <!--s-data:…--> and the markup
  // inside it would otherwise leak into the text.
  return decodeEntities(
    String(html)
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  )
    .replace(/\s+/g, ' ')
    .trim();
}

/** Visible text only: scripts and styles removed before stripping tags. */
function visibleText(html) {
  return stripTags(
    String(html)
      .replace(/<script\b[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style\b[\s\S]*?<\/style>/gi, ' '),
  );
}

/** Bing wraps outbound links in /ck/a?u=a1<base64url>. */
function decodeBingUrl(raw) {
  try {
    const parsed = new URL(raw, 'https://www.bing.com');
    if (!/(^|\.)bing\.com$/i.test(parsed.hostname) || !parsed.pathname.startsWith('/ck/a')) {
      return parsed.toString();
    }
    const wrapped = parsed.searchParams.get('u');
    if (wrapped && wrapped.startsWith('a1')) {
      const base64 = wrapped.slice(2).replace(/-/g, '+').replace(/_/g, '/');
      const padded = base64 + '='.repeat((4 - (base64.length % 4)) % 4);
      return Buffer.from(padded, 'base64').toString('utf8');
    }
  } catch {
    /* fall through to the raw value */
  }
  return raw;
}

/** DuckDuckGo Lite wraps outbound links in /l/?uddg=<encoded>. */
function decodeDuckUrl(raw) {
  const url = raw.startsWith('//') ? `https:${raw}` : raw;
  try {
    const parsed = new URL(url);
    return parsed.searchParams.get('uddg') || parsed.toString();
  } catch {
    return raw;
  }
}

/** Resolve a possibly relative href against the page the result came from. */
function resolveUrl(raw, pageUrl) {
  try {
    return new URL(decodeEntities(raw), pageUrl || undefined).toString();
  } catch {
    return raw;
  }
}

function keepHttp(item) {
  return item.title && /^https?:/i.test(item.url);
}

function parseBing(html, pageUrl) {
  const results = [];
  const blocks = html.split('class="b_algo"').slice(1);

  for (const block of blocks) {
    const anchor = block.match(/<h2[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i);
    if (!anchor) continue;
    const snippet = block.match(/<p[^>]*>([\s\S]*?)<\/p>/i);
    results.push({
      title: stripTags(anchor[2]),
      url: decodeBingUrl(resolveUrl(anchor[1], pageUrl)),
      snippet: snippet ? stripTags(snippet[1]).slice(0, 400) : '',
    });
    if (results.length >= 8) break;
  }

  return results.filter(keepHttp);
}

function parseDuckDuckGo(html, pageUrl) {
  const anchors = [...html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)].filter((match) =>
    /result-link/.test(match[1]),
  );
  const snippets = [...html.matchAll(/<td[^>]*result-snippet[^>]*>([\s\S]*?)<\/td>/gi)];

  return anchors
    .map((match, index) => {
      const href = match[1].match(/href=['"]([^'"]+)['"]/i);
      return {
        title: stripTags(match[2]),
        url: href ? decodeDuckUrl(resolveUrl(href[1], pageUrl)) : '',
        snippet: snippets[index] ? stripTags(snippets[index][1]).slice(0, 400) : '',
      };
    })
    .filter(keepHttp);
}

/** 360 wraps outbound links in /link?m=… but also marks the real URL. */
const OWN_VERTICALS = /^https?:\/\/(?:[\w-]+\.)*(?:so|360|360kan|360tres)\.com\//i;

function parseSo(html, pageUrl) {
  const results = [];

  for (const match of html.matchAll(/<li class="res-list[^"]*"[\s\S]*?<\/li>/g)) {
    const block = match[0];
    const heading = block.match(/<h3[^>]*>([\s\S]*?)<\/h3>/i);
    if (!heading) continue;
    const anchor = heading[1].match(/<a\b[^>]*>/i);
    if (!anchor) continue;

    const real = anchor[0].match(/data-mdurl="([^"]+)"/i);
    const wrapped = anchor[0].match(/href="([^"]+)"/i);
    const title = stripTags(heading[1]);

    // Not every card has .res-desc; fall back to the card's text minus title.
    const desc = block.match(/class="[^"]*res-desc[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/i);
    let snippet = desc ? stripTags(desc[1]) : '';
    if (!snippet) {
      const plain = stripTags(block);
      snippet = (plain.startsWith(title) ? plain.slice(title.length) : plain).trim();
    }
    snippet = snippet.replace(/\s*(?:反馈|举报|收藏)\s*$/g, '').slice(0, 400);

    results.push({
      title,
      url: resolveUrl(real?.[1] || wrapped?.[1] || '', pageUrl),
      snippet,
    });
    if (results.length >= 8) break;
  }

  // 360's own video/image verticals show up as result cards; not sources.
  return results.filter((item) => keepHttp(item) && !OWN_VERTICALS.test(item.url));
}

/**
 * Generic extractor for custom endpoints: heading links first (most result
 * pages structure titles this way), then any reasonably long anchor.
 */
function parseGeneric(html, pageUrl) {
  const results = [];

  const headings =
    /<h[1-4][^>]*>[\s\S]*?<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>[\s\S]*?<\/h[1-4]>([\s\S]{0,600})/gi;
  for (const match of html.matchAll(headings)) {
    const title = stripTags(match[2]);
    if (!title) continue;
    const para = match[3].match(/<(?:p|div|span)\b[^>]*>([\s\S]*?)<\/(?:p|div|span)>/i);
    results.push({
      title: title.slice(0, 200),
      url: resolveUrl(match[1], pageUrl),
      snippet: para ? stripTags(para[1]).slice(0, 400) : '',
    });
    if (results.length >= 10) break;
  }

  if (results.length === 0) {
    for (const match of html.matchAll(/<a\b[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
      const title = stripTags(match[2]);
      if (title.length < 6) continue;
      results.push({
        title: title.slice(0, 200),
        url: resolveUrl(match[1], pageUrl),
        snippet: '',
      });
      if (results.length >= 10) break;
    }
  }

  return results.filter(keepHttp);
}

/**
 * Baidu organic results: <div class="result c-container"> blocks with an
 * <h3> title anchor. `mu` carries the real URL for cards; otherwise the href
 * is a baidu.com redirect. Ads use a different class and are skipped by the
 * block regex itself (plus the tuiguang marker as a backstop).
 */
function parseBaidu(html, pageUrl) {
  const starts = [];
  const blockRe = /<div[^>]*class="result c-container[^"]*"/g;
  let match;
  while ((match = blockRe.exec(html))) starts.push(match.index);

  const results = [];
  for (let index = 0; index < starts.length; index += 1) {
    const block = html.slice(starts[index], starts[index + 1] ?? html.length);
    if (/data-tuiguang|ec_tuiguang/.test(block)) continue;

    const heading = /<h3[^>]*>[\s\S]*?<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/i.exec(block);
    if (!heading) continue;
    const title = visibleText(heading[2]);
    if (!title) continue;

    const mu = block.match(/\bmu="([^"]+)"/i);
    const url = resolveUrl(decodeEntities(mu?.[1] || heading[1]), pageUrl);
    if (!/^https?:/i.test(url)) continue;

    let snippet = visibleText(block);
    while (snippet.startsWith(title)) snippet = snippet.slice(title.length).trim();

    results.push({ title, url, snippet: snippet.slice(0, 400) });
    if (results.length >= 8) break;
  }

  return results;
}

/**
 * Mobile sm.cn pages (神马 / 夸克) render each result as several anchors that
 * share one URL: title, summary, source/date. Group by URL and use the first
 * substantial text as the title, the longest one as the summary. Search
 * suggestions and the engine's own links are filtered out.
 */
const MOBILE_OWN_HOSTS = /(?:^|\.)(?:sm\.cn|quark\.cn|uc\.cn|dailyact\.cn)$/i;

function parseMobileResults(html, pageUrl) {
  const groups = new Map();

  for (const match of html.matchAll(/<a\b([^>]*)>([\s\S]*?)<\/a>/gi)) {
    const href = match[1].match(/href=["']([^"']+)["']/i)?.[1];
    if (!href || /^javascript:/i.test(href) || /adclick/i.test(href)) continue;

    const url = resolveUrl(decodeEntities(href), pageUrl);
    if (!/^https?:/i.test(url)) continue;
    try {
      if (MOBILE_OWN_HOSTS.test(new URL(url).hostname)) continue;
    } catch {
      continue;
    }

    const text = visibleText(match[2]);
    if (!text || text === '广告') continue;

    const group = groups.get(url) ?? { url, texts: [] };
    group.texts.push(text);
    groups.set(url, group);
  }

  const results = [];
  for (const { url, texts } of groups.values()) {
    const unique = [...new Set(texts)];
    const snippet = unique.reduce((longest, text) => (text.length > longest.length ? text : longest), '');
    const title =
      unique.find((text) => text !== snippet && text.length >= 4 && text.length <= 160) ??
      unique.find((text) => text.length >= 4);
    if (!title) continue;
    if (/^(?:查看更多|滑动加载更多|不限时间|综合|视频|资讯|图片)$/.test(title)) continue;

    results.push({
      title: title.slice(0, 200),
      url,
      snippet: snippet === title ? '' : snippet.slice(0, 400),
    });
    if (results.length >= 8) break;
  }

  return results;
}

const PARSERS = {
  bing: parseBing,
  so: parseSo,
  baidu: parseBaidu,
  shenma: parseMobileResults,
  quark: parseMobileResults,
  duckduckgo: parseDuckDuckGo,
  html: parseGeneric,
};

/**
 * How much of the query the results actually mention, 0…1, and how much is
 * required to trust a result set. Chinese queries are compared as character
 * bigrams (two-char words stay intact, single chars are kept as-is); other
 * queries by word. Used to reject Bing's silent fallbacks.
 */
function relevance(results, query) {
  const text = results.map((item) => `${item.title} ${item.snippet}`).join(' ').toLowerCase();
  const compact = text.replace(/\s+/g, '');

  // Question words add tokens like "是谁" that results rarely repeat, which
  // would make a good result set look like a bad match. They do not narrow
  // the topic, so they are removed before tokenizing.
  const topic = query
    .toLowerCase()
    .replace(/(?:是谁|是什么|为什么|怎么样|怎么办|什么|怎么|如何|请问)/g, ' ');

  const cjkTokens = new Set();
  for (const run of topic.match(/[㐀-鿿]+/g) ?? []) {
    if (run.length === 1) cjkTokens.add(run);
    for (let i = 0; i < run.length - 1; i += 1) cjkTokens.add(run.slice(i, i + 2));
  }
  const wordTokens = new Set();
  for (const word of topic.split(/\s+/)) {
    const clean = word.replace(/[^\p{L}\p{N}]/gu, '');
    if (clean.length >= 2 && !/^[㐀-鿿]+$/.test(clean)) wordTokens.add(clean);
  }

  const tokens = new Set([...cjkTokens, ...wordTokens]);
  if (tokens.size === 0) return { score: 1, minimum: 0 };

  let hits = 0;
  for (const token of tokens) {
    if (/[㐀-鿿]/.test(token) ? compact.includes(token) : text.includes(token)) hits += 1;
  }
  const score = hits / tokens.size;

  // Bigram sets scatter over a long question, so one solid match ("梦泪") is
  // already meaningful; word sets (mostly English) need most words to count.
  // When a query has only a few tokens, one hit out of three is too little —
  // e.g. a generic "OpenAI" page for "OpenAI GPT-5 发布" — so short queries must
  // cover at least two tokens (capped at 0.5).
  const minimum =
    tokens.size === 1
      ? 1
      : cjkTokens.size > 0
        ? Math.min(0.5, Math.max(0.2, 1.5 / tokens.size))
        : 0.5;
  return { score, minimum };
}

async function fetchHtml(url) {
  const response = await appFetch(url, {
    headers: {
      'user-agent': UA,
      accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
    },
    redirect: 'follow',
    signal: AbortSignal.timeout(9000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

function entryName(entry) {
  return String(entry.name || entry.id || uiText.t('main.web.entryFallback'));
}

/** Error lines are joined the way the current language punctuates a list. */
function joinErrors(errors) {
  return errors.join(uiText.getLanguage() === 'en' ? '; ' : '；');
}

function entryUsable(entry) {
  return (
    entry &&
    typeof entry.url === 'string' &&
    /^https?:\/\//i.test(entry.url.trim()) &&
    /\{query\}/i.test(entry.url)
  );
}

function expandUrl(template, query) {
  return String(template).replace(/\{query\}/gi, encodeURIComponent(query));
}

/** Dedupe key: host + path + query, ignoring hash, www. and scheme. */
function normalizeUrl(raw) {
  try {
    const url = new URL(raw);
    const host = url.hostname.replace(/^www\./i, '').toLowerCase();
    const pathname = url.pathname.replace(/\/+$/, '');
    return `${host}${pathname}${url.search}`;
  } catch {
    return String(raw);
  }
}

/**
 * Search sites answer a burst of keyless requests with a captcha page instead of
 * results. Parsing that yields nothing, which looks identical to "query too
 * weird" — so name it explicitly and let the entry fail like any other error.
 */
function looksBlocked(html) {
  const head = String(html).slice(0, 20000);
  // Match on the page identity (captcha URLs and <title>) rather than loose
  // wording, so a result snippet that merely says "安全验证" is not mistaken for
  // a block and dropped along with a perfectly good result set.
  const title = (head.match(/<title[^>]*>([\s\S]{0,120}?)<\/title>/i) || [])[1] || '';
  if (/wappass\.baidu\.com\/static\/captcha|antispider|verify\.html|cf-browser-verification/i.test(head))
    return true;
  return /安全验证|人机验证|验证码|Just a moment|Attention Required|Access Denied/i.test(title);
}

async function searchEntry(entry, query, perEntry) {
  const url = expandUrl(entry.url, query);
  const html = await fetchHtml(url);
  if (looksBlocked(html)) throw new Error(uiText.t('main.web.blocked'));
  const parse = PARSERS[entry.parser] ?? parseGeneric;
  const results = parse(html, url).slice(0, perEntry);
  const { score, minimum } = results.length > 0 ? relevance(results, query) : { score: 0, minimum: 1 };
  return { entry, results, score, minimum };
}

/**
 * Search engines match keywords, not chat. "梦泪最近发生啥了" makes them return
 * years-old clips or dream dictionaries; the actual news is titled with an
 * event name ("共创之夜") the user did not type. Strip the conversational tail
 * and add a recency marker so the query looks like "梦泪 最新".
 * Returns the original query untouched when the shape is not recognised.
 */
function cleanChatterTail(tail) {
  let value = String(tail || '');
  const patterns = [
    /(?:发生|出)(?:了)?(?:什么|啥)(?:事|情况)?(?:了|啦)?/g,
    /(?:有)?(?:什么|啥)(?:新鲜事|新动态|动静|事|情况)?(?:了|啦)?/g,
    /(?:咋|怎么)(?:了|回事|样)?/g,
    /(?:什么|啥)情况/g,
    /(?:近况)?(?:如何|怎么样|怎样)/g,
    /[?？!！。，,、\s]+/g,
    /(?:了|啦|呢|吗|呀|啊)/g,
  ];
  for (const pattern of patterns) value = value.replace(pattern, ' ');
  return value.replace(/^的+/, '').replace(/\s+/g, ' ').trim();
}

function rewriteQuery(rawQuery) {
  const original = String(rawQuery || '').trim();
  if (!original) return original;

  const recency = original.match(/^(.{2,}?)(?:最近|近期|近况|这两天|这几天|近来|刚刚|刚才)(.*)$/);
  let subject = '';
  if (recency) {
    subject = recency[1] + cleanChatterTail(recency[2]);
  } else {
    const bare = original.match(
      /^(.{2,}?)(?:咋了|怎么了|发生什么了|发生啥了|出什么事了|什么情况|近况如何)$/,
    );
    if (bare) subject = bare[1];
  }

  subject = subject.replace(/[\s?？!！。，,、]+$/, '').replace(/的$/, '').trim();
  if (subject.length < 2) return original;

  // Already asking for news — do not stack "最新" twice.
  if (/(最新|新闻|热点|热搜|动态|消息)/.test(subject)) return subject;
  return `${subject} 最新`;
}

async function webSearch(rawQuery, options = {}) {
  const query = String(rawQuery || '').trim();
  if (!query) return { ok: true, results: [] };

  // Engines see the keyword form; everything the model gets uses it too.
  const searchQuery = rewriteQuery(query);

  const limit = options.limit ?? 8;
  const perEntry = options.perEntry ?? 6;
  const requested =
    Array.isArray(options.entries) && options.entries.length > 0 ? options.entries : DEFAULT_ENTRIES;
  const enabled = requested.filter((entry) => entry && entry.enabled !== false);
  if (enabled.length === 0) {
    return { ok: false, error: uiText.t('main.web.noEntries') };
  }

  const errors = [];
  const usable = [];
  for (const entry of enabled) {
    if (entryUsable(entry)) usable.push(entry);
    else errors.push(uiText.t('main.web.badEntryUrl', { name: entryName(entry) }));
  }
  if (usable.length === 0) {
    return { ok: false, error: joinErrors(errors) };
  }

  // All enabled entries are asked at once; one slow or blocked site must not
  // hold up the rest.
  const settled = await Promise.allSettled(
    usable.map((entry) => searchEntry(entry, searchQuery, perEntry)),
  );

  const accepted = [];
  let weak = null;

  settled.forEach((outcome, index) => {
    const name = entryName(usable[index]);
    if (outcome.status === 'rejected') {
      errors.push(`${name}: ${outcome.reason?.message || String(outcome.reason)}`);
      return;
    }

    const { entry, results, score, minimum } = outcome.value;
    if (process.env.EZNESS_WEB_DEBUG) {
      const asked = searchQuery === query ? `q="${query}"` : `q="${searchQuery}" (原问："${query}")`;
      console.log(
        `[websearch] ${name} ${asked} -> ${results.length} score=${score.toFixed(2)} need=${minimum}`,
        results.map((item) => item.title).join(' | '),
      );
    }

    if (results.length === 0) {
      errors.push(uiText.t('main.web.noResults', { name }));
      return;
    }
    if (score >= minimum) {
      accepted.push({ entry, results, score });
      return;
    }

    // Keep the closest match in case no entry does well.
    if (!weak || score > weak.score) weak = { entry, results, score };
    errors.push(uiText.t('main.web.mismatch', { name }));
  });

  // Better-matching entries come first, then results interleave so every
  // source contributes before any source repeats.
  accepted.sort((a, b) => b.score - a.score);

  const merged = [];
  const seenUrl = new Set();
  const seenTitle = new Set();
  const counts = new Map();

  const depth = accepted.reduce((max, group) => Math.max(max, group.results.length), 0);
  for (let index = 0; index < depth && merged.length < limit; index += 1) {
    for (const group of accepted) {
      if (merged.length >= limit) break;
      const item = group.results[index];
      if (!item) continue;

      const urlKey = normalizeUrl(item.url);
      const titleKey = item.title.toLowerCase().replace(/\s+/g, '');
      if ((urlKey && seenUrl.has(urlKey)) || seenTitle.has(titleKey)) continue;

      seenUrl.add(urlKey);
      seenTitle.add(titleKey);
      merged.push(item);
      counts.set(group.entry, (counts.get(group.entry) ?? 0) + 1);
    }
  }

  if (merged.length > 0) {
    return {
      ok: true,
      results: merged,
      engines: accepted.map((group) => ({
        id: group.entry.id,
        name: entryName(group.entry),
        count: counts.get(group.entry) ?? 0,
      })),
      errors,
      weak: false,
    };
  }

  if (weak && weak.score > 0) {
    const results = weak.results.slice(0, limit);
    return {
      ok: true,
      results,
      engines: [{ id: weak.entry.id, name: entryName(weak.entry), count: results.length }],
      errors,
      weak: true,
    };
  }

  return { ok: false, error: joinErrors(errors) || uiText.t('main.web.unavailable') };
}

module.exports = { webSearch, DEFAULT_ENTRIES };
