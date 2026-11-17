const { webSearch } = require('../electron/websearch');

(async () => {
  for (const query of ['Electron 45 release notes', '上海天气']) {
    const started = Date.now();
    const result = await webSearch(query);
    console.log(query, `${Date.now() - started}ms`, result.ok, result.engine ?? '', result.error ?? '');
    for (const item of result.results ?? []) {
      console.log('  -', item.title.slice(0, 60), '|', item.url.slice(0, 90));
      console.log('    ', item.snippet.slice(0, 100));
    }
  }
})();
