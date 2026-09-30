import { fieldsOf } from '../static-analysis/rules/condition-parser.js';
import {
  describeConditions,
  describeEffect,
  describeLiteral,
  describeSubject,
  type ApplicationRule,
  type EffectVerdict,
  type RuleCategory,
  type RuleCondition,
  type RuleCoverageStatus,
  type RuleObservation,
  type RuleStatus,
} from '../static-analysis/rules/rule-model.js';
import { observableEffect } from './rule-evaluator.js';

export interface RuleCoverageSummary {
  discovered: number;
  confirmed: number;
  contradicted: number;
  partiallyVerified: number;
  notVerified: number;
  blockedByPolicy: number;
  blockedByContext: number;
  inconclusive: number;
  /** Règles vérifiées / règles découvertes (un constat, jamais un verdict de qualité). */
  verified: string;
  byCategory: Partial<Record<RuleCategory, { discovered: number; confirmed: number }>>;
}

/** Ce qu'une action peut vérifier : les règles non couvertes dont elle réalise la condition. */
export interface RuleCoverageOpportunity {
  field: string;
  /** La valeur à poser pour réaliser la condition (code d'option). */
  value?: string;
  rules: ApplicationRule[];
  /** Effets observables encore non vérifiés. */
  expectations: string[];
  risk: 'LOW' | 'MEDIUM';
  cost: number;
  level: 'LOW' | 'MEDIUM' | 'HIGH';
}

const CLOSED: ReadonlySet<RuleCoverageStatus> = new Set([
  'VERIFIED',
  'CONTRADICTED',
  'BLOCKED_BY_POLICY',
  'BLOCKED_BY_CONTEXT',
]);

/**
 * RULE GRAPH : les règles de l'application, indexées pour des recherches immédiates —
 * jamais un nouveau parcours de l'AST au moment de décider :
 *
 *   champ de condition → règles       champ ciblé → règles
 *   composant → règles                API → règles
 *
 * Il garde aussi ce que le runtime a vu de chaque règle (observations, verdicts par
 * effet, statut, couverture). STATIC_DISCOVERED ne devient RUNTIME_CONFIRMED que par
 * une observation.
 */
export class RuleGraph {
  private readonly rules: ApplicationRule[];
  private readonly byComponent = new Map<string, ApplicationRule[]>();
  private readonly byConditionField = new Map<string, ApplicationRule[]>();
  private readonly byTargetField = new Map<string, ApplicationRule[]>();
  private readonly byApi = new Map<string, ApplicationRule[]>();

  constructor(rules: readonly ApplicationRule[], categories: Partial<Record<RuleCategory, boolean>> = {}) {
    this.rules = rules
      .filter((rule) => categories[rule.category] !== false)
      .map((rule) => ({
        ...rule,
        coverage: rule.coverage ?? 'NOT_VERIFIED',
        observations: [...(rule.observations ?? [])],
      }));
    const add = (map: Map<string, ApplicationRule[]>, key: string, rule: ApplicationRule): void => {
      const list = map.get(key) ?? [];
      if (!list.includes(rule)) map.set(key, [...list, rule]);
    };
    for (const rule of this.rules) {
      if (rule.component) add(this.byComponent, rule.component, rule);
      for (const field of rule.conditions.flatMap(fieldsOf)) add(this.byConditionField, field, rule);
      for (const effect of rule.effects) {
        if (effect.target.kind === 'FIELD')
          add(this.byTargetField, effect.target.control ?? effect.target.name, rule);
        if (effect.api) add(this.byApi, effect.api, rule);
      }
    }
  }

  all(): readonly ApplicationRule[] {
    return this.rules;
  }

  /** Les règles d'un composant (écran) ; sans composant connu : aucune (jamais toutes au hasard). */
  forComponent(component: string | undefined): ApplicationRule[] {
    return component ? (this.byComponent.get(component) ?? []) : [];
  }

  withConditionOn(field: string): ApplicationRule[] {
    return this.byConditionField.get(field) ?? [];
  }

  targeting(field: string): ApplicationRule[] {
    return this.byTargetField.get(field) ?? [];
  }

  forApi(api: string): ApplicationRule[] {
    return this.byApi.get(api) ?? [];
  }

  isOpen(rule: ApplicationRule): boolean {
    return !CLOSED.has(rule.coverage ?? 'NOT_VERIFIED');
  }

