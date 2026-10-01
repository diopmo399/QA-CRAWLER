import type { Locator, Page } from 'playwright';
import { toLocator } from '../execution/locator-resolver.js';
import {
  apiOfExchange,
  diffFormStates,
  type FieldDependency,
  type FieldDependencyGraph,
} from '../forms/state/field-dependencies.js';
import { observeFields, type FieldObservation } from '../forms/state/form-state-analyzer.js';
import { valueDigest } from '../forms/state/value-digest.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { NetworkExchange } from '../model/network.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import { fieldsOf } from '../static-analysis/rules/condition-parser.js';
import {
  describeEffect,
  type ApplicationRule,
  type RuleCondition,
  type RuleObservation,
} from '../static-analysis/rules/rule-model.js';
import type { StaticValueSource } from '../static-analysis/model.js';
import { checkEffect, evaluateConditions, observableEffect, type ScreenFacts } from './rule-evaluator.js';
import type { RuleGraph } from './rule-graph.js';

export type RuleEvent =
  | 'RULE_CANDIDATE_DISCOVERED'
  | 'RULE_DISCOVERED'
  | 'RULE_CLASSIFIED'
  | 'RULE_VERIFICATION_STARTED'
  | 'RULE_RUNTIME_CONFIRMED'
  | 'RULE_RUNTIME_CONTRADICTED'
  | 'RULE_VERIFICATION_INCONCLUSIVE'
  | 'RULE_BLOCKED_BY_POLICY'
  | 'RULE_COVERAGE_UPDATED'
  | 'RULE_COVERAGE_OPPORTUNITY'
  | 'FIELD_DEPENDENCY_DISCOVERED';

export interface VerifierDependencies {
  observe(page: Page): Promise<UiSnapshot>;
  settle(page: Page): Promise<void>;
  /** La SafetyPolicy accepte-t-elle cette action (changer ce champ) ? */
  allowed(action: DiscoveredAction): boolean;
  /** Une fenêtre réseau (NetworkTraceRecorder) : les échanges vus entre start et stop. */
  network: { start(id: string): void; stop(id: string): readonly NetworkExchange[] };
  /** Toutes les requêtes XHR/fetch vues sur la page (GET /api/provinces). */
  apisSeen: ReadonlySet<string>;
  salt: string;
  /** Valeur saisie par le crawler dans ce champ (ses données de test). */
  knownValue(fieldId: string): string | undefined;
  /** Valeur littérale initiale selon le code (country: ['CA']) : permet de rétablir un champ texte. */
  staticDefault(control: string): StaticValueSource['literal'] | undefined;
  /** Un envoi de formulaire est-il permis par la mission ? */
  submitAllowed: boolean;
  onEvent(event: RuleEvent, message: string): void;
  now(): number;
}

export interface VerifierBudget {
  /** Changements de valeur restants (rules.budgets.maxRuntimeVerifications). */
  verifications: number;
  /** Champs sans règle dont on observe les effets (forms.dependencyDiscovery.maxFieldMutations). */
  probes: number;
  maxValuesPerField: number;
  maxRulesPerPage: number;
  deadline: number;
  dependencyDiscovery: boolean;
}

export interface VerificationContext {
  component?: string;
  route: string;
  stateId: string;
  version?: string;
  environment?: string;
  role?: string;
}

const SUBMIT_EFFECTS = new Set(['INCLUDE_IN_REQUEST', 'ALLOW_ACTION', 'DENY_ACTION']);

/**
 * RUNTIME RULE VERIFIER : une règle lue dans le code est confrontée au navigateur.
 *
 * - PASSIF : l'écran tel qu'il est (un compte déjà « BUSINESS » montre déjà ses
 *   champs) — vérifier une règle ne veut pas dire modifier un champ ;
 * - ACTIF : poser la valeur qui réalise la condition (sélectionner BUSINESS), observer,
 *   puis RÉTABLIR la valeur d'origine — seulement pour un champ que la SafetyPolicy
 *   permet de changer, jamais sensible, dont la valeur d'origine est connue, dans les
 *   budgets. Jamais d'envoi de formulaire, jamais de rôle changé : une règle qui en
 *   aurait besoin reste BLOCKED_BY_POLICY / BLOCKED_BY_CONTEXT.
 *
 * Une contradiction n'est pas un bug : elle est rapportée avec son contexte (route,
 * version, état du formulaire), les oracles existants en jugent.
 */
