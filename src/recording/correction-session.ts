import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { FlowStep } from '../config/flow-schema.js';
import type { DryRunDriver } from '../dry-run/dry-run-driver.js';
import { dryRunConfig } from '../dry-run/dry-run-orchestrator.js';
import type { FlowIntent } from '../dry-run/flow-intent-graph.js';
import { loadDryRunScenario, type DryRunInput } from '../dry-run/scenario-input.js';
import { runMission } from '../orchestrator.js';
import { captureContextSnapshot } from '../replay/context-capture.js';
import {
  CONTEXT_CHECKPOINT_SCHEMA,
  compareContext,
  decideRecovery,
  fieldStepsOf,
  mutationSteps,
  redactedCheckpoint,
  type ContextCheckpoint,
  type RecoveryDecision,
} from '../replay/context-checkpoint.js';
import { checkPreconditions, deriveDependencies, derivePreconditions } from '../replay/preconditions.js';

/**
 * LA SESSION DE CORRECTION ET DE REPRISE (revue) — « suivre le même chemin », corriger, puis REPRENDRE.
 *
 * L'URL d'une étape ne suffit pas : l'écran de l'étape 16 dépend des étapes 1 à 15 (un dossier
 * ouvert, une fenêtre, un assistant, une donnée créée par le run). La session rejoue les étapes
 * PRÉCÉDENTES avec le moteur de rejeu de la mission (même connexion, même SafetyPolicy, mêmes données
 * de test), puis GARDE LA PAGE OUVERTE dans cet état réel tant que la correction dure : l'humain y
 * désigne l'élément, rien n'est reproduit ni deviné.
 *
 * Avant chaque étape, un CHECKPOINT DE CONTEXTE est pris (URL complète, route, cadres, onglet,
 * dialogue, champs, défilement, données produites par le run, préconditions de l'étape). Après la
 * correction, `resume` reprend le rejeu À L'ÉTAPE CORRIGÉE, dans cette même session (mêmes données,
 * même entité créée) : la page tenue est comparée au checkpoint et la stratégie est décidée —
 * REVALIDATE, RESTORE (les champs perdus reposés par leurs étapes), REBUILD (les étapes précédentes
 * rejouées, jamais une étape à effet métier déjà faite sans décision) ou MANUAL_RECOVERY. Les
 * préconditions dures de l'étape sont vérifiées avant de la rejouer. Si une étape suivante échoue, la
 * session reste tenue À CETTE ÉTAPE : la corriger ne rejoue rien.
 */
export interface CorrectionSessionRequest extends DryRunInput {
  /** Le dossier de l'enregistrement (la session écrit sous <dossier>/correction/). */
  directory: string;
  /** L'étape à corriger : sa position dans le flow, à partir de 1. Les étapes 1 à N-1 sont rejouées. */
  stepIndex: number;
  headless: boolean;
  /** Une étape précédente rejouée (progression dans la fenêtre du recorder). */
  onStep?: (executed: number, total: number) => void;
  /**
   * Les étapes précédentes sont faites (ou le chemin s'est arrêté) : la page reste ouverte tant que
   * la promesse n'est pas résolue — le temps de la correction, puis de la reprise.
   */
  hold: (state: CorrectionSessionState) => Promise<void>;
  /** replay.contextRecovery (config de la mission) ; absent : les valeurs par défaut. */
  recovery?: {
    checkpoints?: boolean;
    repeatMutations?: boolean;
    maxCheckpointAgeMinutes?: number;
    loginRoutes?: string[];
  };
}

export interface CorrectionSessionState {
  page: Page;
  /** true : l'écran de l'étape visée est atteint (les étapes précédentes ont toutes réussi). */
  reached: boolean;
  executed: number;
  total: number;
  /** Le chemin s'est arrêté là : l'étape, son libellé et la raison (jamais une valeur saisie). */
  stoppedAt?: { index: number; label: string; reason: string };
  /** Les données de test produites par le rejeu (clé → valeur, mémoire seule) : ce que la page montre maintenant. */
  runData: { key: string; value: string }[];
  /** L'étape (1..n) devant laquelle la page est tenue (après une reprise interrompue : l'étape en échec). */
  position: () => number;
  /** Le checkpoint de contexte pris devant l'étape tenue. */
  checkpoint: () => ContextCheckpoint | undefined;
  /** REPRENDRE le rejeu à l'étape tenue, avec le flow corrigé (scenarioFile réécrit). */
  resume: (request: ResumeRequest) => Promise<ResumeOutcome>;
}

