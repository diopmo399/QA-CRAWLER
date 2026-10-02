import type { EvidenceReference, EvidenceType } from './evidence.js';

/** Une affirmation d'une source sur une propriété (« Business number.required = true »). */
export interface KnowledgeClaim {
  property: string;
  source: Extract<
    EvidenceType,
    'RUNTIME' | 'HUMAN_RECORDING' | 'STATIC_SOURCE' | 'OPENAPI' | 'HISTORICAL' | 'BUSINESS_RULE'
  >;
  value: string | number | boolean;
  evidence?: EvidenceReference;
  /** Ce que la source a vu (« submit accepted without the field », « Validators.required »). */
  detail?: string;
}

export const CONTRADICTION_TYPES = [
  'SOURCE_RUNTIME_MISMATCH',
  'OPENAPI_RUNTIME_MISMATCH',
  'HUMAN_RUNTIME_MISMATCH',
  'HISTORY_RUNTIME_MISMATCH',
  'BUSINESS_RULE_RUNTIME_MISMATCH',
  'CONTRACT_IMPLEMENTATION_MISMATCH',
] as const;
export type ContradictionType = (typeof CONTRADICTION_TYPES)[number];

export interface KnowledgeContradiction {
  id: string;
  property: string;
  types: ContradictionType[];
  claims: KnowledgeClaim[];
  /** La valeur observée maintenant, quand le runtime s'est prononcé. */
  runtimeValue?: KnowledgeClaim['value'];
  /** Une contradiction n'est jamais résolue en silence : à investiguer, confiance réduite. */
  status: 'OPEN' | 'INVESTIGATING';
  confidencePenalty: number;
  /** Ce qui permettrait de trancher sans risque (une observation, une expérience SAFE). */
  investigation: string;
}

const PAIR: Partial<Record<KnowledgeClaim['source'], ContradictionType>> = {
  STATIC_SOURCE: 'SOURCE_RUNTIME_MISMATCH',
  OPENAPI: 'OPENAPI_RUNTIME_MISMATCH',
  HUMAN_RECORDING: 'HUMAN_RUNTIME_MISMATCH',
  HISTORICAL: 'HISTORY_RUNTIME_MISMATCH',
  BUSINESS_RULE: 'BUSINESS_RULE_RUNTIME_MISMATCH',
};

/**
 * CONTRADICTION DETECTOR : démonstration, runtime, code, contrat, historique et règles disent-ils
 * la même chose d'une propriété ?
 *
 *   Business number.required — Human: true · OpenAPI: true · Static: false · Runtime: false
 *   → OPENAPI_RUNTIME_MISMATCH, HUMAN_RUNTIME_MISMATCH, CONTRACT_IMPLEMENTATION_MISMATCH
 *
 * Rien n'est résolu en silence : la contradiction est enregistrée, visible, elle réduit la
 * confiance des connaissances concernées et propose une investigation SAFE. Le runtime est la
 * vérité observable du moment, mais une contradiction avec le contrat peut être un BOGUE.
 */
export class ContradictionDetector {
  private readonly claims = new Map<string, KnowledgeClaim[]>();
  private readonly found = new Map<string, KnowledgeContradiction>();

  constructor(private readonly onDetected?: (contradiction: KnowledgeContradiction) => void) {}

  claim(claim: KnowledgeClaim): KnowledgeContradiction | undefined {
    const list = this.claims.get(claim.property) ?? [];
    const same = list.findIndex((existing) => existing.source === claim.source);
    if (same >= 0) list[same] = claim;
    else list.push(claim);
    this.claims.set(claim.property, list);
    return this.check(claim.property);
  }

  all(): KnowledgeContradiction[] {
    return [...this.found.values()];
  }

  /** La pénalité de confiance d'une propriété (0 sans contradiction). */
  penalty(property: string): number {
    return this.found.get(property)?.confidencePenalty ?? 0;
  }