export class RuntimeRuleVerifier {
  constructor(
    private readonly graph: RuleGraph,
    private readonly dependencies: FieldDependencyGraph,
    private readonly deps: VerifierDependencies,
    /** Le champ porte-t-il une valeur venue du serveur, d'une API, d'un profil (FormStateAnalyzer) ? */
    private readonly prefilled?: (observation: FieldObservation) => boolean,
  ) {}

  private facts(snapshot: UiSnapshot, extra: Partial<ScreenFacts> = {}): ScreenFacts {
    return {
      fields: observeFields(snapshot.elements),
      elements: snapshot.elements,
      salt: this.deps.salt,
      knownValue: (fieldId) => this.deps.knownValue(fieldId),
      apisSeen: this.deps.apisSeen,
      ...extra,
    };
  }

  /** Observer, sans rien toucher : chaque règle ouverte du composant dont la condition se lit à l'écran. */
  passive(snapshot: UiSnapshot, context: VerificationContext, budget: VerifierBudget): void {
    const facts = this.facts(snapshot);
    for (const rule of this.graph.forComponent(context.component).slice(0, budget.maxRulesPerPage)) {
      if (!this.graph.isOpen(rule)) continue;
      this.blockIfNeeded(rule);
      this.evaluate(rule, facts, 'PASSIVE', context);
    }
  }

  /** Un rôle ou une permission : jamais changé pour vérifier ; un envoi interdit : jamais forcé. */
  private blockIfNeeded(rule: ApplicationRule): void {
    const permission = JSON.stringify(rule.conditions).includes('"PERMISSION"');
    if (permission && rule.category === 'PERMISSION') {
      if (
        this.graph.block(
          rule,
          'BLOCKED_BY_CONTEXT',
          'depends on a role or permission of the signed-in user; never changed to verify',
        )
      )
        this.deps.onEvent(
          'RULE_BLOCKED_BY_POLICY',
          `${rule.name}: BLOCKED_BY_CONTEXT (role of the signed-in user)`,
        );
      return;
    }
    const observable = rule.effects.some(observableEffect);
    if (
      !observable &&
      rule.effects.some((effect) => SUBMIT_EFFECTS.has(effect.kind)) &&
      !this.deps.submitAllowed
    )
      if (
        this.graph.block(
          rule,
          'BLOCKED_BY_POLICY',
          'needs a form submission, which the mission does not allow',
        )
      )
        this.deps.onEvent('RULE_BLOCKED_BY_POLICY', `${rule.name}: needs a form submission (not allowed)`);
  }

  private evaluate(
    rule: ApplicationRule,
    facts: ScreenFacts,
    mode: RuleObservation['mode'],
    context: VerificationContext,
  ): boolean {
    const held = evaluateConditions(rule.conditions, facts);
    if (held === undefined) return false;
    let observed = false;
    rule.effects.forEach((effect, index) => {
      const check = checkEffect(effect, held, facts);
      if (!check) return;
      const already = (rule.observations ?? []).some(
        (entry) =>
          entry.effect === index &&
          entry.verdict === check.verdict &&
          entry.conditionHeld === held &&
          entry.mode === mode,
      );
      if (already) return;
      observed = true;
      const statusBefore = rule.status;
      this.graph.record(rule, {
        at: new Date().toISOString(),
        effect: index,
        verdict: check.verdict,
        conditionHeld: held,
        mode,
        detail: check.detail,
        ...(check.verdict === 'CONTRADICTED' ? { context: contextOf(context, facts.fields) } : {}),
      });
      if (rule.status !== statusBefore)
        this.deps.onEvent(
          rule.status === 'RUNTIME_CONFIRMED'
            ? 'RULE_RUNTIME_CONFIRMED'
            : rule.status === 'RUNTIME_CONTRADICTED'
              ? 'RULE_RUNTIME_CONTRADICTED'
              : rule.status === 'INCONCLUSIVE'
                ? 'RULE_VERIFICATION_INCONCLUSIVE'
                : 'RULE_COVERAGE_UPDATED',
          `${rule.name}: ${rule.status} (${check.detail})`,
        );
    });
    return observed;
  }

