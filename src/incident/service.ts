import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { flowSchema } from '../config/flow-schema.js';
import type { FlowRunReport } from '../model/flow-run.js';
import { generatePlaywrightTest } from '../platform/playwright-test-generator.js';
import { redactText } from '../security/redactor.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import {
  AttachmentError,
  attachmentsDir,
  decodeAttachment,
  deleteAttachment,
  isAttachmentId,
  isAttachmentType,
  isImageType,
  newAttachmentId,
  readAttachment,
  sanitizeAttachmentName,
  sniffAttachment,
  writeAttachment,
} from './attachments.js';
import {
  AccessInputError,
  accessKeywords,
  accessText,
  buildAccessAnalysis,
  interpretations,
  parseAccessPath,
  sanitizeAccess,
} from './access.js';
import { discoverScope as discoverResources } from './trigger/discovery.js';
import { entryActions, locateTarget, preparationOf } from './target-screen.js';
import { ExplorationSession, describeAction } from './trigger/session.js';
import {
  type IncidentAccess,
  type IncidentAccessInput,
  type TargetLocation,
  type TargetPreparation,
} from '../sdk/core/incident-contracts.js';
import { analyzeCode } from './code/index.js';
import { buildGraph } from './correlator.js';
import { buildFrontendTrace } from './frontend-trace.js';
import { buildTimeline } from './timeline.js';
import { environmentAdapter, type ExecutionEnvironmentAdapter } from './environments.js';
import { incidentReproduction, reproductionFromResult } from './evidence.js';
import { planExperiment, runExperiment } from './experiments.js';
import { LiveProgress, type ReplayProgressEvent } from './live.js';
import { applyExperiment, proposeHypotheses } from './hypotheses.js';
import { IncidentStateError, IncidentStore } from './incident-store.js';
import {
  MAX_ATTACHMENTS,
  SCOPE_TREE_MAX_DEPTH,
  SCOPE_TREE_MAX_NODES,
  type EnvironmentCapabilities,
  type Experiment,
  type ExperimentKind,
  type Incident,
  type IncidentAttachment,
  type IncidentAttachmentContent,
  type IncidentAttachmentInput,
  type IncidentInput,
  type IncidentState,
  type IncidentSummary,
  type InvestigationReport,
  type InvestigationReportPart,
  type RegressionSpec,
  type ReportSection,
  type ReproductionRun,
  type ScopeExtension,
  type KnownRepository,
  type ScopeApplication,
  type ScopeDiscovery,
  type ScopeTree,
  type SourceFileView,
  type SourceTree,
} from './model.js';
import { proposeRegressionTest } from './regression.js';
import { buildReport, reportMarkdown, reportPart } from './report.js';
import { PDF_TIMEOUT_MS, renderPdf, reportHtml, type PdfRenderer } from './report-export.js';
import { guardedFiles } from './guarded-fs.js';
import { scopeTreeOf } from './scope-tree.js';
import { discoverRepository } from './scope-discovery.js';
import { diagnose } from './root-cause.js';
import { decideExtension, requestExtension, validateScope } from './scope.js';
import { ScopePolicy } from './scope-policy.js';
import type { AiRunnerOutcome, IncidentAiRuntime } from './ai/index.js';
import {
  MAX_TRIGGER_RUNS_KEPT,
  TRIGGER_BUDGET_CAPS as TRIGGER_BUDGET_CAPS_FOR,
  TRIGGER_DEPTHS,
  type IncidentBrief,
  type TriggerBudget,
  type TriggerInvestigationInput,
  type TriggerRun,
  type TriggerRunReport,
} from '../sdk/core/incident-trigger-contracts.js';
import { analyzeAngular } from './code/angular.js';
import { createAiSequenceProposer } from './trigger/ai-hook.js';
import { interpretBrief, keywordsOf } from './trigger/brief.js';
import { TriggerEngine, resolveTriggerBudget, type TriggerEngineOutcome } from './trigger/engine.js';
import { buildTriggerReport } from './trigger/report.js';
import {
  DEPTH_MODES,
  INVESTIGATION_DEPTHS,
  MAX_AI_ANSWERS_KEPT,
  MAX_AI_RUNS_KEPT,
  type AiAssistantAnswer,
  type AiBudget,
  type AiCapabilities,
  type AiExperimentProposal,
  type AiInvestigationRun,
  type AiUsage,
  type DeepInvestigationInput,
  type InvestigationDepth,
  type InvestigationMemory,
} from '../sdk/core/incident-ai-contracts.js';

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
    /**
     * Les événements du moteur pendant le rejeu (début de flow, début et fin d'étape), relayés tels
     * quels : descriptions sans valeur saisie, captures relatives au dossier du run.
     */
    onProgress?: (event: ReplayProgressEvent) => void;
  }): Promise<HostReplay>;
  /** Le flow YAML d'un scénario de la bibliothèque. */
  scenarioYaml(name: string): Promise<{ file: string; text: string } | undefined>;
  /** Les scénarios de la bibliothèque (nom, fichier, texte YAML quand il est lisible), pour la découverte du périmètre. */
  listScenarios?(): Promise<{ name: string; file: string; text?: string }[]>;
  /** Ajoute un scénario à la bibliothèque (après validation) ; renvoie son fichier. */
  addScenario(name: string, yaml: string): Promise<string>;
  /** L'URL de l'environnement cible (son hôte entre dans le périmètre de navigation). */
  environment(environmentId?: string): Promise<{ id?: string; baseUrl?: string; kind?: string }>;
  /** Les dépôts que le projet déclare (dossier des sources Angular…), proposés à la réutilisation par la découverte du périmètre. */
  sourceRoots?(): Promise<{ root: string; label: string }[]>;
  /**
   * Les étapes d'un enregistrement du module Enregistrements (décrites sans valeur saisie) pour le
   * scénario d'accès ; undefined : introuvable, ou session encore en cours.
   */
  recordingSteps?(name: string): Promise<
    | {
        name: string;
        startAt?: string;
        startedAt?: string;
        steps: { id: string; kind: string; description: string }[];
      }
    | undefined
  >;
  /** Le dossier d'un run du moteur (captures, trace). */
  runDir(run: string): string;
}

/** Ce que l'explorateur de code lit, par couche (les sources et leur configuration). */
const SOURCE_EXTENSIONS: Record<'FRONTEND' | 'BFF' | 'BACKEND', string[]> = {
  FRONTEND: ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.vue', '.json'],
  BFF: ['.java', '.yml', '.yaml', '.properties', '.xml'],
  BACKEND: ['.java', '.yml', '.yaml', '.properties', '.xml', '.sql'],
};

const IMAGE_TYPES: Record<string, string> = {
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};
const MAX_SCREENSHOT_BYTES = 5 * 1024 * 1024;
/** Le résultat d'un run relu pour le test généré : au-delà, il n'est pas lu. */
const MAX_RESULT_BYTES = 32 * 1024 * 1024;

/** Une clé de configuration qui ressemble à un secret : sa valeur n'est jamais montrée. */
const SECRET_KEY =
  /(pass(word|wd)?|secret|token|api[-_.]?key|credential|private[-_.]?key|client[-_.]?secret)/i;

