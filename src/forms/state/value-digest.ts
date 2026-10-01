import { randomBytes } from 'node:crypto';

/**
 * EMPREINTE DE VALEUR : la valeur d'un champ n'est jamais lue ni gardée en clair (un
 * champ prérempli peut porter un courriel, un nom, un numéro de client). Le navigateur
 * n'en rend qu'une empreinte salée — le sel est tiré au hasard à chaque run et ne quitte
 * jamais la mémoire — qui suffit pour COMPARER : la valeur a-t-elle changé ? Est-ce la
 * valeur par défaut du code ? Celle d'une réponse d'API ? Celle saisie à l'étape d'avant ?
 *
 * Deux FNV-1a 32 bits de graines différentes (64 bits) : pas une protection
 * cryptographique, une comparaison d'égalité sans la valeur. Le même algorithme est
 * recopié dans dom-snapshot.ts (le code envoyé au navigateur ne peut rien importer).
 */
export function valueDigest(value: string, salt: string): string {
  const text = `${salt}\u0000${value.trim()}`;
  let a = 0x811c9dc5;
  let b = 0x01000193 ^ 0x5bd1e995;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b ^ code, 0x01000193) >>> 0;
  }
  return `${a.toString(16).padStart(8, '0')}${b.toString(16).padStart(8, '0')}`;
}

/** Un sel par run : les empreintes d'un run ne se comparent jamais à celles d'un autre. */
export function newValueSalt(): string {
  return randomBytes(12).toString('hex');
}
