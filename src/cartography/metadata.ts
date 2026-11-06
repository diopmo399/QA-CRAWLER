import { lstat, readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { openZip } from '../requirements/connectors/zip.js';
import { analyzeMaven } from './analyze-maven.js';
import { analyzeOpenApi } from './analyze-openapi.js';
import type { SourceFacts } from './facts.js';
import type { ReadFile } from './files.js';

/**
 * LES MÉTADONNÉES DE DÉPENDANCES LOCALES : un dossier configuré, sous une racine autorisée, rangé comme un
 * dépôt Maven (`groupe/artefact/version/artefact-version.pom` et `.jar`). On y lit les pom (identifiants,
 * parents, dépendances : les dépendances indirectes connues) et les contrats OpenAPI empaquetés dans les jars
 * (lus comme une archive, jamais chargés ni exécutés). Rien n'est téléchargé ; un lien symbolique, un fichier
 * de secret ou un fichier trop gros est ignoré et compté.
 */
export interface MetadataLimits {
  maxFiles: number;
  maxJarBytes: number;
  maxEntryBytes: number;
  maxDepth: number;
}
export const DEFAULT_METADATA_LIMITS: MetadataLimits = {
  maxFiles: 5000,
  maxJarBytes: 20 * 1024 * 1024,
  maxEntryBytes: 2 * 1024 * 1024,
  maxDepth: 12,
};
const SECRET = /(^|\/)(\.env|.*\.(pem|key|p12|pfx|jks|keystore)|settings-security\.xml|settings\.xml)$/i;

export interface MetadataRead {
  facts: SourceFacts;
  files: number;
  skipped: string[];
}

export async function readMetadata(
  id: string,
  root: string,
  limits: MetadataLimits = DEFAULT_METADATA_LIMITS,
): Promise<MetadataRead> {
  const poms: ReadFile[] = [];
  const contracts: ReadFile[] = [];
  const skipped: string[] = [];
  let seen = 0;
  const walk = async (dir: string, depth: number): Promise<void> => {
    if (depth > limits.maxDepth || seen >= limits.maxFiles) return;
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      const rel = path.relative(root, full).split(path.sep).join('/');
      const info = await lstat(full);
      if (info.isSymbolicLink()) {
        skipped.push(`${rel} : lien symbolique non suivi`);
        continue;
      }
      if (info.isDirectory()) {
        if (!entry.name.startsWith('.')) await walk(full, depth + 1);
        continue;
      }
      if (SECRET.test(rel)) {
        skipped.push(`${rel} : fichier de secret non lu`);
        continue;
      }
      if (++seen > limits.maxFiles) {
        skipped.push(`plus de ${String(limits.maxFiles)} fichiers : lecture arrêtée`);
        return;
      }
      if (/\.pom$/.test(entry.name))
        poms.push({ path: rel, text: await readFile(full, 'utf8'), hash: '', bytes: info.size });
      else if (/\.(ya?ml|json)$/i.test(entry.name) && info.size <= limits.maxEntryBytes)
        contracts.push({ path: rel, text: await readFile(full, 'utf8'), hash: '', bytes: info.size });
      else if (/\.jar$/.test(entry.name)) {
        if (info.size > limits.maxJarBytes) {
          skipped.push(`${rel} : jar trop gros (${String(info.size)} octets)`);
          continue;
        }
        try {
          const zip = openZip(await readFile(full), {
            maxEntries: 5000,
            maxEntryBytes: limits.maxEntryBytes,
            maxTotalBytes: limits.maxJarBytes * 4,
            maxRatio: 200,
          });
          for (const name of zip.names)
            if (/\.(ya?ml|json)$/i.test(name) && !name.startsWith('META-INF/maven/')) {
              const text = zip.text(name);
              if (text !== undefined)
                contracts.push({ path: `${rel}!/${name}`, text, hash: '', bytes: text.length });
            }
        } catch (error) {
          skipped.push(`${rel} : archive illisible (${(error as Error).message})`);
        }
      }
    }
  };
  await walk(root, 0);
  // Les pom sont lus comme des pom.xml (le nom de fichier n'y change rien).
  const maven = analyzeMaven(poms);
  const openapi = analyzeOpenApi(contracts);
  return {
    facts: {
      sourceId: `meta:${id}`,
      layer: 'API',
      ...(maven.modules.length ? { maven } : {}),
      ...(openapi.operations.length || openapi.documents?.length ? { openapi } : {}),
    },
    files: poms.length + contracts.length,
    skipped: [...skipped, ...maven.warnings, ...openapi.warnings].slice(0, 50),
  };
}
