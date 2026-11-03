import type { Browser } from 'playwright';
import { parse as parseYaml } from 'yaml';
import type {
  CodeIndex,
  Evidence,
  Experiment,
  Hypothesis,
  Incident,
  PolicyDecision,
  PolicyOperation,
  RegressionTestProposal,
} from '../../sdk/core/incident-contracts.js';
import {
  DEFAULT_CONFIDENCE_THRESHOLD,
  DEFAULT_TRIGGER_BUDGET,
  MAX_TRIAL_EVENTS_KEPT,
  TRIGGER_BUDGET_CAPS,
  type AngularModel,
  type ExplorationStrategy,
  type IncidentBrief,
  type ReactionSignature,
  type SilentFailureKind,
  type TriggerAction,
  type TriggerEntry,
  type TriggerBudget,
  type TriggerDepth,
  type TriggerRun,
  type TriggerState,
  type TriggerTrial,
  type TriggerUsage,
} from '../../sdk/core/incident-trigger-contracts.js';
import { analyzeDataLoss, analyzeFirstFailure, deriveConditions, proposeRootCauses } from './analysis.js';
import { discoverScope } from './discovery.js';
import { ddmin, factorsById } from './minimize.js';
import { buildCatalog, boostFactors, type ActionCatalog, type Factor } from './model.js';
import { isFunctionalLoss, judge, observeReactions, reactionOf, type ProbeObservation } from './oracle.js';
import { buildTriggerRegression } from './regression.js';
import { ExplorationSession, describeAction, sequenceKey } from './session.js';
import { actionsOf, planTrials, strategiesFor, type StrategyContext, type TrialPlan } from './strategies.js';

/**
 * LE MOTEUR DE DÉCOUVERTE DES DÉCLENCHEURS : un logiciel classique (machine à états, budgets, stratégies
 * ordonnées), pas un agent autonome. Il observe un parcours de référence, perturbe un ou plusieurs facteurs
 * par essai, juge chaque essai par l'oracle, rejoue ce qui reproduit (fréquence), réduit la séquence
 * (delta debugging), dérive les conditions, analyse la première défaillance et la perte de données, puis
 * propose des hypothèses et des vérifications. Tout est persisté après chaque essai (reprise), et la pause
 * comme l'annulation sont coopératives. Le mode déterministe fonctionne sans IA ; l'IA, quand un crochet est
 * fourni, ne fait que proposer des séquences, jouées et jugées comme les autres.
 */
export interface EngineControl {
  cancelled(): boolean;
  paused(): boolean;
  /** Attend la reprise (ou l'annulation). */
  waitWhilePaused(): Promise<void>;
}

export interface TriggerEngineInput {
  runId: string;
  startedBy: string;
  incident: Incident;
  brief: IncidentBrief;
  depth: TriggerDepth;
  budget?: Partial<TriggerBudget>;
  repeats?: number;
  confidenceThreshold?: number;
  baseUrl: string;
  allowedHosts?: string[];
  check: (operation: PolicyOperation) => Promise<PolicyDecision>;
  code?: CodeIndex;
  angular?: AngularModel[];
  scenarios?: { name: string; file: string; text?: string }[];
  /** Les hypothèses déjà présentes (pour ne pas les dupliquer). */
  existingHypotheses: readonly Hypothesis[];
  headless?: boolean;
  browser?: Browser;
  screenshotDir?: string;
  settleMs?: number;
  actionTimeoutMs?: number;
  now?: () => Date;
  control: EngineControl;
  onProgress?: (run: TriggerRun) => Promise<void> | void;
  /** Le crochet IA : des séquences de facteurs (ids connus seulement), ou une erreur, jamais une décision. */
  proposeWithAi?: (context: AiProposalContext) => Promise<string[][]>;
  /** Le run à reprendre (ses essais sont conservés, les séquences jouées ne le sont pas à nouveau). */
  resumeFrom?: TriggerRun;
  /** Le point d'entrée imposé (écran cible) ; absent : la route la plus pertinente de la découverte. */
  entry?: TriggerEntry;
}

export interface AiProposalContext {
  brief: IncidentBrief;
  factors: readonly Factor[];
  trials: readonly TriggerTrial[];
  angular?: AngularModel;
}

export interface TriggerEngineOutcome {
  run: TriggerRun;
  hypotheses: Hypothesis[];
  experiments: Experiment[];
  regression?: RegressionTestProposal;
  regressionLimitations: string[];
}

const DEFAULT_REPEATS: Record<TriggerDepth, number> = { QUICK: 2, STANDARD: 3, DEEP: 5 };

export function resolveTriggerBudget(depth: TriggerDepth, requested?: Partial<TriggerBudget>): TriggerBudget {
  const base = DEFAULT_TRIGGER_BUDGET[depth];
  const out = { ...base };
  for (const key of Object.keys(base) as (keyof TriggerBudget)[]) {
    const value = requested?.[key];
    if (typeof value === 'number' && Number.isFinite(value) && value > 0)
      out[key] = Math.min(value, TRIGGER_BUDGET_CAPS[key]);
  }
  return out;
}

const ZERO_USAGE: TriggerUsage = {
  durationMs: 0,
  trials: 0,
  actions: 0,
  repeats: 0,
  experiments: 0,
  events: 0,
  aiCalls: 0,
};

class Cancelled extends Error {
  constructor() {
    super('cancelled');
  }
}

class ScopeStop extends Error {
  constructor(readonly why: string) {
    super(`scope: ${why}`);
  }
}

class BudgetExhausted extends Error {
  constructor(readonly what: string) {
    super(`budget exhausted: ${what}`);
  }
}