  /**
   * Une observation du runtime. Le statut se recalcule : tous les effets observables
   * confirmés → RUNTIME_CONFIRMED ; un effet contredit → RUNTIME_CONTRADICTED ; une
   * partie → RUNTIME_OBSERVED. Rend true si le statut a changé.
   */
  record(rule: ApplicationRule, observation: RuleObservation): boolean {
    const before = rule.status;
    rule.observations = [...(rule.observations ?? []), observation].slice(-20);
    const verdicts: EffectVerdict[] = rule.effects.map((_, index) => {
      const seen = (rule.observations ?? []).filter((entry) => entry.effect === index);
      if (seen.some((entry) => entry.verdict === 'CONTRADICTED')) return 'CONTRADICTED';
      if (seen.some((entry) => entry.verdict === 'CONFIRMED' && entry.conditionHeld)) return 'CONFIRMED';
      if (seen.length > 0) return 'INCONCLUSIVE';
      return 'NOT_VERIFIED';
    });
    rule.effectVerdicts = verdicts;
    const observable = rule.effects.map(observableEffect);
    const relevant = verdicts.filter((_, index) => observable[index]);
    const status: RuleStatus = verdicts.includes('CONTRADICTED')
      ? 'RUNTIME_CONTRADICTED'
      : relevant.length > 0 && relevant.every((verdict) => verdict === 'CONFIRMED')
        ? 'RUNTIME_CONFIRMED'
        : verdicts.includes('CONFIRMED') ||
            (rule.observations ?? []).some((entry) => entry.verdict === 'CONFIRMED')
          ? 'RUNTIME_OBSERVED'
          : verdicts.includes('INCONCLUSIVE')
            ? 'INCONCLUSIVE'
            : 'STATIC_DISCOVERED';
    rule.status = status;
    rule.coverage =
      status === 'RUNTIME_CONFIRMED'
        ? 'VERIFIED'
        : status === 'RUNTIME_CONTRADICTED'
          ? 'CONTRADICTED'
          : status === 'RUNTIME_OBSERVED'
            ? 'PARTIALLY_VERIFIED'
            : status === 'INCONCLUSIVE'
              ? 'INCONCLUSIVE'
              : (rule.coverage ?? 'NOT_VERIFIED');
    return before !== status;
  }

  /** La règle ne peut pas être vérifiée ici : rôle absent (CONTEXT) ou action interdite (POLICY). */
  block(rule: ApplicationRule, kind: 'BLOCKED_BY_POLICY' | 'BLOCKED_BY_CONTEXT', reason: string): boolean {
    if (
      rule.coverage === kind ||
      rule.status === 'RUNTIME_CONFIRMED' ||
      rule.status === 'RUNTIME_CONTRADICTED'
    )
      return false;
    rule.coverage = kind;
    rule.blockedReason = reason;
    return true;
  }

  coverage(): RuleCoverageSummary {
    const count = (status: RuleCoverageStatus): number =>
      this.rules.filter((rule) => rule.coverage === status).length;
    const byCategory: RuleCoverageSummary['byCategory'] = {};
    for (const rule of this.rules) {
      const entry = byCategory[rule.category] ?? { discovered: 0, confirmed: 0 };
      entry.discovered += 1;
      if (rule.coverage === 'VERIFIED') entry.confirmed += 1;
      byCategory[rule.category] = entry;
    }
    const confirmed = count('VERIFIED');
    return {
      discovered: this.rules.length,
      confirmed,
      contradicted: count('CONTRADICTED'),
      partiallyVerified: count('PARTIALLY_VERIFIED'),
      notVerified: count('NOT_VERIFIED'),
      blockedByPolicy: count('BLOCKED_BY_POLICY'),
      blockedByContext: count('BLOCKED_BY_CONTEXT'),
      inconclusive: count('INCONCLUSIVE'),
      verified: `${String(confirmed)} / ${String(this.rules.length)}`,
      byCategory,
    };
  }

