import type { BusinessSituation } from './business-state-engine.js';
import type { FunctionalModel } from './functional-model.js';
import type { FailureClass } from './invariants-failures.js';

export const COVERAGE_DIMENSIONS = [
  'CAPABILITY',
  'CHOICE',
  'FIELD_VALID',
  'FIELD_INVALID',
  'FIELD_MISSING',
  'SUBMISSION',
  'TRANSITION',
  'CHECKPOINT',
  'INVARIANT',
  'ROLE',
  'API',
] as const;
export type CoverageDimension = (typeof COVERAGE_DIMENSIONS)[number];

export interface CoverageItem {
  id: string;
  dimension: CoverageDimension;
  label: string;
  /** Le groupe affiché (« Currency », « Company information », « Submission »). */
  group: string;
  covered: boolean;
  /** Pour un champ : l'identifiant de sa phase (COMPANY_INFORMATION). */
  phase?: string;
  /** Importance métier (0..1) : les chemins négatifs et les envois comptent plus qu'un bouton. */
  importance: number;
  evidence: string[];
}

export interface CoverageGap {
  item: CoverageItem;
  reason: 'COVERAGE';
  suggestion: string;
}

const SUBMISSION_OUTCOMES = [
  { id: 'SUCCESS', label: 'success', importance: 0.9 },
  { id: 'VALIDATION_REJECTION', label: 'validation rejection', importance: 0.8 },
  { id: 'API_UNAVAILABLE', label: 'API unavailable', importance: 0.5 },
] as const;

/**
 * FUNCTIONAL COVERAGE GRAPH : ce qui a été testé du MÉTIER, pas seulement de l'interface.
 *
 *   CREATE_REQUEST
 *     Currency: ✓ EUR  ? CAD
 *     Company information: ✓ valid Business number  ? invalid Business number  ? missing
 *     Submission: ✓ success  ? validation rejection  ? API unavailable
 *
 * Beaucoup de pages visitées n'implique pas « numéro invalide testé » : les trous restent
 * visibles, et l'exploration peut demander « quelle capacité importante n'ai-je pas testée ? »
 * (une raison COVERAGE, jamais une exploration au hasard).
 */
export class FunctionalCoverageGraph {
  private readonly items = new Map<string, CoverageItem>();

  constructor(model: FunctionalModel) {
    const mission = model.mission?.label ?? 'application';
    for (const capability of model.capabilities)
      this.define({
        id: `CAPABILITY:${capability.id}`,
        dimension: 'CAPABILITY',
        label: capability.label,
        group: mission,
        importance: capability.kind === 'SUBMISSION' ? 0.9 : 0.6,
      });
    for (const choice of model.choices)
      for (const option of choice.options)
        this.define({
          id: `CHOICE:${choice.name}:${option}`,
          dimension: 'CHOICE',
          label: option,
          group: choice.name,
          importance: 0.6,
        });
    for (const phase of model.phases)
      for (const field of phase.fields) {
        this.define({
          id: `FIELD_VALID:${field}`,
          dimension: 'FIELD_VALID',
          label: `valid ${field}`,
          group: phase.label,
          phase: phase.id,
          importance: 0.6,
        });
        this.define({
          id: `FIELD_INVALID:${field}`,
          dimension: 'FIELD_INVALID',
          label: `invalid ${field}`,
          group: phase.label,
          phase: phase.id,
          importance: 0.8,
        });
        this.define({
          id: `FIELD_MISSING:${field}`,
          dimension: 'FIELD_MISSING',
          label: `missing ${field}`,
          group: phase.label,
          phase: phase.id,
          importance: 0.7,
        });
      }
    if (model.submit)
      for (const outcome of SUBMISSION_OUTCOMES)
        this.define({
          id: `SUBMISSION:${outcome.id}`,
          dimension: 'SUBMISSION',
          label: outcome.label,
          group: 'Submission',
          importance: outcome.importance,
        });
  }

  /** Un choix vu à l'écran, des champs remplis / invalides / manquants. */
  observeSituation(situation: BusinessSituation, source: string): void {
    for (const phase of situation.phases)
      if (phase.status === 'COMPLETE') this.cover(`CAPABILITY:ENTER_${phase.phase}`, source);
    for (const fact of situation.facts) {
      this.cover(
        `CAPABILITY:SELECT_${(fact.value === 'selected' ? fact.name : fact.value).toUpperCase().replace(/[^A-Z0-9]+/g, '_')}`,
        source,
      );
      for (const item of this.items.values())
        if (
          item.dimension === 'CHOICE' &&
          (item.label === fact.value || (fact.value === 'selected' && item.label === fact.name))
        )
          this.cover(item.id, source);
    }
    for (const phase of situation.phases) {
      if (phase.status === 'UNAVAILABLE') continue;
      for (const item of this.items.values()) {
        if (item.phase !== phase.phase) continue;
        const field = item.id.slice(item.id.indexOf(':') + 1);
        if (item.dimension === 'FIELD_INVALID' && phase.invalid.includes(field)) this.cover(item.id, source);
        // « manquant » : le comportement de l'application a été observé avec ce champ vide, envoi connu.
        if (
          item.dimension === 'FIELD_MISSING' &&
          phase.missing.includes(field) &&
          situation.submission !== 'NOT_VISIBLE'
        )
          this.cover(item.id, source);
        if (item.dimension === 'FIELD_VALID' && phase.status === 'COMPLETE' && !phase.missing.includes(field))
          this.cover(item.id, source);
      }
    }
  }

