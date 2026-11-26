/**
 * Launches Electron for the built app.
 *
 * Why not just `electron .`: this machine has a user-level
 * ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node and leaves
 * `require('electron')` returning a path string. Strip it for the child only.
 */
const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');

// Vite empties dist/ before writing, so starting mid-build (or without a
// build at all) leaves Electron on a blank window. Say so instead.
const indexFile = path.join(__dirname, '..', 'dist', 'index.html');
if (!fs.existsSync(indexFile)) {
  console.error('[Ezness] 缺少 dist/index.html，请先运行 npm run build，再运行 npm start。');
  process.exit(1);
}

const env = { ...process.env };
delete env.ELECTRON_RUN_AS_NODE;

const electronBinary = require('electron');
// Extra args are forwarded so the app can be launched with debugging flags,
// e.g. `npm start -- --remote-debugging-port=9222`.
const child = spawn(electronBinary, ['.', ...process.argv.slice(2)], {
  cwd: path.join(__dirname, '..'),
  stdio: 'inherit',
  env,
});

child.on('exit', (code) => process.exit(code ?? 0));
