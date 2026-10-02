import type { Evidence } from './evidence.js';
import type { Hypothesis, HypothesisEngine } from './hypothesis-engine.js';

export type SafetyClass = 'SAFE' | 'MUTATION' | 'DANGEROUS' | 'UNKNOWN';

export interface ExperimentAction {
  kind: 'click' | 'check' | 'uncheck' | 'select';
  label: string;
  role?: string;
}

export interface ExpectedOutcome {
  hypothesisId: string;
  /** Ce que l'on doit observer si l'hypothèse est vraie. */
  ifTrue: string;
  ifFalse: string;
}

/** EXPERIMENT PROPOSAL (§19) : une action SÛRE qui départage des hypothèses concurrentes. */
export interface ExperimentProposal {
  hypothesisIds: string[];
  /** L'hypothèse dont la cause supposée est exécutée. */
  tests: string;
  actions: ExperimentAction[];
  /** L'effet observé (« button:company information ») qui tranche. */
  observable: string;
  expectedOutcomes: ExpectedOutcome[];
  informationGain: number;
  safetyClass: SafetyClass;
  reversible: boolean;
  estimatedCost: number;
}

export interface RejectedExperiment {
  proposal: ExperimentProposal;
  reason: string;
}

const entropy = (probabilities: readonly number[]): number =>
  -probabilities.filter((p) => p > 0).reduce((sum, p) => sum + p * Math.log2(p), 0);

/**
 * INFORMATION GAIN ESTIMATOR : « combien vais-je apprendre en exécutant cette action ? »
 *
 * Les hypothèses concurrentes sur un même effet (H1 : EUR le révèle, H2 : l'entretien le
 * révèle) et un reste « autre cause » forment une distribution. Une expérience qui exécute la
 * cause supposée d'un sous-ensemble S donne un résultat binaire (l'effet apparaît ou non) ;
 * le gain est la baisse d'entropie attendue (bits). Déterministe, explicable.
 */
export function informationGain(confidences: readonly number[], tested: ReadonlySet<number>): number {
  const total = confidences.reduce((sum, value) => sum + value, 0);
  const residual = Math.max(0.1, 1 - Math.min(1, total));
  const weights = [...confidences, residual];
  const sum = weights.reduce((acc, value) => acc + value, 0);
  const prior = weights.map((value) => value / sum);
  const appear = prior.reduce((acc, value, index) => acc + (tested.has(index) ? value : 0), 0);
  const posteriorIf = (keep: (index: number) => boolean): number[] => {
    const kept = prior.map((value, index) => (keep(index) ? value : 0));
    const mass = kept.reduce((acc, value) => acc + value, 0);
    return mass > 0 ? kept.map((value) => value / mass) : kept;
  };
  const expected =
    appear * entropy(posteriorIf((index) => tested.has(index))) +
    (1 - appear) * entropy(posteriorIf((index) => !tested.has(index)));
  return Math.round((entropy(prior) - expected) * 1000) / 1000;
}

/** Ce que l'expérience peut faire au navigateur — rien de plus (testable sans Playwright). */
export interface ExperimentDriver {
  /** Exécute une action ; rend les contrôles apparus et de quoi l'annuler. */
  execute(
    action: ExperimentAction,
  ): Promise<{ done: boolean; appeared: string[]; undo?: () => Promise<boolean>; detail?: string }>;
  /** L'observable est-il visible maintenant ? */
  observe(observable: string): Promise<boolean>;
}

export interface ExperimentResult {
  proposal: ExperimentProposal;
  executed: boolean;
  observed?: boolean;
  restored?: boolean;
  updated: { id: string; before: string; after: string }[];
  detail?: string;
}

/**
 * ACTIVE LEARNING ENGINE : quand plusieurs hypothèses sont plausibles, chercher l'expérience
 * SÛRE et réversible qui les départage le mieux, l'exécuter, observer, mettre à jour.
 *
 * - La SafetyPolicy décide (le juge est passé par l'appelant) : DELETE, PAY, APPROVE, SUBMIT,
 *   SEND, PUBLISH, changement de droits… ne sont JAMAIS expérimentés, même avec le meilleur gain.
 * - Le résultat est une preuve TEST_RESULT (`experiment: true`) pour chaque hypothèse testée :
 *   soutien si l'effet attendu apparaît, contradiction sinon.
 * - Budget : `maxExperiments` ; une expérience non annulable passe après les réversibles.
 */
export class ActiveLearningEngine {
  constructor(
    private readonly hypotheses: HypothesisEngine,
    private readonly addEvidence: (input: Omit<Evidence, 'id'>) => Evidence,
    private readonly options: { maxExperiments: number; now?: () => string },
  ) {}