/** Les valeurs sensibles d'un fichier masquées (configuration : clé = valeur, clé: valeur ; puis le masquage commun). */
export function maskSource(file: string, text: string): string {
  const config = /\.(ya?ml|properties|env|json|xml)$/i.test(file);
  const lines = text.split('\n').map((line) => {
    if (!config) return line;
    const match = /^(\s*["']?([\w.-]+)["']?\s*[:=]\s*)(.+)$/.exec(line);
    return match?.[2] && SECRET_KEY.test(match[2]) && !/^\$\{[^}]*\}$/.test(match[3]?.trim() ?? '')
      ? `${match[1] ?? ''}[REDACTED]`
      : line;
  });
  return redactText(lines.join('\n'));
}

function languageOf(file: string): SourceFileView['language'] {
  if (/\.(ts|tsx|js|jsx|mjs|cjs|vue)$/i.test(file)) return 'typescript';
  if (/\.java$/i.test(file)) return 'java';
  if (/\.ya?ml$/i.test(file)) return 'yaml';
  if (/\.xml$/i.test(file)) return 'xml';
  return 'text';
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
  /** Le dernier numéro de reproduction attribué par incident (voir nextReproduction). */
  private readonly allocated = new Map<string, number>();
  /** Les travaux en arrière-plan (tests : attendre leur fin). */
  private readonly pending = new Set<Promise<unknown>>();
  /**
   * La progression en direct de la reproduction en cours, par incident : en mémoire seulement (une écriture
   * par étape changerait la révision et ferait échouer les modifications faites pendant le rejeu).
   */
  private readonly live = new Map<string, { reproduction: string; progress: LiveProgress }>();

  constructor(
    private readonly host: IncidentHost,
    private readonly deps: {
      adapter?: (incident: Incident) => ExecutionEnvironmentAdapter;
      now?: () => Date;
      env?: NodeJS.ProcessEnv;
      /** L'impression PDF (tests : un double ; par défaut Chromium via Playwright). */
      pdf?: PdfRenderer;
      pdfTimeoutMs?: number;
      /**
       * L'investigation IA (src/incident/ai), assemblée par le serveur quand `ai.incidents.mode` n'est pas
       * DETERMINISTIC ; absente : aucun module IA n'est chargé, les routes IA répondent « indisponible ».
       */
      ai?: IncidentAiRuntime;
    } = {},
  ) {
    this.store = new IncidentStore(host.projectDir);
  }

  /** Le run IA en cours par incident : en mémoire seulement (comme la progression d'un rejeu). */
  private readonly aiLive = new Map<string, AiInvestigationRun>();
  /** L'arrêt du run IA en cours par incident (annulation du run seul, sans annuler l'incident). */
  private readonly aiAbort = new Map<string, AbortController>();
  /** Les incidents dont une personne a demandé la pause de la boucle IA. */
  private readonly aiPaused = new Set<string>();
  /** Le run de découverte des déclencheurs en cours, par incident (progression en mémoire). */
  private readonly triggerLive = new Map<string, TriggerRun>();
  /** Le moteur du dernier run (expériences après la fin du run), par incident. */
  private readonly triggerEngines = new Map<string, TriggerEngine>();
  private readonly triggerControl = new Map<string, TriggerControlState>();
  /** La fin d'une vérification en arrière-plan, par identifiant (la boucle IA l'attend). */
  private readonly experimentJobs = new Map<string, Promise<unknown>>();

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
    // La chronologie unifiée se déduit de tout le reste (reproductions, vérifications, journaux, historique) :
    // calculée à chaque lecture, elle n'est jamais en retard sur l'historique.
    incident.investigation.timeline = buildTimeline(incident);
    const live = this.live.get(id);
    const running = live
      ? incident.investigation.reproductions.find(
          (run) => run.id === live.reproduction && run.status === 'RUNNING',
        )
      : undefined;
    const snapshot = live?.progress.snapshot();
    if (running && snapshot) running.live = snapshot;
    const triggerRun = this.triggerLive.get(id);
    if (triggerRun && incident.investigation.trigger) {
      const at = incident.investigation.trigger.runs.findIndex((run) => run.id === triggerRun.id);
      if (at >= 0) incident.investigation.trigger.runs[at] = structuredClone(triggerRun);
    }
    const aiRun = this.aiLive.get(id);
    if (aiRun && incident.investigation.ai) {
      const at = incident.investigation.ai.runs.findIndex((run) => run.id === aiRun.id);
      // Le run vivant n'est montré que tant qu'il tourne : terminé, il attend que `absorbAiOutcome` ait écrit
      // ses hypothèses, sans quoi un lecteur verrait un run fini sans ce qu'il a produit.
      if (at >= 0 && incident.investigation.ai.runs[at]?.status === 'RUNNING' && aiRun.status === 'RUNNING')
        incident.investigation.ai.runs[at] = structuredClone(aiRun);
    }
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
    // Les événements peuvent arriver avant que la reproduction soit enregistrée : ils sont gardés ici.
    const progress = new LiveProgress();
    let replay: HostReplay;
    try {
      replay = await this.host.replay({
        onProgress: (event) => {
          progress.apply(event);
        },
        scenario: incident.scenario,
        ...(incident.environmentId ? { environmentId: incident.environmentId } : {}),
        ...(options.headed !== undefined ? { headed: options.headed } : {}),
        ...(options.slowMoMs !== undefined ? { slowMoMs: options.slowMoMs } : {}),
      });
    } catch (error) {
      await this.store.transition(id, 'FAILED', actor, `replay refused: ${message(error)}`);
      throw error;
    }
    const reproductionId = this.nextReproduction(incident);
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
    const tracked = { reproduction: reproductionId, progress };
    this.live.set(id, tracked);
    const forget = (): void => {
      if (this.live.get(id) === tracked) this.live.delete(id);
    };
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
            // Une nouvelle reproduction de l'incident : sa traçabilité frontend, si le code est déjà analysé.
            const reference = incidentReproduction(current);
            if (reference?.id === reproduction.id && current.investigation.code)
              current.investigation.frontendTrace = buildFrontendTrace({
                reproduction,
                code: current.investigation.code,
              });
          },
          {
            kind: 'REPRODUCTION',
            message: `${reproductionId}: ${reproduction.symptomMatch ?? reproduction.error ?? outcome.status}`,
          },
        );
        // Les actions enregistrées remplacent la progression en direct.
        forget();
        const latest = await this.incident(id);
        if (latest.state === 'REPRODUCING' && next !== 'CANCELLED')
          await this.store.transition(id, next, actor, reproduction.symptomMatch ?? outcome.status);
      })
      .catch(async (error: unknown) => {
        stop();
        forget();
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

  // ── Lecture du code et des captures (lecture seule, dans le périmètre) ─────────────────────

  /** Les fichiers lisibles du périmètre, application par application ; les refus sont rendus tels quels. */
  async sourceTree(id: string): Promise<SourceTree> {
    const incident = await this.incident(id);
    const policy = await this.policy(incident);
    const files = this.adapter(incident).files(policy);
    const applications: SourceTree['applications'] = [];
    for (const application of incident.scope.applications) {
      const root = application.repository.root;
      const starts =
        application.repository.include.length > 0
          ? application.repository.include.map((entry) => path.join(root, entry))
          : [root];
      const listed = new Set<string>();
      for (const start of starts) {
        try {
          for (const file of await files.list(start, { extensions: SOURCE_EXTENSIONS[application.layer] }))
            listed.add(path.relative(root, file).split(path.sep).join('/'));
        } catch {
          // un dossier refusé ou absent : la raison est dans files.denied
        }
      }
      applications.push({
        applicationId: application.id,
        name: application.name,
        layer: application.layer,
        files: [...listed].sort(),
        truncated: files.truncated.length > 0,
      });
    }
    return { applications, denied: [...files.denied] };
  }

  /** Un fichier du périmètre, masqué, avec ses symboles et les lignes que l'investigation désigne. */
  async source(id: string, applicationId: string, file: string): Promise<SourceFileView> {
    const incident = await this.incident(id);
    const application = incident.scope.applications.find((entry) => entry.id === applicationId);
    if (!application)
      throw new IncidentServiceError('NOT_FOUND', `application ${applicationId} is not in the scope`);
    if (file === '' || path.isAbsolute(file) || file.split(/[\\/]/).includes('..'))
      throw new IncidentServiceError('SCOPE', 'the file must be a path inside the repository');
    const policy = await this.policy(incident);
    const files = this.adapter(incident).files(policy);
    const text = maskSource(file, await files.readText(path.join(application.repository.root, file)));
    const code = incident.investigation.code;
    const symbols = (code?.symbols ?? []).filter(
      (symbol) => symbol.applicationId === applicationId && symbol.file === file,
    );
    const inFile = new Set(symbols.map((symbol) => symbol.id));
    const highlights: SourceFileView['highlights'] = [];
    for (const node of incident.investigation.graph?.nodes ?? []) {
      const symbol = node.symbolId ? symbols.find((entry) => entry.id === node.symbolId) : undefined;
      const line =
        node.source?.applicationId === applicationId && node.source.file === file
          ? node.source.line
          : symbol?.line;
      if (line === undefined) continue;
      highlights.push({
        line,
        ...(node.source?.endLine !== undefined ? { endLine: node.source.endLine } : {}),
        kind: node.kind === 'EXCEPTION' ? 'ERROR' : 'PATH',
        reason: node.label,
        refs: [node.id],
      });
    }
    for (const hypothesis of incident.investigation.hypotheses)
      for (const { ref, fact } of hypothesis.supporting) {
        const symbol = inFile.has(ref) ? symbols.find((entry) => entry.id === ref) : undefined;
        if (symbol)
          highlights.push({
            line: symbol.line,
            kind: 'HYPOTHESIS',
            reason: `${hypothesis.title} — ${fact}`,
            refs: [hypothesis.id],
          });
      }
    return {
      applicationId,
      layer: application.layer,
      file,
      language: languageOf(file),
      text,
      symbols,
      highlights: highlights.sort((a, b) => a.line - b.line),
    };
  }

  /** Une capture d'une reproduction, en image `data:` : seulement les captures qu'elle a enregistrées, dans son dossier. */
  async screenshot(id: string, reproductionId: string, file: string): Promise<{ dataUrl: string }> {
    const incident = await this.incident(id);
    const reproduction = incident.investigation.reproductions.find((entry) => entry.id === reproductionId);
    // Pendant le rejeu : aussi les captures que le moteur a écrites et annoncées (progression en direct).
    const known = [
      ...(reproduction?.screenshots ?? []),
      ...(reproduction?.live?.steps ?? []).map((step) => step.screenshot),
    ];
    if (!reproduction?.run || !known.includes(file))
      throw new IncidentServiceError('NOT_FOUND', 'screenshot not found');
    const type = IMAGE_TYPES[path.extname(file).toLowerCase()];
    if (!type) throw new IncidentServiceError('NOT_FOUND', 'screenshot not found');
    const runDir = await realpath(this.host.runDir(reproduction.run));
    const target = await realpath(path.resolve(runDir, file)).catch(() => undefined);
    if (!target || !target.startsWith(runDir + path.sep))
      throw new IncidentServiceError('SCOPE', 'the screenshot is outside its run');
    if ((await stat(target)).size > MAX_SCREENSHOT_BYTES)
      throw new IncidentServiceError('INVALID', 'the screenshot is too large to display');
    return { dataUrl: `data:${type};base64,${(await readFile(target)).toString('base64')}` };
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
        if (reproduction)
          current.investigation.frontendTrace = buildFrontendTrace({
            reproduction,
            ...(code ? { code } : {}),
          });
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
    input: {
      kind: ExperimentKind;
      params: Experiment['params'];
      hypothesisId?: string;
      description?: string;
    },
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
    this.experimentJobs.set(experimentId, work);
    void work.finally(() => this.experimentJobs.delete(experimentId));
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
    const id = this.nextReproduction(await this.incident(incident.id));
    try {
      const outcome = await replay.done;
      const current = await this.incident(incident.id);
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
    const incident = await this.incident(id);
    const memory = incident.investigation.ai ? await this.aiMemory(id) : undefined;
    return buildReport(incident, this.now(), memory ? { memory } : {});
  }

  async reportMarkdown(id: string, sections?: readonly ReportSection[]): Promise<string> {
    return reportMarkdown(await this.report(id), sections);
  }

  /** Le rapport JSON restreint à des sections (les clés écartées sont absentes). */
  async reportPart(id: string, sections: readonly ReportSection[]): Promise<InvestigationReportPart> {
    return reportPart(await this.report(id), sections);
  }

  /** Le rapport en document HTML autonome (échappé, sans script). */
  async reportHtml(id: string, sections?: readonly ReportSection[]): Promise<string> {
    return reportHtml(await this.report(id), sections);
  }

  /** Le rapport HTML imprimé par Chromium ; PdfUnavailableError sans navigateur, PdfTimeoutError au-delà du délai. */
  async reportPdf(id: string, sections?: readonly ReportSection[]): Promise<{ pdfBase64: string }> {
    const html = await this.reportHtml(id, sections);
    const pdf = await (this.deps.pdf ?? renderPdf)(html, {
      timeoutMs: this.deps.pdfTimeoutMs ?? PDF_TIMEOUT_MS,
    });
    return { pdfBase64: Buffer.from(pdf).toString('base64') };
  }

  // ── Pièces jointes ──────────────────────────────────────────────────────────────────────

  /**
   * Ajoute une pièce jointe : type permis, contenu conforme au type (octets examinés), taille et nombre
   * bornés, nom nettoyé. Le fichier est écrit sous son identifiant, puis déclaré dans l'incident.
   */
  async addAttachment(id: string, input: IncidentAttachmentInput, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    if (incident.state === 'CANCELLED')
      throw new IncidentServiceError('STATE', 'the incident is cancelled: resume it before adding a file');
    const type: unknown = input.type;
    if (!isAttachmentType(type))
      throw new AttachmentError('UNSUPPORTED_TYPE', `type ${String(type)} is not accepted`);
    const name = sanitizeAttachmentName(input.name);
    if ((incident.attachments ?? []).length >= MAX_ATTACHMENTS)
      throw new AttachmentError(
        'TOO_MANY',
        `an incident holds at most ${String(MAX_ATTACHMENTS)} attachments`,
      );
    const bytes = decodeAttachment(input.dataBase64);
    sniffAttachment(type, bytes);
    const directory = attachmentsDir(this.host.projectDir, incident.id);
    const attachment: IncidentAttachment = {
      id: newAttachmentId(),
      name,
      type,
      bytes: bytes.byteLength,
      addedAt: this.now().toISOString(),
      addedBy: actor,
    };
    await writeAttachment(directory, attachment.id, bytes);
    try {
      return await this.store.mutate(
        id,
        actor,
        (current) => {
          const list = current.attachments ?? [];
          // Revérifié dans la file de l'incident : deux envois simultanés ne dépassent pas le plafond.
          if (list.length >= MAX_ATTACHMENTS)
            throw new AttachmentError(
              'TOO_MANY',
              `an incident holds at most ${String(MAX_ATTACHMENTS)} attachments`,
            );
          current.attachments = [...list, attachment];
        },
        {
          kind: 'ATTACHMENT',
          message: `${attachment.id} added: ${name} (${type}, ${String(bytes.byteLength)} bytes)`,
        },
      );
    } catch (error) {
      await deleteAttachment(directory, attachment.id);
      throw error;
    }
  }

  /** Le contenu d'une pièce jointe : une image en `data:`, un texte masqué (redactor, clés sensibles). */
  async attachment(id: string, attachmentId: string): Promise<IncidentAttachmentContent> {
    const incident = await this.incident(id);
    const attachment = isAttachmentId(attachmentId)
      ? (incident.attachments ?? []).find((entry) => entry.id === attachmentId)
      : undefined;
    if (!attachment) throw new IncidentServiceError('NOT_FOUND', 'attachment not found');
    let bytes: Buffer;
    try {
      bytes = await readAttachment(attachmentsDir(this.host.projectDir, incident.id), attachment.id);
    } catch (error) {
      if (error instanceof AttachmentError) throw error;
      throw new IncidentServiceError('NOT_FOUND', 'attachment content not found');
    }
    // Le contenu est réexaminé à la lecture : un fichier remplacé sur le disque n'est pas servi pour autre chose.
    sniffAttachment(attachment.type, bytes);
    if (isImageType(attachment.type))
      return {
        id: attachment.id,
        type: attachment.type,
        dataUrl: `data:${attachment.type};base64,${bytes.toString('base64')}`,
      };
    const text = bytes.toString('utf8');
    return {
      id: attachment.id,
      type: attachment.type,
      text: maskSource(attachment.type === 'application/json' ? 'attachment.json' : 'attachment.txt', text),
    };
  }

  async removeAttachment(id: string, attachmentId: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const attachment = (incident.attachments ?? []).find((entry) => entry.id === attachmentId);
    if (!attachment || !isAttachmentId(attachmentId))
      throw new IncidentServiceError('NOT_FOUND', 'attachment not found');
    const saved = await this.store.mutate(
      id,
      actor,
      (current) => {
        current.attachments = (current.attachments ?? []).filter((entry) => entry.id !== attachmentId);
      },
      { kind: 'ATTACHMENT', message: `${attachmentId} removed: ${attachment.name}` },
    );
    await deleteAttachment(attachmentsDir(this.host.projectDir, incident.id), attachmentId);
    return saved;
  }

  // ── Arborescence du périmètre ───────────────────────────────────────────────────────────

  /**
   * Les dossiers du dépôt d'une application (aucun contenu de fichier), pour choisir `include` : lus par le
   * Scope Policy Engine sur toute la racine du dépôt (les dossiers inclus ne restreignent pas le choix),
   * liens symboliques jamais suivis, dossiers de dépendances et de build ignorés, profondeur et nombre bornés.
   */
  async scopeTree(id: string, applicationId: string, depth = 3): Promise<ScopeTree> {
    if (!Number.isInteger(depth) || depth < 1 || depth > SCOPE_TREE_MAX_DEPTH)
      throw new IncidentServiceError(
        'INVALID',
        `depth must be an integer between 1 and ${String(SCOPE_TREE_MAX_DEPTH)}`,
      );
    const incident = await this.incident(id);
    const application = incident.scope.applications.find((entry) => entry.id === applicationId);
    if (!application)
      throw new IncidentServiceError('NOT_FOUND', `application ${applicationId} is not in the scope`);
    const whole = { ...application, repository: { ...application.repository, include: [] } };
    const scope = { ...incident.scope, applications: [whole] };
    const policy = new ScopePolicy(scope, { execution: incident.execution });
    const files = this.adapter({ ...incident, scope }).files(policy);
    if (!files.listDirectories)
      throw new IncidentServiceError('INVALID', 'this environment cannot list directories');
    const listing = await files.listDirectories(application.repository.root, {
      depth,
      maxNodes: SCOPE_TREE_MAX_NODES,
    });
    return scopeTreeOf(application, listing, depth);
  }

  /**
   * La découverte automatique d'un dépôt pour le périmètre : lue par le Scope Policy Engine sur une racine
   * provisoire (la racine demandée, permissions et limites de l'incident), jamais écrite dans l'incident ;
   * la pertinence vient des mots de l'incident (titre, description, symptôme, application nommée).
   */
  async discoverScope(id: string, root: string): Promise<ScopeDiscovery> {
    const incident = await this.incident(id);
    const trimmed = root.trim();
    const keywords = keywordsOf(
      `${incident.title} ${incident.application ?? ''} ${incident.description} ${incident.observed}`,
      16,
    );
    const common = { keywords, existing: incident.scope.applications, now: this.now().toISOString() };
    const named = incident.application ? { application: incident.application } : {};
    if (!path.isAbsolute(trimmed) && !path.win32.isAbsolute(trimmed)) {
      // Aucun accès au disque pour un chemin relatif : le module explique le problème.
      const probe = guardedFiles(new ScopePolicy(incident.scope, { execution: incident.execution }));
      return discoverRepository({ root: trimmed, files: probe, ...common, ...named });
    }
    const probe: ScopeApplication = {
      id: 'discovery',
      name: path.basename(trimmed) || trimmed,
      layer: 'BACKEND',
      repository: { root: trimmed, include: [] },
    };
    const scope = { ...incident.scope, applications: [probe] };
    const policy = new ScopePolicy(scope, { execution: incident.execution });
    const files = this.adapter({ ...incident, scope }).files(policy);
    return discoverRepository({ root: trimmed, files, ...common, ...named });
  }

  /**
   * Les dépôts déjà connus de l'environnement d'investigation : ceux du projet (sources déclarées), du
   * périmètre de cet incident, et des autres incidents du projet (cinquante au plus) ; une racine une fois.
   */
  // ── Scénario d'accès et démonstration ───────────────────────────────────────────────────────

  /**
   * Enregistre le scénario d'accès (texte, étapes, départ, données de test sans secret : tout est
   * masqué) ; la démonstration et l'analyse précédente sont gardées. `recording` associe un
   * enregistrement existant du projet (vérifié) ou le dissocie (null).
   */
  async saveAccess(id: string, input: IncidentAccessInput, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    if (incident.state === 'CANCELLED')
      throw new IncidentServiceError(
        'STATE',
        'the incident is cancelled: resume it before editing the access scenario',
      );
    const at = this.now().toISOString();
    let next: IncidentAccess;
    try {
      next = sanitizeAccess(input, incident.access, actor, at);
    } catch (error) {
      if (error instanceof AccessInputError) throw new IncidentServiceError('INVALID', error.message);
      throw error;
    }
    if ('recording' in input) {
      const raw: unknown = input.recording;
      if (raw === null) delete next.recording;
      else if (typeof raw === 'string' && raw.trim() !== '' && raw.length <= 200) {
        const name = raw.trim();
        const found = this.host.recordingSteps ? await this.host.recordingSteps(name) : undefined;
        if (!found)
          throw new IncidentServiceError(
            'NOT_FOUND',
            `recording ${name} not found (or still being recorded)`,
          );
        next.recording =
          incident.access?.recording?.name === name
            ? incident.access.recording
            : { name, linkedAt: at, linkedBy: actor };
      } else throw new IncidentServiceError('INVALID', 'recording must be a recording name or null');
    }
    const parts = [
      next.narrative ? 'parcours' : '',
      next.steps.length > 0 ? `${String(next.steps.length)} étape(s)` : '',
      next.recording ? `enregistrement ${next.recording.name}` : '',
    ].filter(Boolean);
    return this.store.mutate(
      id,
      actor,
      (current) => {
        current.access = next;
      },
      {
        kind: 'UPDATED',
        message: `scénario d’accès enregistré${parts.length > 0 ? ` (${parts.join(', ')})` : ''}`,
      },
    );
  }

  /** Les modèles Angular des applications frontend du périmètre (lecture contrôlée par la politique). */
  private async frontendModels(incident: Incident): Promise<Awaited<ReturnType<typeof analyzeAngular>>[]> {
    if (!incident.scope.permissions.readSources) return [];
    const policy = await this.policy(incident);
    const files = this.adapter(incident).files(policy);
    const frontends = incident.scope.applications.filter((application) => application.layer === 'FRONTEND');
    return (await Promise.all(frontends.map((application) => analyzeAngular(application, files)))).filter(
      (model) => model.nodes.length > 0,
    );
  }

  /**
   * LOCALISER L'ÉCRAN : l'écran cible (texte, URL, indications, étapes connues, départ d'un enregistrement)
   * est cherché dans la navigation lue par l'analyseur Angular (routes, redirections, gardes, liens, titres) ;
   * les candidats citent leurs indices, le parcours d'accès est le plus court par liens. `route` impose un
   * candidat. Lecture seule, dans la politique du périmètre.
   */
  async locateAccessTarget(id: string, actor: string, options: { route?: string } = {}): Promise<Incident> {
    const incident = await this.incident(id);
    const access = incident.access;
    const query = [access?.target, access?.hints].filter(Boolean).join(' ').trim();
    if (!access || (query === '' && !access.url))
      throw new IncidentServiceError('INVALID', 'indicate the target screen (or its URL) before locating it');
    if (options.route !== undefined && (typeof options.route !== 'string' || options.route.length > 500))
      throw new IncidentServiceError('INVALID', 'route must be a path');
    const models = await this.frontendModels(incident);
    let recordingStart: string | undefined;
    if (access.mode === 'DEMO' && access.recording && this.host.recordingSteps) {
      const recording = await this.host.recordingSteps(access.recording.name).catch(() => undefined);
      recordingStart = recording?.startAt;
    }
    const location: TargetLocation = locateTarget({
      query: access.target ?? access.url ?? '',
      ...(access.url ? { url: access.url } : {}),
      ...(access.hints ? { hints: access.hints } : {}),
      ...(access.mode === 'GUIDED' ? { steps: access.steps.map((step) => step.text) } : {}),
      ...(recordingStart ? { recordingStart } : {}),
      ...(options.route ? { route: options.route } : {}),
      models,
      actor,
      at: this.now().toISOString(),
    });
    if (!incident.scope.permissions.readSources)
      location.limits.unshift(
        'La lecture des sources n’est pas autorisée par le périmètre : aucune route n’est lue.',
      );
    else if (!incident.scope.applications.some((application) => application.layer === 'FRONTEND'))
      location.limits.unshift(
        'Aucune application frontend dans le périmètre : ajoutez-la depuis « Applications et dépôts ».',
      );
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (!current.access) return;
        current.access.location = location;
        // Un autre écran : la préparation précédente ne vaut plus.
        if (current.access.preparation && current.access.preparation.route !== location.chosen)
          delete current.access.preparation;
      },
      {
        kind: 'SCOPE',
        message: location.chosen
          ? `écran cible localisé : ${location.chosen} (${String(location.candidates.length)} candidat(s), parcours de ${String(location.path.length)} étape(s))`
          : 'écran cible non localisé',
      },
    );
  }

  /**
   * PRÉPARER L'EXPLORATION : le parcours d'accès est joué dans un vrai navigateur (session du moteur de
   * déclencheurs, chaque navigation vérifiée par la politique) ; l'écran atteint est inventorié (boutons,
   * champs, liens, listes, éléments désactivés, dialogues, messages), avec les requêtes et erreurs vues et une
   * capture. Aucune action n'est déclenchée sur l'écran cible ; un blocage (connexion, garde, mauvais écran)
   * est dit précisément.
   */
  async prepareAccessTarget(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const location = incident.access?.location;
    if (!location?.chosen || location.path.length === 0)
      throw new IncidentServiceError('INVALID', 'locate the target screen before preparing the exploration');
    if (incident.state === 'CANCELLED') throw new IncidentServiceError('STATE', 'the incident is cancelled');
    if (!incident.scope.permissions.navigate)
      throw new IncidentServiceError('SCOPE', 'navigation is not allowed by the scope');
    const target = await this.host.environment(incident.environmentId);
    if (!target.baseUrl)
      throw new IncidentServiceError(
        'INVALID',
        'no environment URL: the exploration runs on a test environment',
      );
    const policy = await this.policy(incident);
    const actions = entryActions(location.path, target.baseUrl);
    const blockers: string[] = [];
    for (const action of actions.filter((item) => item.kind === 'NAVIGATE')) {
      const decision = await policy.check({ kind: 'NAVIGATE', url: action.target ?? target.baseUrl });
      if (!decision.allowed)
        blockers.push(`navigation refusée vers ${action.target ?? ''} : ${decision.reason}`);
    }
    const started = Date.now();
    const directory = path.join(this.host.projectDir, 'incidents', id, 'target');
    const session = new ExplorationSession({
      baseUrl: target.baseUrl,
      allowedHosts: incident.scope.allowedHosts,
      headless: true,
      screenshotDir: directory,
      now: () => this.now(),
    });
    const steps: TargetPreparation['steps'] = [];
    let preparation: TargetPreparation;
    try {
      if (blockers.length === 0) {
        await session.open();
        for (const [index, action] of actions.entries()) {
          const outcome = await session.perform(action, index);
          steps.push({
            summary: describeAction(action),
            ok: outcome.ok,
            ...(outcome.error ? { error: outcome.error } : {}),
          });
          if (!outcome.ok) {
            blockers.push(`étape impossible : ${describeAction(action)} (${outcome.error ?? 'échec'})`);
            break;
          }
        }
      }
      const snapshot = await session.snapshot();
      const shot = blockers.length === 0 ? `prepare-${String(Date.now())}.png` : undefined;
      const saved = shot ? await session.screenshot(path.join(directory, shot)) : false;
      preparation = preparationOf({
        route: location.chosen,
        snapshot,
        steps,
        events: session.events,
        blockers,
        actor,
        at: this.now().toISOString(),
        durationMs: Date.now() - started,
        ...(saved && shot ? { screenshot: shot } : {}),
      });
    } finally {
      await session.close();
    }
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (current.access) current.access.preparation = preparation;
      },
      {
        kind: 'SCOPE',
        message: preparation.reached
          ? `écran cible atteint : ${preparation.route} (${String(preparation.inventory.buttons.length)} bouton(s), ${String(preparation.inventory.fields.length)} champ(s))`
          : `écran cible non atteint : ${preparation.blockers.join(' ; ') || preparation.finalUrl}`,
      },
    );
  }

  /**
   * LANCER L'INVESTIGATION depuis l'écran cible : le moteur de découverte des déclencheurs démarre avec le
   * parcours vérifié comme point d'entrée (rejoué avant chaque essai) et le texte du scénario comme
   * description ; stratégies, déduplication, réduction, répétitions, budgets, pause et reprise sont les siens.
   */
  async exploreAccessTarget(
    id: string,
    actor: string,
    options: { depth?: TriggerInvestigationInput['depth'] } = {},
  ): Promise<Incident> {
    const incident = await this.incident(id);
    const access = incident.access;
    const location = access?.location;
    const preparation = access?.preparation;
    if (!access || !location?.chosen || !preparation)
      throw new IncidentServiceError(
        'INVALID',
        'prepare the exploration (target screen reached) before launching it',
      );
    if (!preparation.reached || preparation.route !== location.chosen)
      throw new IncidentServiceError(
        'INVALID',
        `the target screen was not reached: ${preparation.blockers.join(' ; ') || preparation.finalUrl}`,
      );
    const target = await this.host.environment(incident.environmentId);
    if (!target.baseUrl) throw new IncidentServiceError('INVALID', 'no environment URL');
    const description = [access.target ? `Écran : ${access.target}.` : '', accessText(access)]
      .filter(Boolean)
      .join('\n');
    const started = await this.startTrigger(id, actor, {
      description,
      ...(options.depth ? { depth: options.depth } : {}),
      entry: {
        route: location.chosen,
        actions: entryActions(location.path, target.baseUrl),
        source: 'TARGET',
      },
    });
    const run = this.activeTriggerRun(started) ?? started.investigation.trigger?.runs.at(-1);
    if (!run) return started;
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (current.access)
          current.access.exploration = {
            runId: run.id,
            startedAt: run.startedAt,
            startedBy: actor,
            route: location.chosen ?? '',
          };
      },
      { kind: 'TRIGGER', message: `${run.id} : exploration lancée depuis l’écran cible ${location.chosen}` },
    );
  }

  /**
   * ANALYSER LE PARCOURS : le texte, les étapes et l'enregistrement associé deviennent un parcours
   * structuré (interprète FR/EN existant + lexique des actions), puis des portions de code candidates
   * (analyse Angular et index du code, découverte du périmètre). Lecture seule, dans la politique du
   * périmètre : une ressource refusée reste DENIED (une extension se demande, jamais d'office).
   */
  async analyzeAccess(id: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const access = incident.access;
    if (!access || (access.narrative.trim() === '' && access.steps.length === 0 && !access.recording))
      throw new IncidentServiceError(
        'INVALID',
        'describe the path, add steps or link a recording before the analysis',
      );
    const fr = interpretBrief(accessText(access), {}).language === 'fr';
    const say = (french: string, english: string): string => (fr ? french : english);
    const limits: string[] = [];
    let recordingSteps: { description: string; kind?: string }[] = [];
    const observedRoutes: string[] = [];
    if (access.recording) {
      const recording = this.host.recordingSteps
        ? await this.host.recordingSteps(access.recording.name).catch(() => undefined)
        : undefined;
      if (recording) {
        recordingSteps = recording.steps;
        if (recording.startAt) {
          try {
            observedRoutes.push(new URL(recording.startAt, 'http://local.invalid').pathname);
          } catch {
            // un départ illisible n'est pas une route observée
          }
        }
      } else
        limits.push(
          say(
            `L’enregistrement « ${access.recording.name} » est introuvable ou encore en cours : ses étapes ne sont pas reprises.`,
            `Recording “${access.recording.name}” is missing or still running: its steps are not used.`,
          ),
        );
    }
    const parsed = parseAccessPath({
      narrative: access.narrative,
      steps: access.steps,
      recording: recordingSteps,
    });
    const interpreted = this.briefOf(incident, accessText(access, recordingSteps));
    const found = interpretations(parsed, interpreted, incident.application);
    const urlWords = access.url
      ? keywordsOf(access.url.replace(/^https?:\/\/[^/]+/, '').replace(/[/?#=&_-]+/g, ' '), 6)
      : [];
    const keywords = accessKeywords(parsed, found, [...urlWords, ...interpreted.keywords]);
    const brief: IncidentBrief = { ...interpreted, keywords };
    let angular: Awaited<ReturnType<typeof analyzeAngular>>[] = [];
    let graph: Awaited<ReturnType<typeof discoverResources>> | undefined;
    if (!incident.scope.permissions.readSources)
      limits.push(
        say(
          'La lecture des sources n’est pas autorisée par le périmètre : aucune portion de code n’est localisée.',
          'Reading sources is not allowed by the scope: no code is located.',
        ),
      );
    else if (incident.scope.applications.length === 0)
      limits.push(
        say(
          'Aucune application dans le périmètre : ajoutez-en depuis « Applications et dépôts » pour localiser le code.',
          'No application in the scope: add one from “Applications and repositories” to locate code.',
        ),
      );
    else {
      const policy = await this.policy(incident);
      const files = this.adapter(incident).files(policy);
      const frontends = incident.scope.applications.filter((application) => application.layer === 'FRONTEND');
      angular = (
        await Promise.all(frontends.map((application) => analyzeAngular(application, files)))
      ).filter((model) => model.nodes.length > 0);
      if (frontends.length > 0 && angular.length === 0)
        limits.push(
          say(
            'Aucun code Angular reconnu dans les applications frontend lues : seuls les scénarios et les endpoints sont rapprochés.',
            'No Angular code recognised in the frontend applications read: only scenarios and endpoints are matched.',
          ),
        );
      const code =
        incident.investigation.code ??
        (incident.scope.applications.some((application) => application.layer !== 'FRONTEND')
          ? await analyzeCode(incident.scope, files, {})
          : undefined);
      const target = await this.host.environment(incident.environmentId).catch(() => undefined);
      graph = await discoverResources({
        incident,
        brief,
        ...(code ? { code } : {}),
        angular,
        scenarios: (await this.host.listScenarios?.()) ?? [],
        observedRoutes,
        check: (operation) => policy.check(operation),
        ...(target?.baseUrl ? { baseUrl: target.baseUrl } : {}),
        now: this.now().toISOString(),
      });
    }
    const analysis = buildAccessAnalysis({
      access,
      brief,
      parsed,
      found,
      keywords,
      graph,
      angular,
      limits,
      recordingUsed: recordingSteps.length > 0,
      actor,
      at: this.now().toISOString(),
      lang: fr ? 'fr' : 'en',
    });
    const matched = analysis.candidates.filter((item) => item.match === 'MATCHED').length;
    return this.store.mutate(
      id,
      actor,
      (current) => {
        if (current.access) current.access.analysis = analysis;
      },
      {
        kind: 'SCOPE',
        message: `parcours analysé : ${String(analysis.path.length)} étape(s), ${String(matched)} correspondance(s), ${String(analysis.candidates.length - matched)} incertaine(s)`,
      },
    );
  }

  async knownRepositories(id: string): Promise<{ repositories: KnownRepository[] }> {
    const incident = await this.incident(id);
    const seen = new Set<string>();
    const repositories: KnownRepository[] = [];
    const add = (entry: KnownRepository): void => {
      const key = path.resolve(entry.root);
      if (seen.has(key)) return;
      seen.add(key);
      repositories.push(entry);
    };
    for (const declared of (await this.host.sourceRoots?.()) ?? [])
      add({ root: declared.root, label: declared.label, source: 'PROJECT' });
    for (const application of incident.scope.applications)
      add({ root: application.repository.root, label: application.name, source: 'SCOPE' });
    for (const summary of (await this.store.list()).slice(0, 50)) {
      if (summary.id === incident.id) continue;
      const other = await this.store.get(summary.id);
      for (const application of other?.scope.applications ?? [])
        add({
          root: application.repository.root,
          label: `${application.name} (${summary.title})`,
          source: 'INCIDENT',
          incidentId: summary.id,
        });
    }
    return { repositories };
  }

  // ── Test Playwright du test de non-régression ───────────────────────────────────────────

  /**
   * Le test Playwright TypeScript du flow proposé, par le générateur des « Tests générés »
   * (platform/playwright-test-generator) : rien n'est écrit ni exécuté. Le statut cité dans l'en-tête
   * est celui de la dernière exécution réelle du test proposé, sinon « not executed ».
   */
  async regressionSpec(id: string): Promise<RegressionSpec> {
    const incident = await this.incident(id);
    const proposal = incident.investigation.regression;
    if (!proposal) throw new IncidentServiceError('INVALID', 'no regression test proposed');
    const flow = firstFlow(proposal.flowYaml);
    if (!flow) throw new IncidentServiceError('INVALID', 'the proposed test has no flow');
    const { testData, ...rest } = flow;
    const parsed = flowSchema.safeParse(typeof testData === 'string' ? rest : flow);
    if (!parsed.success)
      throw new IncidentServiceError(
        'INVALID',
        `the proposed flow does not pass the flow schema: ${parsed.error.issues
          .map((issue) => `${issue.path.join('.')}: ${issue.message}`)
          .join('; ')}`,
      );
    const target = await this.host.environment(incident.environmentId);
    if (!target.baseUrl)
      throw new IncidentServiceError('INVALID', 'the target environment has no base URL to start from');
    const report = proposal.execution
      ? await this.flowReport(proposal.execution.run, proposal.name)
      : undefined;
    const definition = parsed.data;
    const test = generatePlaywrightTest(
      {
        name: definition.name,
        ...(definition.description !== undefined ? { description: definition.description } : {}),
        ...(definition.startAt !== undefined ? { startAt: definition.startAt } : {}),
        steps: definition.steps,
        assertions: definition.assertions,
        groups: definition.groups,
      },
      report,
      { baseUrl: target.baseUrl },
    );
    return {
      language: 'typescript',
      fileName: test.fileName,
      code: test.content,
      flow: test.flow,
      steps: test.steps,
      assertions: test.assertions,
      baseUrl: target.baseUrl,
    };
  }

  /** Le compte rendu d'un flow dans le résultat d'un run (borné, dans le dossier du run) ; undefined sinon. */
  private async flowReport(run: string, name: string): Promise<FlowRunReport | undefined> {
    try {
      const runDir = await realpath(this.host.runDir(run));
      const file = await realpath(path.join(runDir, 'result.json'));
      if (!file.startsWith(runDir + path.sep) || (await stat(file)).size > MAX_RESULT_BYTES) return undefined;
      const result = JSON.parse(await readFile(file, 'utf8')) as Partial<ExplorationResult>;
      return Array.isArray(result.flows) ? result.flows.find((entry) => entry.name === name) : undefined;
    } catch {
      return undefined;
    }
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
    this.aiAbort.get(id)?.abort();
    return this.store.cancel(id, actor);
  }

  resume(id: string, actor: string): Promise<Incident> {
    return this.store.resume(id, actor);
  }

  // ── Investigation IA ────────────────────────────────────────────────────────────────────

  /** Ce que ce serveur sait faire en IA pour cet incident ; sans runtime : DETERMINISTIC avec la raison. */
  async aiCapabilities(id: string): Promise<AiCapabilities> {
    await this.incident(id);
    const runtime = this.deps.ai;
    if (!runtime)
      return {
        defaultMode: 'DETERMINISTIC',
        availableModes: ['DETERMINISTIC'],
        unavailableReason:
          'L’investigation IA n’est pas configurée sur ce serveur (ai.incidents.mode est DETERMINISTIC ou ai.enabled est faux).',
        dataPolicy: {
          allowExternal: false,
          sendSourceCode: false,
          sendHttpBodies: false,
          sendLogs: false,
          sendScreenshots: false,
          maxSnippetChars: 0,
        },
        budget: ZERO_BUDGET,
      };
    return runtime.capabilities();
  }

  /** La mémoire d'investigation approfondie (stratégies, expériences, contradictions, couverture), si elle existe. */
  async aiMemory(id: string): Promise<InvestigationMemory | undefined> {
    await this.incident(id);
    return this.deps.ai?.memory(this.host.projectDir).read(id);
  }

  /**
   * Lance une investigation IA (arrière-plan) : le run est écrit RUNNING, sa progression est servie depuis la
   * mémoire par `incident()`, et la fin fusionne hypothèses (PROPOSED, origine IA), relations INFERRED, demandes
   * d'extension (PENDING) dans l'incident. Un budget plus petit que la configuration est permis ; plus grand, jamais.
   */
  async investigate(id: string, actor: string, input: DeepInvestigationInput = {}): Promise<Incident> {
    const incident = await this.incident(id);
    const runtime = this.deps.ai;
    const capabilities = await this.aiCapabilities(id);
    const mode =
      input.mode ?? (capabilities.defaultMode === 'DETERMINISTIC' ? undefined : capabilities.defaultMode);
    if (!runtime || mode === undefined || !capabilities.availableModes.includes(mode))
      throw new IncidentServiceError(
        'INVALID',
        capabilities.unavailableReason ?? `le mode ${mode} n’est pas disponible sur ce serveur`,
      );
    const depth: InvestigationDepth = input.depth ?? 'STANDARD';
    if (!(INVESTIGATION_DEPTHS as readonly string[]).includes(depth))
      throw new IncidentServiceError('INVALID', `profondeur inconnue : ${depth}`);
    if (!DEPTH_MODES[depth].includes(mode))
      throw new IncidentServiceError(
        'INVALID',
        `la profondeur ${depth} exige l’un des modes ${DEPTH_MODES[depth].join(', ')} (demandé : ${mode})`,
      );
    if (incident.state === 'REPRODUCING') throw new IncidentServiceError('BUSY', 'a reproduction is running');
    if (incident.state === 'CANCELLED') throw new IncidentServiceError('STATE', 'the incident is cancelled');
    if (incident.investigation.ai?.runs.some((run) => run.status === 'RUNNING'))
      throw new IncidentServiceError('BUSY', 'an AI investigation is already running');
    const budget = resolveBudget(runtime.settings.budget, input.budget);

    const abort = new AbortController();
    this.aiAbort.set(id, abort);
    this.aiPaused.delete(id);
    const stop = this.track(id, () => {
      abort.abort();
    });
    const now = (): string => this.now().toISOString();
    const runId = `ai_${Date.parse(now()).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const initial: AiInvestigationRun = {
      id: runId,
      mode,
      depth,
      status: 'RUNNING',
      startedAt: now(),
      startedBy: actor,
      ...(capabilities.provider ? { provider: capabilities.provider } : {}),
      ...(capabilities.model ? { model: capabilities.model } : {}),
      budget,
      usage: { ...ZERO_USAGE },
      plan: [],
      steps: [],
      findings: [],
      hypothesisIds: [],
      relations: [],
      proposals: [],
      scopeRequests: [],
      limitations: [],
    };
    this.aiLive.set(id, initial);
    if (
      incident.state !== 'INVESTIGATING' &&
      incident.state !== 'DIAGNOSED' &&
      incident.state !== 'INCONCLUSIVE'
    )
      await this.moveTo(id, 'INVESTIGATING', actor, 'ai investigation');
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const ai = (current.investigation.ai ??= { runs: [], answers: [] });
        ai.runs = [...ai.runs, initial].slice(-MAX_AI_RUNS_KEPT);
      },
      { kind: 'AI', message: `${runId}: ${mode} ${depth} investigation started` },
    );

    const work = (async (): Promise<void> => {
      const current = await this.incident(id);
      const policy = await this.policy(current);
      const adapter = this.adapter(current);
      const outcome = await runtime.investigate({
        incident: current,
        mode,
        depth,
        budget,
        policy,
        files: adapter.files(policy),
        capabilities: await adapter.capabilities(),
        actor,
        signal: abort.signal,
        projectDir: this.host.projectDir,
        now,
        runId,
        onProgress: (run) => {
          this.aiLive.set(id, run);
        },
        refresh: () => this.incident(id),
        isPaused: () => this.aiPaused.has(id),
        ...(mode === 'AI_AGENTIC'
          ? { runExperiment: (proposal: AiExperimentProposal) => this.runProposal(id, proposal, actor) }
          : {}),
      });
      await this.absorbAiOutcome(id, actor, outcome);
    })()
      .catch(async (error: unknown) => {
        const failed: AiInvestigationRun = {
          ...(this.aiLive.get(id) ?? initial),
          status: abort.signal.aborted ? 'CANCELLED' : 'FAILED',
          stopReason: abort.signal.aborted ? 'CANCELLED' : 'PROVIDER_ERROR',
          finishedAt: now(),
          error: message(error),
        };
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const ai = (current.investigation.ai ??= { runs: [], answers: [] });
            ai.runs = ai.runs.map((run) => (run.id === runId ? failed : run));
          },
          { kind: 'AI', message: `${runId}: ${failed.status} — ${message(error)}` },
        );
      })
      .finally(() => {
        stop();
        this.aiLive.delete(id);
        this.aiAbort.delete(id);
        this.aiPaused.delete(id);
      });
    this.keep(work);
    return this.incident(id);
  }

  /** La fin d'un run IA : le run final, les hypothèses IA (dédoublonnées par titre), les arêtes INFERRED, les demandes d'extension. */
  private async absorbAiOutcome(id: string, actor: string, outcome: AiRunnerOutcome): Promise<void> {
    const { run } = outcome;
    const requests = [...run.scopeRequests];
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const ai = (current.investigation.ai ??= { runs: [], answers: [] });
        const proposals = [
          ...run.proposals,
          ...outcome.toolProposals.filter((item) => !run.proposals.some((known) => known.id === item.id)),
        ];
        const final: AiInvestigationRun = { ...run, proposals, scopeRequests: requests };
        ai.runs = ai.runs.some((entry) => entry.id === run.id)
          ? ai.runs.map((entry) => (entry.id === run.id ? final : entry))
          : [...ai.runs, final].slice(-MAX_AI_RUNS_KEPT);
        // Les hypothèses d'origine IA : PROPOSED, jamais confirmées ici ; une règle du même titre l'emporte.
        const titles = new Set(current.investigation.hypotheses.map((item) => item.title.toLowerCase()));
        for (const hypothesis of outcome.hypotheses) {
          if (titles.has(hypothesis.title.toLowerCase())) continue;
          titles.add(hypothesis.title.toLowerCase());
          current.investigation.hypotheses.push({ ...hypothesis, status: 'PROPOSED', origin: 'AI' });
        }
        const graph = current.investigation.graph;
        if (graph)
          for (const edge of outcome.edges)
            if (!graph.edges.some((known) => known.from === edge.from && known.to === edge.to))
              graph.edges.push(edge);
        for (const request of requests) {
          try {
            const result = requestExtension(current.scope, request, `ai:${run.id}`, this.now());
            current.scope = result.scope;
            request.extensionId = result.extension.id;
          } catch {
            // une demande illisible n'ouvre aucune extension ; elle reste dans le run sans extensionId
          }
        }
        final.scopeRequests = requests;
      },
      {
        kind: 'AI',
        message: `${run.id}: ${run.status} (${run.stopReason ?? ''}) — ${String(outcome.hypotheses.length)} AI hypothesis(es), ${String(run.proposals.length)} proposal(s), ${String(outcome.edges.length)} inferred edge(s)`,
      },
    );
  }

  /** Une proposition lancée par la boucle (AI_AGENTIC) : planifiée puis exécutée par le chemin ordinaire, jamais approuvée ici. */
  private async runProposal(id: string, proposal: AiExperimentProposal, actor: string): Promise<Experiment> {
    const planned = await this.planExperiment(
      id,
      {
        kind: proposal.kind,
        params: proposal.verification.params,
        hypothesisId: proposal.hypothesisId,
        description: proposal.verification.description,
      },
      `ai:${actor}`,
    );
    const experiment = planned.investigation.experiments.at(-1);
    if (!experiment) throw new Error('la vérification n’a pas été planifiée');
    if (experiment.status === 'APPROVAL_REQUIRED')
      return {
        ...experiment,
        status: 'REFUSED',
        summary: 'approbation d’une personne exigée (effets de bord)',
      };
    await this.runExperiment(id, experiment.id, `ai:${actor}`, { approve: false });
    await this.experimentJobs.get(experiment.id);
    const current = await this.incident(id);
    return current.investigation.experiments.find((entry) => entry.id === experiment.id) ?? experiment;
  }

  /** Annule le run IA en cours (l'incident continue) ; les résultats déjà acquis sont conservés par la fin du run. */
  async cancelInvestigation(id: string, _actor: string): Promise<Incident> {
    await this.incident(id);
    const abort = this.aiAbort.get(id);
    if (!abort) throw new IncidentServiceError('STATE', 'no AI investigation is running');
    abort.abort();
    return this.incident(id);
  }

  /** Demande la pause de la boucle adaptative : elle s'arrête à l'itération suivante, reprise possible. */
  async pauseInvestigation(id: string, actor: string): Promise<Incident> {
    await this.incident(id);
    if (!this.aiAbort.has(id)) throw new IncidentServiceError('STATE', 'no AI investigation is running');
    this.aiPaused.add(id);
    await this.deps.ai?.memory(this.host.projectDir).pause(id, actor);
    return this.incident(id);
  }

  /** Reprend une investigation en pause ou partielle : un nouveau run, depuis le point de reprise de la mémoire. */
  async resumeInvestigation(
    id: string,
    actor: string,
    input: DeepInvestigationInput = {},
  ): Promise<Incident> {
    const memory = await this.aiMemory(id);
    const last = (await this.incident(id)).investigation.ai?.runs.at(-1);
    return this.investigate(id, actor, {
      mode: input.mode ?? (memory?.mode !== 'DETERMINISTIC' ? memory?.mode : undefined) ?? last?.mode,
      depth: input.depth ?? memory?.depth ?? last?.depth,
      ...(input.budget ? { budget: input.budget } : {}),
    });
  }

  /** Une question à l'assistant : réponse citant des références existantes, conservée dans l'incident. */
  async ask(id: string, actor: string, question: string): Promise<AiAssistantAnswer> {
    const incident = await this.incident(id);
    const runtime = this.deps.ai;
    const text = question.trim();
    if (!text) throw new IncidentServiceError('INVALID', 'question is required');
    const askedAt = this.now().toISOString();
    let answer: AiAssistantAnswer;
    if (!runtime)
      answer = {
        id: `ans_${Date.parse(askedAt).toString(36)}${Math.random().toString(36).slice(2, 8)}`,
        askedAt,
        askedBy: actor,
        question: text.slice(0, 1000),
        answer: '',
        refs: [],
        locations: [],
        unavailable: (await this.aiCapabilities(id)).unavailableReason ?? 'IA indisponible',
      };
    else {
      const policy = await this.policy(incident);
      const abort = new AbortController();
      const stop = this.track(id, () => {
        abort.abort();
      });
      try {
        answer = await runtime.ask({
          incident,
          question: text,
          policy,
          files: this.adapter(incident).files(policy),
          actor,
          signal: abort.signal,
          projectDir: this.host.projectDir,
          now: () => this.now().toISOString(),
        });
      } finally {
        stop();
      }
    }
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const ai = (current.investigation.ai ??= { runs: [], answers: [] });
        ai.answers = [...ai.answers, answer].slice(-MAX_AI_ANSWERS_KEPT);
      },
      { kind: 'AI', message: `question: ${text.slice(0, 80)}${answer.unavailable ? ' (unavailable)' : ''}` },
    );
    return answer;
  }

  /**
   * La décision d'une personne sur une vérification proposée (par un agent ou générée par la boucle) : approuvée,
   * elle est planifiée puis lancée par le chemin ordinaire ; refusée, elle le reste. La décision est liée à
   * l'opération et à ses paramètres dans la mémoire.
   */
  async decideAiExperiment(
    id: string,
    experimentId: string,
    approve: boolean,
    actor: string,
    options: { reason?: string; canWrite?: boolean } = {},
  ): Promise<Incident> {
    const incident = await this.incident(id);
    const runs = incident.investigation.ai?.runs ?? [];
    const found = runs
      .flatMap((run) => run.proposals.map((proposal) => ({ run, proposal })))
      .find((entry) => entry.proposal.id === experimentId);
    const memory = await this.aiMemory(id);
    const generated = memory?.experiments.find((entry) => entry.id === experimentId);
    const proposal: AiExperimentProposal | undefined = found?.proposal ?? generated;
    if (!proposal) throw new IncidentServiceError('NOT_FOUND', `AI experiment ${experimentId} not found`);
    if (proposal.status !== 'PROPOSED')
      throw new IncidentServiceError('STATE', `AI experiment ${experimentId} is ${proposal.status}`);
    let plannedId: string | undefined;
    let refusal: string | undefined;
    if (approve) {
      const planned = await this.planExperiment(
        id,
        {
          kind: proposal.kind,
          params: proposal.verification.params,
          hypothesisId: proposal.hypothesisId,
          description: proposal.verification.description,
        },
        actor,
      );
      const experiment = planned.investigation.experiments.at(-1);
      if (experiment) {
        plannedId = experiment.id;
        if (experiment.sideEffects && !options.canWrite) {
          refusal = 'effets de bord : le droit RUN_WRITES est exigé pour approuver';
        } else await this.runExperiment(id, experiment.id, actor, { approve: experiment.sideEffects });
      }
    } else refusal = options.reason ?? `refusée par ${actor}`;
    const status: AiExperimentProposal['status'] = approve && !refusal ? 'PLANNED' : 'REFUSED';
    if (found)
      await this.store.mutate(
        id,
        actor,
        (current) => {
          const ai = current.investigation.ai;
          const run = ai?.runs.find((entry) => entry.id === found.run.id);
          const entry = run?.proposals.find((item) => item.id === experimentId);
          if (entry) {
            entry.status = status;
            if (plannedId) entry.experimentId = plannedId;
            if (refusal) entry.refusal = refusal;
          }
        },
        { kind: 'AI', message: `${experimentId}: ${status}${plannedId ? ` → ${plannedId}` : ''}` },
      );
    if (generated)
      await this.deps.ai?.memory(this.host.projectDir).decide(id, {
        experimentId,
        decision: status === 'PLANNED' ? 'APPROVED' : 'REFUSED',
        by: actor,
        ...(refusal ? { reason: refusal } : options.reason ? { reason: options.reason } : {}),
        ...(plannedId ? { plannedExperimentId: plannedId } : {}),
      });
    return this.incident(id);
  }

  /** Une prolongation de budget accordée par une personne (DECIDE) : bornée, jamais automatique. */
  async extendAiBudget(id: string, added: Partial<AiBudget>, actor: string): Promise<InvestigationMemory> {
    await this.incident(id);
    const runtime = this.deps.ai;
    if (!runtime) throw new IncidentServiceError('INVALID', 'AI investigation is not configured');
    const clean: Partial<AiBudget> = {};
    for (const [key, value] of Object.entries(added) as [keyof AiBudget, unknown][]) {
      if (!(key in ZERO_BUDGET)) throw new IncidentServiceError('INVALID', `unknown budget key ${key}`);
      if (typeof value !== 'number' || !Number.isFinite(value) || value <= 0)
        throw new IncidentServiceError('INVALID', `${key} must be a positive number`);
      if (key === 'maxCommands')
        throw new IncidentServiceError('INVALID', 'maxCommands stays 0: no tool runs commands');
      clean[key] = Math.min(value, runtime.settings.budget[key] * 4 || value);
    }
    if (Object.keys(clean).length === 0) throw new IncidentServiceError('INVALID', 'nothing to extend');
    const memory = await runtime.memory(this.host.projectDir).extend(id, clean, actor);
    if (!memory)
      throw new IncidentServiceError(
        'STATE',
        'no investigation memory to extend (run an investigation first)',
      );
    await this.store.mutate(id, actor, () => undefined, {
      kind: 'AI',
      message: `budget extended: ${Object.entries(clean)
        .map(([key, value]) => `${key} +${String(value)}`)
        .join(', ')}`,
    });
    return memory;
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

  /**
   * L'identifiant d'une nouvelle reproduction (`rep_N`) : au-delà de celles enregistrées ET de celles déjà
   * attribuées par ce serveur, pour qu'une vérification qui rejoue en même temps n'obtienne pas le même.
   */
  private nextReproduction(incident: Incident): string {
    const numbers = incident.investigation.reproductions
      .map((run) => /^rep_(\d+)$/.exec(run.id)?.[1])
      .filter((value): value is string => value !== undefined)
      .map(Number);
    const next = Math.max(0, ...numbers, this.allocated.get(incident.id) ?? 0) + 1;
    this.allocated.set(incident.id, next);
    return `rep_${String(next)}`;
  }

  // ── Découverte des déclencheurs ───────────────────────────────────────────────────────────────

  /** Interprète une description en langage naturel (FR/EN) : chaque élément porte sa provenance (USER_REPORTED). */
  async describeIncident(id: string, text: string, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    if (text.trim() === '') throw new IncidentServiceError('INVALID', 'description must not be empty');
    const brief = this.briefOf(incident, text);
    return this.store.mutate(
      id,
      actor,
      (current) => {
        const trigger = (current.investigation.trigger ??= { runs: [] });
        trigger.brief = brief;
      },
      {
        kind: 'TRIGGER',
        message: `description interprétée (${brief.language}, ${String(brief.symptoms.length)} symptôme(s))`,
      },
    );
  }

  private briefOf(incident: Incident, text: string): IncidentBrief {
    return interpretBrief(text, {
      application: incident.application,
      title: incident.title,
      observed: incident.observed,
      expected: incident.expected,
      now: this.now().toISOString(),
    });
  }

  private activeTriggerRun(incident: Incident): TriggerRun | undefined {
    return incident.investigation.trigger?.runs.find(
      (run) => this.triggerLive.get(incident.id)?.id === run.id,
    );
  }

  /** Lance la découverte automatique des conditions déclenchantes (travail en arrière-plan ; l'incident se relit). */
  async discoverTrigger(id: string, actor: string, input: TriggerInvestigationInput = {}): Promise<Incident> {
    return this.startTrigger(id, actor, input);
  }

  private async startTrigger(
    id: string,
    actor: string,
    input: TriggerInvestigationInput,
    resumeFrom?: TriggerRun,
  ): Promise<Incident> {
    const incident = await this.incident(id);
    const depth = input.depth ?? resumeFrom?.depth ?? 'STANDARD';
    if (!(TRIGGER_DEPTHS as readonly string[]).includes(depth))
      throw new IncidentServiceError('INVALID', `profondeur inconnue : ${depth}`);
    if (incident.state === 'REPRODUCING') throw new IncidentServiceError('BUSY', 'a reproduction is running');
    if (incident.state === 'CANCELLED') throw new IncidentServiceError('STATE', 'the incident is cancelled');
    if (this.triggerLive.has(id))
      throw new IncidentServiceError('BUSY', 'a trigger discovery is already running');
    const target = await this.host.environment(incident.environmentId);
    if (!target.baseUrl)
      throw new IncidentServiceError(
        'INVALID',
        'aucun environnement avec une URL : la découverte explore un environnement de test',
      );
    // Le scénario d'accès, quand il existe, guide la découverte du déclencheur (sans dupliquer sa saisie).
    const accessDescription = incident.access ? accessText(incident.access) : '';
    const text =
      input.description ??
      incident.investigation.trigger?.brief?.rawText ??
      (accessDescription !== ''
        ? `${incident.description}\n${accessDescription}`
        : `${incident.description}\n${incident.observed}`);
    const brief = resumeFrom?.brief ?? this.briefOf(incident, text);
    const policy = await this.policy(incident);
    const files = this.adapter(incident).files(policy);
    const now = (): Date => this.now();
    const runId =
      resumeFrom?.id ??
      `trg_${Date.parse(now().toISOString()).toString(36)}${Math.random().toString(36).slice(2, 8)}`;
    const control: TriggerControlState = { cancelled: false, paused: false, waiters: [] };
    this.triggerControl.set(id, control);
    const stop = this.track(id, () => {
      control.cancelled = true;
      wake(control);
    });
    const initial: TriggerRun = resumeFrom
      ? { ...resumeFrom, state: 'INITIALIZING', updatedAt: now().toISOString() }
      : {
          id: runId,
          depth,
          state: 'INITIALIZING',
          startedAt: now().toISOString(),
          updatedAt: now().toISOString(),
          startedBy: actor,
          budget: { ...resolveTriggerBudgetFor(depth, input.budget) },
          usage: { durationMs: 0, trials: 0, actions: 0, repeats: 0, experiments: 0, events: 0, aiCalls: 0 },
          brief,
          strategies: [],
          trials: [],
          reference: {},
          conditions: [],
          hypothesisIds: [],
          pendingExperimentIds: [],
          coverage: [],
          limitations: [],
        };
    this.triggerLive.set(id, initial);
    // La découverte est une investigation : depuis un brouillon ou un échec, le périmètre est d'abord tenu pour prêt.
    let state: Incident['state'] = incident.state;
    if (state === 'DRAFT' || state === 'FAILED')
      state = (await this.moveTo(id, 'SCOPED', actor, 'trigger discovery')).state;
    if (state !== 'INVESTIGATING' && state !== 'DIAGNOSED' && state !== 'INCONCLUSIVE')
      await this.moveTo(id, 'INVESTIGATING', actor, 'trigger discovery');
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const trigger = (current.investigation.trigger ??= { runs: [] });
        trigger.brief ??= brief;
        trigger.runs = trigger.runs.some((run) => run.id === runId)
          ? trigger.runs.map((run) => (run.id === runId ? initial : run))
          : [...trigger.runs, initial].slice(-MAX_TRIGGER_RUNS_KEPT);
      },
      { kind: 'TRIGGER', message: `${runId}: découverte ${depth} ${resumeFrom ? 'reprise' : 'lancée'}` },
    );

    const work = (async (): Promise<void> => {
      const current = await this.incident(id);
      const angular = current.scope.permissions.readSources
        ? await Promise.all(
            current.scope.applications
              .filter((application) => application.layer === 'FRONTEND')
              .map((application) => analyzeAngular(application, files)),
          )
        : [];
      const scenarios = (await this.host.listScenarios?.()) ?? [];
      const abort = new AbortController();
      const aiClient = this.deps.ai?.client;
      const engine = new TriggerEngine({
        runId,
        startedBy: actor,
        incident: current,
        brief,
        depth,
        budget: input.budget,
        repeats: input.repeats,
        confidenceThreshold: input.confidenceThreshold,
        baseUrl: target.baseUrl ?? '',
        allowedHosts: current.scope.allowedHosts,
        check: (operation) => policy.check(operation),
        code: current.investigation.code,
        angular: angular.filter((model) => model.nodes.length > 0),
        scenarios,
        existingHypotheses: current.investigation.hypotheses,
        headless: true,
        screenshotDir: path.join(this.host.projectDir, 'incidents', id, 'trigger', runId),
        now,
        control: {
          cancelled: () => control.cancelled,
          paused: () => control.paused,
          waitWhilePaused: () =>
            new Promise<void>((resolve) => {
              if (!control.paused || control.cancelled) resolve();
              else control.waiters.push(resolve);
            }),
        },
        onProgress: async (run) => {
          this.triggerLive.set(id, structuredClone(run));
          await this.persistTriggerRun(id, actor, run);
        },
        ...(aiClient && this.deps.ai?.settings.mode !== 'DETERMINISTIC'
          ? { proposeWithAi: createAiSequenceProposer(aiClient, { signal: abort.signal }) }
          : {}),
        resumeFrom,
        ...(input.entry ? { entry: input.entry } : {}),
      });
      this.triggerEngines.set(id, engine);
      const outcome = await engine.execute();
      await this.absorbTriggerOutcome(id, actor, outcome);
    })()
      .catch(async (error: unknown) => {
        const failed: TriggerRun = {
          ...(this.triggerLive.get(id) ?? initial),
          state: control.cancelled ? 'CANCELLED' : 'FAILED',
          stopReason: control.cancelled ? 'annulé' : `erreur du moteur : ${message(error)}`,
          error: message(error),
          finishedAt: now().toISOString(),
          updatedAt: now().toISOString(),
        };
        await this.persistTriggerRun(id, actor, failed, `${runId}: ${failed.state} — ${message(error)}`);
      })
      .finally(() => {
        stop();
        this.triggerLive.delete(id);
        this.triggerControl.delete(id);
      });
    this.keep(work);
    return this.incident(id);
  }

  private async persistTriggerRun(id: string, actor: string, run: TriggerRun, event?: string): Promise<void> {
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const trigger = (current.investigation.trigger ??= { runs: [] });
        trigger.runs = trigger.runs.some((entry) => entry.id === run.id)
          ? trigger.runs.map((entry) => (entry.id === run.id ? structuredClone(run) : entry))
          : [...trigger.runs, structuredClone(run)].slice(-MAX_TRIGGER_RUNS_KEPT);
      },
      { kind: 'TRIGGER', message: event ?? `${run.id}: ${run.state} (${String(run.usage.trials)} essai(s))` },
    );
  }

  /** La fin d'un run : le run final, les hypothèses (PROPOSED, dédoublonnées), les vérifications, le test proposé. */
  private async absorbTriggerOutcome(
    id: string,
    actor: string,
    outcome: TriggerEngineOutcome,
  ): Promise<void> {
    const { run } = outcome;
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const trigger = (current.investigation.trigger ??= { runs: [] });
        const final = structuredClone(run);
        trigger.runs = trigger.runs.some((entry) => entry.id === run.id)
          ? trigger.runs.map((entry) => (entry.id === run.id ? final : entry))
          : [...trigger.runs, final].slice(-MAX_TRIGGER_RUNS_KEPT);
        const titles = new Set(current.investigation.hypotheses.map((item) => item.title.toLowerCase()));
        for (const hypothesis of outcome.hypotheses) {
          if (titles.has(hypothesis.title.toLowerCase())) continue;
          titles.add(hypothesis.title.toLowerCase());
          current.investigation.hypotheses.push({ ...hypothesis, status: 'PROPOSED' });
        }
        const known = new Set(current.investigation.experiments.map((item) => item.id));
        for (const experiment of outcome.experiments) {
          if (known.has(experiment.id)) continue;
          current.investigation.experiments.push(experiment);
          if (experiment.status === 'DONE')
            current.investigation.hypotheses = applyExperiment(current.investigation.hypotheses, experiment);
        }
        if (
          outcome.regression &&
          (!current.investigation.regression ||
            current.investigation.regression.basedOn.startsWith('trigger:'))
        )
          current.investigation.regression = outcome.regression;
        const stored = trigger.runs.find((entry) => entry.id === run.id);
        if (stored) stored.limitations = [...stored.limitations, ...outcome.regressionLimitations];
      },
      {
        kind: 'TRIGGER',
        message: `${run.id}: ${run.state}${run.stopReason ? ` — ${run.stopReason}` : ''} ; ${String(outcome.hypotheses.length)} hypothèse(s), ${String(outcome.experiments.length)} vérification(s)`,
      },
    );
  }

  /** Le run de découverte encore actif (un run qui vient de finir n'est plus pilotable). */
  private activeTrigger(id: string): TriggerControlState {
    const control = this.triggerControl.get(id);
    const live = this.triggerLive.get(id);
    if (!control || !live || (TRIGGER_FINAL_STATES as readonly string[]).includes(live.state))
      throw new IncidentServiceError('STATE', 'no trigger discovery is running');
    return control;
  }

  async pauseTrigger(id: string, _actor: string): Promise<Incident> {
    await this.incident(id);
    this.activeTrigger(id).paused = true;
    return this.incident(id);
  }

  /** Reprend : le run en pause continue ; sinon le dernier run interrompu repart de son point de reprise (nouveau moteur). */
  async resumeTrigger(id: string, actor: string, input: TriggerInvestigationInput = {}): Promise<Incident> {
    const incident = await this.incident(id);
    const control = this.triggerControl.get(id);
    if (control) {
      control.paused = false;
      wake(control);
      return this.incident(id);
    }
    const last = incident.investigation.trigger?.runs.at(-1);
    if (!last) throw new IncidentServiceError('STATE', 'no trigger discovery to resume');
    if (last.state === 'COMPLETED' || last.state === 'FAILED')
      throw new IncidentServiceError('STATE', `the last run is ${last.state}`);
    return this.startTrigger(id, actor, input, last);
  }

  async cancelTrigger(id: string, _actor: string): Promise<Incident> {
    await this.incident(id);
    const control = this.activeTrigger(id);
    control.cancelled = true;
    wake(control);
    return this.incident(id);
  }

  /** DECIDE : une vérification proposée par la découverte est approuvée (jouée par le moteur) ou refusée. */
  async decideTriggerExperiment(
    id: string,
    experimentId: string,
    approve: boolean,
    actor: string,
    options: { reason?: string; canWrite?: boolean } = {},
  ): Promise<Incident> {
    const incident = await this.incident(id);
    const experiment = incident.investigation.experiments.find((entry) => entry.id === experimentId);
    if (!experiment || !experimentId.startsWith('exp_trig_'))
      throw new IncidentServiceError('NOT_FOUND', `trigger experiment ${experimentId} not found`);
    if (experiment.status !== 'APPROVAL_REQUIRED' && experiment.status !== 'PROPOSED')
      throw new IncidentServiceError('STATE', `experiment ${experimentId} is ${experiment.status}`);
    if (this.triggerLive.has(id)) throw new IncidentServiceError('BUSY', 'a trigger discovery is running');
    const runId = experimentId.split('_').slice(2, -2).join('_');
    const run = incident.investigation.trigger?.runs.find((entry) => entry.id === runId);
    if (!run) throw new IncidentServiceError('NOT_FOUND', `trigger run ${runId} not found`);
    if (!approve) {
      return this.store.mutate(
        id,
        actor,
        (current) => {
          const entry = current.investigation.experiments.find((candidate) => candidate.id === experimentId);
          if (entry) {
            entry.status = 'REFUSED';
            entry.summary = options.reason ?? `refusée par ${actor}`;
          }
          const stored = current.investigation.trigger?.runs.find((candidate) => candidate.id === runId);
          if (stored)
            stored.pendingExperimentIds = stored.pendingExperimentIds.filter(
              (pending) => pending !== experimentId,
            );
        },
        { kind: 'TRIGGER', message: `${experimentId}: refusée` },
      );
    }
    if (experiment.sideEffects && !options.canWrite)
      throw new IncidentServiceError(
        'SCOPE',
        'effets de bord : le droit RUN_WRITES est exigé pour approuver',
      );
    const target = await this.host.environment(incident.environmentId);
    if (!target.baseUrl) throw new IncidentServiceError('INVALID', 'aucun environnement avec une URL');
    const policy = await this.policy(incident);
    const engine =
      this.triggerEngines.get(id) ??
      new TriggerEngine({
        runId,
        startedBy: actor,
        incident,
        brief: run.brief ?? this.briefOf(incident, incident.description),
        depth: run.depth,
        baseUrl: target.baseUrl,
        allowedHosts: incident.scope.allowedHosts,
        check: (operation) => policy.check(operation),
        existingHypotheses: incident.investigation.hypotheses,
        now: () => this.now(),
        control: { cancelled: () => false, paused: () => false, waitWhilePaused: () => Promise.resolve() },
        resumeFrom: run,
      });
    this.triggerEngines.set(id, engine);
    await this.store.mutate(
      id,
      actor,
      (current) => {
        const entry = current.investigation.experiments.find((candidate) => candidate.id === experimentId);
        if (entry) {
          entry.status = 'RUNNING';
          entry.approvedBy = actor;
        }
      },
      { kind: 'TRIGGER', message: `${experimentId}: approuvée par ${actor}` },
    );
    const stop = this.track(id, () => undefined);
    const work = engine
      .runExperiment({ ...experiment, approvedBy: actor })
      .then(async (done) => {
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const at = current.investigation.experiments.findIndex((entry) => entry.id === experimentId);
            if (at >= 0) current.investigation.experiments[at] = done;
            if (done.status === 'DONE')
              current.investigation.hypotheses = applyExperiment(current.investigation.hypotheses, done);
            const stored = current.investigation.trigger?.runs.find((candidate) => candidate.id === runId);
            if (stored) {
              stored.pendingExperimentIds = stored.pendingExperimentIds.filter(
                (pending) => pending !== experimentId,
              );
              stored.usage = engine.run.usage;
              stored.trials = engine.run.trials;
              if (stored.state === 'WAITING_FOR_APPROVAL' && stored.pendingExperimentIds.length === 0)
                stored.state = 'COMPLETED';
            }
          },
          {
            kind: 'TRIGGER',
            message: `${experimentId}: ${done.status}${done.summary ? ` — ${done.summary}` : ''}`,
          },
        );
      })
      .catch(async (error: unknown) => {
        await this.store.mutate(
          id,
          actor,
          (current) => {
            const entry = current.investigation.experiments.find(
              (candidate) => candidate.id === experimentId,
            );
            if (entry) {
              entry.status = 'ERROR';
              entry.summary = message(error);
              entry.finishedAt = this.now().toISOString();
            }
          },
          { kind: 'TRIGGER', message: `${experimentId}: ERROR — ${message(error)}` },
        );
      })
      .finally(stop);
    this.keep(work);
    return this.incident(id);
  }

  /** DECIDE : prolonge le budget du run en cours (ou du dernier), jamais au-delà des plafonds. */
  async extendTriggerBudget(id: string, added: Partial<TriggerBudget>, actor: string): Promise<Incident> {
    const incident = await this.incident(id);
    const live = this.triggerLive.get(id);
    const last = live ?? incident.investigation.trigger?.runs.at(-1);
    if (!last) throw new IncidentServiceError('STATE', 'no trigger discovery to extend');
    const budget = { ...last.budget };
    for (const key of Object.keys(added) as (keyof TriggerBudget)[]) {
      const value = added[key];
      if (typeof value === 'number' && Number.isFinite(value) && value > 0)
        budget[key] = Math.min(budget[key] + value, TRIGGER_BUDGET_CAPS_FOR[key]);
    }
    if (live) live.budget = budget;
    const engine = this.triggerEngines.get(id);
    if (engine) engine.run.budget = budget;
    return this.store.mutate(
      id,
      actor,
      (current) => {
        const stored = current.investigation.trigger?.runs.find((entry) => entry.id === last.id);
        if (stored) stored.budget = budget;
      },
      {
        kind: 'TRIGGER',
        message: `${last.id}: budget prolongé par ${actor} (${Object.keys(added).join(', ')})`,
      },
    );
  }

  async triggerReport(id: string, runId?: string): Promise<TriggerRunReport> {
    const incident = await this.incident(id);
    const run = runId
      ? incident.investigation.trigger?.runs.find((entry) => entry.id === runId)
      : incident.investigation.trigger?.runs.at(-1);
    if (!run) throw new IncidentServiceError('NOT_FOUND', 'no trigger discovery run');
    return buildTriggerReport(incident, run, this.now().toISOString());
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

interface TriggerControlState {
  cancelled: boolean;
  paused: boolean;
  waiters: (() => void)[];
}

const wake = (control: TriggerControlState): void => {
  for (const waiter of control.waiters.splice(0)) waiter();
};

const TRIGGER_FINAL_STATES: readonly TriggerRun['state'][] = [
  'WAITING_FOR_APPROVAL',
  'COMPLETED',
  'INCONCLUSIVE',
  'CANCELLED',
  'FAILED',
];

const resolveTriggerBudgetFor = (
  depth: TriggerRun['depth'],
  requested?: Partial<TriggerBudget>,
): TriggerBudget => resolveTriggerBudget(depth, requested);

const ZERO_USAGE: Readonly<AiUsage> = Object.freeze({
  iterations: 0,
  modelCalls: 0,
  toolCalls: 0,
  inputTokens: 0,
  outputTokens: 0,
  estimatedCost: 0,
  durationMs: 0,
  files: 0,
  commands: 0,
  experiments: 0,
});

const ZERO_BUDGET: Readonly<AiBudget> = Object.freeze({
  maxIterations: 0,
  maxModelCalls: 0,
  maxToolCalls: 0,
  maxInputTokens: 0,
  maxOutputTokens: 0,
  maxCost: 0,
  maxDurationMs: 0,
  maxFiles: 0,
  maxCommands: 0,
  maxExperiments: 0,
});

/** Le budget d'un run : la configuration, réduite par la demande ; une demande plus grande est refusée (DECIDE : extend-budget). */
function resolveBudget(configured: AiBudget, requested: Partial<AiBudget> | undefined): AiBudget {
  const budget: AiBudget = { ...configured, maxCommands: 0 };
  if (!requested) return budget;
  for (const [key, value] of Object.entries(requested) as [keyof AiBudget, unknown][]) {
    if (!(key in ZERO_BUDGET)) throw new IncidentServiceError('INVALID', `unknown budget key ${key}`);
    if (typeof value !== 'number' || !Number.isFinite(value) || value < 0)
      throw new IncidentServiceError('INVALID', `budget.${key} must be a non-negative number`);
    if (key === 'maxCommands') continue;
    if (value > configured[key])
      throw new IncidentServiceError(
        'INVALID',
        `budget.${key} (${String(value)}) exceeds the configured budget (${String(configured[key])}): a person with DECIDE may extend it`,
      );
    budget[key] = value;
  }
  return budget;
}
