import { parse as parseYaml } from 'yaml';
import type { ExplorationResult } from '../model/exploration-result.js';
import { analyzeCode } from './code/index.js';
import { buildGraph } from './correlator.js';
import { environmentAdapter, type ExecutionEnvironmentAdapter } from './environments.js';
import { incidentReproduction, reproductionFromResult } from './evidence.js';
import { planExperiment, runExperiment } from './experiments.js';
import { applyExperiment, proposeHypotheses } from './hypotheses.js';
import { IncidentStateError, IncidentStore } from './incident-store.js';
import type {
  EnvironmentCapabilities,
  Experiment,
  ExperimentKind,
  Incident,
  IncidentInput,
  IncidentState,
  IncidentSummary,
  InvestigationReport,
  ReproductionRun,
  ScopeExtension,
} from './model.js';
import { proposeRegressionTest } from './regression.js';
import { buildReport, reportMarkdown } from './report.js';
import { diagnose } from './root-cause.js';
import { decideExtension, requestExtension, validateScope } from './scope.js';
import { ScopePolicy } from './scope-policy.js';

/**
 * L'ORCHESTRATION D'UNE INVESTIGATION : Déclarer → Délimiter → Reproduire → Observer → Inspecter le code
 * → Corréler → Diagnostiquer → Vérifier → Rapporter → Générer un test. Le service ne joue rien lui-même :
 * le rejeu passe par l'hôte (le même chemin que les exécutions du SDK, donc le moteur Playwright et sa
 * SafetyPolicy), les fichiers et commandes par l'adaptateur de l'environnement d'exécution, contrôlé par
 * le Scope Policy Engine. Un seul code pour LOCAL, REMOTE et ARO : seul l'adaptateur change.
 */

/** Un rejeu réel lancé par l'hôte. */
export interface HostReplay {
  run: string;
  runDir: string;
  environmentId?: string;
  baseUrl?: string;
  startedAt: string;
  /** Se résout à la fin du run, avec le résultat du moteur (absent si le run n'a rien écrit). */
  done: Promise<{ status: 'COMPLETED' | 'FAILED' | 'CANCELLED'; result?: ExplorationResult; error?: string }>;
  cancel(): void;
}

export interface IncidentHost {
  projectId: string;
  projectDir: string;
  /** Rejoue un scénario de la bibliothèque, ou un flow hors bibliothèque (test de non-régression proposé). */
  replay(input: {
    scenario?: string;
    flow?: Record<string, unknown>;
    environmentId?: string;
    headed?: boolean;
    slowMoMs?: number;
  }): Promise<HostReplay>;
  /** Le flow YAML d'un scénario de la bibliothèque. */
  scenarioYaml(name: string): Promise<{ file: string; text: string } | undefined>;
  /** Ajoute un scénario à la bibliothèque (après validation) ; renvoie son fichier. */
  addScenario(name: string, yaml: string): Promise<string>;
  /** L'URL de l'environnement cible (son hôte entre dans le périmètre de navigation). */
  environment(environmentId?: string): Promise<{ id?: string; baseUrl?: string; kind?: string }>;
}

export class IncidentServiceError extends Error {
  constructor(
    readonly code: 'NOT_FOUND' | 'INVALID' | 'BUSY' | 'STATE' | 'SCOPE',
    message: string,
  ) {
    super(message);
  }
}

type ReplayStatus = Awaited<HostReplay['done']>['status'];

const FINAL_REPRODUCTION: Record<ReplayStatus, ReproductionRun['status']> = {
  COMPLETED: 'COMPLETED',
  FAILED: 'FAILED',
  CANCELLED: 'CANCELLED',
};

export class IncidentService {
  readonly store: IncidentStore;
  /** Ce qui tourne par incident : un rejeu, une expérience ; l'annulation les arrête. */
  private readonly running = new Map<string, Set<() => void>>();
  /** Les travaux en arrière-plan (tests : attendre leur fin). */
  private readonly pending = new Set<Promise<unknown>>();

