// Release : même version pour @qa-crawler/core et @qa-crawler/cli, CHANGELOG à jour, build, npm pack vérifié.
//   node scripts/release.mjs <patch|minor|major|x.y.z> [--dry-run]
import { execSync } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const [bump = 'patch', ...flags] = process.argv.slice(2);
const dryRun = flags.includes('--dry-run');
const packages = ['packages/core', 'packages/cli'];

const current = JSON.parse(await readFile(path.join(root, 'packages/core/package.json'), 'utf8')).version;
const [major, minor, patch] = current.split('.').map(Number);
const next = /^\d+\.\d+\.\d+$/.test(bump)
  ? bump
  : bump === 'major'
    ? `${major + 1}.0.0`
    : bump === 'minor'
      ? `${major}.${minor + 1}.0`
      : `${major}.${minor}.${patch + 1}`;

const changelog = await readFile(path.join(root, 'CHANGELOG.md'), 'utf8');
if (!changelog.includes(`## ${next}`) && !changelog.includes('## Unreleased'))
  throw new Error(`CHANGELOG.md has neither "## ${next}" nor "## Unreleased": describe the release first`);

for (const directory of [...packages, '.']) {
  const file = path.join(root, directory, 'package.json');
  const pkg = JSON.parse(await readFile(file, 'utf8'));
  pkg.version = next;
  if (pkg.dependencies?.['@qa-crawler/core']) pkg.dependencies['@qa-crawler/core'] = next;
  if (!dryRun) await writeFile(file, `${JSON.stringify(pkg, null, 2)}\n`);
}
const updated = changelog.replace('## Unreleased', `## ${next} — ${new Date().toISOString().slice(0, 10)}`);
if (!dryRun && updated !== changelog) await writeFile(path.join(root, 'CHANGELOG.md'), updated);

const run = (command) => {
  console.log(`$ ${command}`);
  if (!dryRun) execSync(command, { cwd: root, stdio: 'inherit' });
};
run('npm run build');
run('npm run pack:check');
console.log(`\nRelease ${next} prepared${dryRun ? ' (dry run: nothing written)' : ''}.`);
console.log(
  'Publish: npm publish --workspace packages/core && npm publish --workspace packages/cli (add --registry <url> for a private registry).',
);
