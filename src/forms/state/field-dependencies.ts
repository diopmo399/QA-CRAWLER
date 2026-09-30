import type { NetworkExchange } from '../../model/network.js';
import type { ApplicationRule, RuleEffect } from '../../static-analysis/rules/rule-model.js';
import { fieldsOf } from '../../static-analysis/rules/condition-parser.js';
import type { FieldObservation } from './form-state-analyzer.js';

/**
 * FIELD DEPENDENCY GRAPH : QUOI dépend de QUOI (pays → province, type de compte →
 * numéro d'entreprise, quantité + prix → total). Le RuleGraph dit POURQUOI et SOUS
 * QUELLE CONDITION ; les deux se référencent (edge.ruleIds, rule.dependencyEdges),
 * sans jamais dupliquer une relation.
 */

export type DependencyKind =
  | 'VISIBILITY_DEPENDENCY'
  | 'ENABLEMENT_DEPENDENCY'
  | 'VALUE_DEPENDENCY'
  | 'OPTIONS_DEPENDENCY'
  | 'VALIDATION_DEPENDENCY'
  | 'DERIVATION_DEPENDENCY'
  | 'NETWORK_DEPENDENCY';

export interface FieldDependency {
  /** from->to:kind */
  id: string;
  from: string;
  /** Un champ, ou « GET /api/provinces » pour NETWORK_DEPENDENCY. */
  to: string;
  kind: DependencyKind;
  /** STATIC : lu dans le code ; RUNTIME : observé avant/après ; BOTH : les deux. */
  evidence: 'STATIC' | 'RUNTIME' | 'BOTH';
  /** La valeur de `from` qui a produit l'effet observé (code ou libellé d'option, jamais une saisie). */
  triggerValue?: string;
  observations: number;
  ruleIds: string[];
}

// ------------------------------------------------------------------ avant / après

export type FieldChangeKind =
  | 'ADDED'
  | 'REMOVED'
  | 'ENABLED'
  | 'DISABLED'
  | 'READONLY'
  | 'EDITABLE'
  | 'REQUIRED'
  | 'OPTIONAL'
  | 'VALUE_CHANGED'
  | 'OPTIONS_CHANGED';

export interface FieldChange {
  fieldId: string;
  control?: string;
  change: FieldChangeKind;
}

/**
 * « Obligatoire » tel que le runtime le montre : attribut required / aria-required, ou
 * champ vide marqué invalide par le framework (Angular Validators.required ne pose pas
 * d'attribut). undefined : on ne peut pas savoir (champ rempli, sans attribut).
 */
export function runtimeRequired(observation: FieldObservation): boolean | undefined {
  if (observation.required) return true;
  if (!observation.hasValue && observation.valid === false) return true;
  if (!observation.hasValue && observation.valid === true) return false;
  return undefined;
}

function valueKey(observation: FieldObservation): string {
  const value = observation.value;
  if (!value) return '';
  return `${value.digest ?? ''}|${value.code ?? ''}|${value.option ?? ''}|${String(value.checked ?? '')}`;
}

/** FORM STATE DIFF : ce qui a changé entre deux observations du même écran. */
export function diffFormStates(
  before: readonly FieldObservation[],
  after: readonly FieldObservation[],
): FieldChange[] {
  const changes: FieldChange[] = [];
  const key = (observation: FieldObservation): string => observation.fieldId;
  const previous = new Map(before.map((observation) => [key(observation), observation]));
  const next = new Map(after.map((observation) => [key(observation), observation]));
  const push = (observation: FieldObservation, change: FieldChangeKind): void => {
    changes.push({
      fieldId: observation.fieldId,
      ...(observation.control ? { control: observation.control } : {}),
      change,
    });
  };
  for (const [id, observation] of next) {
    const old = previous.get(id);
    if (!old) {
      push(observation, 'ADDED');
      continue;
    }
    if (old.disabled !== observation.disabled)
      push(observation, observation.disabled ? 'DISABLED' : 'ENABLED');
    if (old.readonly !== observation.readonly)
      push(observation, observation.readonly ? 'READONLY' : 'EDITABLE');
    const wasRequired = runtimeRequired(old);
    const isRequired = runtimeRequired(observation);
    if (wasRequired !== undefined && isRequired !== undefined && wasRequired !== isRequired)
      push(observation, isRequired ? 'REQUIRED' : 'OPTIONAL');
    if (valueKey(old) !== valueKey(observation)) push(observation, 'VALUE_CHANGED');
    const oldOptions = (old.options?.codes ?? []).join('\u0000');
    const newOptions = (observation.options?.codes ?? []).join('\u0000');
    if (oldOptions !== newOptions) push(observation, 'OPTIONS_CHANGED');
  }
  for (const [id, observation] of previous) if (!next.has(id)) push(observation, 'REMOVED');
  return changes;
}

