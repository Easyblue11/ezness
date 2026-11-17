/**
 * Validation and testing for tools created inside a 功能编辑 workspace.
 *
 * A definition is never handed to the normal tool registry before it has at
 * least passed a syntax check and a smoke test. Staged scripts live in a temp
 * folder under the agent directory, so testing an update cannot damage the
 * currently working version. Generated code is treated as untrusted: it runs
 * with a minimal environment and a scratch working directory, and output is
 * clipped before it reaches the model.
 */

const fs = require('node:fs/promises');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { RUNTIMES, resolveRuntime, splitCommand, applyArgDefaults } = require('./custom-tools');
const { resolveInside } = require('./paths');
const deps = require('./deps');

const TEST_TIMEOUT_MS = 15000;
const OUTPUT_LIMIT = 4000;
const PLACEHOLDER_RE = /\{([^}]+)\}/g;

const KEEP_ENV = [
  'PATH', 'Path', 'PATHEXT', 'SYSTEMROOT', 'SystemRoot', 'WINDIR', 'windir',
  'TEMP', 'TMP', 'TMPDIR', 'HOME', 'USERPROFILE', 'COMSPEC', 'LANG',
  'LC_ALL', 'LC_CTYPE', 'TZ',
];

function clipText(value, limit = OUTPUT_LIMIT) {
  const text = String(value ?? '').trim();
  if (text.length <= limit) return text;
  return `${text.slice(0, limit)}\n…（输出已截断）`;
}

function testEnv(extra = {}) {
  const env = {};
  for (const key of KEEP_ENV) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return { ...env, ...extra };
}

/**
 * The arguments a smoke test runs with.
 *
 * Only what the caller actually supplied, plus the parameter's declared
 * default. Filling the rest with the type's zero value made every test run
 * against `0` / `false`, which is never what an optional argument means: it
 * silently disabled defaults such as port 443 or active probing.
 */
function testArgsOf(definition, raw) {
  const supplied =
    raw && typeof raw === 'object' && !Array.isArray(raw) ? raw : {};
  return applyArgDefaults(definition, supplied);
}

function missingRequired(definition, args) {
  return (definition.parameters ?? [])
    .filter((parameter) => parameter.required)
    .filter((parameter) => {
      const value = args[parameter.name];
      return value === undefined || value === null || String(value).trim() === '';
    })
    .map((parameter) => parameter.name);
}

function substitute(tokens, args) {
  return tokens.map((token) =>
    token.replace(PLACEHOLDER_RE, (_match, name) =>
      args[name] === undefined || args[name] === null ? '' : String(args[name]),
    ),
  );
}

function killTree(child) {
  if (process.platform === 'win32' && child.pid) {
    spawn('taskkill', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true });
    return;
  }
  try {
    child.kill('SIGKILL');
  } catch {
    /* already gone */
  }
}

/** Run a command without a shell and keep stdout/stderr apart. */
function runCaptured(argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
    } catch (error) {
      resolve({
        code: null,
        stdout: '',
        stderr: `无法启动命令：${error?.message || String(error)}`,
        timedOut: false,
      });
      return;
    }

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let settled = false;
    let stopTimer = null;

    const finish = (code, error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      if (stopTimer) clearTimeout(stopTimer);
      child.stdout?.destroy();
      child.stderr?.destroy();
      resolve({
        code,
        stdout: clipText(stdout),
        stderr: clipText(error ? `${stderr}\n${error.message || error}` : stderr),
        timedOut,
      });
    };

    child.stdout?.on('data', (chunk) => {
      if (stdout.length < OUTPUT_LIMIT * 3) stdout += chunk.toString('utf8');
    });
    child.stderr?.on('data', (chunk) => {
      if (stderr.length < OUTPUT_LIMIT * 3) stderr += chunk.toString('utf8');
    });

    const timer = setTimeout(() => {
      timedOut = true;
      killTree(child);
      stopTimer = setTimeout(
        () => finish(null, new Error(`测试超时（${Math.round(timeoutMs / 1000)} 秒）。`)),
        1500,
      );
    }, timeoutMs);

    child.on('error', (error) => finish(null, error));
    child.on('close', (code) => finish(code));
  });
}

function sanitize(text, dirs) {
  let out = String(text ?? '');
  for (const dir of dirs) {
    if (!dir) continue;
    out = out.split(dir).join('测试目录');
    out = out.split(dir.replace(/\\/g, '/')).join('测试目录');
  }
  return out;
}

