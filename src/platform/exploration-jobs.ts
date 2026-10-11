import path from 'node:path';
import type { ScenarioConfig } from '../config/config.js';
import { runMission, type RunOptions } from '../orchestrator.js';
import type { OverallStatus } from './model.js';

/**
 * EXPLORATION JOBS (parallélisation) : plusieurs missions dérivées d'une même configuration —
 * un acteur par job, ou un sous-ensemble de flows — exécutées en parallèle, chacune dans son
 * propre navigateur, sa propre session, ses propres dossiers de sortie et sa propre mémoire de
 * flows. Rien n'est partagé entre les jobs pendant le run : la connaissance (fichier) l'est
 * seulement par les écritures finales de chaque job.
 */
export interface ExplorationJob {
  id: string;
  /** L'acteur (de `actors`) dont la connexion remplace `auth` ; absent : l'acteur principal. */
  actor?: string;
  /** Les flows à exécuter (par défaut : tous). */
  flows?: string[];
  /** Variables d'environnement propres au job (sans secret : ce sont des noms de variables déjà présents). */
  env?: Record<string, string>;
}

export interface ExplorationJobResult {
  id: string;
  actor: string;
  reportsDir: string;
  status: 'COMPLETED' | 'FAILED';
  overallStatus?: OverallStatus;
  verdict?: string;
  durationMs: number;
  anomalies?: number;
  error?: string;
}

export interface ParallelRunReport {
  jobs: ExplorationJobResult[];
  concurrency: number;
  durationMs: number;
  /** Le pire statut des jobs (FAIL > INCONCLUSIVE > DEGRADED > PASS_WITH_WARNINGS > PASS). */
  overallStatus: OverallStatus;
}

/** knowledge.json → knowledge-<job>.json */
function withSuffix(file: string, suffix: string): string {
  const extension = path.extname(file);
  return path.join(path.dirname(file), `${path.basename(file, extension)}-${suffix}${extension}`);
}

const SEVERITY: OverallStatus[] = ['PASS', 'PASS_WITH_WARNINGS', 'DEGRADED', 'INCONCLUSIVE', 'FAIL'];

/** La configuration d'un job : l'acteur, les flows, des sorties isolées. */
export function jobConfig(config: ScenarioConfig, job: ExplorationJob): ScenarioConfig {
  const actor = job.actor ? config.actors.find((entry) => entry.name === job.actor) : undefined;
  if (job.actor && !actor) throw new Error(`exploration job ${job.id}: unknown actor "${job.actor}"`);
  const flows = job.flows ? config.flows.filter((flow) => job.flows?.includes(flow.name)) : config.flows;
  if (job.flows && flows.length !== job.flows.length)
    throw new Error(
      `exploration job ${job.id}: unknown flow(s) ${job.flows.filter((name) => !flows.some((flow) => flow.name === name)).join(', ')}`,
    );
  const suffix = job.id.replace(/[^A-Za-z0-9_-]+/g, '-');
  return {
    ...config,
    ...(actor ? { auth: actor.auth } : {}),
    flows,
    // Les autres acteurs sont observés par le job de l'acteur principal seulement.
    actors: actor ? [] : config.actors,
    authorization: { ...config.authorization, ...(actor ? { primaryActor: actor.name } : {}) },
    output: {
      ...config.output,
      reportsDir: path.join(config.output.reportsDir, suffix),
      screenshotsDir: path.join(config.output.screenshotsDir, suffix),
    },
    memory: { ...config.memory, file: path.join(config.output.reportsDir, suffix, 'flow-graph.json') },
    // Rien n'est écrit au même endroit par deux jobs : connaissance, persistance fichier, baselines, par job.
    ...(config.knowledge.file
      ? { knowledge: { ...config.knowledge, file: withSuffix(config.knowledge.file, suffix) } }
      : {}),
    persistence: {
      ...config.persistence,
      file: { ...config.persistence.file, directory: path.join(config.persistence.file.directory, suffix) },
    },
    baseline: { ...config.baseline, dir: path.join(config.baseline.dir, suffix) },
    ...(config.visual.baselineDir
      ? { visual: { ...config.visual, baselineDir: path.join(config.visual.baselineDir, suffix) } }
      : {}),
    // Les sessions réutilisables sont déjà par acteur (fichier par nom) : isolées.
  };
}

/** Exécute les jobs avec au plus `concurrency` en parallèle. */
export async function runExplorationJobs(
  config: ScenarioConfig,
  jobs: readonly ExplorationJob[],
  options: { concurrency: number; run?: RunOptions; runner?: typeof runMission },
): Promise<ParallelRunReport> {
  const started = Date.now();
  const runner = options.runner ?? runMission;
  const results: ExplorationJobResult[] = new Array<ExplorationJobResult>(jobs.length);
  let next = 0;
  const worker = async (): Promise<void> => {
    while (next < jobs.length) {
      const index = next;
      next += 1;
      const job = jobs[index];
      if (!job) continue;
      const jobStarted = Date.now();
      const actor = job.actor ?? config.authorization.primaryActor;
      try {
        const derived = jobConfig(config, job);
        const env = { ...(options.run?.env ?? process.env), ...(job.env ?? {}) };
        const { result } = await runner(derived, { ...options.run, env });
        results[index] = {
          id: job.id,
          actor,
          reportsDir: derived.output.reportsDir,
          status: 'COMPLETED',
          ...(result.workflowAnalysis
            ? {
                overallStatus: result.workflowAnalysis.overallStatus,
                anomalies: result.workflowAnalysis.anomalySummary.total,
              }
            : {}),
          ...(result.runAnalysis ? { verdict: result.runAnalysis.status } : {}),
          durationMs: Date.now() - jobStarted,
        };
      } catch (error) {
        results[index] = {
          id: job.id,
          actor,
          reportsDir: path.join(config.output.reportsDir, job.id),
          status: 'FAILED',
          durationMs: Date.now() - jobStarted,
          error: error instanceof Error ? (error.message.split('\n')[0] ?? 'failed') : String(error),
        };
      }
    }
  };
  const concurrency = Math.max(1, Math.min(options.concurrency, jobs.length));
  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  const worst = results.reduce<OverallStatus>((current, job) => {
    const status: OverallStatus = job.status === 'FAILED' ? 'FAIL' : (job.overallStatus ?? 'INCONCLUSIVE');
    return SEVERITY.indexOf(status) > SEVERITY.indexOf(current) ? status : current;
  }, 'PASS');
  return { jobs: results, concurrency, durationMs: Date.now() - started, overallStatus: worst };
}

/** Un job par acteur (l'acteur principal compris) : la manière la plus simple de paralléliser. */
export function jobsPerActor(config: ScenarioConfig): ExplorationJob[] {
  return [
    { id: config.authorization.primaryActor },
    ...config.actors.map((actor) => ({ id: actor.name, actor: actor.name })),
  ];
}