export interface ResumeRequest {
  /** Le flow corrigé (le même fichier, réécrit après la correction). */
  scenarioFile: string;
  onStep?: (executed: number, total: number) => void;
}

export interface ResumeOutcome {
  status: 'PASSED' | 'FAILED' | 'MANUAL_RECOVERY';
  /** L'étape où la reprise a commencé. */
  from: number;
  decision: RecoveryDecision;
  /** Les étapes rejouées pour restaurer ou reconstruire le contexte. */
  recovered: number[];
  executed: number;
  total: number;
  /** FAILED : l'étape qui a échoué (la session reste tenue devant elle). */
  failure?: { index: number; label: string; reason: string };
  /** Préconditions dures non satisfaites (MANUAL_RECOVERY) ou signalées. */
  preconditions: { value: string; satisfied: boolean | undefined; detail: string; severity: string }[];
}

const digest = (value: string): string => createHash('sha256').update(value).digest('hex').slice(0, 16);

export async function runCorrectionSession(
  request: CorrectionSessionRequest,
): Promise<CorrectionSessionState | { error: string }> {
  let state: CorrectionSessionState | undefined;
  try {
    const input: DryRunInput = {
      scenarioFile: request.scenarioFile,
      ...(request.missionFile ? { missionFile: request.missionFile } : {}),
      overrides: { ...request.overrides, headless: request.headless },
      ...(request.env ? { env: request.env } : {}),
    };
    const loaded = loadDryRunScenario(input);
    // Une mémoire propre à la correction : elle n'apprend rien à la mission et n'en lit rien.
    const config = dryRunConfig(
      loaded.config,
      { ...input, isolatedMemory: true, useHistory: false },
      path.join(request.directory, 'correction'),
    );
    const graph = loaded.graphs[0];
    const flow = graph ? config.flows.find((candidate) => candidate.name === graph.name) : undefined;
    if (!graph || !flow) return { error: 'the generated flow could not be loaded for the correction' };
    const settings = {
      checkpoints: request.recovery?.checkpoints ?? true,
      repeatMutations: request.recovery?.repeatMutations ?? false,
      maxAgeMs: (request.recovery?.maxCheckpointAgeMinutes ?? 30) * 60_000,
      loginRoutes: request.recovery?.loginRoutes ?? [],
    };
    const runId = `correction-${Date.now().toString(36)}`;
    await runMission(config, {
      mode: 'explore',
      ...(request.env ? { env: request.env } : {}),
      onWarning: () => undefined,
      dryRun: async (driverFor) => {
        const driver = driverFor(flow);
        const tracker = new SessionTracker(
          driver,
          graph.name,
          runId,
          settings.checkpoints,
          request.directory,
        );
        const started = await driver.start(graph.startAt);
        const before = graph.intents.filter((intent) => intent.index < request.stepIndex);
        const total = before.length;
        let executed = 0;
        request.onStep?.(0, total);
        let stoppedAt: CorrectionSessionState['stoppedAt'];
        const stepsOf = stepsByIndex(graph.intents);
        if (!started)
          stoppedAt = {
            index: 0,
            label: graph.startAt ?? config.target.startAt,
            reason: 'the start page could not be loaded',
          };
        else
          for (const intent of before) {
            const result = await tracker.perform(intent, stepsOf);
            if ((result.status === 'FAILED' || result.status === 'BLOCKED') && intent.required) {
              stoppedAt = {
                index: intent.index,
                label: intent.label,
                reason: result.reason ?? result.status,
              };
              break;
            }
            executed += 1;
            request.onStep?.(executed, total);
          }
        const page = driver.page?.();
        if (!page) return;
        // Le checkpoint devant l'étape visée : celui que la reprise comparera à la page tenue.
        if (!stoppedAt) await tracker.capture(request.stepIndex, stepsOf);
        let position = stoppedAt ? stoppedAt.index : request.stepIndex;
        state = {
          page,
          reached: stoppedAt === undefined,
          executed,
          total,
          ...(stoppedAt ? { stoppedAt } : {}),
          runData: driver.testDataValues?.() ?? [],
          position: () => position,
          checkpoint: () => tracker.checkpoints.get(position),
          resume: async (resume) => {
            const outcome = await resumeAt(tracker, position, resume, { input, settings });
            // Une reprise interrompue garde la page tenue DEVANT l'étape en échec : la corriger ne rejoue rien.
            if (outcome.status === 'FAILED' && outcome.failure) position = outcome.failure.index;
            await tracker.persist();
            return outcome;
          },
        };
        await request.hold(state);
      },
    });
  } catch (error) {
    return {
      error: `the correction session could not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)}`,
    };
  }
  return state ?? { error: 'the correction session did not reach the application' };
}

