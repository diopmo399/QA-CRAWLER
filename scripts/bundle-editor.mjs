// Après `tsc` : le kit de l'éditeur (CodeMirror 6, yaml, @cucumber/gherkin et les modèles de l'éditeur)
// regroupé en un seul module navigateur, chargé à la demande par le Dashboard (`/sdk/ui/editor-kit.js`).
// Les licences des paquets embarqués sont écrites à côté (editor-kit.licenses.txt).
import { stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { bundleEditorKit } from './editor-kit-bundle.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const outfile = path.join(root, 'packages', 'core', 'dist', 'sdk', 'ui', 'editor-kit.js');
const { code, licenses } = await bundleEditorKit(root);
await writeFile(outfile, code, 'utf8');
await writeFile(outfile.replace(/\.js$/, '.licenses.txt'), licenses, 'utf8');
const { size } = await stat(outfile);
console.log(`editor kit bundled: ${path.relative(root, outfile)} (${Math.round(size / 1024)} kB)`);
