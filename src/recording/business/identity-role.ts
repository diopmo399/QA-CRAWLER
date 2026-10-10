import { sameIdentity, type EntityEvidence, type EntityIdentity } from './entity-evidence.js';

/**
 * LE RÔLE SÉMANTIQUE D'UN IDENTIFIANT : jamais déduit du NOM du champ. Un champ « id » peut porter
 * une clé métier, un « businessKey » un identifiant technique : seul ce que l'humain et
 * l'application en FONT tranche, et le rôle évolue quand de nouvelles preuves arrivent.
 *
 *   REFERENCE     la valeur est l'identité d'une AUTRE entité observée
 *   BUSINESS_KEY  l'humain la CONNAÎT : il l'a saisie, ou l'application la lui a MONTRÉE (texte affiché)
 *   TECHNICAL_ID  jamais montrée ni saisie : seulement dans le réseau (réponse, chemin d'API)
 *   EXTERNAL_ID   un identifiant d'un autre système : jamais supposé (aucune preuve automatique)
 *   UNKNOWN       pas assez de preuves (une URL d'écran seule, un nom de champ seul) : normal
 */
export type IdentityRole = 'TECHNICAL_ID' | 'BUSINESS_KEY' | 'REFERENCE' | 'EXTERNAL_ID' | 'UNKNOWN';

export interface RoleSignals {
  /** L'application l'a montrée en texte (un résultat, un titre, un message). */
  shown?: { actionId?: string; where: string }[];
  /** L'humain l'a saisie (une recherche, un champ). */
  typed?: { actionId?: string; where: string }[];
  /** Elle figurait dans l'URL d'un écran. */
  route?: { actionId?: string; where: string }[];
  /** Elle n'a circulé que dans le réseau (réponse, chemin d'API). */
  network?: { actionId?: string; where: string }[];
  /** Elle est l'identité d'une autre entité. */
  references?: { actionId?: string; where: string }[];
}

export interface RoleAssessment {
  semanticRole: IdentityRole;
  confidence: number;
  /** Les preuves, dans l'ordre du parcours : le rôle a pu changer en chemin. */
  evidence: string[];
}

/** Les poids fixes du rôle : une décision se recalcule à la main. */
export const ROLE_WEIGHTS = {
  reference: 0.8,
  typed: 0.75,
  shown: 0.65,
  networkOnly: 0.6,
  unknown: 0.55,
} as const;

export function assessRole(signals: RoleSignals): RoleAssessment {
  const W = ROLE_WEIGHTS;
  const lines = (entries: RoleSignals['shown'], prefix: string): { order: number; text: string }[] =>
    (entries ?? []).map((entry) => ({
      // L'ordre du parcours (a12 → 12) : le rôle se lit comme il a évolué.
      order: Number(/\d+/.exec(entry.actionId ?? '')?.[0] ?? -1),
      text: `${prefix}: ${entry.where}${entry.actionId ? ` (${entry.actionId})` : ''}`,
    }));
  const evidence = [
    ...lines(signals.network, 'network'),
    ...lines(signals.route, 'screen URL'),
    ...lines(signals.shown, 'shown to the user'),
    ...lines(signals.typed, 'typed by the user'),
    ...lines(signals.references, 'identity of another entity'),
  ]
    .sort((a, b) => a.order - b.order)
    .map((entry) => entry.text);
  if (signals.references?.length) return { semanticRole: 'REFERENCE', confidence: W.reference, evidence };
  if (signals.typed?.length) return { semanticRole: 'BUSINESS_KEY', confidence: W.typed, evidence };
  if (signals.shown?.length) return { semanticRole: 'BUSINESS_KEY', confidence: W.shown, evidence };
  if (signals.network?.length && !signals.route?.length)
    return { semanticRole: 'TECHNICAL_ID', confidence: W.networkOnly, evidence };
  return {
    semanticRole: 'UNKNOWN',
    confidence: W.unknown,
    evidence: evidence.length ? evidence : ['no evidence of its role (a field name is never one)'],
  };
}

/** Les signaux d'une identité d'entité, tirés des preuves collectées (jamais du nom de son champ). */
export function roleSignalsOf(identity: EntityIdentity, evidence: readonly EntityEvidence[]): RoleSignals {
  const signals: Required<Omit<RoleSignals, 'references'>> = { shown: [], typed: [], route: [], network: [] };
  for (const entry of evidence) {
    if (!entry.identity || !sameIdentity(entry.identity, identity)) continue;
    const where = { ...(entry.actionId ? { actionId: entry.actionId } : {}), where: entry.description };
    switch (entry.identity.source) {
      case 'USER_INPUT':
        signals.typed.push(where);
        break;
      case 'VISIBLE_TEXT':
        signals.shown.push(where);
        break;
      case 'URL':
      case 'ROUTE':
      case 'DOM_LINK':
        signals.route.push(where);
        break;
      case 'NETWORK_RESPONSE':
      case 'NETWORK_PATH':
      case 'LOCATION_HEADER':
        signals.network.push(where);
        break;
    }
  }
  return signals;
}