function syntaxArgv(runtime, meta, file) {
  if (runtime === 'node') return [meta.command, ...meta.prefix, '--check', file];
  return [
    meta.command,
    ...meta.prefix,
    '-c',
    "import sys; compile(open(sys.argv[1], encoding='utf-8').read(), sys.argv[1], 'exec')",
    file,
  ];
}

function smokeArgv(runtime, meta, file, definition, args) {
  // Secrets are skipped here exactly as they are in production: a secret slot
  // in the test argv would shift every later value one position along.
  const values = (definition.parameters ?? [])
    .filter((parameter) => !parameter.secret)
    .map((parameter) => {
      const value = args[parameter.name];
      return value === undefined || value === null ? '' : String(value);
    });
  if (runtime === 'python') return [meta.command, ...meta.prefix, '-u', file, ...values];
  return [meta.command, ...meta.prefix, file, ...values];
}

function runtimeEnv(runtime, meta, definition, args, extra = {}) {
  const env = testEnv({
    EZNESS_TOOL_NAME: definition.name,
    EZNESS_TOOL_RUNTIME: definition.runtime,
    EZNESS_TOOL_ARGS: JSON.stringify(args),
    EZNESS_TOOL_TEST: '1',
  });
  if (runtime === 'node') env.ELECTRON_RUN_AS_NODE = '1';
  if (runtime === 'python') {
    env.PYTHONUTF8 = '1';
    env.PYTHONIOENCODING = 'utf-8';
    env.PYTHONUNBUFFERED = '1';
    if (meta?.source === 'portable') env.PYTHONNOUSERSITE = '1';
  }
  return { ...env, ...extra };
}

function brokenHealth(errors, extra = {}) {
  return {
    status: 'broken',
    errors,
    testedAt: Date.now(),
    ...extra,
  };
}

/**
 * Check and exercise one definition.
 *
 * `scratchDir` is the hidden per-category directory used as cwd. Returns
 * `{ ok, errors, health }`; `health` can be persisted as-is.
 */