  constructor(
    private readonly host: IncidentHost,
    private readonly deps: {
      adapter?: (incident: Incident) => ExecutionEnvironmentAdapter;
      now?: () => Date;
      env?: NodeJS.ProcessEnv;
    } = {},
  ) {
    this.store = new IncidentStore(host.projectDir);
  }

  private now(): Date {
    return this.deps.now?.() ?? new Date();
  }

  private adapter(incident: Incident): ExecutionEnvironmentAdapter {
    return this.deps.adapter?.(incident) ?? environmentAdapter(incident.execution, { env: this.deps.env });
  }

  private async policy(incident: Incident): Promise<ScopePolicy> {
    const target = await this.host.environment(incident.environmentId);
    const hosts: string[] = [];
    if (target.baseUrl)
      try {
        hosts.push(new URL(target.baseUrl).host);
      } catch {
        // une URL illisible n'ajoute aucun hôte
      }
    return new ScopePolicy(incident.scope, { extraHosts: hosts, execution: incident.execution });
  }

  async incident(id: string): Promise<Incident> {
    const incident = await this.store.get(id);
    if (!incident) throw new IncidentServiceError('NOT_FOUND', `incident ${id} not found`);
    return incident;
  }

  list(): Promise<IncidentSummary[]> {
    return this.store.list();
  }

  async create(input: IncidentInput, actor: string): Promise<Incident> {
    return this.store.create(this.host.projectId, input, actor);
  }

  update(id: string, revision: number, patch: Partial<IncidentInput>, actor: string): Promise<Incident> {
    return this.store.update(id, revision, patch, actor);
  }

  async validateScope(id: string): Promise<{ ok: boolean; issues: { field: string; message: string }[] }> {
    const incident = await this.incident(id);
    const result = await validateScope(incident.scope);
    if (!incident.scenario)
      result.issues.push({ field: 'scenario', message: 'choose the scenario that leads to the symptom' });
    return { ok: result.issues.length === 0, issues: result.issues };
  }

  async requestExtension(
    id: string,
    request: { kind: ScopeExtension['kind']; target: string; applicationId?: string; reason: string },
    actor: string,
  ): Promise<Incident> {
    return this.store.mutate(
      id,
      actor,
      (incident) => {
        incident.scope = requestExtension(incident.scope, request, actor, this.now()).scope;
      },
      { kind: 'EXTENSION_REQUESTED', message: `${request.kind} ${request.target}: ${request.reason}` },
    );
  }

  async decideExtension(id: string, extensionId: string, approve: boolean, actor: string): Promise<Incident> {
    return this.store.mutate(
      id,
      actor,
      (incident) => {
        incident.scope = decideExtension(incident.scope, extensionId, approve, actor, this.now());
      },
      { kind: 'EXTENSION_DECIDED', message: `${extensionId} ${approve ? 'approved' : 'rejected'}` },
    );
  }

  async capabilities(id: string): Promise<EnvironmentCapabilities> {
    return this.adapter(await this.incident(id)).capabilities();
  }

  // ── Reproduction ────────────────────────────────────────────────────────────────────────

