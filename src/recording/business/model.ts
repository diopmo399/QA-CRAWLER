/**
 * LA COUCHE MÉTIER DU RECORDING : ce que le parcours enregistré SIGNIFIE (une demande créée, puis
 * recherchée, puis ouverte), au-dessus des actions Playwright — jamais à leur place.
 *
 *   TECHNICAL OBSERVATION (actions, DOM, navigation, réseau)
 *     → BUSINESS INTERPRETATION (BusinessEventDetector, EntityMemory)
 *       → BUSINESS FLOW (BusinessFlowModel, relié aux actions d'origine)
 *         → PLAYWRIGHT EXECUTION (le flow enregistré, inchangé)
 *
 * Tout est déterministe ; une IA (facultative) ne fait que CHOISIR parmi des candidats observés
 * quand le déterministe hésite, et son choix est validé.
 */
export type BusinessEventType =
  'ENTITY_CREATED' | 'ENTITY_SEARCHED' | 'ENTITY_OPENED' | 'ENTITY_UPDATED' | 'ENTITY_DELETED';

/**
 * CONFIRMED  plusieurs indices concordants (≥ 0,85)
 * PROBABLE   indices suffisants mais incomplets (≥ 0,60)
 * AMBIGUOUS  plusieurs interprétations possibles : aucune n'est retenue
 * UNKNOWN    indices trop faibles : jamais une vérité métier
 */
export type BusinessStatus = 'CONFIRMED' | 'PROBABLE' | 'AMBIGUOUS' | 'UNKNOWN';

export const CONFIRMED_AT = 0.85;
export const PROBABLE_AT = 0.6;

export function statusOf(confidence: number): BusinessStatus {
  if (confidence >= CONFIRMED_AT) return 'CONFIRMED';
  if (confidence >= PROBABLE_AT) return 'PROBABLE';
  return 'UNKNOWN';
}

/** Un identifiant d'entité : son empreinte (comparable à une saisie) et, s'il est affichable, sa valeur. */
export interface BusinessIdentifier {
  digest?: string;
  value?: string;
  /** network (corps de réponse), location (en-tête), path (URL d'API), dom (texte affiché), url (route). */
  source: 'network' | 'location' | 'path' | 'dom' | 'url';
  /** Le champ qui le portait (id, data.reference, (path)…). */
  field?: string;
}

/** Les preuves d'une interprétation, par origine. */
export interface BusinessEvidence {
  network: string[];
  dom: string[];
  navigation: string[];
  context: string[];
}

export interface BusinessEvent {
  id: string;
  type: BusinessEventType;
  /** L'entité retenue (absente si AMBIGUOUS ou UNKNOWN). */
  entity?: string;
  /** Les entités possibles quand plusieurs indices se contredisent. */
  candidates?: string[];
  /** ENTITY_CREATED : la référence runtime produite ($created.demande.id). */
  output?: string;
  /** SEARCHED / OPENED / UPDATED / DELETED : la référence de l'entité concernée. */
  reference?: string;
  identifier?: BusinessIdentifier;
  status: BusinessStatus;
  confidence: number;
  /** Les actions techniques d'origine (a3…), leurs événements bruts (r12…) et les étapes du flow (s4…). */
  actionIds: string[];
  rawEventIds: string[];
  stepIds: string[];
  evidence: BusinessEvidence;
  /** DETERMINISTIC ; AI_PROPOSAL : une ambiguïté tranchée par l'IA parmi les candidats observés. */
  analyzer: 'DETERMINISTIC' | 'AI_PROPOSAL';
}

/** Une relation entre deux événements : la recherche d'une entité créée plus tôt. */
export interface BusinessRelation {
  type: 'SEARCH_REFERENCE' | 'OPEN_REFERENCE' | 'UPDATE_REFERENCE' | 'DELETE_REFERENCE';
  from: string;
  to: string;
  reference: string;
  /** Comment la valeur a été reconnue (même empreinte, même valeur, même segment d'URL…). */
  match: string;
}

export interface BusinessFlowStep {
  action: 'create' | 'search' | 'open' | 'update' | 'delete';
  entity?: string;
  candidates?: string[];
  reference?: string;
  outputs?: { id: string; source: BusinessIdentifier['source']; field?: string; value?: string };
  status: BusinessStatus;
  confidence: number;
  businessEventId: string;
  /** Lien vers les actions enregistrées : le flow métier ne remplace jamais le flow Playwright. */
  recordedActions: string[];
  actionIds: string[];
  rawEventIds: string[];
  evidence: BusinessEvidence;
  analyzer: BusinessEvent['analyzer'];
}

export interface BusinessFlowModel {
  name: string;
  entities: { name: string; type: 'business_entity'; references: string[] }[];
  /** Les étapes métier retenues (CONFIRMED, PROBABLE) dans l'ordre du parcours. */
  steps: BusinessFlowStep[];
  relations: BusinessRelation[];
  /** Ce qui n'est PAS une vérité métier : ambiguïtés et hypothèses faibles, pour revue. */
  unresolved: BusinessEvent[];
  summary: Record<BusinessStatus, number> & { events: number };
  thresholds: { confirmed: number; probable: number };
}