const CHANGE_DEPENDENCY: Record<FieldChangeKind, DependencyKind> = {
  ADDED: 'VISIBILITY_DEPENDENCY',
  REMOVED: 'VISIBILITY_DEPENDENCY',
  ENABLED: 'ENABLEMENT_DEPENDENCY',
  DISABLED: 'ENABLEMENT_DEPENDENCY',
  READONLY: 'ENABLEMENT_DEPENDENCY',
  EDITABLE: 'ENABLEMENT_DEPENDENCY',
  REQUIRED: 'VALIDATION_DEPENDENCY',
  OPTIONAL: 'VALIDATION_DEPENDENCY',
  VALUE_CHANGED: 'VALUE_DEPENDENCY',
  OPTIONS_CHANGED: 'OPTIONS_DEPENDENCY',
};

const EFFECT_DEPENDENCY: Partial<Record<RuleEffect['kind'], DependencyKind>> = {
  SHOW: 'VISIBILITY_DEPENDENCY',
  HIDE: 'VISIBILITY_DEPENDENCY',
  ENABLE: 'ENABLEMENT_DEPENDENCY',
  DISABLE: 'ENABLEMENT_DEPENDENCY',
  READONLY: 'ENABLEMENT_DEPENDENCY',
  EDITABLE: 'ENABLEMENT_DEPENDENCY',
  REQUIRED: 'VALIDATION_DEPENDENCY',
  OPTIONAL: 'VALIDATION_DEPENDENCY',
  ADD_VALIDATOR: 'VALIDATION_DEPENDENCY',
  SET_VALUE: 'VALUE_DEPENDENCY',
  SET_OPTIONS: 'OPTIONS_DEPENDENCY',
  API_REQUEST_EXPECTED: 'NETWORK_DEPENDENCY',
};

export function apiOfExchange(exchange: Pick<NetworkExchange, 'method' | 'url'>): string {
  try {
    return `${exchange.method.toUpperCase()} ${new URL(exchange.url).pathname}`;
  } catch {
    return `${exchange.method.toUpperCase()} ${exchange.url.split('?')[0] ?? exchange.url}`;
  }
}

export class FieldDependencyGraph {
  private readonly edges = new Map<string, FieldDependency>();

  private upsert(
    from: string,
    to: string,
    kind: DependencyKind,
    evidence: 'STATIC' | 'RUNTIME',
    extra: { triggerValue?: string; ruleId?: string } = {},
  ): FieldDependency {
    const id = `${from}->${to}:${kind}`;
    const existing = this.edges.get(id);
    if (existing) {
      if (existing.evidence !== evidence && existing.evidence !== 'BOTH') existing.evidence = 'BOTH';
      if (evidence === 'RUNTIME') existing.observations += 1;
      if (extra.ruleId && !existing.ruleIds.includes(extra.ruleId)) existing.ruleIds.push(extra.ruleId);
      if (extra.triggerValue && !existing.triggerValue) existing.triggerValue = extra.triggerValue;
      return existing;
    }
    const edge: FieldDependency = {
      id,
      from,
      to,
      kind,
      evidence,
      ...(extra.triggerValue ? { triggerValue: extra.triggerValue } : {}),
      observations: evidence === 'RUNTIME' ? 1 : 0,
      ruleIds: extra.ruleId ? [extra.ruleId] : [],
    };
    this.edges.set(id, edge);
    return edge;
  }

