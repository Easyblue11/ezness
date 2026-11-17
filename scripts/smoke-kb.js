/**
 * End-to-end smoke test for the knowledge base backend.
 * Run with Electron's bundled Node (which has node:sqlite):
 *   ELECTRON_RUN_AS_NODE=1 electron scripts/smoke-kb.js
 */

const fs = require('node:fs');
const path = require('node:path');

const { KbEngine } = require('../electron/kb/engine');

const ROOT = path.join(__dirname, '..', '.tmp-kb-test', 'kb');
const SAMPLES = path.join(__dirname, '..', '.tmp-kb-test', 'samples');

/** Minimal one-page PDF with a Helvetica text run — enough for text extraction. */
function writePdf(filePath, lines) {
  const content = [
    'BT',
    '/F1 14 Tf',
    '72 720 Td',
    '16 TL',
    ...lines.map((line) => `(${line.replace(/([()\\])/g, '\\$1')}) '`),
    'ET',
  ].join('\n');

  const objects = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>',
    `<< /Length ${Buffer.byteLength(content)} >>\nstream\n${content}\nendstream`,
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
  ];

  let pdf = '%PDF-1.4\n';
  const offsets = [];
  objects.forEach((body, index) => {
    offsets.push(Buffer.byteLength(pdf));
    pdf += `${index + 1} 0 obj\n${body}\nendobj\n`;
  });

  const xref = Buffer.byteLength(pdf);
  pdf += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const offset of offsets) pdf += `${String(offset).padStart(10, '0')} 00000 n \n`;
  pdf += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;

  fs.writeFileSync(filePath, pdf, 'latin1');
}

async function writeXlsx(filePath) {
  const ExcelJS = require('exceljs');
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet('价格表');
  sheet.addRow(['套餐', '月费', '说明']);
  sheet.addRow(['基础版', '99', '适合个人用户，包含 10GB 存储']);
  sheet.addRow(['专业版', '299', '支持团队协作与无限存储']);
  await workbook.xlsx.writeFile(filePath);
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  fs.rmSync(path.join(__dirname, '..', '.tmp-kb-test'), { recursive: true, force: true });
  fs.mkdirSync(SAMPLES, { recursive: true });

  const txt = path.join(SAMPLES, '退款政策.txt');
  fs.writeFileSync(
    txt,
    [
      '第一章 退款政策',
      '',
      '用户在购买后七天内可以申请全额退款，超过七天则按月折算。',
      '退款申请需要提供订单号与付款凭证，客服会在三个工作日内处理。',
      '',
      '第二章 发票',
      '',
      '电子发票在付款后自动开具，可以在账户中心下载。',
    ].join('\n'),
    'utf8',
  );

  const xlsx = path.join(SAMPLES, '价格表.xlsx');
  await writeXlsx(xlsx);

  const pdf = path.join(SAMPLES, 'manual.pdf');
  writePdf(pdf, ['Ezness Manual', 'The storage limit for the basic plan is 10 GB.', 'Upgrade to unlock unlimited storage.']);

  const engine = new KbEngine();
  engine.setEmitter((event) => {
    if (event.type === 'ingest') {
      console.log(`  [${event.stage}] ${event.name ?? ''} ${event.message ?? ''} ${event.progress ?? ''}`);
    }
  });

  engine.configure({
    storageRoot: ROOT,
    embedding: {
      baseUrl: 'http://localhost:11434',
      model: 'xagi/qwen3-embedding:0.6b-q4_k_m-1024',
      apiKey: '',
    },
  });

  console.log('storage:', ROOT);
  console.log('enqueue:', engine.enqueue([txt, xlsx, pdf]));

  const deadline = Date.now() + 180000;
  while ((engine.working || engine.queue.length > 0) && Date.now() < deadline) await sleep(250);
  if (engine.working || engine.queue.length > 0) throw new Error('ingest timed out');

  const snapshot = engine.snapshot();
  console.log('\ndocuments:');
  for (const doc of snapshot.documents) {
    console.log(`  ${doc.status.padEnd(8)} ${doc.name}  chunks=${doc.chunkCount} ${doc.error ?? ''}`);
  }
  console.log('stats:', snapshot.stats);

  for (const query of ['退款怎么申请', '基础版多少钱', 'storage limit']) {
    const result = await engine.search(query, { topK: 3 });
    console.log(`\nquery: ${query}  (${result.mode}, ${result.took}ms)${result.note ? ` note=${result.note}` : ''}`);
    for (const hit of result.results) {
      console.log(`  ${hit.score}  ${hit.docName}${hit.section ? ` / ${hit.section}` : ''}${hit.page ? ` p${hit.page}` : ''}`);
      console.log(`      ${hit.text.replace(/\s+/g, ' ').slice(0, 90)}`);
    }
  }

  // Category round trip: move one doc to a new category, then remove the category.
  const category = engine.createCategory('测试分类');
  const first = snapshot.documents[0];
  engine.moveDocument(first.id, category.id);
  console.log('\nmoved', first.name, '->', category.id);

  const filtered = await engine.search('退款', { categoryId: category.id, topK: 3 });
  console.log('category-scoped hits:', filtered.results.map((hit) => hit.docName));

  engine.deleteCategory(category.id);
  console.log('categories after delete:', engine.snapshot().categories.map((c) => c.name));

  engine.deleteDocument(first.id);
  console.log('stats after delete:', engine.snapshot().stats);

  // Migration: move the whole library, confirm it still searches and deletes.
  const moved = path.join(__dirname, '..', '.tmp-kb-test', 'kb-moved');
  const movedSnapshot = await engine.migrate(moved);
  console.log('\nmigrated to:', moved);
  console.log('  stats:', movedSnapshot.stats);
  console.log('  files copied:', fs.readdirSync(path.join(moved, 'files')).length);
  console.log('  old db removed:', !fs.existsSync(path.join(ROOT, 'kb.sqlite')));
  console.log('  config root:', engine.config.storageRoot === moved);

  const afterMove = await engine.search('退款怎么申请', { topK: 2 });
  console.log('  search after move:', afterMove.results.map((hit) => hit.docName));

  const survivor = engine.snapshot().documents[0];
  engine.deleteDocument(survivor.id);
  console.log('  delete after move ok, stats:', engine.snapshot().stats);

  engine.store?.close();
  console.log('\nOK');
}

main().catch((error) => {
  console.error('\nFAILED:', error);
  process.exitCode = 1;
});