/** Les étapes du flow par position (1..n), lues dans les intentions (la position du flow est gardée). */
function stepsByIndex(intents: readonly FlowIntent[]): FlowStep[] {
  const steps: FlowStep[] = [];
  for (const intent of intents) steps[intent.index - 1] = intent.step;
  return steps;
}

/**
 * Ce que la session sait de son run : les checkpoints de contexte (devant chaque étape), les étapes à
 * effet métier déjà exécutées, et l'écriture des checkpoints (empreintes, jamais une valeur).
 */
class SessionTracker {
  readonly checkpoints = new Map<number, ContextCheckpoint>();
  readonly executedMutations = new Set<number>();
  readonly confirmed: string[] = [];

  constructor(
    readonly driver: DryRunDriver,
    private readonly scenario: string,
    private readonly runId: string,
    private readonly enabled: boolean,
    private readonly directory: string,
  ) {}

  async capture(index: number, steps: readonly FlowStep[]): Promise<ContextCheckpoint | undefined> {
    if (!this.enabled) return undefined;
    const page = this.driver.page?.();
    if (!page) return undefined;
    const snapshot = await captureContextSnapshot(page);
    if (!snapshot) return undefined;
    const dependencies = deriveDependencies(steps);
    const checkpoint: ContextCheckpoint = {
      schema: CONTEXT_CHECKPOINT_SCHEMA,
      scenario: this.scenario,
      runId: this.runId,
      stepIndex: index,
      capturedAt: snapshot.capturedAt,
      snapshot,
      runData: this.driver.testDataValues?.() ?? [],
      confirmedCheckpoints: [...this.confirmed],
      executedMutations: [...this.executedMutations],
      preconditions: derivePreconditions(steps, index, dependencies),
    };
    this.checkpoints.set(index, checkpoint);
    return checkpoint;
  }

  /** Une étape, précédée de son checkpoint ; une étape à effet métier réussie est retenue. */
  async perform(
    intent: FlowIntent,
    steps: readonly FlowStep[],
  ): Promise<Awaited<ReturnType<DryRunDriver['perform']>>> {
    await this.capture(intent.index, steps);
    const result = await this.driver.perform(intent);
    if (result.status === 'PASSED' && mutationSteps(steps).includes(intent.index))
      this.executedMutations.add(intent.index);
    return result;
  }

  /** replay-checkpoints.json : la reprise s'explique (empreintes des données, jamais une valeur). */
  async persist(): Promise<void> {
    if (!this.enabled) return;
    const written = [...this.checkpoints.values()].map((checkpoint) =>
      redactedCheckpoint(checkpoint, digest),
    );
    await writeFile(
      path.join(this.directory, 'replay-checkpoints.json'),
      `${JSON.stringify({ schema: CONTEXT_CHECKPOINT_SCHEMA, checkpoints: written }, null, 2)}\n`,
      'utf8',
    ).catch(() => undefined);
  }
}