  /**
   * Vérification ACTIVE : pour chaque champ dont dépendent des règles encore ouvertes,
   * poser la valeur qui réalise leur condition, observer, rétablir. Rend l'instantané
   * final, ou navigated: true si la page a changé d'adresse (l'explorateur relira l'écran).
   */
  async active(
    page: Page,
    snapshot: UiSnapshot,
    actions: readonly DiscoveredAction[],
    context: VerificationContext,
    budget: VerifierBudget,
  ): Promise<{ snapshot: UiSnapshot; navigated: boolean }> {
    let current = snapshot;
    const rules = this.graph
      .forComponent(context.component)
      .filter((rule) => this.graph.isOpen(rule) || needsNegative(rule));
    const plans = new Map<string, Set<string>>();
    for (const rule of rules)
      for (const field of rule.conditions.flatMap(fieldsOf))
        for (const value of this.valuesFor(field, rule, current))
          plans.set(field, (plans.get(field) ?? new Set()).add(value));

    for (const [field, values] of plans) {
      for (const value of [...values].slice(0, budget.maxValuesPerField)) {
        if (budget.verifications <= 0 || this.deps.now() > budget.deadline)
          return { snapshot: current, navigated: false };
        const affected = this.graph
          .withConditionOn(field)
          .filter((rule) => rule.component === context.component);
        if (!affected.some((rule) => this.graph.isOpen(rule) || needsNegative(rule))) break;
        const expected = affected
          .flatMap((rule) => rule.effects.filter(observableEffect).map(describeEffect))
          .slice(0, 6);
        const result = await this.withValue(
          page,
          current,
          actions,
          field,
          value,
          context,
          expected,
          budget,
          affected,
        );
        if (!result) continue;
        budget.verifications -= 1;
        if (result.navigated) return { snapshot: result.snapshot, navigated: true };
        current = result.snapshot;
      }
    }

    // Champs sans règle connue : leurs effets (FieldDependencyGraph), dans le budget de découverte.
    if (budget.dependencyDiscovery)
      for (const field of observeFields(current.elements)) {
        if (budget.probes <= 0 || this.deps.now() > budget.deadline) break;
        if (
          field.kind !== 'select' ||
          plans.has(field.control ?? field.fieldId) ||
          field.disabled ||
          field.readonly ||
          field.sensitive
        )
          continue;
        const key = field.control ?? field.fieldId;
        if (this.dependencies.from(key).length > 0) continue;
        const others = (field.options?.codes ?? []).filter(
          (code) => code.trim() !== '' && code !== field.value?.code,
        );
        for (const value of others.slice(0, Math.max(0, budget.maxValuesPerField - 1))) {
          const result = await this.withValue(page, current, actions, key, value, context, [], budget, []);
          if (!result) break;
          if (result.navigated) return { snapshot: result.snapshot, navigated: true };
          current = result.snapshot;
        }
        budget.probes -= 1;
      }
    return { snapshot: current, navigated: false };
  }

