/**
 * External language packs.
 *
 * A pack is one JSON file in `<dataRoot>/locales`. It contains a `_meta` block
 * and flat, string-valued keys:
 *
 *   {
 *     "_meta": { "code": "fr-FR", "name": "French", "nativeName": "Français" },
 *     "rail.chat": "Discussion"
 *   }
 *
 * Files are data, never code: they are only parsed as JSON and handed to the
 * renderer. Anything malformed is reported per file and skipped, so one bad
 * pack cannot break the language picker. A pack whose `code` matches a built-in
 * language overrides the built-in strings one key at a time; missing keys fall
 * back to Chinese.
 */
const fsp = require('node:fs/promises');
const path = require('node:path');

const LOCALES_DIR = 'locales';
const MAX_PACK_BYTES = 2 * 1024 * 1024;
/** zh-CN, pt-BR, zh-Hant-HK — no path characters, no whitespace. */
const CODE_RE = /^[A-Za-z]{2,3}(?:[-_][A-Za-z0-9]{1,8})*$/;

function localeDir(root) {
  return path.join(root, LOCALES_DIR);
}

function normalizeCode(value) {
  const raw = typeof value === 'string' ? value.trim() : '';
  if (!CODE_RE.test(raw)) return '';
  return raw.replace(/_/g, '-');
}

/** Only `_meta` may be non-string; every other entry becomes a message. */
function splitPack(raw) {
  const messages = {};
  let keyCount = 0;
  for (const [key, value] of Object.entries(raw)) {
    if (key === '_meta' || typeof value !== 'string') continue;
    messages[key] = value;
    keyCount += 1;
  }
  return { messages, keyCount };
}

function metaOf(raw) {
  const source = raw && typeof raw._meta === 'object' && !Array.isArray(raw._meta) ? raw._meta : {};
  const code = normalizeCode(source.code);
  if (!code) throw new Error('_meta.code is missing or not a language code');
  const name = typeof source.name === 'string' && source.name.trim() ? source.name.trim() : code;
  const nativeName =
    typeof source.nativeName === 'string' && source.nativeName.trim()
      ? source.nativeName.trim()
      : name;
  return { code, name, nativeName, dir: source.dir === 'rtl' ? 'rtl' : 'ltr' };
}

async function readPack(file) {
  const stat = await fsp.stat(file);
  if (!stat.isFile()) throw new Error('not a file');
  if (stat.size > MAX_PACK_BYTES) throw new Error('file is larger than 2 MB');

  let raw;
  try {
    raw = JSON.parse(await fsp.readFile(file, 'utf8'));
  } catch (error) {
    throw new Error(`invalid JSON (${error.message})`);
  }
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    throw new Error('the root of the file must be a JSON object');
  }

  const meta = metaOf(raw);
  const { messages, keyCount } = splitPack(raw);
  if (keyCount === 0) throw new Error('no string entries were found');
  return { meta, messages, keyCount };
}

function isPackName(name) {
  // `_` is the reserved prefix for examples/templates that should not load.
  return (
    !name.startsWith('_') &&
    !name.startsWith('.') &&
    path.extname(name).toLowerCase() === '.json'
  );
}

/** List usable packs and, separately, files that failed to load. */
async function list(root) {
  const dir = localeDir(root);
  const result = { dir, packs: [], errors: [] };

  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return result;
  }

  const seen = new Map();
  for (const entry of entries) {
    if (!entry.isFile() || !isPackName(entry.name)) continue;
    try {
      const pack = await readPack(path.join(dir, entry.name));
      const duplicate = seen.get(pack.meta.code.toLowerCase());
      if (duplicate) {
        result.errors.push({
          file: entry.name,
          error: `language code ${pack.meta.code} is already used by ${duplicate}`,
        });
        continue;
      }
      seen.set(pack.meta.code.toLowerCase(), entry.name);
      result.packs.push({
        file: entry.name,
        code: pack.meta.code,
        name: pack.meta.name,
        nativeName: pack.meta.nativeName,
        dir: pack.meta.dir,
        keyCount: pack.keyCount,
      });
    } catch (error) {
      result.errors.push({ file: entry.name, error: error?.message || String(error) });
    }
  }

  result.packs.sort((a, b) => a.file.localeCompare(b.file));
  return result;
}

