'use strict';

/**
 * The file-tree API for remote workspaces. Same request/response shapes as the
 * local handlers in main.js, so WorkspaceFiles renders either kind unchanged.
 */

const posix = require('node:path').posix;
const uiText = require('../ui-text');

const TREE_LIMIT = 500;
const TEXT_PREVIEW_LIMIT = 2 * 1024 * 1024;
const IMAGE_PREVIEW_LIMIT = 12 * 1024 * 1024;
const IMAGE_MIME = {
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  bmp: 'image/bmp',
  ico: 'image/x-icon',
  avif: 'image/avif',
  svg: 'image/svg+xml',
};

function formatBytes(bytes) {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}

function describe(error) {
  const code = error?.code ?? '';
  if (code === 'ENOENT') return uiText.t('main.remote.error.pathMissing');
  if (code === 'EISDIR') return uiText.t('main.remote.error.isFolder');
  if (code === 'path_escape') return error.message;
  return error?.message ? String(error.message) : uiText.t('main.remote.error.failed');
}

/** POSIX is stricter than Windows here; the name must stay one segment. */
function validateName(value) {
  const name = typeof value === 'string' ? value.trim() : '';
  if (!name) return { error: uiText.t('main.remote.error.nameEmpty') };
  if (name === '.' || name === '..') return { error: uiText.t('main.remote.error.nameReserved') };
  if (/[/\u0000-\u001F]/.test(name)) {
    return { error: uiText.t('main.remote.error.nameInvalidChars') };
  }
  if (name.length > 255) return { error: uiText.t('main.remote.error.nameTooLong') };
  return { name };
}

function relOf(fs, target) {
  return fs.display(target);
}

async function tree(fs, request = {}) {
  const dir = posix.normalize(String(request.dir ?? '').replace(/^\/+|\/+$/g, '')) || '.';
  const target = await fs.resolve(dir === '.' ? '.' : dir);
  const list = await fs.readdir(target);
  const base = relOf(fs, target) === '.' ? '' : relOf(fs, target);
  const entries = [];
  let truncated = false;
  for (const entry of list) {
    if (entries.length >= TREE_LIMIT) {
      truncated = true;
      break;
    }
    entries.push({
      name: entry.name,
      path: base && base !== '.' ? `${base}/${entry.name}` : entry.name,
      isDir: entry.isDir,
    });
  }
  entries.sort(
    (a, b) =>
      Number(b.isDir) - Number(a.isDir) ||
      a.name.localeCompare(b.name, 'zh-Hans-CN', { numeric: true, sensitivity: 'base' }),
  );
  return { ok: true, root: fs.root, dir: base === '.' ? '' : base, entries, truncated };
}

async function readFile(fs, request = {}) {
  const target = await fs.resolve(request.path ?? '');
  const stat = await fs.stat(target);
  if (stat.isDirectory) return { ok: false, error: uiText.t('main.remote.error.previewFolder') };

  const name = posix.basename(target);
  const relativePath = relOf(fs, target);
  const ext = posix.extname(target).slice(1).toLowerCase();
  const mime = IMAGE_MIME[ext];
  if (mime) {
    if (stat.size > IMAGE_PREVIEW_LIMIT) {
      return {
        ok: false,
        error: uiText.t('main.remote.error.imageTooLarge', { size: formatBytes(stat.size) }),
      };
    }
    const data = await fs.readBuffer(target);
    return {
      ok: true,
      kind: 'image',
      name,
      path: relativePath,
      size: stat.size,
      mtime: stat.mtimeMs,
      mime,
      dataUrl: `data:${mime};base64,${data.toString('base64')}`,
    };
  }

  const buffer = await fs.readBuffer(target, { maxBytes: TEXT_PREVIEW_LIMIT });

  if (buffer.subarray(0, Math.min(buffer.length, 8192)).includes(0)) {
    return { ok: true, kind: 'binary', name, path: relativePath, size: stat.size, mtime: stat.mtimeMs };
  }

  return {
    ok: true,
    kind: 'text',
    name,
    path: relativePath,
    size: stat.size,
    mtime: stat.mtimeMs,
    content: buffer.toString('utf8').replace(/^﻿/, ''),
    truncated: stat.size > TEXT_PREVIEW_LIMIT,
  };
}

