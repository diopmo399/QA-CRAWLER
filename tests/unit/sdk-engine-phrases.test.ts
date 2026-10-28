import { readFile, readdir } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { enginePhrase, TRANSLATED_ENGINE_PHRASES } from '../../src/sdk/ui/engine-phrases.js';

/**
 * LES PHRASES DU MOTEUR EN FRANÇAIS : chaque phrase traduite existe bien dans le moteur (une phrase
 * retirée du moteur se voit ici), les valeurs citées restent intactes, une phrase inconnue reste telle
 * quelle et l'anglais n'est jamais touché.
 */
async function sources(directory: string): Promise<string> {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const files = entries
    .filter((entry) => entry.isFile() && entry.name.endsWith('.ts'))
    .map((entry) => path.join(entry.parentPath, entry.name));
  return (await Promise.all(files.map((file) => readFile(file, 'utf8')))).join('\n');
}

describe('engine phrases', () => {
  it('every translated phrase is written by the engine', async () => {
    const engine = await sources(path.resolve('src'));
    const missing = TRANSLATED_ENGINE_PHRASES.filter((text) => !engine.includes(`'${text}'`));
    expect(missing).toEqual([]);
  });

  it('keeps the cited values; leaves an unknown phrase and the English as they are', () => {
    expect(enginePhrase('the page /users is displayed', 'fr')).toBe('la page /users est affichée');
    expect(enginePhrase('the link "À propos (lien relatif)" of / is displayed', 'fr')).toBe(
      'le lien « À propos (lien relatif) » de / est affiché',
    );
    expect(enginePhrase('the page "Utilisateurs" (/users) is displayed', 'fr')).toBe(
      'la page « Utilisateurs » (/users) est affichée',
    );
    expect(enginePhrase('POST /api/items is accepted (201)', 'fr')).toBe(
      'POST /api/items est acceptée (201)',
    );
    expect(enginePhrase('POST /api/items is refused (422, TITLE_REQUIRED)', 'fr')).toBe(
      'POST /api/items est refusée (422, TITLE_REQUIRED)',
    );
    expect(enginePhrase('checkpoint "La liste": page /users', 'fr')).toBe(
      'vérification « La liste » : page /users',
    );
    expect(enginePhrase('testData.item.title is displayed at the end of "Recherche"', 'fr')).toBe(
      'testData.item.title est affichée à la fin de « Recherche »',
    );
    expect(enginePhrase('where the application leads', 'fr')).toBe('là où l’application mène');
    expect(enginePhrase('element on the screen', 'fr')).toBe('élément présent à l’écran');
    expect(enginePhrase('something the engine never said', 'fr')).toBe('something the engine never said');
    expect(enginePhrase('the page /users is displayed', 'en')).toBe('the page /users is displayed');
  });
});
