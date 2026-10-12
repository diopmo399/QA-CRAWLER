// `npm run clean` / `npm run build` : suppression portable (Windows cmd, PowerShell, Git Bash, WSL, Linux, macOS).
// Usage : node scripts/clean.mjs <chemin relatif au dépôt | dossier/*.ext>... — jamais hors du dépôt.
import { readdir, rm } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const targets = process.argv.slice(2);
if (targets.length === 0) throw new Error('clean: nothing to remove (pass repository-relative paths)');
const inside = (absolute, target) => {
  if (absolute === root || !absolute.startsWith(root + path.sep))
    throw new Error(`clean: ${target} is not inside the repository`);
  return absolute;
};
for (const target of targets) {
  const star = /^(.*)\/\*(\.[A-Za-z0-9]+)$/.exec(target);
  if (star) {
    // dossier/*.ext : seulement les fichiers de cette extension, le dossier reste.
    const directory = inside(path.resolve(root, star[1]), target);
    const entries = await readdir(directory, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) {
      if (!entry.isFile() || !entry.name.endsWith(star[2])) continue;
      await rm(path.join(directory, entry.name), { force: true });
      console.log(`removed ${path.relative(root, path.join(directory, entry.name))}`);
    }
    continue;
  }
  const absolute = inside(path.resolve(root, target), target);
  await rm(absolute, { recursive: true, force: true });
  console.log(`removed ${path.relative(root, absolute)}`);
}
