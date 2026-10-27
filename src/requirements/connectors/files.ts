import { open, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { ConnectorError } from '../connector.js';

/**
 * L'ENTRÉE D'UN CONNECTEUR DE FICHIER (PDF, Word, Excel) : un chemin, ou un contenu déjà reçu (envoi
 * par le SDK). Un chemin est résolu (liens suivis), doit désigner un fichier ordinaire, et sa taille
 * est vérifiée AVANT lecture.
 */
export type FileInput = ({ file: string } | { data: Uint8Array; name: string }) & {
  /** Identifiant stable de la source (défaut : `<type>:<nom du fichier>`). */
  sourceId?: string;
  maxBytes?: number;
};

export const fileNameOf = (input: FileInput): string =>
  path.basename('file' in input ? input.file : input.name);

export async function readSourceFile(input: FileInput, maxBytes: number): Promise<Uint8Array> {
  if ('data' in input) {
    if (input.data.byteLength > maxBytes)
      throw new ConnectorError('TOO_LARGE', `the document is larger than ${String(maxBytes)} bytes`);
    return input.data;
  }
  let resolved: string;
  try {
    resolved = await realpath(input.file);
  } catch {
    throw new ConnectorError('NOT_FOUND', `${path.basename(input.file)} not found`);
  }
  const info = await stat(resolved);
  if (!info.isFile())
    throw new ConnectorError('INVALID_INPUT', `${path.basename(input.file)} is not a regular file`);
  if (info.size > maxBytes)
    throw new ConnectorError('TOO_LARGE', `the document is larger than ${String(maxBytes)} bytes`);
  const handle = await open(resolved, 'r');
  try {
    const buffer = Buffer.alloc(info.size);
    await handle.read(buffer, 0, info.size, 0);
    return new Uint8Array(buffer);
  } finally {
    await handle.close();
  }
}
