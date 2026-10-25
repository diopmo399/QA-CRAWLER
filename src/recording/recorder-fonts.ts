import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * LES POLICES DU RECORDER (IBM Plex Sans et Mono, SIL OFL 1.1 — voir assets/fonts/OFL.txt) : lues
 * une fois sur le disque et intégrées en data URI. La fenêtre et la barre ne chargent donc rien
 * depuis le réseau. Si un fichier manque (installation partielle), la police système prend le relais.
 */
const FONTS_DIR = fileURLToPath(new URL('../../assets/fonts/', import.meta.url));

export type RecorderFontFamily = 'IBM Plex Sans' | 'IBM Plex Mono';

const FACES: { family: RecorderFontFamily; weight: 400 | 500 | 600; file: string }[] = [
  { family: 'IBM Plex Sans', weight: 400, file: 'ibm-plex-sans-latin-400-normal.woff2' },
  { family: 'IBM Plex Sans', weight: 500, file: 'ibm-plex-sans-latin-500-normal.woff2' },
  { family: 'IBM Plex Sans', weight: 600, file: 'ibm-plex-sans-latin-600-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 400, file: 'ibm-plex-mono-latin-400-normal.woff2' },
  { family: 'IBM Plex Mono', weight: 500, file: 'ibm-plex-mono-latin-500-normal.woff2' },
];

const cache = new Map<string, string | null>();

/** Le fichier d'une police en base64 ; undefined s'il est absent ou illisible. */
export function recorderFontBase64(family: RecorderFontFamily, weight: 400 | 500 | 600): string | undefined {
  const face = FACES.find((entry) => entry.family === family && entry.weight === weight);
  if (!face) return undefined;
  if (!cache.has(face.file)) {
    try {
      cache.set(face.file, readFileSync(path.join(FONTS_DIR, face.file)).toString('base64'));
    } catch {
      cache.set(face.file, null);
    }
  }
  return cache.get(face.file) ?? undefined;
}

/** Les règles @font-face de la fenêtre du recorder (vide si aucune police n'est disponible). */
export function recorderFontFaces(): string {
  return FACES.map((face) => {
    const data = recorderFontBase64(face.family, face.weight);
    return data
      ? `@font-face{font-family:'${face.family}';font-style:normal;font-weight:${String(face.weight)};font-display:block;src:url(data:font/woff2;base64,${data}) format('woff2')}`
      : '';
  }).join('\n');
}