  /** Les valeurs qui réalisent (ou, pour une liaison du gabarit, défont) la condition sur ce champ. */
  private valuesFor(field: string, rule: ApplicationRule, snapshot: UiSnapshot): string[] {
    const observation = observeFields(snapshot.elements).find(
      (entry) => (entry.control ?? entry.fieldId) === field,
    );
    if (!observation) return [];
    const compares = flatten(rule.conditions).filter(
      (condition): condition is Extract<RuleCondition, { kind: 'COMPARE' }> =>
        condition.kind === 'COMPARE' && (condition.subject.control ?? condition.subject.name) === field,
    );
    const values: string[] = [];
    const codes = observation.options?.codes ?? [];
    const current = observation.value?.code;
    if (this.graph.isOpen(rule)) {
      for (const condition of compares.filter((entry) => entry.operator === '==' && entry.value !== null))
        values.push(String(condition.value));
      // Bornes numériques : une valeur au milieu (0 < âge < 18 → 9).
      const lower = compares
        .filter((entry) => entry.operator === '>' || entry.operator === '>=')
        .map((entry) => Number(entry.value));
      const upper = compares
        .filter((entry) => entry.operator === '<' || entry.operator === '<=')
        .map((entry) => Number(entry.value));
      if ((lower.length > 0 || upper.length > 0) && observation.kind === 'text') {
        const low = lower.length > 0 ? Math.max(...lower) : undefined;
        const high = upper.length > 0 ? Math.min(...upper) : undefined;
        const pick =
          low !== undefined && high !== undefined
            ? Math.floor((low + high) / 2)
            : low !== undefined
              ? low + 1
              : (high ?? 1) - 1;
        if (Number.isFinite(pick)) values.push(String(pick));
      }
      // « x changes » seul : une autre valeur.
      if (compares.length === 0 && rule.conditions.some((condition) => condition.kind === 'CHANGE')) {
        if (observation.kind === 'select') {
          const other = codes.find((code) => code.trim() !== '' && code !== current);
          if (other) values.push(other);
        } else if (observation.kind === 'text') {
          const known = this.deps.knownValue(observation.fieldId) ?? this.deps.staticDefault(field);
          values.push(String(Number(known ?? 1) + 1));
        }
      }
    }
    // Liaison du gabarit déjà confirmée dans un sens : l'autre sens (PERSONAL → companyNumber absent).
    if (needsNegative(rule) && observation.kind === 'select') {
      const equal = compares.find((entry) => entry.operator === '==');
      const other = codes.find(
        (code) => code.trim() !== '' && equal && code.toLowerCase() !== String(equal.value).toLowerCase(),
      );
      if (other) values.push(other);
    }
    return [...new Set(values)].filter(
      (value) =>
        observation.kind !== 'select' ||
        codes.includes(value) ||
        codes.some((code) => code.toLowerCase() === value.toLowerCase()),
    );
  }

