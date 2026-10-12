import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

/**
 * PLAYWRIGHT DU PROJET : ce que QA-Crawler reprend de `playwright.config.*` du projet consommateur —
 * baseURL, headless, viewport, storageState — pour que les deux outils regardent la même
 * application de la même façon. Le fichier est importé quand Node sait le charger (.js, .mjs,
 * .cjs ; .ts quand le retrait des types est actif) ; sinon ses valeurs sont lues dans le texte.
 * Aucune installation de navigateur n'est déclenchée : Playwright reste celui du projet
 * (dépendance partagée) ou celui du package.
 */
export interface PlaywrightSettings {
  file: string;
  baseURL?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
  storageState?: string;
  /** Comment le fichier a été lu. */
  source: 'import' | 'text';
}

interface PlaywrightUse {
  baseURL?: string;
  headless?: boolean;
  viewport?: { width: number; height: number } | null;
  storageState?: string | { cookies?: unknown[] };
}

interface PlaywrightConfigShape {
  use?: PlaywrightUse;
  projects?: { use?: PlaywrightUse }[];
}

function fromShape(file: string, shape: PlaywrightConfigShape): PlaywrightSettings {
  const use = { ...shape.projects?.[0]?.use, ...shape.use };
  return {
    file,
    source: 'import',
    ...(typeof use.baseURL === 'string' ? { baseURL: use.baseURL } : {}),
    ...(typeof use.headless === 'boolean' ? { headless: use.headless } : {}),
    ...(use.viewport && typeof use.viewport === 'object' ? { viewport: use.viewport } : {}),
    ...(typeof use.storageState === 'string' ? { storageState: use.storageState } : {}),
  };
}

/** Lecture textuelle (sans exécuter le fichier) : baseURL, headless, viewport, storageState. */
export function parsePlaywrightConfigText(file: string, text: string): PlaywrightSettings {
  const string = (key: string): string | undefined =>
    new RegExp(`\\b${key}\\s*:\\s*['"\`]([^'"\`]+)['"\`]`).exec(text)?.[1];
  const headless = /\bheadless\s*:\s*(true|false)/.exec(text)?.[1];
  const viewport = /\bviewport\s*:\s*\{\s*width\s*:\s*(\d+)\s*,\s*height\s*:\s*(\d+)/.exec(text);
  const baseURL = string('baseURL');
  const storageState = string('storageState');
  return {
    file,
    source: 'text',
    ...(baseURL ? { baseURL } : {}),
    ...(headless ? { headless: headless === 'true' } : {}),
    ...(viewport?.[1] && viewport[2]
      ? { viewport: { width: Number(viewport[1]), height: Number(viewport[2]) } }
      : {}),
    ...(storageState ? { storageState } : {}),
  };
}

/** Lit la configuration Playwright du projet. */
export async function readPlaywrightConfig(file: string): Promise<PlaywrightSettings> {
  const absolute = path.resolve(file);
  if (/\.(m?js|cjs)$/.test(absolute) || process.features.typescript) {
    try {
      const module = (await import(pathToFileURL(absolute).href)) as {
        default?: PlaywrightConfigShape;
      } & PlaywrightConfigShape;
      const shape = module.default ?? module;
      return fromShape(absolute, shape);
    } catch {
      // le fichier ne se charge pas ici (TypeScript sans retrait des types, dépendances absentes) : lecture textuelle
    }
  }
  return parsePlaywrightConfigText(absolute, await readFile(absolute, 'utf8'));
}

/** Les surcharges de mission tirées des réglages Playwright (jamais de secret : storageState est un chemin). */
export function missionOverridesOf(settings: PlaywrightSettings): {
  baseUrl?: string;
  headless?: boolean;
  viewport?: { width: number; height: number };
} {
  return {
    ...(settings.baseURL ? { baseUrl: settings.baseURL } : {}),
    ...(settings.headless !== undefined ? { headless: settings.headless } : {}),
    ...(settings.viewport ? { viewport: settings.viewport } : {}),
  };
}
