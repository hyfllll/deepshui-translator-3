'use strict';

const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const root = path.resolve(__dirname, '..');
const candidates = [
  path.join(root, 'node_modules', 'electron', 'dist', process.platform === 'win32' ? 'electron.exe' : 'electron'),
];
const electronPath = candidates.find((candidate) => fs.existsSync(candidate));
if (!electronPath) {
  console.error('未找到 Electron 41 运行时，请先执行 npm install。');
  process.exit(1);
}

const tests = fs.readdirSync(path.join(root, 'tests'))
  .filter((name) => name.endsWith('.test.js'))
  .sort()
  .map((name) => path.join(root, 'tests', name));
const result = spawnSync(electronPath, ['--test', ...tests], {
  cwd: root,
  env: { ...process.env, ELECTRON_RUN_AS_NODE: '1' },
  stdio: 'inherit',
});
if (result.error) {
  console.error(result.error.message);
  process.exit(1);
}
process.exit(result.status ?? 1);