  /** Poser une valeur, observer, rétablir. undefined : champ impossible à changer sans risque. */
  private async withValue(
    page: Page,
    snapshot: UiSnapshot,
    actions: readonly DiscoveredAction[],
    field: string,
    value: string,
    context: VerificationContext,
    expected: string[],
    budget: VerifierBudget,
    affected: readonly ApplicationRule[],
  ): Promise<{ snapshot: UiSnapshot; navigated: boolean } | undefined> {
    const before = observeFields(snapshot.elements);
    const observation = before.find((entry) => (entry.control ?? entry.fieldId) === field);
    if (!observation || observation.disabled || observation.readonly || observation.sensitive)
      return undefined;
    const action = actionFor(actions, observation);
    if (!action) return undefined;
    if (!this.deps.allowed(action)) {
      for (const rule of affected)
        if (
          this.graph.block(
            rule,
            'BLOCKED_BY_POLICY',
            `changing "${field}" is not allowed by the safety policy`,
          )
        )
          this.deps.onEvent('RULE_BLOCKED_BY_POLICY', `${rule.name}: changing "${field}" is not allowed`);
      return undefined;
    }
    const original = this.originalOf(observation);
    if (original === undefined) return undefined;
    // Une valeur venue du serveur, d'une API ou d'un profil n'est jamais changée par la vérification :
    // VÉRIFIER une règle ne veut pas dire MODIFIER un champ prérempli (seule l'observation passive s'applique).
    if (this.prefilled?.(observation) === true) return undefined;
    if (expected.length > 0)
      this.deps.onEvent('RULE_VERIFICATION_STARTED', `${field} = ${value}: expecting ${expected.join('; ')}`);
    const url = new URL(page.url()).pathname;
    const windowId = `rule-verify-${field}-${String(this.deps.now())}`;
    this.deps.network.start(windowId);
    const set = await this.setValue(page, actions, observation, value);
    if (!set) {
      this.deps.network.stop(windowId);
      return undefined;
    }
    await this.deps.settle(page);
    const after = await this.deps.observe(page);
    const exchanges = this.deps.network.stop(windowId);
    const navigated = safePath(page.url()) !== url;
    const windowApis = new Set(
      exchanges
        .filter((exchange) => exchange.resourceType === 'xhr' || exchange.resourceType === 'fetch')
        .map(apiOfExchange),
    );
    if (!navigated) {
      // Le vérificateur sait ce qu'il vient de poser : « age < 18 » se lit sur sa propre valeur.
      const facts = this.facts(after, {
        apisSeen: windowApis,
        changed: new Set([field]),
        knownValue: (fieldId) => (fieldId === observation.fieldId ? value : this.deps.knownValue(fieldId)),
      });
      for (const rule of affected) this.evaluate(rule, facts, 'ACTIVE', context);
      const afterFields = observeFields(after.elements);
      const changes = diffFormStates(before, afterFields);
      // Un calcul se vérifie par son effet : la cible a changé quand une de ses entrées a changé.
      for (const rule of affected)
        rule.effects.forEach((effect, index) => {
          if (
            effect.kind !== 'CALCULATE_VALUE' ||
            effect.target.kind !== 'FIELD' ||
            !(effect.inputs ?? []).includes(field)
          )
            return;
          const target = effect.target.control ?? effect.target.name;
          const recalculated = changes.some(
            (change) => (change.control ?? change.fieldId) === target && change.change === 'VALUE_CHANGED',
          );
          const statusBefore = rule.status;
          this.graph.record(rule, {
            at: new Date().toISOString(),
            effect: index,
            verdict: recalculated ? 'CONFIRMED' : 'INCONCLUSIVE',
            conditionHeld: true,
            mode: 'ACTIVE',
            detail: recalculated
              ? `${target} recalculated when ${field} changed`
              : `${target} unchanged when ${field} changed`,
          });
          if (rule.status !== statusBefore)
            this.deps.onEvent(
              rule.status === 'RUNTIME_CONFIRMED' ? 'RULE_RUNTIME_CONFIRMED' : 'RULE_COVERAGE_UPDATED',
              `${rule.name}: ${rule.status}`,
            );
        });
      const found = this.dependencies.infer(field, changes, exchanges, {
        triggerValue: value,
        derived: (target) =>
          afterFields.find((entry) => (entry.control ?? entry.fieldId) === target)?.readonly === true,
      });
      for (const edge of uniqueEdges(found))
        this.deps.onEvent(
          'FIELD_DEPENDENCY_DISCOVERED',
          `${edge.from} → ${edge.to} (${edge.kind}${edge.triggerValue ? `, ${edge.from} = ${edge.triggerValue}` : ''})`,
        );
    } else {
      for (const rule of affected)
        this.deps.onEvent(
          'RULE_VERIFICATION_INCONCLUSIVE',
          `${rule.name}: the page navigated when "${field}" changed`,
        );
      return { snapshot: after, navigated: true };
    }
    // Rétablir la valeur d'origine, puis relire (le sens inverse des liaisons du gabarit).
    await this.setValue(page, actions, observation, original);
    await this.deps.settle(page);
    const restored = await this.deps.observe(page);
    if (safePath(page.url()) !== url) return { snapshot: restored, navigated: true };
    const facts = this.facts(restored, { changed: new Set([field]) });
    for (const rule of affected) this.evaluate(rule, facts, 'ACTIVE', context);
    return { snapshot: restored, navigated: false };
  }

