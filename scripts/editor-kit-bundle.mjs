// Le regroupement du kit de l'éditeur : partagé par le build (scripts/bundle-editor.mjs) et par le serveur
// SDK en développement (quand le module compilé n'existe pas encore).
import { readFile } from 'node:fs/promises';
import path from 'node:path';

export const EDITOR_KIT_MARKER = '/* qa-crawler editor kit: bundled */';

/** Le code regroupé et les licences des paquets qu'il embarque. */
export async function bundleEditorKit(root) {
  const { build } = await import('esbuild');
  const result = await build({
    entryPoints: [path.join(root, 'src', 'sdk', 'ui', 'editor-kit.ts')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    target: 'es2022',
    minify: true,
    write: false,
    metafile: true,
    legalComments: 'none',
    banner: { js: EDITOR_KIT_MARKER },
  });
  const code = result.outputFiles[0]?.text ?? '';
  const packages = new Set();
  for (const input of Object.keys(result.metafile.inputs)) {
    const match = /node_modules\/((?:@[^/]+\/)?[^/]+)\//.exec(input.split(path.sep).join('/'));
    if (match?.[1]) packages.add(match[1]);
  }
  const notices = [];
  for (const name of [...packages].sort()) {
    const directory = path.join(root, 'node_modules', name);
    const manifest = JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8'));
    let text = '';
    for (const file of ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE'])
      text ||= await readFile(path.join(directory, file), 'utf8').catch(() => '');
    notices.push(
      `${name}@${manifest.version} — ${manifest.license ?? 'see the package'}\n\n${text.trim()}\n`,
    );
  }
  return {
    code,
    licenses: `Third-party code bundled in editor-kit.js\n\n${notices.join('\n---\n\n')}`,
  };
}
