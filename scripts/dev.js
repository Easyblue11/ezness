/**
 * Dev launcher: boots Vite, waits for it to serve, then opens Electron against it.
 * No extra dependencies — just node + the local binaries.
 */
const { spawn } = require('node:child_process');
const http = require('node:http');
const path = require('node:path');

const PORT = 5173;
const URL = `http://127.0.0.1:${PORT}`;
const root = path.join(__dirname, '..');

const children = [];

function shutdown(code = 0) {
  for (const child of children) {
    if (!child.killed) child.kill();
  }
  process.exit(code);
}

function waitForVite(attemptsLeft = 150) {
  return new Promise((resolve, reject) => {
    const retry = () => {
      if (attemptsLeft <= 0) return reject(new Error('Vite did not start in time'));
      setTimeout(() => waitForVite(attemptsLeft - 1).then(resolve, reject), 200);
    };
    const req = http.get(URL, (res) => {
      res.resume();
      resolve();
    });
    req.on('error', retry);
    req.setTimeout(1000, () => {
      req.destroy();
      retry();
    });
  });
}

async function main() {
  // Resolve through package.json: vite's exports map does not expose bin/vite.js directly.
  const vitePkg = require.resolve('vite/package.json');
  const viteBin = path.join(path.dirname(vitePkg), 'bin', 'vite.js');

  const vite = spawn(process.execPath, [viteBin, '--port', String(PORT)], {
    cwd: root,
    stdio: 'inherit',
  });
  children.push(vite);
  vite.on('exit', (code) => shutdown(code ?? 0));

  await waitForVite();

  const electronBinary = require('electron');
  const electronEnv = { ...process.env, EZNESS_DEV_URL: URL };
  // A user-level ELECTRON_RUN_AS_NODE=1 turns Electron into plain Node.
  delete electronEnv.ELECTRON_RUN_AS_NODE;

  const electron = spawn(electronBinary, ['.'], {
    cwd: root,
    stdio: 'inherit',
    env: electronEnv,
  });
  children.push(electron);
  electron.on('exit', (code) => shutdown(code ?? 0));
}

main().catch((error) => {
  console.error(error);
  shutdown(1);
});
