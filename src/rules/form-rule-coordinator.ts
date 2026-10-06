import type { Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { decideFieldAction, type FieldActionDecision, type FieldState } from '../forms/state/field-state.js';
import {
  FieldDependencyGraph,
  diffFormStates,
  type FieldDependency,
} from '../forms/state/field-dependencies.js';
import type { FormKnowledgeObserver } from '../forms/state/form-knowledge-observer.js';
import {
  FormStateAnalyzer,
  observeFields,
  type ProvenanceContext,
} from '../forms/state/form-state-analyzer.js';
import type { CrawlerValueMemory, ResponseValueIndex } from '../forms/state/value-sources.js';
import type { RuleKnowledgeStore } from '../knowledge/rule-knowledge-store.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { NetworkExchange } from '../model/network.js';
import type { PageContext } from '../model/page-context.js';
import type { UiSnapshot } from '../model/ui-snapshot.js';
import type { StaticKnowledge } from '../static-analysis/static-knowledge.js';
import {
  describeConditions,
  describeEffect,
  type ApplicationRule,
  type RuleCategory,
} from '../static-analysis/rules/rule-model.js';
import { RuleGraph, type RuleCoverageSummary } from './rule-graph.js';
import { RuntimeRuleVerifier, type RuleEvent, type VerifierBudget } from './runtime-rule-verifier.js';

export interface FieldStateReport {
  fieldId: string;
  label?: string;
  state: FieldState['state'];
  origin?: string;
  confidence?: number;
  /** GET /api/profile → email, champ source, calcul (jamais une valeur). */
  source?: string;
  decision: FieldActionDecision['decision'];
  reason: string;
}

export interface RuleReportItem {
  id: string;
  name: string;
  category: RuleCategory;
  component?: string;
  conditions: string;
  effects: { text: string; verdict: string }[];
  status: ApplicationRule['status'];
  coverage: string;
  blockedReason?: string;
  confidence: 'HIGH' | 'MEDIUM' | 'LOW';
  /** fichier:ligne — preuve (@if, Validators.required). */
  evidence: string[];
  /** Ce que le runtime a vu (les dernières observations). */
  runtime: string[];
  /** Effets sur les requêtes (companyNumber envoyé dans POST /api/accounts). */
  network: string[];
  /** Ce qu'un run précédent en disait (jamais une preuve). */
  history?: string;
  /** Contexte d'une contradiction (route, version, état du formulaire). */
  contradiction?: Record<string, string>;
}

export interface FormRulesSummary {
  /** Règles activées (la section s'affiche même vide, avec la raison). */
  rulesEnabled?: boolean;
  fieldStates: { stateId: string; route: string; fields: FieldStateReport[] }[];
  dependencies: FieldDependency[];
  rules?: {
    coverage: RuleCoverageSummary;
    items: RuleReportItem[];
    tree: ReturnType<RuleGraph['tree']>;
    technicalConditions: number;
  };
}

export interface CoordinatorDependencies {
  config: ScenarioConfig;
  salt: string;
  network: FormKnowledgeObserver;
  responses: ResponseValueIndex;
  crawlerValues: CrawlerValueMemory;
  observe(page: Page): Promise<UiSnapshot>;
  settle(page: Page): Promise<void>;
  allowed(action: DiscoveredAction): boolean;
  submitAllowed: boolean;
  emit(event: RuleEvent, message: string): void;
  store?: RuleKnowledgeStore;
  version?: string;
  environment?: string;
  now?: () => number;
}

const CATEGORY_KEYS: Record<RuleCategory, keyof ScenarioConfig['rules']['categories']> = {
  BUSINESS: 'business',
  VISIBILITY: 'visibility',
  ENABLEMENT: 'enablement',
  READONLY: 'readonly',
  VALIDATION: 'validation',
  CALCULATION: 'calculation',
  NAVIGATION: 'navigation',
  PERMISSION: 'permission',
  OPTIONS: 'options',
};

/**
 * Le chef d'orchestre de la compréhension fonctionnelle d'un écran : état des champs
 * et provenance des valeurs (FormStateAnalyzer), règles du code (RuleGraph) confirmées
 * par le navigateur (RuntimeRuleVerifier), dépendances entre champs
 * (FieldDependencyGraph), opportunités pour le moteur de décision. Il n'analyse pas le
 * code lui-même : il utilise ce que l'analyse statique existante a produit.
 */
export class FormRuleCoordinator {
  readonly dependencies = new FieldDependencyGraph();
  private rules: RuleGraph | undefined;
  private verifier: RuntimeRuleVerifier | undefined;
  private knowledge: StaticKnowledge | undefined;
  private readonly analyzer = new FormStateAnalyzer();
  private readonly states = new Map<string, { route: string; fields: FieldStateReport[] }>();
  private readonly understood = new Set<string>();
  private readonly budget: VerifierBudget;
  private technical = 0;
  private readonly now: () => number;

  constructor(private readonly deps: CoordinatorDependencies) {
    this.now = deps.now ?? Date.now;
    const { rules, forms } = deps.config;
    this.budget = {
      verifications: rules.enabled && rules.runtimeVerification ? rules.budgets.maxRuntimeVerifications : 0,
      probes:
        rules.enabled && rules.runtimeVerification && forms.dependencyDiscovery.enabled
          ? forms.dependencyDiscovery.maxFieldMutations
          : 0,
      maxValuesPerField: forms.dependencyDiscovery.maxValuesPerField,
      maxRulesPerPage: rules.budgets.maxRulesPerPage,
      deadline: Number.POSITIVE_INFINITY,
      dependencyDiscovery: forms.dependencyDiscovery.enabled,
    };
  }

  get rulesEnabled(): boolean {
    return this.deps.config.rules.enabled;
  }

  /** La connaissance statique est là (ou enrichie) : les règles du code deviennent le RuleGraph. */
  useStaticKnowledge(knowledge: StaticKnowledge): void {
    this.knowledge = knowledge;
    const settings = this.deps.config.rules;
    if (!settings.enabled || !settings.staticDiscovery) return;
    const previous = new Map((this.rules?.all() ?? []).map((rule) => [rule.signature, rule]));
    const categories = Object.fromEntries(
      Object.entries(CATEGORY_KEYS).map(([category, key]) => [category, settings.categories[key]]),
    ) as Partial<Record<RuleCategory, boolean>>;
    const rules = (knowledge.graph.rules ?? []).map((rule) => {
      const known = previous.get(rule.signature);
      // Un enrichissement (chunk chargé à la demande) garde ce que le runtime a déjà vu.
      return known
        ? {
            ...rule,
            status: known.status,
            coverage: known.coverage,
            observations: known.observations,
            effectVerdicts: known.effectVerdicts,
            ...(known.blockedReason ? { blockedReason: known.blockedReason } : {}),
          }
        : rule;
    });
    this.rules = new RuleGraph(rules, categories);
    this.technical = knowledge.graph.technicalConditions?.length ?? 0;
    this.dependencies.addRules(this.rules.all());
    this.verifier = new RuntimeRuleVerifier(
      this.rules,
      this.dependencies,
      {
        observe: (page) => this.deps.observe(page),
        settle: (page) => this.deps.settle(page),
        allowed: (action) => this.deps.allowed(action),
        network: {
          start: (id) => {
            this.deps.network.start(id);
          },
          stop: (id) => this.deps.network.stop(id),
        },
        apisSeen: this.deps.network.apisSeen,
        salt: this.deps.salt,
        knownValue: (fieldId) => this.knownValue(fieldId),
        staticDefault: (control) =>
          knowledge.graph.valueSources?.find(
            (source) => source.control === control && source.origin === 'FORM_DEFAULT',
          )?.literal,
        submitAllowed: this.deps.submitAllowed,
        onEvent: (event, message) => {
          this.deps.emit(event, message);
        },
        now: this.now,
      },
      (observation) => {
        const component = this.currentComponent;
        const state = this.analyzer.stateOf(observation, this.provenanceContext('verification', component));
        return state.state === 'PREFILLED' || state.state === 'AUTOFILLED';
      },
    );
    if (previous.size === 0) {
      for (const rule of this.rules.all().slice(0, 50))
        this.deps.emit(
          'RULE_DISCOVERED',
          `${rule.name}: IF ${describeConditions(rule.conditions)} → ${rule.effects.map(describeEffect).join('; ')}`,
        );
      const byCategory = Object.entries(this.rules.coverage().byCategory)
        .map(([category, entry]) => `${category} ${String(entry.discovered)}`)
        .join(', ');
      this.deps.emit(
        'RULE_CLASSIFIED',
        `${String(this.rules.all().length)} rule(s): ${byCategory || 'none'}; ${String(this.technical)} technical condition(s) not classified as rules`,
      );
    }
    if (this.deps.config.rules.budgets.maxDurationMs > 0 && this.budget.deadline === Number.POSITIVE_INFINITY)
      this.budget.deadline = this.now() + this.deps.config.rules.budgets.maxDurationMs;
  }

  private currentComponent: string | undefined;

  private knownValue(fieldId: string): string | undefined {
    return this.lastTyped.get(fieldId);
  }

  private readonly lastTyped = new Map<string, string>();

  private componentOf(url: string): string | undefined {
    try {
      return this.knowledge?.componentAt(new URL(url).pathname);
    } catch {
      return undefined;
    }
  }

  private provenanceContext(stateId: string, component: string | undefined): ProvenanceContext {
    const sources = this.knowledge?.graph.valueSources ?? [];
    return {
      salt: this.deps.salt,
      stateId,
      staticSources: (control) => {
        const all = sources.filter((source) => source.control === control);
        const local = component ? all.filter((source) => source.component === component) : [];
        return local.length > 0 ? local : all;
      },
      derived: (fieldId, control) => {
        const from = this.dependencies.derivedFrom(control ?? fieldId);
        return from ? { from } : undefined;
      },
      responses: this.deps.responses,
      crawlerValues: this.deps.crawlerValues,
    };
  }

  /**
   * Comprendre un écran (une fois par état) : l'état et la provenance de chaque champ,
   * puis les règles de son composant — observées, et vérifiées activement dans les
   * budgets. navigated : la page a changé d'adresse, l'explorateur doit relire l'écran.
   */
  async understand(page: Page, snapshot: UiSnapshot, context: PageContext): Promise<{ navigated: boolean }> {
    if (this.understood.has(context.stateId)) return { navigated: false };
    this.understood.add(context.stateId);
    const component = this.componentOf(snapshot.url);
    this.currentComponent = component;
    this.recordStates(context.stateId, context.route, snapshot, component);
    const verifier = this.verifier;
    if (!verifier || !this.rules || !component) return { navigated: false };
    const verification = {
      component,
      route: context.route,
      stateId: context.stateId,
      ...(this.deps.version ? { version: this.deps.version } : {}),
      ...(this.deps.environment ? { environment: this.deps.environment } : {}),
    };
    verifier.passive(snapshot, verification, this.budget);
    if (!this.deps.config.rules.runtimeVerification) return { navigated: false };
    const result = await verifier.active(page, snapshot, context.actions, verification, this.budget);
    this.deps.emit('RULE_COVERAGE_UPDATED', `rule coverage: ${this.rules.coverage().verified} verified`);
    return { navigated: result.navigated };
  }

  private recordStates(
    stateId: string,
    route: string,
    snapshot: UiSnapshot,
    component: string | undefined,
  ): void {
    const states = this.analyzer.analyze(snapshot.elements, this.provenanceContext(stateId, component));
    if (states.length === 0 || this.states.size >= 30) return;
    const preserve = this.deps.config.forms.preserveExistingValues;
    this.states.set(stateId, {
      route,
      fields: states.slice(0, 40).map((state) => {
        const decision = decideFieldAction(state, { preserveExisting: preserve });
        const provenance = state.provenance;
        const source = provenance
          ? provenance.sourceApi
            ? `${provenance.sourceApi}${provenance.sourceProperty ? ` → ${provenance.sourceProperty}` : ''}`
            : provenance.sourceField
          : undefined;
        return {
          fieldId: state.fieldId,
          ...(state.label ? { label: state.label } : {}),
          state: state.state,
          ...(provenance ? { origin: provenance.origin, confidence: provenance.confidence } : {}),
          ...(source ? { source } : {}),
          decision: decision.decision,
          reason: decision.explanation,
        };
      }),
    });
  }

  /**
   * Après une action du crawler sur un champ : la valeur qu'il a saisie (ses données de
   * test), ce qui a changé ailleurs (dépendances), et les règles de ce champ revues.
   */
  afterAction(input: {
    action: DiscoveredAction;
    value?: string;
    before: UiSnapshot | undefined;
    after: UiSnapshot | undefined;
    stateId: string;
    route: string;
    network: readonly NetworkExchange[];
  }): void {
    const field = input.action.field;
    if (!field || !input.before || !input.after) return;
    const key = field.frameworkName ?? field.name ?? input.action.label ?? input.action.id;
    if (input.value !== undefined && !input.action.risks.includes('sensitive-data')) {
      this.deps.crawlerValues.record({ fieldId: key, stateId: input.stateId, value: input.value });
      this.lastTyped.set(key, input.value);
    }
    if (!this.deps.config.forms.dependencyDiscovery.enabled) return;
    const beforeFields = observeFields(input.before.elements);
    const afterFields = observeFields(input.after.elements);
    const found = this.dependencies.infer(key, diffFormStates(beforeFields, afterFields), input.network, {
      ...(input.value !== undefined && input.action.type === 'select' ? { triggerValue: input.value } : {}),
      derived: (target) =>
        afterFields.find((entry) => (entry.control ?? entry.fieldId) === target)?.readonly === true,
    });
    for (const edge of new Map(found.map((entry) => [entry.id, entry])).values())
      this.deps.emit('FIELD_DEPENDENCY_DISCOVERED', `${edge.from} → ${edge.to} (${edge.kind})`);
    const component = this.componentOf(input.after.url);
    if (this.verifier && component)
      this.verifier.passive(
        input.after,
        { component, route: input.route, stateId: input.stateId },
        this.budget,
      );
  }

  /** Ce qu'une action de champ vérifierait (signal ruleCoverageOpportunity du moteur de décision). */
  opportunityOf(
    action: DiscoveredAction,
    context: PageContext,
  ):
    | {
        field: string;
        value?: string;
        expectations: string[];
        influence?: { dependencies: number; unverifiedRules: number; level: string };
      }
    | undefined {
    if (!this.rules || !this.deps.config.rules.influenceDecisionEngine) return undefined;
    if (action.type !== 'select' && action.type !== 'fill' && action.type !== 'check') return undefined;
    const field = action.field?.frameworkName ?? action.field?.name;
    if (!field) return undefined;
    const component = this.componentOf(context.url);
    const value = this.valueFor(field, action);
    const opportunity = this.rules.opportunity(field, {
      ...(value !== undefined ? { value } : {}),
      ...(component ? { component } : {}),
    });
    if (!opportunity) return undefined;
    const unverified = this.rules.withConditionOn(field).filter((rule) => this.rules?.isOpen(rule)).length;
    const influence = this.dependencies.influence(field, unverified);
    return {
      field,
      ...(value !== undefined ? { value } : {}),
      expectations: opportunity.expectations,
      influence,
    };
  }

  /** La valeur qui réalise une condition ouverte (une option de la liste), s'il y en a une. */
  valueFor(field: string, action: DiscoveredAction): string | undefined {
    const candidates = this.rules?.targetValues(field) ?? [];
    const options = action.field?.optionValues ?? action.field?.options ?? [];
    const current = action.field?.selectedValue;
    return candidates.find(
      (value) =>
        value !== current &&
        (action.type !== 'select' || options.some((option) => option.toLowerCase() === value.toLowerCase())),
    );
  }

  /**
   * L'action est choisie pour couvrir des règles : la valeur qui réalise leur condition
   * remplace la donnée de test, et la décision est expliquée (ACTION SELECTED …).
   */
  ruleValueFor(action: DiscoveredAction, context: PageContext): string | undefined {
    const opportunity = this.opportunityOf(action, context);
    if (!opportunity?.value) return undefined;
    this.deps.emit(
      'RULE_COVERAGE_OPPORTUNITY',
      `ACTION SELECTED ${action.type} ${opportunity.field}=${opportunity.value} — reason RULE_COVERAGE; expected: ${opportunity.expectations.slice(0, 5).join('; ')}; risk LOW`,
    );
    // L'exécuteur choisit une option par son libellé : le code de la condition (BUSINESS) → « Entreprise ».
    const codes = action.field?.optionValues ?? [];
    const labels = action.field?.options ?? [];
    const index = codes.findIndex((code) => code.toLowerCase() === (opportunity.value ?? '').toLowerCase());
    return index >= 0 ? (labels[index] ?? opportunity.value) : opportunity.value;
  }

  /** Les règles du RuleGraph, avec leur statut du run (objectifs de test RULE / PERMISSION). */
  ruleList(): readonly ApplicationRule[] {
    return this.rules?.all() ?? [];
  }

  summary(): FormRulesSummary {
    const rules = this.rules;
    return {
      fieldStates: [...this.states.entries()].map(([stateId, entry]) => ({ stateId, ...entry })),
      dependencies: this.dependencies.all().slice(0, 150),
      ...(rules
        ? {
            rules: {
              coverage: rules.coverage(),
              items: rules
                .all()
                .slice(0, 150)
                .map((rule) => this.reportOf(rule)),
              tree: rules.tree(),
              technicalConditions: this.technical,
            },
          }
        : {}),
    };
  }

  private reportOf(rule: ApplicationRule): RuleReportItem {
    const history = this.deps.store?.recall(rule.signature);
    const contradiction = (rule.observations ?? []).find(
      (entry) => entry.verdict === 'CONTRADICTED',
    )?.context;
    return {
      id: rule.id,
      name: rule.name,
      category: rule.category,
      ...(rule.component ? { component: rule.component } : {}),
      conditions: describeConditions(rule.conditions),
      effects: rule.effects.map((effect, index) => ({
        text: describeEffect(effect),
        verdict: rule.effectVerdicts?.[index] ?? 'NOT_VERIFIED',
      })),
      status: rule.status,
      coverage: rule.coverage ?? 'NOT_VERIFIED',
      ...(rule.blockedReason ? { blockedReason: rule.blockedReason } : {}),
      confidence: rule.confidence >= 0.8 ? 'HIGH' : rule.confidence >= 0.6 ? 'MEDIUM' : 'LOW',
      evidence: rule.evidence
        .slice(0, 4)
        .map(
          (entry) =>
            `${entry.provenance?.location ? `${entry.provenance.location.file}:${String(entry.provenance.location.line)} ` : ''}${entry.value}`,
        ),
      runtime: (rule.observations ?? [])
        .slice(-4)
        .map((entry) => `${entry.mode} ${entry.verdict}: ${entry.detail}`),
      network: rule.effects
        .filter(
          (effect) =>
            effect.kind === 'INCLUDE_IN_REQUEST' ||
            effect.kind === 'API_REQUEST_EXPECTED' ||
            (effect.kind === 'SET_OPTIONS' && effect.api),
        )
        .map(describeEffect),
      ...(history
        ? {
            history: `${history.status} (${history.version ?? history.commit ?? 'earlier run'}${history.sameVersion ? '' : ', not current — needs a new confirmation'})`,
          }
        : {}),
      ...(contradiction ? { contradiction } : {}),
    };
  }

  async persist(): Promise<void> {
    if (this.rules && this.deps.store) await this.deps.store.save(this.rules.all()).catch(() => undefined);
  }
}
