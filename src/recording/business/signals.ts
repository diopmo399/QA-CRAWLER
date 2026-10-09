import type { RecordedState, SemanticRecordedAction } from '../model.js';

/**
 * LES SIGNAUX GÉNÉRIQUES de la couche métier : des INDICES (verbes d'interface, forme d'une URL),
 * jamais des règles d'un domaine. Aucun nom d'entité n'est connu à l'avance : « demande »,
 * « commande », « ticket » ou « item » passent par les mêmes signaux.
 */
export const WRITE = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
export const CREATE_LABEL =
  /\b(cr[ée]er|ajouter|enregistrer|soumettre|valider|confirmer|envoyer|create|add|save|submit|confirm|send)\b/iu;
export const SEARCH_LABEL = /\b(recherch\w*|chercher|trouver|search\w*|find|lookup|query)\b/iu;
export const SUCCESS =
  /\b(cr[ée]{2}e?s?|enregistr[ée]e?s?|ajout[ée]e?s?|cr[ée]ation|created|saved|added|succ[eè]s|success\w*)\b/iu;
/** Enregistrer une modification (sur une entité déjà affichée). */
export const SAVE_LABEL = /\b(enregistrer|sauvegarder|sauver|mettre à jour|valider|save|update|apply)\b/iu;
export const DELETE_LABEL = /\b(supprimer|effacer|retirer|delete|remove|archive[rz]?)\b/iu;
/** Un geste qui QUITTE l'entité affichée (nouveau formulaire, retour à une liste ou une recherche). */
export const LEAVE_LABEL =
  /\b(nouvel(?:le)?|nouveau|cr[ée]er|ajouter|new|create|add|retour|back|liste|list|accueil|home)\b/iu;

/** Les segments d'URL qui ne nomment pas une ressource (préfixes techniques). */
const TECHNICAL_SEGMENT =
  /^(api|apis|rest|v\d+(\.\d+)?|app|apps|ui|web|public|internal|graphql|gql|services?|#|-|_)$/i;
const ID_SEGMENT =
  /^(\d+|[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,}[-_][A-Z0-9][A-Z0-9_-]*|(?=(?:[^0-9]*[0-9]){2})(?=.*[A-Za-z])[A-Za-z0-9]{4,40})$/i;

/**
 * L'identité portée par une URL ou un chemin d'API, par sa STRUCTURE seulement :
 * /items/123, /api/v2/orders/CMD-2026-001/edit, /x/0f8f…-uuid. La ressource est le segment de
 * collection qui précède l'identifiant (au singulier), si c'en est un.
 */
export function identityInPath(path: string): { value: string; resource?: string } | undefined {
  const clean = (path.split(/[?#]/)[0] ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '');
  const segments = clean.split('/').filter(Boolean);
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    const segment = decodeSegment(segments[index] ?? '');
    if (!ID_SEGMENT.test(segment)) continue;
    const resource = resourceBefore(segments, index);
    return { value: segment, ...(resource ? { resource } : {}) };
  }
  return undefined;
}

/**
 * Le MOTIF d'une route ou d'un chemin : les identifiants remplacés par « :id », trois segments au
 * plus (/items/ABC123/edit → /items/:id/edit). La forme d'un écran, sans ses valeurs.
 */
export function routePattern(path: string, maxSegments = 3): string {
  const clean = (path.split(/[?#]/)[0] ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '');
  const segments = clean
    .split('/')
    .filter(Boolean)
    .slice(0, maxSegments)
    .map((segment) => (ID_SEGMENT.test(decodeSegment(segment)) ? ':id' : segment.toLowerCase()));
  return `/${segments.join('/')}`;
}

/** La ressource d'un chemin de COLLECTION (POST /api/items → item), sans identifiant. */
export function collectionOf(path: string): string | undefined {
  const clean = (path.split(/[?#]/)[0] ?? '').replace(/^[a-z]+:\/\/[^/]+/i, '');
  const segments = clean.split('/').filter(Boolean);
  return resourceBefore(segments, segments.length);
}

function resourceBefore(segments: readonly string[], index: number): string | undefined {
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const segment = decodeSegment(segments[cursor] ?? '');
    if (TECHNICAL_SEGMENT.test(segment)) continue;
    if (/^[\p{L}][\p{L}_-]{1,40}$/u.test(segment)) return singular(segment);
    return undefined;
  }
  return undefined;
}

function decodeSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

/** Les jetons d'un texte qui peuvent être un identifiant : nombres (≥ 3 chiffres), codes, uuid. */
export function identifierTokens(text: string): string[] {
  const tokens = [
    // Une clé alphanumérique en capitales (ABC123) : avant les nombres qu'elle contient.
    ...(text.match(/\b[A-Z]{2,}\d{2,}[A-Z0-9]*\b/g) ?? []),
    ...(text.match(
      /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[A-Z]{2,}[-_][A-Z0-9][A-Z0-9_-]*|\d{3,}/gi,
    ) ?? []),
  ];
  const kept = [...new Set(tokens)].filter(
    (token, _, all) =>
      !all.some(
        (other) => other !== token && /^\d+$/.test(token) && !/^\d+$/.test(other) && other.includes(token),
      ),
  );
  return kept.slice(0, 20);
}

export function labelOf(action: SemanticRecordedAction): string {
  return action.target?.label ?? action.route ?? '';
}

/** Les textes d'un écran qui disent le résultat d'une action (messages, titres). */
export function screenTexts(state: RecordedState | undefined): string[] {
  return state ? [...state.alerts, ...(state.statuses ?? []), ...state.headings, state.title] : [];
}

export function hasPathId(path: string): boolean {
  const last = path.split('?')[0]?.split('/').filter(Boolean).at(-1) ?? '';
  return /^\d+$/.test(last) || /^[0-9a-f]{8}-[0-9a-f-]{27}$/i.test(last);
}

export function singular(word: string): string {
  const lower = word.toLowerCase();
  if (/(ss|us)$/.test(lower)) return lower;
  if (/[^s]s$/.test(lower) || (/x$/.test(lower) && lower.length > 4)) return lower.slice(0, -1);
  return lower;
}

export function fold(word: string): string {
  return word.normalize('NFD').replace(/[̀-ͯ]/g, '').toLowerCase();
}

/** Deux écritures d'un même identifiant (« #123 », « 123 », « cmd-1 » / « CMD-1 »). */
export function sameValue(a: string, b: string): boolean {
  return a.trim().replace(/^#/, '').toLowerCase() === b.trim().replace(/^#/, '').toLowerCase();
}

export function round(value: number): number {
  return Math.round(value * 100) / 100;
}
