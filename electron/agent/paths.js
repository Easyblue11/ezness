/**
 * Path confinement for agent tools.
 *
 * Every path an agent touches is resolved against the workspace root, and the
 * real (symlink-free) location must still sit inside it. Without the realpath
 * step a symlink planted inside the workspace would hand the agent the rest of
 * the disk. Ported from the same idea ClawCode uses for its `--cwd` jail.
 */

const path = require('node:path');
const fs = require('node:fs/promises');

function inside(child, parent) {
  const rel = path.relative(parent, child);
  return rel === '' || (!rel.startsWith('..') && !path.isAbsolute(rel));
}

/** realpath for a path that may not exist yet: resolve the deepest existing ancestor. */
async function realish(target) {
  let current = target;
  const rest = [];
  for (;;) {
    try {
      const real = await fs.realpath(current);
      return rest.length > 0 ? path.join(real, ...rest.slice().reverse()) : real;
    } catch {
      const parent = path.dirname(current);
      if (parent === current) return target;
      rest.push(path.basename(current));
      current = parent;
    }
  }
}

class PathEscapeError extends Error {
  constructor(requested) {
    super(`路径越界：${requested} 不在工作空间内`);
    this.code = 'path_escape';
  }
}

/**
 * Resolve `target` (relative to the workspace root, or absolute) and guarantee
 * the real location is inside the workspace.
 */
async function resolveInside(root, target, options = {}) {
  const rootReal = await fs.realpath(root);
  const raw = String(target ?? '.').trim() || '.';
  const abs = path.isAbsolute(raw) ? path.normalize(raw) : path.resolve(rootReal, raw);
  const real = await realish(abs);

  if (!inside(real, rootReal)) throw new PathEscapeError(raw);
  if (options.allowRoot === false && real === rootReal) throw new PathEscapeError(raw);
  return real;
}

/** Workspace-relative POSIX path, for display and model output. */
function relative(root, target) {
  return path.relative(root, target).split(path.sep).join('/') || '.';
}

module.exports = { inside, resolveInside, relative, PathEscapeError };
