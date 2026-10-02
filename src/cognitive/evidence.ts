import { recencyWeight, type AgingOptions } from '../intelligence/knowledge-aging.js';
import type { EvidenceSource, SemanticEvidence } from '../static-analysis/model.js';

/**
 * EVIDENCE-FIRST : toute connaissance importante est reliée à des PREUVES, et chaque
 * preuve dit d'où elle vient. Le type fixe ce qu'elle peut prouver au plus :
 *
 *   RUNTIME / DOM / NETWORK / TEST_RESULT   ce qui est observable maintenant (vérité courante)
 *   HUMAN_RECORDING                         une intention démontrée
 *   STATIC_SOURCE                           ce que le code implémente (suggère)
 *   OPENAPI                                 ce que le contrat promet (suggère)
 *   BUSINESS_RULE                           une règle lue ou déclarée (suggère)
 *   HISTORICAL                              une expérience (vieillit)
 *   LLM_PROPOSAL                            une proposition : jamais plus qu'une hypothèse
 *
 * Aucune valeur saisie, aucun secret : `details` ne porte que des noms, codes et compteurs.
 */
export const EVIDENCE_TYPES = [
  'RUNTIME',
  'HUMAN_RECORDING',
  'STATIC_SOURCE',
  'OPENAPI',
  'NETWORK',
  'HISTORICAL',
  'BUSINESS_RULE',
  'DOM',
  'ACCESSIBILITY',
  'TEST_RESULT',
  'LLM_PROPOSAL',
] as const;
export type EvidenceType = (typeof EVIDENCE_TYPES)[number];

export type EvidenceDetail = string | number | boolean | null | readonly string[];

export interface Evidence {
  id: string;
  type: EvidenceType;
  /** Qui l'a produite : « flow company step 4 », « CompanyComponent.ts:42 », « POST /api/company 201 ». */
  source: string;
  timestamp?: string;
  applicationVersion?: string;
  /** Confiance propre à la preuve (0..1), avant le plafond de son type. */
  confidence: number;
  details: Readonly<Record<string, EvidenceDetail>>;
}

/** Ce qu'une preuve sert à référencer ailleurs (hypothèse, relation, décision). */
export interface EvidenceReference {
  id: string;
  type: EvidenceType;
}

/**
 * PRINCIPE DE CONFIANCE (§122) : le poids maximal d'une preuve selon son type. Le runtime
 * est la vérité observable ; une proposition de LLM ne vaut au plus qu'une hypothèse.
 */
export const EVIDENCE_TRUST: Readonly<Record<EvidenceType, number>> = {
  RUNTIME: 1,
  DOM: 0.95,
  NETWORK: 0.95,
  TEST_RESULT: 0.95,
  ACCESSIBILITY: 0.85,
  HUMAN_RECORDING: 0.8,
  STATIC_SOURCE: 0.6,
  OPENAPI: 0.6,
  BUSINESS_RULE: 0.6,
  HISTORICAL: 0.5,
  LLM_PROPOSAL: 0.2,
};

/** Les preuves qui OBSERVENT l'application maintenant (et confirment une connaissance). */
export const RUNTIME_EVIDENCE: ReadonlySet<EvidenceType> = new Set([
  'RUNTIME',
  'DOM',
  'NETWORK',
  'TEST_RESULT',
  'ACCESSIBILITY',
]);

export function isRuntimeEvidence(type: EvidenceType): boolean {
  return RUNTIME_EVIDENCE.has(type);
}

/** Le poids effectif d'une preuve : sa confiance × le plafond de son type × son âge × sa version. */
export function evidenceWeight(
  evidence: Pick<Evidence, 'type' | 'confidence' | 'timestamp' | 'applicationVersion'>,
  context: { now?: string; version?: string; aging?: AgingOptions } = {},
): number {
  let weight = Math.max(0, Math.min(1, evidence.confidence)) * EVIDENCE_TRUST[evidence.type];
  if (context.now && evidence.timestamp)
    weight *= recencyWeight(evidence.timestamp, context.now, context.aging);
  // Une preuve d'une autre version de l'application compte moins (sans disparaître).
  if (context.version && evidence.applicationVersion && evidence.applicationVersion !== context.version)
    weight *= 0.7;
  return Math.round(weight * 1000) / 1000;
}

/**
 * Combinaison « noisy-or » de poids indépendants : deux preuves moyennes valent plus
 * qu'une, sans jamais atteindre 1. Le plafond rappelle qu'aucune somme ne fait une certitude.
 */
export function combineWeights(weights: readonly number[], ceiling = 0.99): number {
  let remaining = 1;
  for (const weight of weights) remaining *= 1 - Math.max(0, Math.min(1, weight));
  return Math.round(Math.min(ceiling, 1 - remaining) * 1000) / 1000;
}

const SOURCE_TYPE: Readonly<Record<EvidenceSource, EvidenceType>> = {
  DOM: 'DOM',
  ACCESSIBILITY: 'ACCESSIBILITY',
  FRAMEWORK: 'STATIC_SOURCE',
  STATIC_CODE: 'STATIC_SOURCE',
  DTO: 'STATIC_SOURCE',
  HTTP: 'NETWORK',
  OPENAPI: 'OPENAPI',
  RUNTIME: 'RUNTIME',
  HISTORICAL: 'HISTORICAL',
};

/** Les preuves sémantiques existantes (analyse statique, résolveur) deviennent des Evidence. */
export function evidenceFromSemantic(
  semantic: SemanticEvidence,
  id: string,
  applicationVersion?: string,
): Evidence {
  return {
    id,
    type: SOURCE_TYPE[semantic.source],
    source: semantic.provenance?.detail ?? `${semantic.source}:${semantic.kind}`,
    ...(applicationVersion ? { applicationVersion } : {}),
    confidence: semantic.confidence,
    details: {
      kind: semantic.kind,
      value: semantic.value,
      ...(semantic.concept ? { concept: semantic.concept } : {}),
    },
  };
}

/**
 * Le registre des preuves d'un run : un identifiant stable par preuve (E-1, E-2…), et la
 * même preuve n'est jamais comptée deux fois (même type, même source, mêmes détails).
 */
export class EvidenceStore {
  private readonly byId = new Map<string, Evidence>();
  private readonly byKey = new Map<string, string>();
  private next = 1;

  constructor(
    /** Préfixe des identifiants (E-<run>-1…) : les preuves de runs différents ne se confondent pas. */
    private readonly prefix = 'E',
    private readonly onAdded?: (evidence: Evidence) => void,
  ) {}

  add(input: Omit<Evidence, 'id'>): Evidence {
    const key = `${input.type}|${input.source}|${JSON.stringify(input.details)}|${input.timestamp ?? ''}`;
    const known = this.byKey.get(key);
    const existing = known ? this.byId.get(known) : undefined;
    if (existing) return existing;
    const evidence: Evidence = { ...input, id: `${this.prefix}-${String(this.next)}` };
    this.next += 1;
    this.byId.set(evidence.id, evidence);
    this.byKey.set(key, evidence.id);
    this.onAdded?.(evidence);
    return evidence;
  }

  get(id: string): Evidence | undefined {
    return this.byId.get(id);
  }

  all(): Evidence[] {
    return [...this.byId.values()];
  }

  get size(): number {
    return this.byId.size;
  }
}

export function referenceOf(evidence: Evidence): EvidenceReference {
  return { id: evidence.id, type: evidence.type };
}
