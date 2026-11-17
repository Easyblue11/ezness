/**
 * Fetches candidate search result pages and reports whether they look usable
 * (blocked / captcha / JS-only / real HTML). Usage:
 *   node scripts/probe-candidates.js "问题"
 */
const fs = require('node:fs');
const path = require('node:path');

const UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36';

const CANDIDATES = [
  { id: 'baidu', name: '百度', url: 'https://www.baidu.com/s?wd={query}' },
  { id: 'sogou', name: '搜狗', url: 'https://www.sogou.com/web?query={query}' },
  { id: 'shenma', name: '神马', url: 'https://m.sm.cn/s?q={query}' },
  { id: 'quark', name: '夸克', url: 'https://quark.sm.cn/s?q={query}' },
  { id: 'toutiao', name: '头条搜索', url: 'https://so.toutiao.com/search?keyword={query}' },
  { id: 'chinaso', name: '中国搜索', url: 'https://www.chinaso.com/newssearch.html?q={query}' },
  { id: 'yahoo', name: 'Yahoo', url: 'https://search.yahoo.com/search?p={query}' },
  { id: 'mojeek', name: 'Mojeek', url: 'https://www.mojeek.com/search?q={query}' },
  { id: 'brave', name: 'Brave', url: 'https://search.brave.com/search?q={query}' },
  { id: 'startpage', name: 'Startpage', url: 'https://www.startpage.com/sp/search?query={query}' },
];

async function probe(candidate, query) {
  const url = candidate.url.replace('{query}', encodeURIComponent(query));
  const started = Date.now();
  try {
    const response = await fetch(url, {
      headers: {
        'user-agent': UA,
        accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
        'accept-language': 'zh-CN,zh;q=0.9,en;q=0.8',
      },
      redirect: 'follow',
      signal: AbortSignal.timeout(12000),
    });
    const html = await response.text();
    const title = html.match(/<title[^>]*>([\s\S]*?)<\/title>/i)?.[1]?.trim().slice(0, 80);
    const flags = [
      /安全验证/.test(html) && '安全验证',
      /验证码|captcha/i.test(html) && '验证码',
      /enable javascript|需要开启\s*javascript|请开启\s*javascript/i.test(html) && '需要 JS',
      /<h3\b/i.test(html) && '有 h3',
      /class="[^"]*(result|res-list|b_algo)/i.test(html) && '有结果标记',
    ].filter(Boolean);

    const out = path.join(process.env.TEMP || '.', `ezness-probe-${candidate.id}.html`);
    fs.writeFileSync(out, html);

    return {
      id: candidate.id,
      status: response.status,
      finalUrl: response.url,
      bytes: html.length,
      ms: Date.now() - started,
      title,
      flags,
      saved: out,
    };
  } catch (error) {
    return { id: candidate.id, error: error?.message || String(error), ms: Date.now() - started };
  }
}

(async () => {
  const query = process.argv[2] || '上海今天天气';
  const rows = await Promise.all(CANDIDATES.map((candidate) => probe(candidate, query)));
  for (const row of rows) console.log(JSON.stringify(row));
})();
