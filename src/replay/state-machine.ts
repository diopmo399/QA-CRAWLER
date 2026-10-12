import type { FlowStep, StepFunctionalIntent } from '../config/flow-schema.js';
import type { FunctionalState } from '../workflow-healing/model.js';
import { checkpointsAfter, evaluateCheckpoint } from './checkpoints.js';
import type {
  CheckpointResult,
  FunctionalCheckpoint,
  ObservedFunctionalState,
  ReplayDivergence,
  ReplayPosition,
  ReplayStepVerdict,
  StepDependency,
} from './model.js';

/**
 * REPLAY STATE MACHINE : le rejeu sait en permanence où le parcours en est —
 *
 *   état attendu + état observé + position dans le workflow + objectif courant
 *
 * — et ce qui est PROUVÉ (checkpoints confirmés). Une étape n'est « commise » que si son verdict
 * transactionnel tient ; sinon la position ne progresse pas et la divergence est localisée entre
 * le dernier checkpoint confirmé et le premier qui manque. Pure : aucune dépendance au navigateur.
 */
export class ReplayStateMachine {
  private readonly checkpoints: FunctionalCheckpoint[];
  private readonly results = new Map<string, CheckpointResult>();
  private readonly position: ReplayPosition;
  private readonly committed = new Set<number>();

  constructor(
    readonly flowId: string,
    private readonly steps: readonly FlowStep[],
    checkpoints: readonly FunctionalCheckpoint[],
    readonly dependencies: readonly StepDependency[] = [],
  ) {
    this.checkpoints = [...checkpoints];
    this.position = { flowId, stepIndex: 0, confirmedCheckpoints: [] };
    this.position.nextCheckpoint = this.checkpoints[0]?.id;
  }

  /** L'étape `index` (1..n) commence : son intention et son état attendu deviennent courants. */
  beginStep(index: number, expected?: FunctionalState): ReplayPosition {
    const step = this.steps[index - 1];
    this.position.stepIndex = index;
    const intent: StepFunctionalIntent | undefined = step?.functionalIntent;
    if (intent) this.position.currentIntent = intent;
    else delete this.position.currentIntent;
    if (expected) this.position.expectedState = expected;
    else delete this.position.expectedState;
    delete this.position.observedState;
    const next = this.checkpoints.find(
      (checkpoint) => checkpoint.afterStep >= index && !this.results.has(checkpoint.id),
    );
    if (next) this.position.nextCheckpoint = next.id;
    else delete this.position.nextCheckpoint;
    return this.snapshot();
  }

  /** L'état observé après l'étape courante ; les checkpoints de cette étape sont évalués. */
  observe(index: number, observed: ObservedFunctionalState | undefined): CheckpointResult[] {
    if (observed)
      this.position.observedState = {
        route: observed.route,
        controls: observed.controls,
        ...(observed.selectedTabs ? { selectedTabs: observed.selectedTabs } : {}),
      };
    const results: CheckpointResult[] = [];
    for (const checkpoint of checkpointsAfter(this.checkpoints, index)) {
      const result = evaluateCheckpoint(checkpoint, observed);
      this.results.set(checkpoint.id, result);
      results.push(result);
      if (result.status === 'CONFIRMED') {
        this.position.confirmedCheckpoints.push(checkpoint.id);
        this.position.lastConfirmedCheckpoint = checkpoint.id;
      }
    }
    return results;
  }

  /** Le verdict transactionnel de l'étape : commise, commise avec doute, ou annulée (la position reste). */
  commit(index: number, verdict: ReplayStepVerdict): void {
    if (verdict.outcome === 'ROLLED_BACK') return;
    this.committed.add(index);
    this.position.lastConfirmedAction = index;
  }

  /** Une étape sautée (checkpoints non évalués : SKIPPED). */
  skip(index: number, reason: string): CheckpointResult[] {
    const results: CheckpointResult[] = [];
    for (const checkpoint of checkpointsAfter(this.checkpoints, index)) {
      const result: CheckpointResult = {
        id: checkpoint.id,
        status: 'SKIPPED',
        satisfied: [],
        missing: checkpoint.predicates.map((predicate) => predicate.value),
        progress: 0,
        reasons: [reason],
      };
      this.results.set(checkpoint.id, result);
      results.push(result);
    }
    return results;
  }

  /**
   * DIVERGENCE : localisée entre le dernier checkpoint confirmé et le premier qui manque (FAILED
   * ou INCONCLUSIVE fort), avec l'étape racine d'après les dépendances quand elle est connue.
   */
  diverge(
    index: number,
    symptom: string,
    rootStep?: number,
    reasons: readonly string[] = [],
  ): ReplayDivergence {
    const from = this.position.lastConfirmedCheckpoint;
    const missing = this.checkpoints.find((checkpoint) => {
      const result = this.results.get(checkpoint.id);
      return (
        checkpoint.afterStep <= index &&
        (result === undefined
          ? checkpoint.afterStep === index
          : result.status === 'FAILED' ||
            (result.status === 'INCONCLUSIVE' && checkpoint.strength === 'STRONG')) &&
        !this.position.confirmedCheckpoints.includes(checkpoint.id)
      );
    });
    const window = { ...(from ? { from } : {}), ...(missing ? { to: missing.id } : {}) };
    const divergence: ReplayDivergence = {
      stepIndex: index,
      window,
      symptom,
      ...(rootStep !== undefined ? { rootStep } : {}),
      reasons: [
        ...(from ? [`last confirmed checkpoint ${from}`] : ['no checkpoint confirmed yet']),
        ...(missing
          ? [`first missing checkpoint ${missing.id} (after step ${String(missing.afterStep)})`]
          : []),
        ...(rootStep !== undefined && rootStep !== index
          ? [`root step ${String(rootStep)} (dependency chain)`]
          : []),
        ...reasons,
      ],
    };
    this.position.divergence ??= divergence;
    return divergence;
  }

  /** La position courante (copie). */
  snapshot(): ReplayPosition {
    return {
      ...this.position,
      confirmedCheckpoints: [...this.position.confirmedCheckpoints],
      ...(this.position.divergence
        ? {
            divergence: {
              ...this.position.divergence,
              window: { ...this.position.divergence.window },
              reasons: [...this.position.divergence.reasons],
            },
          }
        : {}),
    };
  }

  /** Les checkpoints avec leur résultat (pour le rapport). */
  checkpointReport(): (FunctionalCheckpoint & { result?: CheckpointResult })[] {
    return this.checkpoints.map((checkpoint) => {
      const result = this.results.get(checkpoint.id);
      return { ...checkpoint, ...(result ? { result } : {}) };
    });
  }

  /** Les checkpoints dérivés (lecture seule). */
  checkpointsList(): readonly FunctionalCheckpoint[] {
    return this.checkpoints;
  }

  resultOf(checkpointId: string): CheckpointResult | undefined {
    return this.results.get(checkpointId);
  }

  isCommitted(index: number): boolean {
    return this.committed.has(index);
  }

  /** Le dernier checkpoint confirmé AVANT l'étape `index` (point de reprise fiable). */
  lastConfirmedBefore(index: number): FunctionalCheckpoint | undefined {
    return [...this.checkpoints]
      .reverse()
      .find(
        (checkpoint) =>
          checkpoint.afterStep < index && this.position.confirmedCheckpoints.includes(checkpoint.id),
      );
  }
}