  /** Lance la reproduction (arrière-plan) ; l'incident passe REPRODUCING, puis REPRODUCED ou NOT_REPRODUCED. */
  async reproduce(
    id: string,
    actor: string,
    options: { headed?: boolean; slowMoMs?: number } = {},
  ): Promise<Incident> {
    const incident = await this.incident(id);
    if (!incident.scenario)
      throw new IncidentServiceError('INVALID', 'the incident has no scenario to replay');
    if (!incident.scope.permissions.navigate)
      throw new IncidentServiceError('SCOPE', 'the scope does not allow Playwright navigation');
    const target = await this.host.environment(incident.environmentId);
    if (target.baseUrl) {
      const decision = await (await this.policy(incident)).check({ kind: 'NAVIGATE', url: target.baseUrl });
      if (!decision.allowed) throw new IncidentServiceError('SCOPE', decision.reason);
    }
    if (incident.state === 'DRAFT') await this.store.transition(id, 'SCOPED', actor, 'scope ready');
    await this.store.transition(id, 'REPRODUCING', actor, `replaying ${incident.scenario}`);
    let replay: HostReplay;
    try {
      replay = await this.host.replay({
        scenario: incident.scenario,
        ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
        ...(options.headed !== undefined ? { headed: options.headed } : {}),
        ...(options.slowMoMs !== undefined ? { slowMoMs: options.slowMoMs } : {}),
      });
    } catch (error) {
      await this.store.transition(id, 'FAILED', actor, `replay refused: ${message(error)}`);
      throw error;
    }
    const reproductionId = `rep_${String(incident.investigation.reproductions.length + 1)}`;
    const placeholder: ReproductionRun = {
      id: reproductionId,
      startedAt: replay.startedAt,
      status: 'RUNNING',
      target: incident.execution.target,
      ...(replay.environmentId ? { environmentId: replay.environmentId } : {}),
      ...(replay.baseUrl ? { baseUrl: replay.baseUrl } : {}),
      scenario: incident.scenario,
      run: replay.run,
      reproduced: null,
      actions: [],
      requests: [],
      evidence: [],
      screenshots: [],
    };
    const saved = await this.store.mutate(
      id,
      actor,
      (current) => {
        current.investigation.reproductions.push(placeholder);
      },
      { kind: 'REPRODUCTION', message: `${reproductionId}: run ${replay.run} started` },
    );
    const stop = this.track(id, () => {
      replay.cancel();
    });
    const work = replay.done
      .then(async (outcome) => {
        stop();
        const reproduction = this.reproductionOf(saved, reproductionId, replay, outcome);
        const next: IncidentState =
          outcome.status === 'CANCELLED'
            ? 'CANCELLED'
            : reproduction.reproduced === true
              ? 'REPRODUCED'
              : reproduction.reproduced === false
                ? 'NOT_REPRODUCED'
                : 'FAILED';
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const at = current.investigation.reproductions.findIndex((entry) => entry.id === reproductionId);
            if (at >= 0) current.investigation.reproductions[at] = reproduction;
            else current.investigation.reproductions.push(reproduction);
          },
          {
            kind: 'REPRODUCTION',
            message: `${reproductionId}: ${reproduction.symptomMatch ?? reproduction.error ?? outcome.status}`,
          },
        );
        const latest = await this.incident(id);
        if (latest.state === 'REPRODUCING' && next !== 'CANCELLED')
          await this.store.transition(id, next, actor, reproduction.symptomMatch ?? outcome.status);
      })
      .catch(async (error: unknown) => {
        stop();
        const latest = await this.store.get(id);
        if (latest?.state === 'REPRODUCING')
          await this.store.transition(id, 'FAILED', actor, `reproduction failed: ${message(error)}`);
      });
    this.keep(work);
    return this.incident(id);
  }

  private reproductionOf(
    incident: Incident,
    id: string,
    replay: HostReplay,
    outcome: Awaited<HostReplay['done']>,
  ): ReproductionRun {
    const built = reproductionFromResult({
      id,
      scenario: incident.scenario ?? '',
      target: incident.execution.target,
      ...(replay.environmentId ? { environmentId: replay.environmentId } : {}),
      ...(replay.baseUrl ? { baseUrl: replay.baseUrl } : {}),
      run: replay.run,
      runDir: replay.runDir,
      startedAt: replay.startedAt,
      finishedAt: this.now().toISOString(),
      result: outcome.result,
      observed: incident.observed,
    });
    return {
      ...built,
      status: FINAL_REPRODUCTION[outcome.status],
      ...(outcome.status !== 'COMPLETED' && outcome.error ? { error: outcome.error } : {}),
      ...(outcome.status === 'CANCELLED' ? { reproduced: null } : {}),
    };
  }

  // ── Analyse : code, graphe, hypothèses ──────────────────────────────────────────────────

  async analyze(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    if (incident.state === 'REPRODUCING') throw new IncidentServiceError('BUSY', 'a reproduction is running');
    const policy = await this.policy(incident);
    const files = this.adapter(incident).files(policy);
    const reproduction = incidentReproduction(incident);
    const endpoints = [
      ...incident.scope.endpoints,
      ...(reproduction?.requests ?? [])
        .filter((request) => request.resourceType === 'xhr' || request.resourceType === 'fetch')
        .map((request) => `${request.method} ${request.path}`),
    ];
    const code = incident.scope.permissions.readSources
      ? await analyzeCode(incident.scope, files, { endpoints })
      : undefined;
    const graph = buildGraph({
      incident,
      ...(reproduction ? { reproduction } : {}),
      ...(code ? { code } : {}),
      depth: incident.scope.depth,
    });
    const hypotheses = proposeHypotheses({
      incident,
      ...(reproduction ? { reproduction } : {}),
      ...(code ? { code } : {}),
      graph,
    });
    if (incident.state !== 'INVESTIGATING') await this.moveTo(id, 'INVESTIGATING', actor, 'code analysis');
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (code) current.investigation.code = code;
        current.investigation.graph = graph;
        // Les hypothèses déjà vérifiées gardent leur statut ; les nouvelles s'ajoutent.
        const kept = current.investigation.hypotheses.filter((entry) => entry.status !== 'PROPOSED');
        current.investigation.hypotheses = [
          ...kept,
          ...hypotheses.filter((entry) => !kept.some((old) => old.title === entry.title)),
        ];
      },
      {
        kind: 'HYPOTHESES',
        message: `${String(code?.symbols.length ?? 0)} symbol(s), ${String(graph.nodes.length)} node(s), ${String(hypotheses.length)} hypothesis(es)`,
      },
    );
  }

  // ── Vérifications ───────────────────────────────────────────────────────────────────────

  async planExperiment(
    id: string,
    input: { kind: ExperimentKind; params: Experiment['params']; hypothesisId?: string },
    actor: string,
  ): Promise<Incident> {
    const planned = planExperiment(input, this.now());
    return this.store.mutate(
      id,
      actor,
      (incident) => {
        incident.investigation.experiments.push(planned);
      },
      { kind: 'EXPERIMENT', message: `${planned.id}: ${planned.kind} planned` },
    );
  }

  /** Exécute une vérification (arrière-plan) ; un refus du périmètre est enregistré, rien n'est exécuté. */
  async runExperiment(
    id: string,
    experimentId: string,
    actor: string,
    options: { approve?: boolean } = {},
  ): Promise<Incident> {
    const incident = await this.incident(id);
    const experiment = incident.investigation.experiments.find((entry) => entry.id === experimentId);
    if (!experiment) throw new IncidentServiceError('NOT_FOUND', `experiment ${experimentId} not found`);
    if (experiment.status === 'RUNNING') throw new IncidentServiceError('BUSY', 'the experiment is running');
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const entry = current.investigation.experiments.find((candidate) => candidate.id === experimentId);
        if (entry) {
          entry.status = 'RUNNING';
          entry.startedAt = this.now().toISOString();
        }
      },
      { kind: 'EXPERIMENT', message: `${experimentId}: started` },
    );
    const abort = new AbortController();
    const stop = this.track(id, () => {
      abort.abort();
    });
    const work = (async () => {
      const policy = await this.policy(incident);
      const adapter = this.adapter(incident);
      const done = await runExperiment(
        { ...experiment, status: experiment.status === 'RUNNING' ? 'PROPOSED' : experiment.status },
        {
          incident,
          policy,
          adapter,
          files: adapter.files(policy),
          ...(incident.investigation.code ? { code: incident.investigation.code } : {}),
          replay: (scenario) => this.replayFor(incident, scenario, actor),
          signal: abort.signal,
          actor,
          now: () => this.now(),
        },
        options.approve ? { approvedBy: actor } : {},
      );
      return done;
    })()
      .then(async (done) => {
        stop();
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const at = current.investigation.experiments.findIndex((entry) => entry.id === experimentId);
            if (at >= 0) current.investigation.experiments[at] = done;
            if (done.status === 'DONE')
              current.investigation.hypotheses = applyExperiment(current.investigation.hypotheses, done);
          },
          {
            kind: 'EXPERIMENT',
            message: `${experimentId}: ${done.status}${done.summary ? ` — ${done.summary}` : ''}`,
          },
        );
      })
      .catch(async (error: unknown) => {
        stop();
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const entry = current.investigation.experiments.find(
              (candidate) => candidate.id === experimentId,
            );
            if (entry) {
              entry.status = abort.signal.aborted ? 'CANCELLED' : 'ERROR';
              entry.summary = message(error);
              entry.finishedAt = this.now().toISOString();
            }
          },
          { kind: 'EXPERIMENT', message: `${experimentId}: ${message(error)}` },
        );
      });
    this.keep(work);
    return this.incident(id);
  }

  /** Un rejeu pour une vérification : même chemin que la reproduction, conservé dans l'investigation. */
  private async replayFor(incident: Incident, scenario: string, actor: string): Promise<ReproductionRun> {
    const replay = await this.host.replay({
      scenario,
      ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
    });
    const stop = this.track(incident.id, () => {
      replay.cancel();
    });
    try {
      const outcome = await replay.done;
      const current = await this.incident(incident.id);
      const id = `rep_${String(current.investigation.reproductions.length + 1)}`;
      const reproduction = this.reproductionOf({ ...current, scenario }, id, replay, outcome);
      await this.store.mutate(
        incident.id,
        actor,
        (latest) => {
          latest.investigation.reproductions.push(reproduction);
        },
        {
          kind: 'REPRODUCTION',
          message: `${id}: ${scenario} replayed for a verification (${reproduction.status})`,
        },
      );
      return reproduction;
    } finally {
      stop();
    }
  }

  // ── Diagnostic, rapport, non-régression ────────────────────────────────────────────────

  async diagnose(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const reproduction = incidentReproduction(incident);
    const result = diagnose(
      {
        hypotheses: incident.investigation.hypotheses,
        experiments: incident.investigation.experiments,
        ...(reproduction ? { reproduction } : {}),
        ...(incident.investigation.code ? { code: incident.investigation.code } : {}),
      },
      this.now(),
    );
    if (
      incident.state !== 'INVESTIGATING' &&
      incident.state !== 'DIAGNOSED' &&
      incident.state !== 'INCONCLUSIVE'
    )
      await this.moveTo(id, 'INVESTIGATING', actor, 'diagnosis');
    const saved = await this.store.mutate(
      id,
      actor,
      (current) => {
        current.investigation.diagnosis = result;
      },
      {
        kind: 'DIAGNOSIS',
        message: `${result.status}${result.rootCause ? `: ${result.rootCause.statement}` : ''}`,
      },
    );
    const next: IncidentState = result.status === 'INCONCLUSIVE' ? 'INCONCLUSIVE' : 'DIAGNOSED';
    return saved.state === next ? saved : this.moveTo(id, next, actor, result.status);
  }

  async report(id: string): Promise<InvestigationReport> {
    return buildReport(await this.incident(id), this.now());
  }

  async reportMarkdown(id: string): Promise<string> {
    return reportMarkdown(await this.report(id));
  }

  async proposeRegression(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    if (!incident.scenario) throw new IncidentServiceError('INVALID', 'the incident has no scenario');
    const source = await this.host.scenarioYaml(incident.scenario);
    if (!source) throw new IncidentServiceError('NOT_FOUND', `scenario ${incident.scenario} not found`);
    const proposal = proposeRegressionTest({
      incident,
      scenarioName: incident.scenario,
      scenarioYaml: source.text,
    });
    return this.store.mutate(
      id,
      actor,
      (current) => {
        current.investigation.regression = proposal;
      },
      { kind: 'REGRESSION', message: `${proposal.name} proposed` },
    );
  }

  /** Exécute réellement le test proposé, hors bibliothèque ; son verdict est celui du moteur. */
  async runRegression(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const proposal = incident.investigation.regression;
    if (!proposal) throw new IncidentServiceError('INVALID', 'no regression test proposed');
    const flow = firstFlow(proposal.flowYaml);
    if (!flow) throw new IncidentServiceError('INVALID', 'the proposed test has no flow');
    const replay = await this.host.replay({
      flow,
      ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
    });
    const stop = this.track(id, () => {
      replay.cancel();
    });
    const work = replay.done
      .then(async (outcome) => {
        stop();
        const flowReport = outcome.result?.flows.find((entry) => entry.name === proposal.name);
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const regression = current.investigation.regression;
            if (!regression || regression.name !== proposal.name) return;
            // Un run sans verdict (annulé, en échec avant le flow) n'est pas une exécution du test.
            if (outcome.status === 'COMPLETED' && flowReport)
              regression.execution = {
                run: replay.run,
                passed: flowReport.status === 'PASSED',
                at: this.now().toISOString(),
              };
          },
          {
            kind: 'REGRESSION',
            message: flowReport
              ? `${proposal.name}: ${flowReport.status} (run ${replay.run})`
              : `${proposal.name}: no verdict (${outcome.status}${outcome.error ? `: ${outcome.error}` : ''})`,
          },
        );
      })
      .catch(() => {
        stop();
      });
    this.keep(work);
    return this.incident(id);
  }

  async acceptRegression(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const proposal = incident.investigation.regression;
    if (!proposal) throw new IncidentServiceError('INVALID', 'no regression test proposed');
    if (proposal.status === 'ACCEPTED') return incident;
    const file = await this.host.addScenario(proposal.name, proposal.flowYaml);
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (current.investigation.regression) {
          current.investigation.regression.status = 'ACCEPTED';
          current.investigation.regression.file = file;
        }
      },
      { kind: 'REGRESSION', message: `${proposal.name} added to the library (${file})` },
    );
  }

  async rejectRegression(id: string, actor: string): Promise<Incident> {
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (current.investigation.regression?.status === 'PROPOSED')
          current.investigation.regression.status = 'REJECTED';
      },
      { kind: 'REGRESSION', message: 'proposal rejected' },
    );
  }

  // ── Annulation, reprise ─────────────────────────────────────────────────────────────────

  async cancel(id: string, actor: string): Promise<Incident> {
    for (const stop of [...(this.running.get(id) ?? [])]) stop();
    this.running.delete(id);
    return this.store.cancel(id, actor);
  }

  resume(id: string, actor: string): Promise<Incident> {
    return this.store.resume(id, actor);
  }

  /** Attend la fin des travaux en arrière-plan (tests, arrêt du serveur). */
  async settle(): Promise<void> {
    while (this.pending.size > 0) await Promise.allSettled([...this.pending]);
  }

  private async moveTo(id: string, to: IncidentState, actor: string, why: string): Promise<Incident> {
    try {
      return await this.store.transition(id, to, actor, why);
    } catch (error) {
      if (error instanceof IncidentStateError) throw new IncidentServiceError('STATE', error.message);
      throw error;
    }
  }

  private track(id: string, stop: () => void): () => void {
    const set = this.running.get(id) ?? new Set();
    set.add(stop);
    this.running.set(id, set);
    return () => {
      set.delete(stop);
    };
  }

  private keep(work: Promise<unknown>): void {
    this.pending.add(work);
    void work.finally(() => this.pending.delete(work));
  }
}

function firstFlow(yaml: string): Record<string, unknown> | undefined {
  const parsed = parseYaml(yaml) as unknown;
  if (!parsed || typeof parsed !== 'object') return undefined;
  const document = parsed as { flows?: unknown };
  const flows = Array.isArray(document.flows) ? (document.flows as unknown[]) : [parsed];
  const flow = flows[0];
  return flow && typeof flow === 'object' ? (flow as Record<string, unknown>) : undefined;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
