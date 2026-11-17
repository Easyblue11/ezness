'use strict';

/**
 * The file operations agent tools are allowed to perform, for both kinds of
 * workspace:
 *
 *   LocalWorkspaceFs   a folder on this machine (node fs, realpath jail)
 *   RemoteWorkspaceFs  a folder on an SSH host (SFTP, posix jail)
 *
 * Tools talk to this interface instead of node fs, so the same list_files /
 * read_file / write_file / run_command code works on either one. Every path is
 * absolute for the adapter (resolve() produces it) and confined to the root.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { resolveInside } = require('./paths');

const MAX_OUTPUT = 30000;

function clip(text, limit = MAX_OUTPUT) {
  const value = String(text ?? '');
  if (value.length <= limit) return value;
  return `${value.slice(0, limit)}\n…（输出已截断，共 ${value.length} 字符）`;
}

class LocalWorkspaceFs {
  constructor(root) {
    this.root = String(root ?? '');
    this.remote = false;
    this.sep = path.sep;
  }

  async ready() {
    return this.root;
  }

  async resolve(relative) {
    return resolveInside(this.root, relative);
  }

  join(base, name) {
    return path.join(base, name);
  }

  dirname(target) {
    return path.dirname(target);
  }

  display(target) {
    return path.relative(this.root, target).split(path.sep).join('/') || '.';
  }

  async stat(target) {
    const info = await fs.stat(target);
    return {
      isDirectory: info.isDirectory(),
      isFile: info.isFile(),
      size: info.size,
      mtimeMs: info.mtimeMs,
      birthtimeMs: info.birthtimeMs,
      ctimeMs: info.ctimeMs,
    };
  }

  async readdir(target) {
    const entries = await fs.readdir(target, { withFileTypes: true });
    return entries.map((entry) => ({
      name: entry.name,
      isDir: entry.isDirectory(),
      isFile: entry.isFile(),
    }));
  }

  async readText(target) {
    return fs.readFile(target, 'utf8');
  }

  async readBuffer(target, options = {}) {
    const maxBytes = Number(options.maxBytes) || 0;
    if (!maxBytes) return fs.readFile(target);
    const handle = await fs.open(target, 'r');
    try {
      const info = await handle.stat();
      const length = Math.min(info.size, maxBytes);
      const buffer = Buffer.alloc(length);
      await handle.read(buffer, 0, length, 0);
      return buffer;
    } finally {
      await handle.close();
    }
  }

  async writeText(target, text) {
    await fs.writeFile(target, text, 'utf8');
  }

  async mkdir(target, options = {}) {
    await fs.mkdir(target, { recursive: options.recursive !== false });
  }

  async exists(target) {
    try {
      await fs.access(target);
      return true;
    } catch {
      return false;
    }
  }

  exec(command, { cwd, timeoutMs = 120000, signal } = {}) {
    return new Promise((resolve, reject) => {
      // 中文 Windows 的控制台默认是 GBK，Python 子进程会把中文写成乱码，
      // 员工和验收员只能猜输出。统一按 UTF-8 跑，并要求子进程也用 UTF-8。
      const env = {
        ...process.env,
        ELECTRON_RUN_AS_NODE: '',
        PYTHONUTF8: '1',
        PYTHONIOENCODING: 'utf-8',
      };
      const shellCommand =
        process.platform === 'win32' ? `chcp 65001 >nul & ${command}` : command;
      const child = spawn(shellCommand, {
        cwd: cwd || this.root,
        shell: true,
        windowsHide: true,
        env,
      });

      let output = '';
      let settled = false;
      let killedBy = null;
      let exited = false;
      let exitTimer = null;
      let killTimer = null;

      const append = (chunk) => {
        if (output.length < MAX_OUTPUT * 2) output += chunk.toString('utf8');
      };
      child.stdout?.on('data', append);
      child.stderr?.on('data', append);

      const body = () => clip(output.trim() || '（没有输出）');

      const killTree = () => {
        if (process.platform === 'win32' && child.pid) {
          spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
        } else {
          try {
            child.kill('SIGKILL');
          } catch {
            /* already gone */
          }
        }
      };

      const killStrays = () =>
        new Promise((done) => {
          if (process.platform !== 'win32' || !child.pid) {
            done();
            return;
          }
          const ps = spawn(
            'powershell',
            [
              '-NoProfile',
              '-Command',
              `Get-CimInstance Win32_Process -Filter "ParentProcessId = ${child.pid}" | ForEach-Object { Stop-Process -Id $_.ProcessId -Force -ErrorAction SilentlyContinue }`,
            ],
            { windowsHide: true },
          );
          const guard = setTimeout(done, 4000);
          ps.on('close', () => {
            clearTimeout(guard);
            done();
          });
          ps.on('error', () => {
            clearTimeout(guard);
            done();
          });
        });

      const settle = (payload) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitTimer) clearTimeout(exitTimer);
        if (killTimer) clearTimeout(killTimer);
        signal?.removeEventListener('abort', onAbort);
        child.stdout?.destroy();
        child.stderr?.destroy();
        resolve(payload);
      };

      const stop = async (reason) => {
        killedBy = reason;
        if (exited) await killStrays();
        else killTree();
        killTimer = setTimeout(() => {
          settle(`命令被${killedBy}终止。\n${body()}`);
        }, 1500);
      };

      const timer = setTimeout(() => {
        void stop(`超时（${Math.round(timeoutMs / 1000)} 秒）`);
      }, timeoutMs);

      const onAbort = () => {
        void stop('用户中断');
      };
      if (signal) {
        if (signal.aborted) onAbort();
        else signal.addEventListener('abort', onAbort, { once: true });
      }

      child.on('error', (error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (exitTimer) clearTimeout(exitTimer);
        signal?.removeEventListener('abort', onAbort);
        reject(error);
      });

      child.on('close', (code) => {
        if (settled) return;
        settle(killedBy ? `命令被${killedBy}终止。\n${body()}` : `退出码 ${code}\n${body()}`);
      });

      child.on('exit', (code) => {
        exited = true;
        exitTimer = setTimeout(async () => {
          if (settled) return;
          await killStrays();
          killTimer = setTimeout(() => {
            settle(`退出码 ${code}（命令结束后仍有子进程占用输出，已清理该后台进程）\n${body()}`);
          }, 600);
        }, 800);
      });
    });
  }
}

/** The adapter to use for this tool call; local unless the run supplied one. */
function workspaceFsOf(ctx) {
  if (ctx?.ws) return ctx.ws;
  if (!ctx?.root) throw new Error('没有工作空间目录。');
  return new LocalWorkspaceFs(ctx.root);
}

module.exports = { LocalWorkspaceFs, workspaceFsOf, clip };