export class TriggerEngine {
  readonly run: TriggerRun;
  private readonly now: () => Date;
  private readonly startedAtMs: number;
  private browser?: Browser;
  private ownsBrowser = false;
  private catalog?: ActionCatalog;
  private entry: TriggerAction[] = [];
  private played = new Set<string>();
  private readonly errorFactors = new Set<string>();
  private readonly reproducingFactors = new Set<string>();
  private readonly target: SilentFailureKind[];
  private aiProposals: Factor[][] = [];
  private aiAsked = false;
  private readonly repeats: number;
  private readonly threshold: number;
  private hypotheses: Hypothesis[] = [];
  private experiments: Experiment[] = [];
  private plansSeen = 0;

  constructor(private readonly input: TriggerEngineInput) {
    this.now = input.now ?? (() => new Date());
    this.startedAtMs = this.now().getTime();
    this.repeats = Math.max(1, Math.min(input.repeats ?? DEFAULT_REPEATS[input.depth], 50));
    this.threshold = input.confidenceThreshold ?? DEFAULT_CONFIDENCE_THRESHOLD;
    this.target = input.brief.suspectedFailures.filter(isFunctionalLoss);
    const startedAt = this.now().toISOString();
    // Le run repris est copié : celui qu'on nous a donné reste intact (persisté tel quel par l'appelant).
    const previous = input.resumeFrom ? structuredClone(input.resumeFrom) : undefined;
    this.run = previous
      ? {
          ...previous,
          state: 'INITIALIZING',
          updatedAt: startedAt,
          // Une reprise peut élargir le budget (plafonds respectés) ; sinon celui du run repris est conservé.
          budget: input.budget
            ? resolveTriggerBudget(previous.depth, { ...previous.budget, ...input.budget })
            : previous.budget,
          usage: { ...previous.usage },
          limitations: [
            ...previous.limitations,
            `reprise le ${startedAt} après « ${previous.stopReason ?? previous.state} »`,
          ],
        }
      : {
          id: input.runId,
          depth: input.depth,
          state: 'INITIALIZING',
          startedAt,
          updatedAt: startedAt,
          startedBy: input.startedBy,
          budget: resolveTriggerBudget(input.depth, input.budget),
          usage: { ...ZERO_USAGE },
          brief: input.brief,
          strategies: [],
          trials: [],
          reference: {},
          conditions: [],
          hypothesisIds: [],
          pendingExperimentIds: [],
          coverage: [],
          limitations: [],
        };
    delete this.run.finishedAt;
    delete this.run.error;
    delete this.run.stopReason;
    for (const trial of this.run.trials) this.played.add(trial.key);
  }

  // ── Cycle de vie ───────────────────────────────────────────────────────────────────────────