  private check(property: string): KnowledgeContradiction | undefined {
    const list = this.claims.get(property) ?? [];
    const values = new Set(list.map((claim) => String(claim.value)));
    if (values.size <= 1) {
      this.found.delete(property);
      return undefined;
    }
    const runtime = list.find((claim) => claim.source === 'RUNTIME');
    const types = new Set<ContradictionType>();
    if (runtime)
      for (const claim of list)
        if (claim.source !== 'RUNTIME' && String(claim.value) !== String(runtime.value)) {
          const type = PAIR[claim.source];
          if (type) types.add(type);
        }
    const contract = list.find((claim) => claim.source === 'OPENAPI');
    const implementation = list.find((claim) => claim.source === 'STATIC_SOURCE');
    if (contract && implementation && String(contract.value) !== String(implementation.value))
      types.add('CONTRACT_IMPLEMENTATION_MISMATCH');
    if (contract && runtime && String(contract.value) !== String(runtime.value))
      types.add('CONTRACT_IMPLEMENTATION_MISMATCH');
    if (types.size === 0) types.add('SOURCE_RUNTIME_MISMATCH');
    const previous = this.found.get(property);
    const contradiction: KnowledgeContradiction = {
      id: previous?.id ?? `C-${String(this.found.size + 1)}`,
      property,
      types: [...types],
      claims: [...list],
      ...(runtime ? { runtimeValue: runtime.value } : {}),
      status: 'OPEN',
      confidencePenalty: Math.min(0.5, 0.15 * (values.size - 1) + 0.1 * types.size),
      investigation: runtime
        ? `re-observe "${property}" at runtime (SAFE) and compare with ${list
            .filter((claim) => claim.source !== 'RUNTIME')
            .map((claim) => claim.source)
            .join(', ')}`
        : `observe "${property}" at runtime (no runtime evidence yet)`,
    };
    const isNew = !previous || previous.types.join() !== contradiction.types.join();
    this.found.set(property, contradiction);
    if (isNew) this.onDetected?.(contradiction);
    return contradiction;
  }
}

// ------------------------------------------------------------------ temporal

export const TEMPORAL_RELATIONS = [
  'BEFORE',
  'AFTER',
  'DURING',
  'UNTIL',
  'EVENTUALLY',
  'TRIGGERS',
  'WAITS_FOR',
  'COMPLETES_BEFORE',
] as const;
export type TemporalRelation = (typeof TEMPORAL_RELATIONS)[number];

export interface TimedEvent {
  at: number;
  kind:
    | 'ACTION'
    | 'REQUEST_STARTED'
    | 'REQUEST_COMPLETED'
    | 'LOADING_STARTED'
    | 'LOADING_ENDED'
    | 'CONTROL_APPEARED';
  label: string;
  /** Pour une requête : sa fin (ms). */
  end?: number;
}

export interface TemporalLink {
  from: string;
  relation: TemporalRelation;
  to: string;
  latencyMs?: number;
  observations: number;
}

/**
 * TEMPORAL DEPENDENCY GRAPH : ne pas apprendre « CLICK → liste visible immédiatement » quand
 * la vraie séquence est CLICK → requête → chargement → réponse → rendu.
 *
 *   CLICK Search TRIGGERS GET /api/provinces
 *   GET /api/provinces COMPLETES_BEFORE combobox:province
 *   combobox:province WAITS_FOR GET /api/provinces   (latence observée)
 *   LOADING DURING GET /api/provinces · LOADING UNTIL combobox:province
 */
export class TemporalDependencyGraph {
  private readonly links = new Map<string, TemporalLink>();

  learn(events: readonly TimedEvent[]): TemporalLink[] {
    const sorted = [...events].sort((a, b) => a.at - b.at);
    const action = sorted.find((event) => event.kind === 'ACTION');
    const requests = sorted.filter((event) => event.kind === 'REQUEST_STARTED');
    const appeared = sorted.filter((event) => event.kind === 'CONTROL_APPEARED');
    const loading = sorted.find((event) => event.kind === 'LOADING_STARTED');
    const learned: TemporalLink[] = [];
    const add = (from: string, relation: TemporalRelation, to: string, latencyMs?: number): void => {
      const key = `${from}|${relation}|${to}`;
      const existing = this.links.get(key);
      const link: TemporalLink = {
        from,
        relation,
        to,
        ...(latencyMs !== undefined
          ? {
              latencyMs:
                existing?.latencyMs !== undefined
                  ? Math.round((existing.latencyMs + latencyMs) / 2)
                  : latencyMs,
            }
          : {}),
        observations: (existing?.observations ?? 0) + 1,
      };
      this.links.set(key, link);
      learned.push(link);
    };
    for (const request of requests) {
      if (action && request.at >= action.at)
        add(action.label, 'TRIGGERS', request.label, request.at - action.at);
      const end = request.end;
      if (end === undefined) continue;
      if (loading && loading.at >= request.at && loading.at <= end) add('LOADING', 'DURING', request.label);
      for (const control of appeared)
        if (control.at >= end) {
          // Le contrôle n'est apparu qu'APRÈS la réponse : il l'attend (pas « immédiatement visible »).
          add(control.label, 'WAITS_FOR', request.label, control.at - (action?.at ?? request.at));
          add(request.label, 'COMPLETES_BEFORE', control.label);
          if (loading) add('LOADING', 'UNTIL', control.label);
        }
    }
    if (action && requests.length === 0)
      for (const control of appeared) add(action.label, 'EVENTUALLY', control.label, control.at - action.at);
    return learned;
  }

  /** Ce qu'il faut attendre avant de chercher un contrôle (requête, latence observée). */
  waitsFor(control: string): TemporalLink[] {
    return [...this.links.values()].filter((link) => link.from === control && link.relation === 'WAITS_FOR');
  }

  all(): TemporalLink[] {
    return [...this.links.values()];
  }
}