/** LA REPRISE : décider (comparer la page tenue au checkpoint), restaurer ou reconstruire, vérifier, rejouer. */
async function resumeAt(
  tracker: SessionTracker,
  from: number,
  request: ResumeRequest,
  context: {
    input: DryRunInput;
    settings: { repeatMutations: boolean; maxAgeMs: number; loginRoutes: string[] };
  },
): Promise<ResumeOutcome> {
  const { driver } = tracker;
  const graph = loadDryRunScenario({ ...context.input, scenarioFile: request.scenarioFile }).graphs[0];
  const intents = graph?.intents ?? [];
  const steps = stepsByIndex(intents);
  const mutations = mutationSteps(steps);
  const remaining = intents.filter((intent) => intent.index >= from);
  const total = remaining.length;
  const base = {
    from,
    recovered: [] as number[],
    executed: 0,
    total,
    preconditions: [] as ResumeOutcome['preconditions'],
  };
  const checkpoint = tracker.checkpoints.get(from);
  const page = driver.page?.();
  const live = page && !page.isClosed() ? await captureContextSnapshot(page) : undefined;
  const decision: RecoveryDecision = checkpoint
    ? decideRecovery({
        checkpoint: { ...checkpoint, executedMutations: [...tracker.executedMutations] },
        live,
        stepIndex: from,
        mutations,
        repeatMutations: context.settings.repeatMutations,
        now: new Date(),
        maxAgeMs: context.settings.maxAgeMs,
        loginRoutes: context.settings.loginRoutes,
        fieldSteps: fieldStepsOf(steps),
      })
    : {
        strategy: 'REVALIDATE',
        differences: [],
        reasons: [
          'no context checkpoint was taken (replay.contextRecovery.checkpoints: false): the page is verified',
        ],
      };
  if (decision.strategy === 'MANUAL_RECOVERY') return { status: 'MANUAL_RECOVERY', decision, ...base };
  const recovered: number[] = [];
  const replayStep = async (index: number): Promise<boolean> => {
    const intent = intents.find((candidate) => candidate.index === index);
    if (!intent) return true;
    const result = await tracker.perform(intent, steps);
    recovered.push(index);
    return !((result.status === 'FAILED' || result.status === 'BLOCKED') && intent.required);
  };
  if (decision.strategy === 'RESTORE')
    for (const index of decision.restoreSteps ?? []) await replayStep(index);
  // RESTORE insuffisant (le contexte ne correspond toujours pas) : la reconstruction prend le relais.
  let effective: RecoveryDecision = decision;
  if (decision.strategy === 'RESTORE' && checkpoint) {
    const now = page && !page.isClosed() ? await captureContextSnapshot(page) : undefined;
    const still = compareContext(checkpoint.snapshot, now, {
      loginRoutes: context.settings.loginRoutes,
    }).filter((difference) => difference.kind === 'FIELD_LOST' || difference.severity === 'HARD');
    if (still.length > 0)
      effective = decideRecovery({
        checkpoint: { ...checkpoint, executedMutations: [...tracker.executedMutations] },
        live: undefined,
        stepIndex: from,
        mutations,
        repeatMutations: context.settings.repeatMutations,
        now: new Date(),
        maxAgeMs: context.settings.maxAgeMs,
      });
    if (effective.strategy === 'MANUAL_RECOVERY')
      return { status: 'MANUAL_RECOVERY', decision: effective, ...base, recovered };
  }
  if (effective.strategy === 'REBUILD') {
    if (!(await driver.start(graph?.startAt))) {
      return {
        status: 'MANUAL_RECOVERY',
        decision: {
          ...effective,
          strategy: 'MANUAL_RECOVERY',
          blockedBy: [{ reason: 'the start page could not be loaded' }],
        },
        ...base,
        recovered,
      };
    }
    for (const intent of intents.filter((candidate) => candidate.index < from))
      if (!(await replayStep(intent.index)))
        return {
          status: 'MANUAL_RECOVERY',
          decision: {
            ...effective,
            strategy: 'MANUAL_RECOVERY',
            blockedBy: [
              { step: intent.index, reason: 'the path could not be rebuilt up to the corrected step' },
            ],
          },
          ...base,
          recovered,
        };
  }
  // REVALIDATE : les préconditions DURES de l'étape corrigée, sur la page telle qu'elle est maintenant.
  const after = page && !page.isClosed() ? await captureContextSnapshot(page) : undefined;
  const checks = checkPreconditions(
    derivePreconditions(steps, from, deriveDependencies(steps)),
    after?.functional,
    [],
    (driver.testDataValues?.() ?? []).map((entry) => entry.key),
  );
  const preconditions = checks.map((check) => ({
    value: `${check.precondition.kind} ${check.precondition.value}`,
    satisfied: check.satisfied,
    detail: check.detail,
    severity: check.precondition.severity,
  }));
  const unmet = checks.filter((check) => check.precondition.severity === 'HARD' && check.satisfied === false);
  if (unmet.length > 0)
    return {
      status: 'MANUAL_RECOVERY',
      decision: {
        ...effective,
        strategy: 'MANUAL_RECOVERY',
        blockedBy: unmet.map((check) => ({
          step: from,
          reason: `${check.precondition.kind} ${check.precondition.value}: ${check.detail}`,
        })),
      },
      ...base,
      recovered,
      preconditions,
    };
  // LA REPRISE : l'étape corrigée, puis la suite, dans la même session (mêmes données du run).
  let executed = 0;
  request.onStep?.(0, total);
  for (const intent of remaining) {
    const result = await tracker.perform(intent, steps);
    if ((result.status === 'FAILED' || result.status === 'BLOCKED') && intent.required)
      return {
        status: 'FAILED',
        decision: effective,
        ...base,
        recovered,
        executed,
        preconditions,
        failure: { index: intent.index, label: intent.label, reason: result.reason ?? result.status },
      };
    executed += 1;
    request.onStep?.(executed, total);
  }
  return { status: 'PASSED', decision: effective, ...base, recovered, executed, preconditions };
}
