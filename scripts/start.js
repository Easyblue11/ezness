/**
 * Launches Electron for the built app.
 *
 * Why not just `electron .`: this machine has a user-level
 * ELECTRON_RUN_AS_NODE=1, which makes Electron start as plain Node and leaves
 * `require('electron')` returning a path string. Strip it for the child only.
 */
const { spawn } = require('node:child_process');
const path = require('node:path');

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