async function createFolder(fs, request = {}) {
  const checked = validateName(request.name);
  if (checked.error) return { ok: false, error: checked.error };
  const parent = await fs.resolve(request.parent ?? '');
  const stat = await fs.stat(parent);
  if (!stat.isDirectory) return { ok: false, error: uiText.t('main.remote.error.createInFolder') };
  const target = fs.join(parent, checked.name);
  if (await fs.exists(target)) return { ok: false, error: uiText.t('main.remote.error.nameExists') };
  await fs.mkdir(target, { recursive: false });
  return { ok: true, path: relOf(fs, target) };
}

async function move(fs, request = {}) {
  const fromRequest = String(request.from ?? '').trim();
  if (!fromRequest) return { ok: false, error: uiText.t('main.remote.error.nothingToMove') };
  const from = await fs.resolve(fromRequest);
  if (from === fs.root) return { ok: false, error: uiText.t('main.remote.error.moveRoot') };

  const toDir = await fs.resolve(request.toDir ?? '');
  const dirStat = await fs.stat(toDir);
  if (!dirStat.isDirectory) return { ok: false, error: uiText.t('main.remote.error.moveToFolder') };
  if (posix.dirname(from) === toDir) return { ok: true, path: relOf(fs, from) };

  const fromStat = await fs.stat(from);
  if (fromStat.isDirectory) {
    const relativeToSource = posix.relative(from, toDir);
    if (
      relativeToSource === '' ||
      (!relativeToSource.startsWith('..') && !posix.isAbsolute(relativeToSource))
    ) {
      return { ok: false, error: uiText.t('main.remote.error.moveIntoSelf') };
    }
  }

  const target = fs.join(toDir, posix.basename(from));
  if (target === from) return { ok: true, path: relOf(fs, from) };
  if (await fs.exists(target)) return { ok: false, error: uiText.t('main.remote.error.targetExists') };
  await fs.rename(from, target);
  return { ok: true, path: relOf(fs, target) };
}

async function rename(fs, request = {}) {
  const from = await fs.resolve(request.path ?? '');
  if (from === fs.root) return { ok: false, error: uiText.t('main.remote.error.renameRoot') };
  const checked = validateName(request.name);
  if (checked.error) return { ok: false, error: checked.error };

  const parent = posix.dirname(from);
  const target = fs.join(parent, checked.name);
  if (target === from) return { ok: true, path: relOf(fs, from) };
  if (await fs.exists(target)) return { ok: false, error: uiText.t('main.remote.error.nameExists') };
  await fs.rename(from, target);
  return { ok: true, path: relOf(fs, target) };
}

async function remove(fs, request = {}) {
  const target = await fs.resolve(request.path ?? '');
  if (target === fs.root) return { ok: false, error: uiText.t('main.remote.error.deleteRoot') };
  await fs.stat(target);
  await fs.remove(target, { recursive: true });
  return { ok: true };
}

async function properties(fs, request = {}) {
  const target = await fs.resolve(request.path ?? '');
  const stat = await fs.stat(target);
  return {
    ok: true,
    name: posix.basename(target) || fs.root,
    path: relOf(fs, target),
    absolutePath: target,
    kind: stat.isDirectory ? 'folder' : 'file',
    size: stat.isDirectory ? undefined : stat.size,
    mtime: stat.mtimeMs,
    ctime: stat.ctimeMs,
    birthtime: stat.birthtimeMs,
  };
}

module.exports = {
  tree,
  readFile,
  createFolder,
  move,
  rename,
  remove,
  properties,
  describe,
};
