import { readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse, stringify } from 'yaml';
import { PROJECT_FILE } from '../../src/sdk/server/project.js';

/**
 * Garde les valeurs dans la trace des données des exécutions de ce projet (`testData.traceValues: true`
 * dans la mission du fichier projet). Par défaut, la trace ne garde que les événements, sans les valeurs ;
 * `keep: false` revient à ce défaut.
 */
export async function keepTraceValues(projectDir: string, keep = true): Promise<void> {
  const file = path.join(projectDir, PROJECT_FILE);
  const document = parse(await readFile(file, 'utf8')) as {
    qaCrawler: { mission?: { testData?: Record<string, unknown> } };
  };
  const mission = (document.qaCrawler.mission ??= {});
  mission.testData = { ...(mission.testData ?? {}), traceValues: keep };
  await writeFile(file, stringify(document, { lineWidth: 0 }));
}