  /** Les expériences possibles pour départager les causes concurrentes d'un effet. */
  propose(
    effect: string,
    available: ReadonlySet<string>,
    judge: (action: ExperimentAction) => SafetyClass,
  ): { proposals: ExperimentProposal[]; rejected: RejectedExperiment[] } {
    const competing = this.hypotheses
      .competing('REVEALS', effect)
      .filter(
        (hypothesis) =>
          hypothesis.status !== 'RUNTIME_CONFIRMED' ||
          this.hypotheses.competing('REVEALS', effect).length > 1,
      );
    if (competing.length < 2) return { proposals: [], rejected: [] };
    const confidences = competing.map((hypothesis) => Math.max(0.05, hypothesis.confidence));
    const proposals: ExperimentProposal[] = [];
    const rejected: RejectedExperiment[] = [];
    competing.forEach((hypothesis, index) => {
      const action = actionOf(hypothesis);
      if (!action) return;
      const proposal: ExperimentProposal = {
        hypothesisIds: competing.map((candidate) => candidate.id),
        tests: hypothesis.id,
        actions: [action],
        observable: effect,
        expectedOutcomes: competing.map((candidate) => ({
          hypothesisId: candidate.id,
          ifTrue: candidate === hypothesis ? `${effect} appears` : `${effect} does not appear`,
          ifFalse: candidate === hypothesis ? `${effect} does not appear` : `${effect} may appear`,
        })),
        informationGain: informationGain(confidences, new Set([index])),
        safetyClass: judge(action),
        reversible: action.kind === 'check' || action.kind === 'uncheck' || action.role === 'tab',
        estimatedCost: 1,
      };
      // L'action doit exister à l'écran (une hypothèse ne se teste pas sur un contrôle inventé).
      const key = `${action.role ?? (action.kind === 'check' || action.kind === 'uncheck' ? 'checkbox' : 'button')}:${action.label}`;
      if (!available.has(key) && ![...available].some((candidate) => candidate.endsWith(`:${action.label}`)))
        rejected.push({ proposal, reason: 'the action is not available on this screen' });
      else if (proposal.safetyClass !== 'SAFE')
        rejected.push({
          proposal,
          reason: `SafetyPolicy: ${proposal.safetyClass} actions are never experimented automatically`,
        });
      else proposals.push(proposal);
    });
    proposals.sort(
      (a, b) =>
        Number(b.reversible) - Number(a.reversible) ||
        b.informationGain / b.estimatedCost - a.informationGain / a.estimatedCost,
    );
    return { proposals: proposals.slice(0, this.options.maxExperiments), rejected };
  }

  /** Exécute une expérience SAFE (déjà acceptée), observe, met à jour, annule. */
  async run(proposal: ExperimentProposal, driver: ExperimentDriver): Promise<ExperimentResult> {
    if (proposal.safetyClass !== 'SAFE')
      return { proposal, executed: false, updated: [], detail: 'not SAFE: never executed' };
    const before = new Map(proposal.hypothesisIds.map((id) => [id, this.hypotheses.byId(id)?.status ?? '?']));
    const [action] = proposal.actions;
    if (!action) return { proposal, executed: false, updated: [] };
    const execution = await driver.execute(action);
    if (!execution.done)
      return {
        proposal,
        executed: false,
        updated: [],
        ...(execution.detail ? { detail: execution.detail } : {}),
      };
    const observed =
      execution.appeared.includes(proposal.observable) || (await driver.observe(proposal.observable));
    const proof = this.addEvidence({
      type: 'TEST_RESULT',
      source: `experiment ${action.kind} "${action.label}"`,
      timestamp: this.options.now?.() ?? new Date().toISOString(),
      confidence: 0.9,
      details: { experiment: true, observable: proposal.observable, observed },
    });
    if (observed) this.hypotheses.support(proposal.tests, proof);
    else this.hypotheses.contradict(proposal.tests, proof);
    const restored = execution.undo ? await execution.undo().catch(() => false) : undefined;
    return {
      proposal,
      executed: true,
      observed,
      ...(restored !== undefined ? { restored } : {}),
      updated: proposal.hypothesisIds.map((id) => ({
        id,
        before: before.get(id) ?? '?',
        after: this.hypotheses.byId(id)?.status ?? '?',
      })),
    };
  }
}

/** « check eur » → check EUR ; « click enterprise interview » → click. */
function actionOf(hypothesis: Hypothesis): ExperimentAction | undefined {
  const [kind, ...rest] = hypothesis.proposition.subject.split(' ');
  const label = rest.join(' ');
  if (!label) return undefined;
  if (kind === 'check' || kind === 'uncheck' || kind === 'select') return { kind, label };
  if (kind === 'click') return { kind: 'click', label };
  return undefined;
}