  /**
   * Les dépendances qu'expliquent les règles du code : condition sur `accountType`,
   * effet sur `companyNumber` → accountType → companyNumber. Chaque arête garde l'id de
   * sa règle, chaque règle la liste de ses arêtes.
   */
  addRules(rules: readonly ApplicationRule[]): void {
    for (const rule of rules) {
      const sources = new Set(rule.conditions.flatMap(fieldsOf));
      const edges: string[] = [];
      for (const effect of rule.effects) {
        if (effect.kind === 'CALCULATE_VALUE' && effect.target.kind === 'FIELD')
          for (const input of effect.inputs ?? [])
            edges.push(
              this.upsert(
                input,
                effect.target.control ?? effect.target.name,
                'DERIVATION_DEPENDENCY',
                'STATIC',
                { ruleId: rule.id },
              ).id,
            );
        const kind = EFFECT_DEPENDENCY[effect.kind];
        if (!kind) continue;
        const target =
          effect.kind === 'API_REQUEST_EXPECTED'
            ? effect.api
            : effect.target.kind === 'FIELD'
              ? (effect.target.control ?? effect.target.name)
              : undefined;
        if (!target) continue;
        for (const source of sources) {
          if (source === target) continue;
          const literal = rule.conditions.find(
            (condition) =>
              condition.kind === 'COMPARE' &&
              (condition.subject.control ?? condition.subject.name) === source,
          );
          const triggerValue =
            literal?.kind === 'COMPARE' && literal.operator === '==' ? String(literal.value) : undefined;
          edges.push(
            this.upsert(source, target, kind, 'STATIC', {
              ruleId: rule.id,
              ...(triggerValue ? { triggerValue } : {}),
            }).id,
          );
          if (effect.kind === 'SET_OPTIONS' && effect.api)
            edges.push(
              this.upsert(source, effect.api, 'NETWORK_DEPENDENCY', 'STATIC', { ruleId: rule.id }).id,
            );
        }
      }
      if (edges.length > 0) rule.dependencyEdges = [...new Set(edges)];
    }
  }

  /**
   * DEPENDENCY INFERENCE : `source` a pris la valeur `triggerValue` ; ce qui a changé
   * ailleurs dépend de lui. Les requêtes XHR/fetch de la fenêtre deviennent des
   * dépendances réseau. Un champ calculé (lecture seule, ou déjà connu comme dérivé)
   * donne DERIVATION_DEPENDENCY plutôt que VALUE_DEPENDENCY.
   */
  infer(
    source: string,
    changes: readonly FieldChange[],
    network: readonly NetworkExchange[],
    options: { triggerValue?: string; derived?: (fieldId: string) => boolean } = {},
  ): FieldDependency[] {
    const found: FieldDependency[] = [];
    for (const change of changes) {
      if (change.fieldId === source || change.control === source) continue;
      const target = change.control ?? change.fieldId;
      const kind =
        change.change === 'VALUE_CHANGED' && options.derived?.(target)
          ? 'DERIVATION_DEPENDENCY'
          : CHANGE_DEPENDENCY[change.change];
      found.push(
        this.upsert(
          source,
          target,
          kind,
          'RUNTIME',
          options.triggerValue ? { triggerValue: options.triggerValue } : {},
        ),
      );
    }
    for (const exchange of network) {
      if (exchange.resourceType !== 'xhr' && exchange.resourceType !== 'fetch') continue;
      found.push(
        this.upsert(
          source,
          apiOfExchange(exchange),
          'NETWORK_DEPENDENCY',
          'RUNTIME',
          options.triggerValue ? { triggerValue: options.triggerValue } : {},
        ),
      );
    }
    return found;
  }

  all(): FieldDependency[] {
    return [...this.edges.values()];
  }

  from(field: string): FieldDependency[] {
    return this.all().filter((edge) => edge.from === field);
  }

  /** Les champs d'où un champ est calculé (DERIVATION), s'il l'est. */
  derivedFrom(field: string): string[] | undefined {
    const inputs = this.all()
      .filter((edge) => edge.to === field && edge.kind === 'DERIVATION_DEPENDENCY')
      .map((edge) => edge.from);
    return inputs.length > 0 ? inputs : undefined;
  }

  /**
   * FIELD INFLUENCE : combien de choses dépendent d'un champ (autres champs, réseau),
   * plus les règles encore non vérifiées qui le prennent pour condition.
   */
  influence(
    field: string,
    unverifiedRules = 0,
  ): {
    dependencies: number;
    networkEffects: number;
    unverifiedRules: number;
    level: 'LOW' | 'MEDIUM' | 'HIGH';
  } {
    const edges = this.from(field);
    const networkEffects = edges.filter((edge) => edge.kind === 'NETWORK_DEPENDENCY').length;
    const dependencies = edges.length - networkEffects;
    const score = dependencies + networkEffects + unverifiedRules * 2;
    return {
      dependencies,
      networkEffects,
      unverifiedRules,
      level: score >= 5 ? 'HIGH' : score >= 2 ? 'MEDIUM' : 'LOW',
    };
  }
}
