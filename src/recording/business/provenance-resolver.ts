import {
  OBSERVATION,
  type EntityEvidence,
  type EntityEvidenceType,
  type EntityIdentity,
  type IdentitySource,
} from './entity-evidence.js';
import { round } from './signals.js';

/**
 * LA PROVENANCE d'une entité vue pendant un enregistrement. Une PREMIÈRE apparition n'est jamais
 * une création : le Recorder dit « j'ai observé cette entité » sans prétendre « je sais qu'elle a
 * été créée » tant qu'aucune preuve de création ne le montre.
 *
 *   CREATED_DURING_RECORDING     une action de création a PRODUIT cette identité (preuves concordantes)
 *   CONFIRMED_EXISTING           elle était là avant toute action (l'écran de départ la montrait)
 *   DISCOVERED_DURING_RECORDING  observée (recherche, liste, URL, lecture) — son passé est inconnu
 *   UNKNOWN                      trop peu de preuves (une saisie seule, une création trop faible)
 *   AMBIGUOUS                    des preuves qui se contredisent : aucune n'est choisie
 *
 * « Existait avant l'enregistrement » n'est jamais déduit d'une recherche : seul l'état initial le
 * prouve.
 */
export type EntityProvenance =
  'CREATED_DURING_RECORDING' | 'CONFIRMED_EXISTING' | 'DISCOVERED_DURING_RECORDING' | 'UNKNOWN' | 'AMBIGUOUS';

export interface ProvenanceDecision {
  classification: EntityProvenance;
  /** Dérivée des poids fixes de PROVENANCE_WEIGHTS : jamais un nombre arbitraire. */
  confidence: number;
  reason: string;
  /** Les types de preuve retenus (ordre d'apparition, sans doublon). */
  evidence: EntityEvidenceType[];
  evidenceIds: string[];
  /** Les règles appliquées (R1…R9, voir docs/HUMAN_FLOW_RECORDER.md). */
  rules: string[];
  /** AMBIGUOUS : les preuves qui se contredisent, conservées. */
  contradictions?: string[];
  /** AMBIGUOUS : les provenances possibles (la seule liste où une IA peut choisir). */
  candidates?: EntityProvenance[];
  analyzer: 'DETERMINISTIC' | 'AI_PROPOSAL';
}

/** L'entité à juger : sa clé et son identité (sans son type métier, que le moteur ne connaît pas). */
export interface ProvenanceSubject {
  key: string;
  identity: EntityIdentity;
  /** Une valeur partagée par plusieurs entités (même identifiant, ressources différentes). */
  linkCandidates?: string[];
}

export interface RecordingContext {
  /** Une provenance proposée (IA facultative) pour une AMBIGUÏTÉ : retenue seulement si candidate. */
  proposal?: EntityProvenance;
}

export interface ProvenanceResolver {
  resolve(
    subject: ProvenanceSubject,
    evidence: readonly EntityEvidence[],
    context?: RecordingContext,
  ): ProvenanceDecision;
}

/** Les poids des règles : une décision se recalcule à la main depuis ses preuves. */
export const PROVENANCE_WEIGHTS = {
  /** R1 : l'identité produite par la création, selon d'où elle vient. */
  creation: {
    NETWORK_RESPONSE: 0.55,
    LOCATION_HEADER: 0.55,
    NETWORK_PATH: 0.5,
    VISIBLE_TEXT: 0.45,
    ROUTE: 0.4,
    URL: 0.4,
    DOM_LINK: 0.4,
    USER_INPUT: 0.3,
  } satisfies Record<IdentitySource, number>,
  /** R2 : chaque preuve de création concordante. */
  writeRequest: 0.2,
  createAction: 0.1,
  successResponse: 0.1,
  detailView: 0.05,
  /** L'état initial montrait l'entité. */
  existing: 0.9,
  existingConfirmed: 0.05,
  /** R3–R5 : une observation, puis chaque type d'observation en plus. */
  discovered: 0.6,
  discoveredPerKind: 0.1,
  discoveredSearch: 0.05,
  discoveredCap: 0.95,
  /** R8 / R6. */
  ambiguous: 0.5,
  inputOnly: 0.3,
  /** Sous ce seuil, une hypothèse reste UNKNOWN. */
  threshold: 0.6,
  /** Une IA ne tranche jamais au-delà. */
  aiCap: 0.7,
} as const;