  /** La valeur d'origine, si on sait la rétablir : code d'option, case, vide, ou valeur connue. */
  private originalOf(observation: FieldObservation): string | undefined {
    if (observation.kind === 'select') return observation.value?.code ?? '';
    if (observation.kind === 'radio') return observation.value?.code;
    if (observation.kind === 'checkbox') return observation.value?.checked ? 'true' : 'false';
    if (observation.kind !== 'text') return undefined;
    if (!observation.hasValue) return '';
    const known = this.deps.knownValue(observation.fieldId);
    if (known !== undefined) return known;
    const literal = observation.control ? this.deps.staticDefault(observation.control) : undefined;
    if (literal !== undefined && observation.value?.digest === valueDigest(String(literal), this.deps.salt))
      return String(literal);
    // Une valeur inconnue (profil, serveur) n'est jamais écrasée : on ne saurait pas la rétablir.
    return undefined;
  }

  private async setValue(
    page: Page,
    actions: readonly DiscoveredAction[],
    observation: FieldObservation,
    value: string,
  ): Promise<boolean> {
    try {
      if (observation.kind === 'radio') {
        const radio = actions.find(
          (action) =>
            action.field?.choiceValue === value &&
            (action.field.frameworkName ?? action.field.name) ===
              (observation.control ?? observation.fieldId),
        );
        if (!radio) return false;
        await (await resolveLocator(page, radio)).check({ timeout: 3000 });
        return true;
      }
      const action = actionFor(actions, observation);
      if (!action) return false;
      const locator = await resolveLocator(page, action);
      if (observation.kind === 'select') {
        if (action.field?.customSelect) return false;
        await locator.selectOption(value === '' ? { index: 0 } : { value }, { timeout: 3000 });
      } else if (observation.kind === 'checkbox')
        await locator.setChecked(value === 'true', { timeout: 3000 });
      else await locator.fill(value, { timeout: 3000 });
      return true;
    } catch {
      return false;
    }
  }
}

function flatten(conditions: readonly RuleCondition[]): RuleCondition[] {
  return conditions.flatMap((condition) =>
    condition.kind === 'AND' || condition.kind === 'OR' ? flatten(condition.items) : [condition],
  );
}

/** Une liaison du gabarit confirmée dans un sens seulement : le sens inverse reste à voir. */
function needsNegative(rule: ApplicationRule): boolean {
  if (rule.status !== 'RUNTIME_CONFIRMED') return false;
  return rule.effects.some(
    (effect, index) =>
      effect.bidirectional &&
      !(rule.observations ?? []).some((entry) => entry.effect === index && !entry.conditionHeld),
  );
}

function actionFor(
  actions: readonly DiscoveredAction[],
  observation: FieldObservation,
): DiscoveredAction | undefined {
  const key = observation.control ?? observation.fieldId;
  return actions.find(
    (action) =>
      (action.type === 'fill' ||
        action.type === 'select' ||
        action.type === 'check' ||
        action.type === 'uncheck') &&
      (action.field?.frameworkName === key ||
        action.field?.name === key ||
        action.label === observation.label),
  );
}

/** Le localisateur préféré ; s'il ne trouve rien, le CSS de repli (comme l'exécuteur). */
async function resolveLocator(page: Page, action: DiscoveredAction): Promise<Locator> {
  const base = toLocator(page, action.locator);
  const primary = action.locator.nth !== undefined ? base.nth(action.locator.nth) : base.first();
  if ((await primary.count().catch(() => 0)) > 0 || !action.fallback) return primary;
  return toLocator(page, action.fallback).first();
}

function safePath(url: string): string {
  try {
    return new URL(url).pathname;
  } catch {
    return url;
  }
}

function uniqueEdges(edges: readonly FieldDependency[]): FieldDependency[] {
  return [...new Map(edges.map((edge) => [edge.id, edge])).values()];
}

/** Le contexte d'une contradiction : où, pour qui, dans quel état — jamais une valeur saisie. */
function contextOf(
  context: VerificationContext,
  fields: readonly FieldObservation[],
): Record<string, string> {
  return {
    route: context.route,
    ...(context.version ? { version: context.version } : {}),
    ...(context.environment ? { environment: context.environment } : {}),
    ...(context.role ? { role: context.role } : {}),
    formState: fields
      .slice(0, 12)
      .map(
        (field) =>
          `${field.control ?? field.fieldId}=${field.value?.code ?? (field.hasValue ? 'filled' : 'empty')}`,
      )
      .join(', '),
  };
}
