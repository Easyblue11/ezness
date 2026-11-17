/**
 * Probes the main-process web search without Electron.
 * Usage: node scripts/websearch-probe.js "问题 1" "问题 2"
 */
const { webSearch } = require('../electron/websearch');

(async () => {
  const queries = process.argv.slice(2);
  if (queries.length === 0) queries.push('今天的新闻');

  for (const query of queries) {
    const result = await webSearch(query);
    console.log(`\n=== ${query}`);
    console.log(
      JSON.stringify({ ok: result.ok, weak: result.weak, engines: result.engines, error: result.error }),
    );
    for (const [index, item] of (result.results ?? []).entries()) {
      console.log(`${index + 1}. ${item.title}\n   ${item.url}\n   ${item.snippet.slice(0, 80)}`);
    }
  }
})().catch((error) => {
  console.error(error);
  process.exit(1);
});