  /**
   * RULE COVERAGE OPPORTUNITY : poser `value` dans `field` réaliserait la condition de
   * règles encore ouvertes — combien d'attentes cela vérifierait-il, pour une interaction.
   */
  opportunity(
    field: string,
    options: { value?: string; component?: string } = {},
  ): RuleCoverageOpportunity | undefined {
    const rules = this.withConditionOn(field).filter(
      (rule) =>
        this.isOpen(rule) &&
        (!options.component || rule.component === options.component) &&
        (options.value === undefined || satisfiedBy(rule.conditions, field, options.value) !== false),
    );
    if (rules.length === 0) return undefined;
    const expectations = rules.flatMap((rule) =>
      rule.effects
        .filter((effect, index) => observableEffect(effect) && rule.effectVerdicts?.[index] !== 'CONFIRMED')
        .map(describeEffect),
    );
    if (expectations.length === 0) return undefined;
    return {
      field,
      ...(options.value !== undefined ? { value: options.value } : {}),
      rules,
      expectations: [...new Set(expectations)],
      risk: 'LOW',
      cost: 1,
      level: expectations.length >= 3 ? 'HIGH' : expectations.length === 2 ? 'MEDIUM' : 'LOW',
    };
  }

  /** Les valeurs qui réalisent les conditions ouvertes d'un champ (BUSINESS, CA…). */
  targetValues(field: string): string[] {
    const values = new Set<string>();
    for (const rule of this.withConditionOn(field))
      if (this.isOpen(rule))
        for (const condition of flatten(rule.conditions))
          if (
            condition.kind === 'COMPARE' &&
            condition.operator === '==' &&
            (condition.subject.control ?? condition.subject.name) === field &&
            condition.value !== null
          )
            values.add(describeLiteral(condition.value));
    return [...values];
  }

  /** L'arbre des règles, par champ de condition puis par valeur (pour le rapport). */
  tree(): { subject: string; branches: { when: string; effects: string[]; rules: string[] }[] }[] {
    const subjects = new Map<string, Map<string, { effects: Set<string>; rules: Set<string> }>>();
    for (const rule of this.rules) {
      const first = flatten(rule.conditions).find(
        (condition) =>
          condition.kind === 'COMPARE' ||
          condition.kind === 'FLAG' ||
          condition.kind === 'PERMISSION' ||
          condition.kind === 'CHANGE',
      );
      const subject =
        first?.kind === 'COMPARE' || first?.kind === 'FLAG' || first?.kind === 'CHANGE'
          ? describeSubject(first.subject)
          : first?.kind === 'PERMISSION'
            ? 'permission'
            : 'form';
      const when = describeConditions(rule.conditions);
      const branches =
        subjects.get(subject) ?? new Map<string, { effects: Set<string>; rules: Set<string> }>();
      const branch = branches.get(when) ?? { effects: new Set<string>(), rules: new Set<string>() };
      for (const effect of rule.effects) branch.effects.add(describeEffect(effect));
      branch.rules.add(rule.name);
      branches.set(when, branch);
      subjects.set(subject, branches);
    }
    return [...subjects.entries()].map(([subject, branches]) => ({
      subject,
      branches: [...branches.entries()].map(([when, branch]) => ({
        when,
        effects: [...branch.effects],
        rules: [...branch.rules],
      })),
    }));
  }
}

function flatten(conditions: readonly RuleCondition[]): RuleCondition[] {
  return conditions.flatMap((condition) =>
    condition.kind === 'AND' || condition.kind === 'OR'
      ? flatten(condition.items)
      : condition.kind === 'NOT'
        ? flatten([condition.item])
        : [condition],
  );
}

/** La valeur réalise-t-elle les comparaisons de ce champ ? (undefined : aucune comparaison.) */
function satisfiedBy(
  conditions: readonly RuleCondition[],
  field: string,
  value: string,
): boolean | undefined {
  let result: boolean | undefined;
  for (const condition of flatten(conditions)) {
    if (condition.kind !== 'COMPARE' || (condition.subject.control ?? condition.subject.name) !== field)
      continue;
    const left = value.trim().toLowerCase();
    const right = String(condition.value ?? '')
      .trim()
      .toLowerCase();
    const a = Number(value);
    const b = Number(condition.value);
    const numbers = value.trim() !== '' && !Number.isNaN(a) && !Number.isNaN(b);
    const ok =
      condition.operator === '=='
        ? left === right
        : condition.operator === '!='
          ? left !== right
          : !numbers
            ? false
            : condition.operator === '>'
              ? a > b
              : condition.operator === '>='
                ? a >= b
                : condition.operator === '<'
                  ? a < b
                  : a <= b;
    result = (result ?? true) && ok;
  }
  return result;
}
