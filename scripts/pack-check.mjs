// `npm pack --dry-run` des deux packages : le tarball ne contient que le runtime (dist, domain-packs, assets, bin, README, package.json).
import { execSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const forbidden =
  /^(src\/|tests\/|scenarios\/|reports\/|screenshots\/|knowledge\/|\.env|.*\.map$|.*\.test\.)/;
for (const directory of ['packages/core', 'packages/cli']) {
  const output = execSync('npm pack --dry-run --json', { cwd: path.join(root, directory), encoding: 'utf8' });
  const [info] = JSON.parse(output);
  const files = info.files.map((file) => file.path);
  const bad = files.filter((file) => forbidden.test(file));
  if (bad.length > 0) throw new Error(`${info.name}: files that must not be published: ${bad.join(', ')}`);
  const required = directory.endsWith('core')
    ? [
        'dist/index.js',
        'dist/cli/cli.js',
        'domain-packs/generic.yaml',
        'assets/fonts/ibm-plex-sans-latin-400-normal.woff2',
        'assets/fonts/OFL.txt',
        'package.json',
      ]
    : ['bin/qa-crawler.js', 'package.json'];
  for (const file of required)
    if (!files.includes(file)) throw new Error(`${info.name}: ${file} missing from the tarball`);
  console.log(
    `${info.name}@${info.version}: ${files.length} file(s), ${Math.round(info.size / 1024)} kB packed`,
  );
}