const W = PROVENANCE_WEIGHTS;

export class DeterministicProvenanceResolver implements ProvenanceResolver {
  resolve(
    subject: ProvenanceSubject,
    evidence: readonly EntityEvidence[],
    context: RecordingContext = {},
  ): ProvenanceDecision {
    const sorted = [...evidence].sort((a, b) => a.actionIndex - b.actionIndex);
    const decision = this.decide(subject, sorted);
    // Une IA (facultative) peut CHOISIR parmi les candidats d'une ambiguïté — rien d'autre.
    if (
      decision.classification === 'AMBIGUOUS' &&
      context.proposal !== undefined &&
      decision.candidates?.includes(context.proposal)
    )
      return {
        ...decision,
        classification: context.proposal,
        confidence: W.aiCap,
        reason: `${decision.reason}; AI chose ${context.proposal} among the candidates (contradictions kept)`,
        analyzer: 'AI_PROPOSAL',
      };
    return decision;
  }

  private decide(subject: ProvenanceSubject, evidence: readonly EntityEvidence[]): ProvenanceDecision {
    const make = (
      classification: EntityProvenance,
      confidence: number,
      reason: string,
      used: readonly EntityEvidence[],
      rules: string[],
      extra: Partial<ProvenanceDecision> = {},
    ): ProvenanceDecision => ({
      classification,
      confidence: round(Math.min(0.99, confidence)),
      reason,
      evidence: [...new Set(used.map((entry) => entry.type))],
      evidenceIds: used.map((entry) => entry.id),
      rules,
      analyzer: 'DETERMINISTIC',
      ...extra,
    });
    const creations = evidence.filter((entry) => entry.type === 'NEW_ENTITY_ID');
    const observations = evidence.filter((entry) => OBSERVATION.has(entry.type));
    const inputs = evidence.filter((entry) => entry.type === 'USER_INPUT');

    // ------------------------------------------------------------ R1 / R2 / R8 : une identité produite par une création
    if (creations.length > 0) {
      const creationActions = [...new Set(creations.map((entry) => entry.actionIndex))];
      const first = Math.min(...creationActions);
      const prior = observations.filter(
        (entry) => entry.type === 'INITIAL_STATE' || entry.actionIndex < first,
      );
      const contradictions = [
        ...(creationActions.length > 1
          ? [`the same identity is produced by ${String(creationActions.length)} different creations`]
          : []),
        ...prior.map((entry) => `observed before its creation: ${entry.description}`),
      ];
      if (contradictions.length > 0)
        return make(
          'AMBIGUOUS',
          W.ambiguous,
          'creation evidence and evidence of prior existence contradict each other: no provenance is chosen',
          [...prior, ...creations],
          ['R8 contradictory evidence'],
          {
            contradictions,
            candidates: [
              'CREATED_DURING_RECORDING',
              prior.some((entry) => entry.type === 'INITIAL_STATE')
                ? 'CONFIRMED_EXISTING'
                : 'DISCOVERED_DURING_RECORDING',
            ],
          },
        );
      const atCreation = evidence.filter((entry) => entry.actionIndex === first);
      const has = (type: EntityEvidenceType): EntityEvidence | undefined =>
        atCreation.find((entry) => entry.type === type);
      const best = creations
        .filter((entry) => entry.actionIndex === first)
        .reduce((a, b) =>
          W.creation[b.identity?.source ?? 'USER_INPUT'] > W.creation[a.identity?.source ?? 'USER_INPUT']
            ? b
            : a,
        );
      let score = W.creation[best.identity?.source ?? 'USER_INPUT'];
      const used = [best];
      for (const [type, weight] of [
        ['WRITE_REQUEST', W.writeRequest],
        ['CREATE_ACTION', W.createAction],
        ['SUCCESS_RESPONSE', W.successResponse],
        ['DETAIL_VIEW', W.detailView],
      ] as const) {
        const found = has(type);
        if (!found) continue;
        score += weight;
        used.push(found);
      }
      const kinds = new Set(used.map((entry) => entry.type)).size;
      if (score >= W.threshold)
        return make(
          'CREATED_DURING_RECORDING',
          score,
          `the action "${best.details.label ?? best.actionId ?? ''}" produced this identity (${[...new Set(used.map((entry) => entry.type))].join(' + ')})`,
          used,
          ['R1 explicit creation', ...(kinds >= 3 ? ['R2 converging creation evidence'] : [])],
        );
      return make(
        'UNKNOWN',
        score,
        'a creation is suspected but its evidence is too weak to establish it',
        used,
        ['R9 insufficient evidence'],
      );
    }

    // ------------------------------------------------------------ l'écran de départ la montrait : elle existait
    const initial = observations.filter((entry) => entry.type === 'INITIAL_STATE');
    if (initial.length > 0) {
      const confirmed = observations.find((entry) => entry.type === 'READ_RESPONSE');
      return make(
        'CONFIRMED_EXISTING',
        W.existing + (confirmed ? W.existingConfirmed : 0),
        'the entity was displayed before any user action: it existed when the recording started',
        [...initial, ...(confirmed ? [confirmed] : [])],
        ['R7 first sighting is not a creation'],
      );
    }

    // ------------------------------------------------------------ R3 / R4 / R5 / R7 : observée, sans preuve de création
    if (observations.length > 0) {
      const kinds = [...new Set(observations.map((entry) => entry.type))];
      const searched = inputs.some((entry) => entry.details.search === true);
      const rules = [
        ...(searched ? ['R3 search is not a creation'] : []),
        ...(kinds.some((kind) => kind === 'DIRECT_NAVIGATION' || kind === 'READ_RESPONSE')
          ? ['R4 direct navigation / read is not a creation']
          : []),
        ...(kinds.includes('RESULT_SELECTED') ? ['R5 opening from a list is not a creation'] : []),
        'R7 first sighting is not a creation',
      ];
      return make(
        'DISCOVERED_DURING_RECORDING',
        Math.min(
          W.discoveredCap,
          W.discovered + W.discoveredPerKind * (kinds.length - 1) + (searched ? W.discoveredSearch : 0),
        ),
        `the entity was reached through ${[...(searched ? ['a search'] : []), ...kinds.map(describe)].join(', ')} without any correlated creation evidence`,
        [...(searched ? inputs : []), ...observations],
        rules,
      );
    }

    // ------------------------------------------------------------ R6 / R9 : une saisie seule, ou rien de probant
    if (subject.linkCandidates && subject.linkCandidates.length > 1)
      return make(
        'UNKNOWN',
        W.inputOnly,
        `the value identifies several observed entities (${subject.linkCandidates.join(', ')}): the link is not decided`,
        evidence,
        ['R6 typed identifier', 'R9 insufficient evidence'],
      );
    return make(
      'UNKNOWN',
      inputs.length > 0 ? W.inputOnly : 0,
      inputs.length > 0
        ? 'only typed by the user: nothing observed yet says where this entity comes from'
        : 'not enough evidence',
      evidence,
      inputs.length > 0 ? ['R6 typed identifier', 'R9 insufficient evidence'] : ['R9 insufficient evidence'],
    );
  }
}

function describe(type: EntityEvidenceType): string {
  switch (type) {
    case 'READ_RESPONSE':
      return 'a read request';
    case 'RESULT_SELECTED':
      return 'a selected result / list item';
    case 'DETAIL_VIEW':
      return 'a detail view';
    case 'DIRECT_NAVIGATION':
      return 'a URL typed directly';
    case 'UPDATE_REQUEST':
      return 'an update request';
    case 'DELETE_REQUEST':
      return 'a delete request';
    default:
      return type.toLowerCase();
  }
}
