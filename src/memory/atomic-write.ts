import { rename, rm, writeFile } from 'node:fs/promises';

/** Erreurs de Windows quand un autre programme (éditeur, antivirus, indexation) tient le fichier ouvert. */
const LOCKED = new Set(['EPERM', 'EACCES', 'EBUSY']);
const RETRY_DELAYS_MS = [50, 100, 200, 400, 800];

export interface AtomicWriteFs {
  writeFile: (file: string, content: string, encoding: 'utf8') => Promise<void>;
  rename: (from: string, to: string) => Promise<void>;
  rm: (file: string, options: { force: boolean }) => Promise<void>;
}

const nodeFs: AtomicWriteFs = { writeFile, rename, rm };

/**
 * Écrit un fichier sans jamais le laisser à moitié écrit : fichier temporaire puis renommage.
 * Sous Windows, le renommage échoue (EPERM, EACCES, EBUSY) tant qu'un autre programme tient la
 * cible ouverte, par exemple l'éditeur qui affiche reports/flow-graph.json : on réessaie un peu,
 * puis on écrit directement dans la cible plutôt que de faire échouer toute l'exploration.
 */
export async function writeFileAtomic(
  file: string,
  content: string,
  fs: AtomicWriteFs = nodeFs,
): Promise<void> {
  const temporary = `${file}.${process.pid}.tmp`;
  await fs.writeFile(temporary, content, 'utf8');
  for (let attempt = 0; ; attempt += 1) {
    try {
      await fs.rename(temporary, file);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code ?? '';
      if (!LOCKED.has(code)) {
        await fs.rm(temporary, { force: true }).catch(() => undefined);
        throw error;
      }
      const delay = RETRY_DELAYS_MS[attempt];
      if (delay === undefined) break;
      await new Promise((resolve) => setTimeout(resolve, delay));
    }
  }
  try {
    await fs.writeFile(file, content, 'utf8');
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => undefined);
  }
}