  async execute(): Promise<TriggerEngineOutcome> {
    try {
      await this.transition('DISCOVERING_SCOPE');
      await this.discover();
      await this.transition('EXPLORING_TRIGGERS');
      await this.openBrowser();
      await this.reference();
      const reproduced = await this.explore();
      if (reproduced) {
        await this.transition('CONFIRMING_REPRODUCTION');
        await this.confirm(reproduced);
        await this.transition('MINIMIZING');
        await this.minimize(reproduced);
        await this.transition('ANALYZING_ROOT_CAUSE');
        this.analyze(reproduced);
        await this.transition('VERIFYING_HYPOTHESES');
        await this.verify();
      } else {
        this.run.conditions = deriveConditions(
          this.run.trials,
          this.catalog?.factors ?? [],
          undefined,
          this.threshold,
        );
      }
      this.coverage();
      await this.finish(
        this.run.pendingExperimentIds.length > 0
          ? 'WAITING_FOR_APPROVAL'
          : reproduced
            ? 'COMPLETED'
            : 'INCONCLUSIVE',
        reproduced ? undefined : 'aucune séquence explorée n’a reproduit la perte de réaction',
      );
    } catch (error) {
      if (error instanceof Cancelled) {
        this.coverage();
        await this.finish('CANCELLED', 'annulé par une personne ; rapport partiel');
      } else if (error instanceof ScopeStop) {
        this.run.limitations.push(error.why);
        this.coverage();
        await this.finish('INCONCLUSIVE', `périmètre : ${error.why}`);
      } else if (error instanceof BudgetExhausted) {
        this.coverage();
        const reproduced = this.firstReproduced();
        if (reproduced && this.run.hypothesisIds.length === 0) {
          this.run.limitations.push(
            `budget épuisé (${error.what}) avant la fin de l’analyse : analyse faite sur les essais disponibles`,
          );
          this.analyze(reproduced);
        }
        await this.finish(reproduced ? 'COMPLETED' : 'INCONCLUSIVE', `budget épuisé : ${error.what}`);
      } else {
        this.run.error = error instanceof Error ? error.message : String(error);
        this.coverage();
        await this.finish('FAILED', `erreur du moteur : ${this.run.error}`);
      }
    } finally {
      await this.closeBrowser();
    }
    let regression: RegressionTestProposal | undefined;
    const regressionLimitations: string[] = [];
    if (this.run.minimal || this.firstReproduced()) {
      try {
        const built = buildTriggerRegression(this.input.incident, this.run);
        regression = built.proposal;
        regressionLimitations.push(
          ...built.unexpressed.map((item) => `non exprimable dans un flow : ${item}`),
        );
      } catch (error) {
        regressionLimitations.push(
          `test de non-régression non généré : ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return {
      run: this.run,
      hypotheses: this.hypotheses,
      experiments: this.experiments,
      regression,
      regressionLimitations,
    };
  }

  private async transition(state: TriggerState): Promise<void> {
    await this.checkpoint();
    this.run.state = state;
    this.run.updatedAt = this.now().toISOString();
    await this.input.onProgress?.(this.run);
  }

  /** Annulation et pause coopératives, budget de durée. */
  private async checkpoint(): Promise<void> {
    if (this.input.control.cancelled()) throw new Cancelled();
    if (this.input.control.paused()) {
      const previous = this.run.state;
      this.run.state = 'PAUSED';
      this.run.updatedAt = this.now().toISOString();
      await this.input.onProgress?.(this.run);
      await this.input.control.waitWhilePaused();
      if (this.input.control.cancelled()) throw new Cancelled();
      this.run.state = previous;
    }
    this.run.usage.durationMs =
      this.now().getTime() - this.startedAtMs + (this.input.resumeFrom?.usage.durationMs ?? 0);
    if (this.run.usage.durationMs > this.run.budget.maxDurationMs)
      throw new BudgetExhausted('durée maximale');
  }

  private async finish(state: TriggerState, stopReason?: string): Promise<void> {
    this.run.state = state;
    if (stopReason) this.run.stopReason = stopReason;
    this.run.updatedAt = this.now().toISOString();
    this.run.finishedAt = this.run.updatedAt;
    this.run.usage.durationMs =
      this.now().getTime() - this.startedAtMs + (this.input.resumeFrom?.usage.durationMs ?? 0);
    await this.input.onProgress?.(this.run);
  }

  private async openBrowser(): Promise<void> {
    if (this.input.browser) {
      this.browser = this.input.browser;
      return;
    }
    const { chromium } = await import('playwright');
    this.browser = await chromium.launch({ headless: this.input.headless ?? true, handleSIGINT: false });
    this.ownsBrowser = true;
  }

  private async closeBrowser(): Promise<void> {
    if (this.ownsBrowser && this.browser) await this.browser.close().catch(() => undefined);
    this.browser = undefined;
  }

  // ── Périmètre et référence ─────────────────────────────────────────────────────────────────

  private async discover(): Promise<void> {
    const angular = this.input.angular ?? [];
    this.run.angular = angular[0];
    this.run.scope = await discoverScope({
      incident: this.input.incident,
      brief: this.input.brief,
      code: this.input.code,
      angular,
      scenarios: this.input.scenarios,
      check: this.input.check,
      baseUrl: this.input.baseUrl,
      now: this.now().toISOString(),
    });
    const base = this.input.baseUrl.replace(/\/$/, '');
    const imposed = this.input.entry ?? this.run.entry;
    if (imposed && imposed.actions.length > 0) {
      // L'écran cible : son parcours vérifié (navigation, clics sur des liens) est rejoué avant chaque essai.
      this.entry = imposed.actions;
      this.run.entry = imposed;
      this.run.limitations.push(
        `point d'entrée imposé : écran cible ${imposed.route} (${String(imposed.actions.length)} action(s) de parcours)`,
      );
    } else {
      const routes = this.run.scope.resources
        .filter((resource) => resource.kind === 'ROUTE' && resource.status === 'AUTHORIZED')
        .sort((a, b) => b.relevance - a.relevance || b.ref.length - a.ref.length);
      const route = routes[0]?.ref ?? '/';
      this.entry = [
        {
          kind: 'NAVIGATE',
          target: route.startsWith('http') ? route : `${base}${route.startsWith('/') ? route : `/${route}`}`,
        },
      ];
    }
    // Chaque navigation du parcours d'entrée passe par le Scope Policy Engine : refusée, rien n'est exploré.
    for (const action of this.entry.filter((item) => item.kind === 'NAVIGATE')) {
      const entryUrl = action.target ?? base;
      const navigation = await this.input.check({ kind: 'NAVIGATE', url: entryUrl });
      if (!navigation.allowed)
        throw new ScopeStop(`navigation refusée vers ${entryUrl} : ${navigation.reason}`);
    }
    const denied = this.run.scope.resources.filter((resource) => resource.status === 'DENIED');
    if (denied.length > 0)
      this.run.limitations.push(
        `${String(denied.length)} ressource(s) découverte(s) hors périmètre autorisé (non lues)`,
      );
  }

  private scenarioFills(): TriggerAction[] {
    const scenario = this.run.scope?.resources.find(
      (resource) => resource.kind === 'SCENARIO' && resource.status === 'AUTHORIZED',
    );
    const text = this.input.scenarios?.find(
      (item) => item.name === scenario?.ref || item.file === scenario?.ref,
    )?.text;
    if (!text) return [];
    try {
      const document = parseYaml(text) as { flows?: { steps?: unknown[] }[]; steps?: unknown[] } | undefined;
      const steps = document?.flows?.[0]?.steps ?? document?.steps ?? [];
      const fills: TriggerAction[] = [];
      for (const step of steps) {
        if (typeof step !== 'object' || step === null) continue;
        const fill = (step as { fill?: { label?: string; value?: string } }).fill;
        const select = (step as { select?: { label?: string; option?: string } }).select;
        if (fill?.label && typeof fill.value === 'string')
          fills.push({ kind: 'FILL', target: `label:${fill.label}`, value: fill.value, origin: 'scenario' });
        if (select?.label && typeof select.option === 'string')
          fills.push({
            kind: 'SELECT',
            target: `label:${select.label}`,
            value: select.option,
            origin: 'scenario',
          });
      }
      return fills;
    } catch {
      return [];
    }
  }

  private async reference(): Promise<void> {
    const existing = this.run.trials.find(
      (trial) => trial.strategy === 'REFERENCE' && trial.status === 'DONE',
    );
    const session = this.newSession();
    await session.open();
    try {
      for (const [index, action] of this.entry.entries()) {
        const outcome = await session.perform(action, index);
        if (!outcome.ok)
          throw new Error(`parcours de référence impossible : ${outcome.error ?? describeAction(action)}`);
      }
      const snapshot = await session.snapshot();
      const catalog = buildCatalog(snapshot, {
        scenarioFills: this.scenarioFills(),
        keywords: this.input.brief.keywords,
      });
      boostFactors(
        catalog,
        this.input.brief.knownConditions.map((item) => item.text),
      );
      this.catalog = catalog;
      if (catalog.probes.length === 0) {
        this.run.limitations.push(
          'aucun bouton de soumission ou d’action sûre trouvé sur la page d’entrée : aucune sonde possible',
        );
        throw new BudgetExhausted('aucune sonde');
      }
      if (existing && Object.keys(this.run.reference).length > 0) return; // reprise : la référence est connue
      const plan: TrialPlan = { strategy: 'REFERENCE', factors: [], priority: 1000 };
      const { actions, probes } = actionsOf(plan, catalog, this.entry);
      const trial = await this.playTrial(plan, actions, probes, undefined, session, this.entry.length);
      this.run.trials.push(trial);
      this.played.add(trial.key);
      const reactions: Record<string, ReactionSignature> = {};
      let reacting = 0;
      for (const index of trial.probes) {
        const action = trial.actions[index];
        if (!action) continue;
        const outcome = this.lastOutcomes.get(index);
        if (!outcome) continue;
        const signature = reactionOf(outcome);
        reactions[action.target ?? String(index)] = signature;
        if (
          signature.request ||
          signature.loading ||
          signature.validation ||
          signature.domChange ||
          signature.navigation ||
          signature.message
        )
          reacting += 1;
      }
      this.run.reference = reactions;
      if (reacting === 0)
        this.run.limitations.push(
          'le parcours de référence ne montre aucune réaction aux sondes : les essais ne pourront pas être jugés (INCONCLUSIVE)',
        );
      this.account('REFERENCE', trial);
      await this.input.onProgress?.(this.run);
    } finally {
      await session.close();
    }
  }

  // ── Exploration ────────────────────────────────────────────────────────────────────────────

  private context(): StrategyContext {
    return {
      depth: this.input.depth,
      catalog: this.catalog ?? { probes: [], fills: [], factors: [], destructive: [], fields: [] },
      trials: this.run.trials,
      angular: this.input.angular,
      errorFactors: this.errorFactors,
      reproducingFactors: this.reproducingFactors,
      played: this.played,
      aiProposals: this.aiProposals,
    };
  }

  private async explore(): Promise<TriggerTrial | undefined> {
    const already = this.firstReproduced();
    if (already) return already;
    if (
      Object.values(this.run.reference).every(
        (signature) =>
          !signature.request &&
          !signature.loading &&
          !signature.validation &&
          !signature.domChange &&
          !signature.navigation &&
          !signature.message,
      )
    )
      return undefined;
    const strategies = strategiesFor(this.input.depth);
    let consecutiveInfrastructure = 0;
    for (;;) {
      await this.checkpoint();
      this.ensureBudget();
      let plans = planTrials(this.context(), strategies).filter((plan) => !this.played.has(this.keyOf(plan)));
      // L'IA est sollicitée quand les stratégies déterministes sont épuisées, ou à mi-budget en profondeur DEEP.
      const midway = this.run.usage.trials >= Math.ceil(this.run.budget.maxTrials / 2);
      if ((plans.length === 0 || midway) && strategies.includes('AI_GUIDED') && !this.aiAsked) {
        await this.askAi();
        plans = planTrials(this.context(), strategies).filter((plan) => !this.played.has(this.keyOf(plan)));
      }
      this.plansSeen = Math.max(this.plansSeen, plans.length + this.played.size);
      const plan = plans[0];
      if (!plan) return undefined;
      const trial = await this.runPlan(plan);
      if (trial.verdict === 'TEST_INFRASTRUCTURE_FAILURE' || trial.verdict === 'ENVIRONMENT_FAILURE') {
        consecutiveInfrastructure += 1;
        if (consecutiveInfrastructure >= 5) {
          this.run.limitations.push(
            '5 essais consécutifs en échec d’infrastructure ou d’environnement : exploration arrêtée',
          );
          return undefined;
        }
      } else consecutiveInfrastructure = 0;
      if (trial.verdict === 'FAILURE_REPRODUCED') {
        this.run.state = 'FAILURE_DETECTED';
        await this.input.onProgress?.(this.run);
        return trial;
      }
    }
  }

  private keyOf(plan: TrialPlan): string {
    if (!this.catalog) return '';
    return sequenceKey(actionsOf(plan, this.catalog, this.entry).actions);
  }

  private ensureBudget(): void {
    const { usage, budget } = this.run;
    if (usage.trials >= budget.maxTrials) throw new BudgetExhausted('nombre d’essais');
    if (usage.actions >= budget.maxActions) throw new BudgetExhausted('nombre d’actions');
    if (usage.events >= budget.maxEvents) throw new BudgetExhausted('nombre d’événements');
  }

  private async runPlan(plan: TrialPlan, note?: string): Promise<TriggerTrial> {
    if (!this.catalog) throw new Error('catalog missing');
    const { actions, probes } = actionsOf(plan, this.catalog, this.entry);
    const session = this.newSession();
    await session.open();
    let trial: TriggerTrial;
    try {
      trial = await this.playTrial(plan, actions, probes, this.run.reference, session, 0);
    } finally {
      await session.close();
    }
    if (note) trial.reason = `${note} — ${trial.reason ?? ''}`;
    this.run.trials.push(trial);
    this.played.add(trial.key);
    if (trial.events.some((event) => event.kind === 'PAGE_ERROR'))
      for (const factor of plan.factors) this.errorFactors.add(factor.id);
    if (trial.verdict === 'FAILURE_REPRODUCED')
      for (const factor of plan.factors) this.reproducingFactors.add(factor.id);
    this.account(plan.strategy, trial);
    this.run.resumePoint = { strategy: plan.strategy, trialIndex: this.run.trials.length };
    this.run.updatedAt = this.now().toISOString();
    await this.input.onProgress?.(this.run);
    return trial;
  }

  private account(strategy: ExplorationStrategy, trial: TriggerTrial): void {
    const entry = this.run.strategies.find((item) => item.strategy === strategy);
    const reproduced = trial.verdict === 'FAILURE_REPRODUCED' ? 1 : 0;
    if (entry) {
      entry.trials += 1;
      entry.reproduced += reproduced;
    } else this.run.strategies.push({ strategy, trials: 1, reproduced });
    this.run.usage.trials += 1;
    this.run.usage.actions += trial.cost.actions;
    this.run.usage.events += trial.events.length;
  }

  private readonly lastOutcomes = new Map<number, ProbeObservation['outcome']>();

  /** Joue une séquence dans une session ouverte et la juge ; `skip` : les actions déjà jouées (référence). */
  private async playTrial(
    plan: TrialPlan,
    actions: TriggerAction[],
    probes: number[],
    reference: Record<string, ReactionSignature> | undefined,
    session: ExplorationSession,
    skip: number,
  ): Promise<TriggerTrial> {
    const startedAt = this.now();
    const id = `tr_${String(this.run.trials.length + 1).padStart(3, '0')}`;
    const observations: ProbeObservation[] = [];
    const preparationErrors: string[] = [];
    this.lastOutcomes.clear();
    let before: ProbeObservation['outcome']['before'] | undefined;
    let after: ProbeObservation['outcome']['after'] | undefined;
    let played = skip;
    for (let index = skip; index < actions.length; index += 1) {
      const action = actions[index];
      if (!action) continue;
      if (index === probes[0] && probes.length > 0) {
        // Les sondes ne sont jouées que si la préparation a réussi : sinon l'essai est une erreur d'infrastructure.
        if (preparationErrors.length > 0) break;
      }
      const outcome = await session.perform(action, index);
      played += 1;
      if (probes.includes(index)) {
        before ??= outcome.before;
        after = outcome.after;
        this.lastOutcomes.set(index, outcome);
        observations.push({ index, action, outcome, reference: reference?.[action.target ?? String(index)] });
      } else if (!outcome.ok)
        preparationErrors.push(`${describeAction(action)} : ${outcome.error ?? 'échec'}`);
    }
    const result = judge({
      probes: observations,
      preparationErrors,
      events: session.events,
      target: this.target.length > 0 ? this.target : undefined,
    });
    const firstErrorEvent = session.events.find((event) => event.kind === 'PAGE_ERROR');
    const screenshots: string[] = [];
    if (this.input.screenshotDir && result.verdict === 'FAILURE_REPRODUCED') {
      const file = `${this.input.screenshotDir}/${this.run.id}-${id}.png`;
      if (await session.screenshot(file)) screenshots.push(file);
    }
    const events =
      session.events.length > MAX_TRIAL_EVENTS_KEPT
        ? [...session.events.slice(0, MAX_TRIAL_EVENTS_KEPT - 20), ...session.events.slice(-20)]
        : [...session.events];
    if (session.droppedEvents > 0 || session.events.length > MAX_TRIAL_EVENTS_KEPT)
      this.run.limitations.push(
        `essai ${id} : événements tronqués (${String(session.events.length + session.droppedEvents)} observés, ${String(events.length)} conservés)`,
      );
    const finishedAt = this.now();
    const factors: Record<string, string> = {};
    for (const factor of plan.factors) factors[factor.id] = factor.label;
    return {
      id,
      strategy: plan.strategy,
      factors,
      actions,
      probes,
      startedAt: startedAt.toISOString(),
      finishedAt: finishedAt.toISOString(),
      status: 'DONE',
      verdict: result.verdict,
      reason: result.reason,
      failures: result.failures,
      ...(firstErrorEvent
        ? {
            firstError: {
              eventId: firstErrorEvent.id,
              t: firstErrorEvent.t,
              summary: firstErrorEvent.summary,
              ...(typeof firstErrorEvent.data?.stack === 'string'
                ? { stack: firstErrorEvent.data.stack }
                : {}),
            },
          }
        : {}),
      events,
      snapshots: { ...(before ? { before } : {}), ...(after ? { after } : {}) },
      key: sequenceKey(actions),
      cost: { actions: played - skip, durationMs: finishedAt.getTime() - startedAt.getTime() },
      screenshots,
    };
  }

  private newSession(): ExplorationSession {
    return new ExplorationSession({
      baseUrl: this.input.baseUrl,
      allowedHosts: this.input.allowedHosts,
      headless: this.input.headless ?? true,
      browser: this.browser,
      screenshotDir: this.input.screenshotDir,
      settleMs: this.input.settleMs,
      actionTimeoutMs: this.input.actionTimeoutMs,
      maxEvents: Math.min(2000, Math.max(50, this.run.budget.maxEvents - this.run.usage.events)),
      now: this.now,
    });
  }

  private async askAi(): Promise<void> {
    this.aiAsked = true;
    if (!this.input.proposeWithAi || !this.catalog) return;
    if (this.run.usage.aiCalls >= this.run.budget.maxAiCalls) {
      this.run.limitations.push('budget d’appels IA épuisé : aucune séquence proposée par l’IA');
      return;
    }
    this.run.usage.aiCalls += 1;
    try {
      const proposals = await this.input.proposeWithAi({
        brief: this.input.brief,
        factors: this.catalog.factors,
        trials: this.run.trials,
        angular: this.run.angular,
      });
      const known = this.catalog.factors;
      this.aiProposals = proposals
        .map((ids) => factorsById(ids, known))
        .filter((factors) => factors.length > 0)
        .slice(0, 12);
      if (this.aiProposals.length === 0)
        this.run.limitations.push('l’IA n’a proposé aucune séquence exploitable (facteurs inconnus ou vide)');
    } catch (error) {
      this.run.limitations.push(
        `IA indisponible pour proposer des séquences : ${error instanceof Error ? error.message : String(error)} ; exploration déterministe poursuivie`,
      );
    }
  }

  // ── Confirmation, minimisation ─────────────────────────────────────────────────────────────

  private firstReproduced(): TriggerTrial | undefined {
    return this.run.trials.find(
      (trial) =>
        trial.verdict === 'FAILURE_REPRODUCED' &&
        trial.strategy !== 'MINIMIZATION' &&
        trial.strategy !== 'REPETITION',
    );
  }

  private planOf(trial: TriggerTrial): TrialPlan {
    const factors = factorsById(Object.keys(trial.factors), this.catalog?.factors ?? []);
    return { strategy: trial.strategy, factors, priority: 0 };
  }

  private async confirm(trial: TriggerTrial): Promise<void> {
    if (trial.repeats) return;
    const plan = this.planOf(trial);
    let reproduced = 1;
    let total = 1;
    for (let index = 1; index < this.repeats; index += 1) {
      if (this.run.usage.repeats >= this.run.budget.maxRepeats) {
        this.run.limitations.push('budget de répétitions épuisé : fréquence estimée sur les rejouages faits');
        break;
      }
      await this.checkpoint();
      this.ensureBudget();
      this.run.usage.repeats += 1;
      this.played.delete(this.keyOf(plan));
      const again = await this.runPlan(
        { ...plan, strategy: 'REPETITION' },
        `rejouage ${String(index + 1)}/${String(this.repeats)}`,
      );
      total += 1;
      if (again.verdict === 'FAILURE_REPRODUCED') reproduced += 1;
    }
    trial.repeats = { total, reproduced };
    if (reproduced < total)
      this.run.limitations.push(
        `bug intermittent : la séquence a reproduit ${String(reproduced)} fois sur ${String(total)} ; corrélation observée, pas une causalité démontrée`,
      );
  }

  private async minimize(trial: TriggerTrial): Promise<void> {
    if (!this.catalog) return;
    const factors = factorsById(Object.keys(trial.factors), this.catalog.factors);
    const frequency = trial.repeats ?? { total: 1, reproduced: 1 };
    const attempts = frequency.reproduced < frequency.total ? 2 : 1;
    const preconditions = [
      `page d'entrée : ${this.entry.map(describeAction).join(', ')}`,
      ...this.catalog.fills.map((fill) => `référence : ${describeAction(fill)}`),
    ];
    if (factors.length <= 1) {
      this.run.minimal = {
        actions: trial.actions,
        preconditions,
        frequency,
        fromTrialId: trial.id,
        reducedFrom: factors.length,
        trialIds: [trial.id],
        note: 'un seul facteur : rien à réduire',
      };
      return;
    }
    const trialIds = [trial.id];
    const budgetLeft = () => Math.max(0, Math.min(this.run.budget.maxTrials - this.run.usage.trials, 40));
    const result = await ddmin(
      factors,
      async (candidate) => {
        for (let attempt = 0; attempt < attempts; attempt += 1) {
          await this.checkpoint();
          if (this.run.usage.trials >= this.run.budget.maxTrials) return false;
          const plan: TrialPlan = { strategy: 'MINIMIZATION', factors: [...candidate], priority: 0 };
          const key = this.keyOf(plan);
          const known = this.run.trials.find(
            (item) =>
              item.key === key && item.status === 'DONE' && item.verdict !== 'TEST_INFRASTRUCTURE_FAILURE',
          );
          if (known && known.strategy !== 'MINIMIZATION') {
            trialIds.push(known.id);
            if (known.verdict === 'FAILURE_REPRODUCED') return true;
            continue;
          }
          this.played.delete(key);
          const played = await this.runPlan(plan);
          trialIds.push(played.id);
          if (played.verdict === 'FAILURE_REPRODUCED') return true;
        }
        return false;
      },
      { maxTests: budgetLeft() },
    );
    const minimalPlan: TrialPlan = { strategy: 'MINIMIZATION', factors: result.minimal, priority: 0 };
    const minimalKey = this.keyOf(minimalPlan);
    const minimalTrial =
      this.run.trials
        .filter((item) => item.key === minimalKey && item.verdict === 'FAILURE_REPRODUCED')
        .at(-1) ?? trial;
    this.run.minimal = {
      actions: minimalTrial.actions,
      preconditions,
      frequency: minimalTrial.id === trial.id ? frequency : { total: 1, reproduced: 1 },
      fromTrialId: minimalTrial.id,
      reducedFrom: factors.length,
      trialIds: [...new Set(trialIds)],
      note:
        result.minimal.length < factors.length
          ? `séquence réduite de ${String(factors.length)} à ${String(result.minimal.length)} facteur(s) en ${String(result.tests)} rejouage(s) ; d'autres séquences minimales peuvent exister`
          : `aucun facteur n'a pu être retiré (${String(result.tests)} rejouage(s)) ; d'autres séquences minimales peuvent exister`,
    };
  }

  // ── Analyse, vérifications ─────────────────────────────────────────────────────────────────

  private analyze(trial: TriggerTrial): void {
    const reference = this.run.trials.find((item) => item.strategy === 'REFERENCE');
    const factors = this.catalog?.factors ?? [];
    this.run.conditions = deriveConditions(this.run.trials, factors, this.run.minimal, this.threshold);
    const failing = this.run.trials.find((item) => item.id === this.run.minimal?.fromTrialId) ?? trial;
    this.run.firstFailure = analyzeFirstFailure(
      failing,
      reference,
      this.run.trials.filter((item) => item.verdict === 'FAILURE_REPRODUCED'),
    );
    this.run.dataLoss = analyzeDataLoss(this.input.brief, failing, this.run.angular, this.run.minimal);
    const proposed = proposeRootCauses({
      runId: this.run.id,
      failing,
      reference,
      minimal: this.run.minimal,
      angular: this.run.angular,
      conditions: this.run.conditions,
      existing: [...this.input.existingHypotheses, ...this.hypotheses],
      now: this.now().toISOString(),
    });
    this.hypotheses.push(...proposed.hypotheses);
    this.experiments.push(...proposed.experiments);
    this.run.hypothesisIds = this.hypotheses.map((hypothesis) => hypothesis.id);
    this.run.pendingExperimentIds = this.experiments
      .filter((experiment) => experiment.status === 'APPROVAL_REQUIRED')
      .map((experiment) => experiment.id);
  }

  /** Les vérifications sans effet de bord sont jouées maintenant, dans le budget ; les autres attendent une personne. */
  private async verify(): Promise<void> {
    for (const experiment of this.experiments) {
      if (experiment.status !== 'PROPOSED' || experiment.sideEffects) continue;
      if (experiment.kind !== 'CHECK_VALIDATION') continue; // seules les vérifications jouables par le navigateur
      if (this.run.usage.experiments >= this.run.budget.maxExperiments) {
        this.run.limitations.push(
          'budget d’expériences épuisé : vérifications restantes proposées, non jouées',
        );
        break;
      }
      await this.checkpoint();
      await this.runExperiment(experiment);
    }
  }

  /** Joue une expérience contrôlée (REPLAY, COMPARE_WITH_PASSING, CHECK_VALIDATION) et consigne ses preuves. */
  async runExperiment(experiment: Experiment): Promise<Experiment> {
    if (!this.catalog) {
      await this.openBrowser();
      await this.reference();
    }
    const failing =
      this.run.trials.find((trial) => trial.id === this.run.minimal?.fromTrialId) ?? this.firstReproduced();
    if (!failing || !this.catalog) {
      experiment.status = 'ERROR';
      experiment.summary = 'aucune séquence reproduite à vérifier';
      return experiment;
    }
    experiment.status = 'RUNNING';
    experiment.startedAt = this.now().toISOString();
    this.run.usage.experiments += 1;
    const evidence: Evidence[] = [];
    const alive = this.hypotheses.filter(
      (hypothesis) =>
        hypothesis.status === 'PROPOSED' ||
        hypothesis.status === 'SUPPORTED' ||
        hypothesis.status === 'INVESTIGATING',
    ).length;
    const plan = this.planOf(failing);
    const evidenceOf = (trial: TriggerTrial, summary: string): Evidence => ({
      id: `ev_${experiment.id}_${String(evidence.length + 1)}`,
      kind: 'EXPERIMENT',
      at: this.now().toISOString(),
      summary,
      source: { experiment: experiment.id },
      data: {
        trialId: trial.id,
        verdict: trial.verdict,
        failures: trial.failures.map((failure) => failure.kind),
      },
    });
    try {
      if (experiment.kind === 'REPLAY') {
        this.played.delete(this.keyOf(plan));
        const replay = await this.runPlan({ ...plan, strategy: 'EXPERIMENT' }, `expérience ${experiment.id}`);
        evidence.push(evidenceOf(replay, `rejouage : ${replay.verdict ?? ''} — ${replay.reason ?? ''}`));
        const reproduced = replay.verdict === 'FAILURE_REPRODUCED';
        experiment.outcome = reproduced ? (alive > 1 ? 'NEUTRAL' : 'SUPPORTS') : 'REFUTES';
        experiment.summary = reproduced
          ? alive > 1
            ? 'la séquence reproduit la perte de réaction ; ce rejouage ne distingue pas les hypothèses concurrentes'
            : 'la séquence reproduit la perte de réaction'
          : 'la séquence n’a pas reproduit la perte de réaction cette fois (intermittence ou condition manquante)';
      } else if (experiment.kind === 'COMPARE_WITH_PASSING') {
        const withoutPlan: TrialPlan = { strategy: 'EXPERIMENT', factors: [], priority: 0 };
        this.played.delete(this.keyOf(withoutPlan));
        const passing = await this.runPlan(withoutPlan, `expérience ${experiment.id} (sans déclencheur)`);
        this.played.delete(this.keyOf(plan));
        const replay = await this.runPlan(
          { ...plan, strategy: 'EXPERIMENT' },
          `expérience ${experiment.id} (avec déclencheur)`,
        );
        evidence.push(
          evidenceOf(passing, `sans déclencheur : ${passing.verdict ?? ''}`),
          evidenceOf(replay, `avec déclencheur : ${replay.verdict ?? ''}`),
        );
        const discriminates =
          passing.verdict === 'FAILURE_NOT_REPRODUCED' && replay.verdict === 'FAILURE_REPRODUCED';
        experiment.outcome = discriminates
          ? alive > 1
            ? 'NEUTRAL'
            : 'SUPPORTS'
          : passing.verdict === 'FAILURE_REPRODUCED'
            ? 'REFUTES'
            : 'NEUTRAL';
        experiment.summary = discriminates
          ? `sans le déclencheur les sondes réagissent, avec lui elles ne réagissent plus${alive > 1 ? ' ; ne distingue pas les hypothèses concurrentes' : ''}`
          : passing.verdict === 'FAILURE_REPRODUCED'
            ? 'la perte de réaction survient aussi sans le déclencheur : la séquence n’en est pas la condition'
            : 'comparaison non concluante';
      } else if (experiment.kind === 'CHECK_VALIDATION') {
        // Différentiel : la même saisie invalide, sans puis avec le déclencheur. La validation doit apparaître
        // sans lui ; si elle n'apparaît dans aucun des deux cas, le champ n'a pas de validation visible (NEUTRAL).
        const targeted = new Set(plan.factors.map((factor) => factor.target));
        const field = this.catalog.fields.find(
          (item) =>
            item.role === 'textbox' && item.visible && item.enabled && !targeted.has(`label:${item.name}`),
        );
        if (!field) throw new Error('aucun champ texte hors du déclencheur pour une saisie invalide');
        const invalid: Factor = {
          id: 'exp:invalid',
          dimension: 'DATA',
          label: `saisie invalide (${field.name})`,
          actions: [{ kind: 'FILL', target: `label:${field.name}`, value: '§§§' }],
          target: `label:${field.name}`,
          priority: 0,
          origin: 'MODEL',
        };
        const validationIn = (trial: TriggerTrial): boolean =>
          trial.probes.some((index) => {
            const outcome = this.lastOutcomes.get(index);
            if (!outcome) return false;
            return observeReactions({
              index,
              action: trial.actions[index] ?? { kind: 'WAIT' },
              outcome,
              reference: undefined,
            }).some((reaction) => reaction.level === 'VALIDATION_RUN' && reaction.state === 'OBSERVED');
          });
        const withoutPlan: TrialPlan = { strategy: 'EXPERIMENT', factors: [invalid], priority: 0 };
        this.played.delete(this.keyOf(withoutPlan));
        const healthy = await this.runPlan(withoutPlan, `expérience ${experiment.id} (sans déclencheur)`);
        const healthyValidation = validationIn(healthy);
        const checkPlan: TrialPlan = {
          strategy: 'EXPERIMENT',
          factors: [...plan.factors, invalid],
          priority: 0,
        };
        this.played.delete(this.keyOf(checkPlan));
        const check = await this.runPlan(checkPlan, `expérience ${experiment.id} (avec déclencheur)`);
        const triggeredValidation = validationIn(check);
        evidence.push(
          evidenceOf(
            healthy,
            healthyValidation
              ? 'sans déclencheur : validation observée'
              : 'sans déclencheur : aucune validation visible',
          ),
          evidenceOf(
            check,
            triggeredValidation
              ? 'avec déclencheur : validation observée'
              : 'avec déclencheur : aucune validation visible',
          ),
        );
        if (healthyValidation && !triggeredValidation) {
          experiment.outcome = 'SUPPORTS';
          experiment.summary =
            'la validation apparaît sans le déclencheur et plus après lui : les gestionnaires ne s’exécutent plus';
        } else if (healthyValidation && triggeredValidation) {
          experiment.outcome = 'REFUTES';
          experiment.summary =
            'la validation s’exécute encore après la séquence : le blocage global est réfuté';
        } else {
          experiment.outcome = 'NEUTRAL';
          experiment.summary = `non observable : le champ « ${field.name} » ne montre aucune validation visible, même sans le déclencheur`;
        }
      } else {
        experiment.status = 'PROPOSED';
        experiment.summary = `${experiment.kind} : à jouer par le chemin de vérification de l'incident`;
        return experiment;
      }
      experiment.status = 'DONE';
    } catch (error) {
      experiment.status = 'ERROR';
      experiment.summary = `erreur : ${error instanceof Error ? error.message : String(error)}`;
    }
    experiment.evidence = evidence;
    experiment.finishedAt = this.now().toISOString();
    this.run.pendingExperimentIds = this.run.pendingExperimentIds.filter((id) => id !== experiment.id);
    return experiment;
  }

  // ── Couverture ─────────────────────────────────────────────────────────────────────────────

  private coverage(): void {
    const factors = this.catalog?.factors ?? [];
    const explored = new Set<string>();
    for (const trial of this.run.trials) for (const id of Object.keys(trial.factors)) explored.add(id);
    const dims: ('ACTIONS' | 'DATA' | 'STATES' | 'TIMING')[] = ['ACTIONS', 'DATA', 'STATES', 'TIMING'];
    this.run.coverage = [
      ...dims.map((dimension) => {
        const known = factors.filter((factor) => factor.dimension === dimension);
        return {
          dimension,
          explored: known.filter((factor) => explored.has(factor.id)).length,
          known: known.length,
        };
      }),
      {
        dimension: 'SEQUENCES' as const,
        explored: this.played.size,
        known: Math.max(this.plansSeen, this.played.size),
        note: 'séquences candidates connues au moment de l’arrêt, jamais un produit cartésien complet',
      },
    ];
  }
}

export async function runTriggerDiscovery(input: TriggerEngineInput): Promise<TriggerEngineOutcome> {
  const engine = new TriggerEngine(input);
  return engine.execute();
}
