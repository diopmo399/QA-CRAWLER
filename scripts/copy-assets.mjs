// Après `tsc` : les ressources que le cœur lit à l'exécution (packs de domaine, polices, README) à côté de dist/.
import { cp, mkdir, copyFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const core = path.join(root, 'packages', 'core');
await mkdir(core, { recursive: true });
await cp(path.join(root, 'domain-packs'), path.join(core, 'domain-packs'), { recursive: true });
await cp(path.join(root, 'assets'), path.join(core, 'assets'), { recursive: true });
await copyFile(path.join(root, 'README.md'), path.join(core, 'README.md'));
await copyFile(path.join(root, 'README.md'), path.join(root, 'packages', 'cli', 'README.md'));
console.log('assets copied to packages/core (domain-packs, assets, README.md) and packages/cli (README.md)');
