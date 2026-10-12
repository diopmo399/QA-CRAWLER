// `npm run pack` : build, puis `npm pack` des deux paquets dans dist-packages/ (portable : pas de mkdir -p ni de rm -rf).
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const destination = path.join(root, 'dist-packages');
await mkdir(destination, { recursive: true });
const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
const run = (args) =>
  execFileSync(npm, args, { cwd: root, stdio: 'inherit', shell: process.platform === 'win32' });
run(['run', 'build']);
run([
  'pack',
  '--workspace',
  'packages/core',
  '--workspace',
  'packages/cli',
  '--pack-destination',
  destination,
]);