/** Read one pack by file name. Returns null when it is missing or invalid. */
async function read(root, file) {
  const name = typeof file === 'string' ? path.basename(file) : '';
  if (!name || name !== file || !isPackName(name)) return null;
  try {
    const pack = await readPack(path.join(localeDir(root), name));
    return { meta: pack.meta, messages: pack.messages };
  } catch {
    return null;
  }
}

const README = `# Ezness 语言包 / Language packs

这里放语言包。每个语言一个 \`.json\` 文件，改完回到
「设置 → 系统设置 → 界面语言」点「刷新语言包」，不用重启。

Each language is one \`.json\` file. After editing, return to
**Settings → System → Interface language** and click **Refresh packs**; no restart needed.

## 怎么开始 / Getting started

1. 复制 \`_example.zh-CN.json\`，改成你的语言代码，例如 \`fr-FR.json\`。
2. 改 \`_meta\`：\`code\` 必须是语言代码（\`fr-FR\`、\`ja-JP\`、\`pt-BR\`）；
   \`name\` 是英文名，\`nativeName\` 是这门语言自己的写法。
3. 翻译右侧的值，**不要改左边的键名**。
4. 保存，回到设置点「刷新语言包」，然后在下拉框里选它。

1. Copy \`_example.zh-CN.json\` and rename it to your language code, e.g. \`fr-FR.json\`.
2. Edit \`_meta\`: \`code\` must be a language code (\`fr-FR\`, \`ja-JP\`, \`pt-BR\`);
   \`name\` is the English name and \`nativeName\` is the name in that language.
3. Translate the values on the right. **Do not rename the keys on the left.**
4. Save, click **Refresh packs** in Settings, then pick it in the dropdown.

## 规则 / Rules

- 文件必须以 \`.json\` 结尾。以 \`_\` 或 \`.\` 开头的文件会被忽略，适合放模板。
- 键名是程序使用的稳定标识，例如 \`rail.chat\`、\`system.language.label\`。
- 只需要翻译你关心的键；没翻译的键会自动回退到中文。
- 值里的 \`{name}\` 是占位符，必须原样保留，例如 \`{count} 次\`。
- 需要区分单复数时，可以写 \`key.one\` 和 \`key.other\`（按键出现的 \`count\` 选择）。
- 文件最大 2 MB；根节点必须是 JSON 对象。
- 如果 \`code\` 和内置语言相同（例如 \`en-US\`），你的同名键会覆盖内置文案。

- Files must end in \`.json\`. Files starting with \`_\` or \`.\` are ignored, for templates.
- Keys are stable identifiers such as \`rail.chat\`; keep them unchanged.
- Translate only the keys you care about; missing keys fall back to Chinese.
- Placeholders such as \`{name}\` or \`{count}\` must be kept exactly as written.
- For plural forms, add \`key.one\` and \`key.other\`; they are chosen by the \`count\` variable.
- Files are limited to 2 MB and the root must be a JSON object.
- If \`code\` matches a built-in language (e.g. \`en-US\`), your keys override the built-in text.

## 注意 / Notes

英文界面目前是逐页覆盖的，没有翻译的页面会显示中文。欢迎把自己完成的语言包
分享到项目 Issue，让更多人直接用。

The English UI is being translated page by page, so untranslated pages still show
Chinese. Finished packs are welcome in the project's Issues for others to use.
`;

async function ensureFolder(root, example) {
  const dir = localeDir(root);
  await fsp.mkdir(dir, { recursive: true });

  const readme = path.join(dir, 'README.md');
  try {
    await fsp.access(readme);
  } catch {
    await fsp.writeFile(readme, README, 'utf8');
  }

  // `_example` starts with `_`, so the scanner never loads it as a real pack.
  const sample = path.join(dir, '_example.zh-CN.json');
  try {
    await fsp.access(sample);
  } catch {
    const body = example && typeof example === 'object' ? example : {};
    await fsp.writeFile(sample, JSON.stringify(body, null, 2) + '\n', 'utf8');
  }

  return dir;
}

async function openFolder(root, example, openPath) {
  const dir = await ensureFolder(root, example);
  const error = await openPath(dir);
  return error ? { ok: false, dir, error } : { ok: true, dir };
}

module.exports = {
  LOCALES_DIR,
  localeDir,
  list,
  read,
  ensureFolder,
  openFolder,
};