async function evaluateDefinition(
  definition,
  { agentDir, testArgs, scratchDir, root, autoInstallDeps = true },
) {
  const stageParent = path.join(agentDir, 'tool-tests');
  await fs.mkdir(stageParent, { recursive: true });
  const stageDir = await fs.mkdtemp(path.join(stageParent, 'run-'));
  const cwdBase = scratchDir || stageDir;
  await fs.mkdir(cwdBase, { recursive: true });

  const args = testArgsOf(definition, testArgs);
  const missing = missingRequired(definition, args);
  if (missing.length > 0) {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
    const message = `缺少测试参数：${missing.join('、')}。请提供 testArgs。`;
    return {
      ok: false,
      errors: [{ phase: 'test', message }],
      health: brokenHealth([{ phase: 'test', message }], { testArgs: args }),
    };
  }

  let cwd = cwdBase;
  if (definition.cwd) {
    try {
      cwd = await resolveInside(cwdBase, definition.cwd);
    } catch (error) {
      await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
      const message = `运行目录不可用：${error?.message || String(error)}`;
      return {
        ok: false,
        errors: [{ phase: 'test', message }],
        health: brokenHealth([{ phase: 'test', message }], { testArgs: args }),
      };
    }
  }

  const dirs = [stageDir, cwdBase, cwd];

  try {
    if (definition.runtime === 'executable') {
      const argv = substitute(splitCommand(definition.command), args);
      if (argv.length === 0 || !argv[0]) {
        const message = '执行命令为空。';
        return {
          ok: false,
          errors: [{ phase: 'syntax', message }],
          health: brokenHealth([{ phase: 'syntax', message }], { testArgs: args }),
        };
      }
      const result = await runCaptured(argv, {
        cwd,
        env: runtimeEnv('executable', null, definition, args),
        timeoutMs: Math.min(definition.timeoutMs || TEST_TIMEOUT_MS, TEST_TIMEOUT_MS),
      });
      return outcome(result, args, dirs);
    }

    const runtime = RUNTIMES[definition.runtime];
    if (!runtime) {
      const message = '执行方式不合法。';
      return {
        ok: false,
        errors: [{ phase: 'syntax', message }],
        health: brokenHealth([{ phase: 'syntax', message }], { testArgs: args }),
      };
    }

    let meta;
    try {
      meta = await resolveRuntime(definition.runtime);
    } catch (error) {
      const message = error?.message || String(error);
      return {
        ok: false,
        errors: [{ phase: 'syntax', message }],
        health: brokenHealth([{ phase: 'syntax', message }], { testArgs: args }),
      };
    }

    const file = path.join(stageDir, `main${runtime.ext}`);
    await fs.writeFile(file, definition.script, 'utf8');

    const syntax = await runCaptured(syntaxArgv(definition.runtime, meta, file), {
      cwd,
      env: runtimeEnv(definition.runtime, meta, definition, args),
      timeoutMs: TEST_TIMEOUT_MS,
    });
    if (syntax.timedOut || syntax.code !== 0) {
      const detail = sanitize(syntax.stderr || syntax.stdout || '语法检查没有通过。', dirs);
      const message = `语法错误：${clipText(detail.split('\n')[0] || detail, 400)}`;
      return {
        ok: false,
        errors: [{ phase: 'syntax', message, detail }],
        health: brokenHealth([{ phase: 'syntax', message, detail }], { testArgs: args }),
      };
    }

    // Third-party packages are installed before the smoke test, so the person
    // describing the tool never has to run pip or npm themselves.
    const allowInstall = autoInstallDeps !== false;
    let installed = [];
    let depEnv = definition.runtime === 'python' ? deps.pythonPathEnv(root) : {};

    if (allowInstall && (definition.dependencies ?? []).length > 0) {
      const result = await deps.ensureDependencies({
        root,
        agentDir,
        runtime: definition.runtime,
        specs: definition.dependencies,
        pythonMeta: meta,
      });
      if (!result.ok) {
        const message = `依赖安装失败（${definition.dependencies.join('、')}）：${result.error}`;
        return {
          ok: false,
          installed: [],
          errors: [{ phase: 'runtime', message, detail: result.output }],
          health: brokenHealth(
            [{ phase: 'runtime', message, detail: result.output }],
            { testArgs: args },
          ),
        };
      }
      installed = [...result.installed];
      if (result.pythonPath) depEnv = deps.withPythonPath(depEnv, result.pythonPath);
    }

    const smoke = () =>
      runCaptured(smokeArgv(definition.runtime, meta, file, definition, args), {
        cwd,
        env: runtimeEnv(definition.runtime, meta, definition, args, depEnv),
        timeoutMs: Math.min(definition.timeoutMs || TEST_TIMEOUT_MS, TEST_TIMEOUT_MS),
      });

    let result = await smoke();

    // The definition may omit a package the script actually imports. Install
    // what the error names and run once more, so the test result is meaningful.
    if (allowInstall && !result.timedOut && result.code !== 0) {
      const missing = deps.missingModules(
        definition.runtime,
        `${result.stderr}\n${result.stdout}`,
      );
      if (missing.length > 0) {
        const auto = await deps.ensureDependencies({
          root,
          agentDir,
          runtime: definition.runtime,
          specs: missing,
          pythonMeta: meta,
        });
        if (auto.ok) {
          installed = [...new Set([...installed, ...auto.installed])];
          if (auto.pythonPath) depEnv = deps.withPythonPath(depEnv, auto.pythonPath);
          result = await smoke();
        }
      }
    }

    return outcome(result, args, dirs, installed);
  } finally {
    await fs.rm(stageDir, { recursive: true, force: true }).catch(() => {});
  }
}

function outcome(result, args, dirs, installed = []) {
  const stdout = sanitize(result.stdout, dirs);
  const stderr = sanitize(result.stderr, dirs);
  const base = { testArgs: args, exitCode: result.code, stdout, stderr };
  if (result.timedOut) {
    const message = '测试超时：脚本在限定时间内没有结束。';
    return {
      ok: false,
      installed,
      errors: [{ phase: 'test', message, detail: stderr }],
      health: brokenHealth([{ phase: 'test', message, detail: stderr }], base),
    };
  }
  if (result.code !== 0) {
    const detail = stderr || stdout || `退出码 ${result.code}`;
    const message = `测试未通过（退出码 ${result.code}）：${clipText(detail.split('\n')[0] || detail, 400)}`;
    return {
      ok: false,
      installed,
      errors: [{ phase: 'test', message, detail }],
      health: brokenHealth([{ phase: 'test', message, detail }], base),
    };
  }
  return {
    ok: true,
    installed,
    errors: [],
    health: { status: 'ok', errors: [], testedAt: Date.now(), ...base },
  };
}

module.exports = {
  evaluateDefinition,
  TEST_TIMEOUT_MS,
};