  /** Le résultat d'un envoi (classé par le FailureUnderstandingEngine, ou réussi). */
  observeSubmission(outcome: 'SUCCESS' | FailureClass, source: string): void {
    const id =
      outcome === 'SUCCESS'
        ? 'SUBMISSION:SUCCESS'
        : outcome === 'EXPECTED_VALIDATION'
          ? 'SUBMISSION:VALIDATION_REJECTION'
          : outcome === 'TECHNICAL_FAILURE' || outcome === 'API_FAILURE' || outcome === 'TIMEOUT_FAILURE'
            ? 'SUBMISSION:API_UNAVAILABLE'
            : undefined;
    if (id) this.cover(id, source);
    if (outcome === 'SUCCESS')
      for (const item of this.items.values())
        if (
          item.dimension === 'CAPABILITY' &&
          (item.id.startsWith('CAPABILITY:SUBMIT_') || item.group === item.label)
        )
          this.cover(item.id, source);
  }

  /** Une capacité exercée, une transition causale confirmée, un checkpoint atteint, un rôle, une API. */
  observe(
    dimension: Exclude<
      CoverageDimension,
      'FIELD_VALID' | 'FIELD_INVALID' | 'FIELD_MISSING' | 'SUBMISSION' | 'CHOICE'
    >,
    label: string,
    source: string,
    importance = 0.5,
  ): void {
    const id = `${dimension}:${label}`;
    this.define({ id, dimension, label, group: dimension, importance });
    this.cover(id, source);
  }

  /** Reprendre une couverture déjà acquise (le modèle a grandi pendant le run). */
  markCovered(id: string, source: string): void {
    this.cover(id, source);
  }

  coverCapability(capabilityId: string, source: string): void {
    this.cover(`CAPABILITY:${capabilityId}`, source);
  }

  all(): CoverageItem[] {
    return [...this.items.values()];
  }

  /** Les trous, du plus important au moins important — la raison d'une exploration ciblée. */
  gaps(): CoverageGap[] {
    return this.all()
      .filter((item) => !item.covered)
      .sort((a, b) => b.importance - a.importance || a.id.localeCompare(b.id))
      .map((item) => ({ item, reason: 'COVERAGE', suggestion: `test ${item.group}: ${item.label}` }));
  }

  /** « Quelle capacité métier importante n'ai-je pas encore testée ? » */
  nextGoal(): CoverageGap | undefined {
    return this.gaps()[0];
  }

  summary(): { dimension: CoverageDimension; covered: number; total: number }[] {
    return COVERAGE_DIMENSIONS.map((dimension) => {
      const items = this.all().filter((item) => item.dimension === dimension);
      return { dimension, covered: items.filter((item) => item.covered).length, total: items.length };
    }).filter((row) => row.total > 0);
  }

  /** « Currency: ✓ EUR ? CAD » — une ligne par groupe. */
  describe(): string[] {
    const groups = new Map<string, CoverageItem[]>();
    for (const item of this.items.values()) groups.set(item.group, [...(groups.get(item.group) ?? []), item]);
    return [...groups].map(
      ([group, items]) =>
        `${group}: ${items.map((item) => `${item.covered ? '✓' : '?'} ${item.label}`).join('  ')}`,
    );
  }

  toJSON(): {
    summary: ReturnType<FunctionalCoverageGraph['summary']>;
    items: CoverageItem[];
    gaps: CoverageGap[];
  } {
    return { summary: this.summary(), items: this.all(), gaps: this.gaps() };
  }

  private define(item: Omit<CoverageItem, 'covered' | 'evidence'>): void {
    if (!this.items.has(item.id)) this.items.set(item.id, { ...item, covered: false, evidence: [] });
  }

  private cover(id: string, source: string): void {
    const item = this.items.get(id);
    if (!item) return;
    item.covered = true;
    if (item.evidence.length < 5 && !item.evidence.includes(source)) item.evidence.push(source);
  }
}
