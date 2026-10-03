import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { stringify as stringifyYaml } from 'yaml';
import { createAuthenticator } from '../auth/authenticator.js';
import { BrowserManager } from '../browser/browser-manager.js';
import { browserHttpCredentials } from '../interactions/browser-credentials.js';
import { ConfigError, loadConfigFile, parseConfig, type ConfigOverrides } from '../config/config-loader.js';
import type { ScenarioConfig } from '../config/config.js';
import { runDryRun } from '../dry-run/dry-run-orchestrator.js';
import { FunctionalKnowledgeStore } from '../knowledge/functional-knowledge-store.js';
import { slug } from '../knowledge/signatures.js';
import { EngineEventLog } from '../logging/engine-log.js';
import { HumanFlowRecorder, type StopReason } from './human-flow-recorder.js';
import type { RecordingEvent } from './model.js';
import type { IntelligenceProvider } from '../ai/provider.js';
import { processRecording, TEST_DATA_FILE, type RecordingResult } from './process-recording.js';
import { recordingHtml, type ReplayOutcome } from './recording-report.js';
import { createIntelligenceGateway, effectiveMode } from '../ai/factory.js';
import type { IntelligenceGateway } from '../ai/gateway.js';
import {
  enrichRecording,
  recordingCandidatesFile,
  rememberRecordingCandidates,
  type RecordingIntelligence,
} from './recording-intelligence.js';
import { auditRecordingSemantics, targetAuditAdvisor, type SemanticAuditReport } from './semantic-audit.js';
import { RecordingTargetValidator, type TargetValidationStatus } from './target-validator.js';
import { withSemanticGoal } from './validation-mode.js';

export type RecordOutputFormat = 'yaml' | 'gherkin' | 'both';

export interface RecordRequest {
  /** Nom du flow (et du dossier du rapport). */
  name: string;
  /** Adresse de départ : absolue, ou une route de la mission. */
  url?: string;
  /** Mission (cible, connexion, sécurité, recording:). */
  missionFile?: string;
  overrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
  outputFormat?: RecordOutputFormat;
  /** Rejouer le flow généré tout de suite (dry run) : REPLAY_CONFIRMED / REPLAY_FAILED. */
  validate?: boolean;
  /** Langue du .feature (sinon recording.language, puis report.language). */
  language?: 'fr' | 'en';
  onEvent?: (event: RecordingEvent) => void;
  /**
   * Ce que fait « l'humain » : par défaut, attendre qu'il arrête (bandeau, terminal,
   * fermeture). Les tests y jouent la démonstration avec Playwright.
   */
  drive?: (session: { page: Page; recorder: HumanFlowRecorder }) => Promise<void>;
  /** Un fournisseur d'intelligence injecté (tests, intégrations) : remplace ai.provider. */
  intelligenceProvider?: IntelligenceProvider;
  /** Le terminal : Entrée pour arrêter, « c » pour un point de contrôle… ; renvoie de quoi se détacher. */
  control?: (recorder: HumanFlowRecorder) => () => void;
}

export interface RecordOutcome {
  result: RecordingResult;
  directory: string;
  files: Record<string, string>;
  replay: ReplayOutcome;
  stopReason: StopReason;
  warnings: string[];
  /** RECORDING SEMANTIC AUDIT (semantic-audit.json). */
  audit?: SemanticAuditReport;
}

/**
 * RECORD : ouvrir Chromium (connecté si la mission le demande), laisser l'humain faire,
 * puis RAW → SEMANTIC → FINAL et écrire sous `<reportsDir>/recordings/<nom>/` :
 * raw-recording.json, semantic-recording.json, recorded-flow.json, generated.flow.yaml,
 * generated.feature, flow-graph.json, recording-events.jsonl, index.html.
 * Le flow généré n'est jamais modifié par la validation.
 */
export async function runRecording(request: RecordRequest): Promise<RecordOutcome> {
  const env = request.env ?? process.env;
  const { config, warnings } = await recordingConfig(request, env);
  if (!config.recording.enabled)
    throw new ConfigError('Recording is disabled', [
      'set recording.enabled: true in the mission to use qa-crawler record',
    ]);
  const directory = path.join(config.output.reportsDir, 'recordings', slug(request.name) || 'recording');
  const log = new EngineEventLog('INFO');
  const onEvent = (event: RecordingEvent): void => {
    // RAW_EVENT_CAPTURED : une ligne par événement brut, inutile dans le journal (la trace est dans raw-recording.json).
    if (event.type !== 'RAW_EVENT_CAPTURED') log.log('INFO', event.type, event.message);
    request.onEvent?.(event);
  };
  // LE TEMPS APRÈS « STOP », phase par phase : le bilan dit où il passe (jamais deviné).
  const stopClock = {
    start: 0,
    last: 0,
    phases: [] as { phase: string; ms: number }[],
    mark(phase: string): void {
      if (this.start === 0) return;
      const now = Date.now();
      const from = this.last || this.start;
      this.phases.push({ phase, ms: now - from });
      this.last = now;
    },
  };
  const startUrl = new URL(config.target.startAt, config.target.baseUrl).toString();
  const identity = {
    ...((config.staticAnalysis.version ?? env.QA_VERSION)
      ? { version: config.staticAnalysis.version ?? env.QA_VERSION }
      : {}),
    ...((config.baseline.environment ?? env.QA_ENVIRONMENT)
      ? { environment: config.baseline.environment ?? env.QA_ENVIRONMENT }
      : {}),
    ...(env.QA_ROLE ? { role: env.QA_ROLE } : {}),
  };
  // UN SEUL gateway pour la session : validation des cibles, enrichissement, audit (jamais en OFF).
  const mode = effectiveMode(config.ai);
  const gateway =
    mode !== 'OFF'
      ? createIntelligenceGateway(config.ai, {
          env,
          ...(request.intelligenceProvider ? { provider: request.intelligenceProvider } : {}),
          emit: (record) => {
            log.log('INFO', record.event, record.message);
          },
        })
      : undefined;
  const validation = config.recording.targetValidation;
  const audit = config.recording.intelligenceAudit;
  // Les statuts qui méritent un audit (selon les déclencheurs de recording.intelligenceAudit).
  const auditOn = new Set<TargetValidationStatus>(
    !audit.enabled || audit.mode === 'OFF'
      ? []
      : [
          ...(audit.triggers.ambiguousTarget ? (['AMBIGUOUS'] as const) : []),
          ...(audit.triggers.contextMismatch ? (['CONTEXT_MISMATCH'] as const) : []),
          ...(audit.triggers.lowSemanticConfidence
            ? (['MISMATCH', 'SEMANTIC_MISMATCH', 'NOT_FOUND', 'STALE_BEFORE_VALIDATION'] as const)
            : []),
          ...(audit.triggers.fragileLocator ? (['VALIDATED_FRAGILE'] as const) : []),
        ],
  );
  const targetValidator = validation.enabled
    ? new RecordingTargetValidator({
        maxDeterministicRepairAttempts: validation.maxDeterministicRepairAttempts,
        flowName: request.name,
        auditOn,
        ...(gateway && validation.aiAudit
          ? { advisor: targetAuditAdvisor(gateway, { maxCalls: audit.maxCalls }) }
          : {}),
        log: (line) => {
          onEvent({ type: 'TARGET_VALIDATION', at: new Date().toISOString(), message: line });
        },
      })
    : undefined;
  const recorder = new HumanFlowRecorder({
    name: request.name,
    config,
    onEvent,
    ...identity,
    ...(targetValidator ? { targetValidator } : {}),
  });
  const browser = new BrowserManager(config.browser);
  let stopReason: StopReason = 'api';
  let detach: (() => void) | undefined;
  try {
    const authenticator = createAuthenticator(config.auth, config.target.baseUrl, env, startUrl);
    // La fenêtre de connexion d'une popup SSO : remplie par le navigateur (httpAuth.origins + profil).
    const preauthorized = browserHttpCredentials(config, env);
    const context = await browser.start({
      ...(preauthorized?.options ?? {}),
      ...authenticator.contextOptions(),
    });
    const page = await browser.newPage();
    page.setDefaultTimeout(config.exploration.actionTimeoutMs);
    // La connexion n'est pas enregistrée : le flow rejoué se connecte avec la mission (CredentialProvider).
    if (config.recording.recordAfterAuthentication && config.auth.type !== 'none')
      await authenticator.login(page);
    await page.goto(startUrl, {
      waitUntil: 'domcontentloaded',
      timeout: config.exploration.navigationTimeoutMs,
    });
    await recorder.attach(context, page);
    detach = request.control?.(recorder);
    if (request.drive) {
      await request.drive({ page, recorder });
      recorder.requestStop('api');
    }
    stopReason = await recorder.stopped;
    stopClock.start = Date.now();
    await recorder.stop();
    stopClock.mark('recorder stop (total)');
  } catch (error) {
    recorder.session.status = 'FAILED';
    onEvent({
      type: 'RECORDING_FAILED',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    await gateway?.close();
    throw error;
  } finally {
    detach?.();
    await browser.close();
    stopClock.mark('browser close');
  }

  const language =
    request.language ?? config.recording.language ?? (config.report.language === 'fr' ? 'fr' : 'en');
  stopClock.mark('(pre-processing)');
  const result = processRecording(recorder.session, config, {
    language,
    snapshot: (observationId) => recorder.snapshot(observationId),
    onEvent,
    typedValues: recorder.typedValues,
  });
  // Les textes saisis ne servent plus : effacés de la mémoire du recorder.
  recorder.typedValues.clear();
  stopClock.mark('processing (journey, flow, test data)');
  const format = request.outputFormat ?? config.recording.outputFormat;
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {};
  const write = async (name: string, content: string): Promise<void> => {
    await writeFile(path.join(directory, name), content, 'utf8');
    files[name] = name;
  };
  // La trace brute ne contient aucune saisie : formes, empreintes salées (le sel n'est jamais écrit), libellés.
  await write('raw-recording.json', json({ ...sessionMeta(result), rawEvents: result.session.rawEvents }));
  await write(
    'semantic-recording.json',
    json({
      ...sessionMeta(result),
      stats: result.normalized.stats,
      negative: result.normalized.negative,
      actions: result.normalized.actions,
    }),
  );
  await write('recorded-flow.json', json(result.flow));
  await write('flow-graph.json', json(result.graph));
  // Le jeu de données du flow (aucune valeur sensible : références à des variables d'environnement).
  if (result.testData && Object.keys(result.testData.set.values).length > 0)
    await write(TEST_DATA_FILE, stringifyYaml(result.testData.document, { lineWidth: 0 }));
  // HUMAN JOURNEY : chaque interaction humaine, son statut et sa place dans le flow (jamais une valeur saisie).
  await write(
    'human-journey.json',
    json({
      recordingSessionId: result.session.id,
      fidelity: result.fidelity,
      startState: result.session.initialStateId,
      finalState: result.session.states.at(-1)?.id,
      summary: result.journey.summary,
      ordered: result.journey.ordered,
      interactions: result.journey.interactions,
      dependencies: result.journey.dependencies,
      phases: result.journey.phases,
    }),
  );
  await write('action-preservation.json', json(result.journey.accounts));
  // AI CONTEXT AUDIT : ce qui a été envoyé au conseiller, assaini (jamais un secret ni une saisie).
  const aiContexts = recorder.session.rawEvents
    .filter((event) => event.targetValidation?.aiAudit?.context)
    .map((event) => ({
      rawEventId: event.id,
      humanActionId: event.targetValidation?.humanActionId,
      outcome: event.targetValidation?.aiAudit?.outcome,
      decisionId: event.targetValidation?.aiAudit?.decisionId,
      context: event.targetValidation?.aiAudit?.context,
    }));
  if (aiContexts.length > 0) await write('ai-context-summary.json', json({ audits: aiContexts }));
  // AUTO-VALIDATION DES CIBLES : avant, réparation, après, audit — et la confiance de rejeu.
  await write(
    'target-validation.json',
    json({
      enabled: config.recording.targetValidation.enabled,
      summary: result.targetValidation.summary,
      replayConfidence: result.targetValidation.replayConfidence,
      coherence: result.targetValidation.coherence,
      actions: result.targetValidation.entries.map(({ validation, ...entry }) => ({
        ...entry,
        ...(validation
          ? {
              // CIBLE / EFFET / OBJECTIF : trois verdicts séparés (ValidationMode.RECORDING).
              mode: validation.mode,
              // CAPTURE AVANT MUTATION : ce qui existait quand l'humain a agi, puis ce qui existe maintenant.
              ...(validation.preActionCapture ? { preActionCapture: validation.preActionCapture } : {}),
              ...(validation.currentRuntime ? { currentRuntime: validation.currentRuntime } : {}),
              validation: {
                status: validation.validationStatus ?? validation.status,
                ...(validation.validatedCandidate ? { candidate: validation.validatedCandidate } : {}),
                confidence: validation.confidence,
              },
              target: validation.verdict.target,
              effect: validation.verdict.effect,
              goal: withSemanticGoal(validation.verdict.goal, entry.finalFingerprint?.semanticId),
              original: validation.original,
              fingerprintBefore: validation.fingerprintBefore,
              targetBefore: validation.targetBefore,
              validationBefore: validation.validationBefore,
              repair: validation.repair ?? null,
              targetAfter: validation.targetAfter,
              fingerprintAfter: validation.fingerprintAfter,
              validationAfter: validation.validationAfter ?? null,
              aiAudit: validation.aiAudit ?? null,
              attempts: validation.attempts,
              confidence: validation.confidence,
              originalTargetMatch: validation.originalTargetMatch,
              knowledge: validation.knowledge,
              ...(validation.effects ? { effects: validation.effects } : {}),
              ...(validation.semanticallyConfirmed ? { semanticallyConfirmed: true } : {}),
              ...(validation.drag ? { drag: validation.drag } : {}),
            }
          : {}),
      })),
    }),
  );
  if (format !== 'gherkin') await write('generated.flow.yaml', result.files.yaml);
  // Le flow raccourci est un AUTRE fichier : generated.flow.yaml reste le parcours enseigné.
  if (result.optimized && format !== 'gherkin')
    await write('optimized.flow.yaml', result.optimized.files.yaml);
  if (format !== 'yaml') await write('generated.feature', result.files.feature);

  stopClock.mark('writing artifacts');
  if (config.recording.knowledge) await rememberRecording(config, result, env).catch(() => undefined);
  stopClock.mark('knowledge');

  // RECORDING INTELLIGENCE : comprendre (jamais modifier) le parcours humain, après la capture.
  let intelligence: RecordingIntelligence | undefined;
  // RECORDING SEMANTIC AUDIT : le déterministe toujours ; le conseiller seulement si ai.mode ≠ OFF.
  let semanticAudit: SemanticAuditReport | undefined;
  const runSemanticAudit = async (
    gateway: IntelligenceGateway | undefined,
  ): Promise<SemanticAuditReport | undefined> => {
    try {
      const report = await auditRecordingSemantics({
        result,
        settings: config.recording.intelligenceAudit,
        intelligenceMode: mode,
        ...(gateway ? { gateway } : {}),
        minProposalConfidence: config.ai.thresholds.minProposalConfidence,
      });
      onEvent({
        type: 'RECORDING_SEMANTIC_AUDITED',
        at: new Date().toISOString(),
        message: `${String(report.summary.audited)} action(s) audited (${String(report.aiCalls)} AI call(s)): ${String(report.summary.confirmed)} confirmed, ${String(report.summary.disagreements)} disagreement(s), ${String(report.summary.suspicious)} suspicious, ${String(report.summary.reviewRequired)} to review`,
      });
      return report;
    } catch (error) {
      onEvent({
        type: 'RECORDING_SEMANTIC_AUDITED',
        at: new Date().toISOString(),
        message: `semantic audit skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  };
  if (mode !== 'OFF') {
    try {
      intelligence = await enrichRecording({
        result,
        mode,
        ...(gateway && config.ai.triggers.recordingEnrichment ? { gateway } : {}),
        context: config.ai.context,
      });
      onEvent({
        type: 'RECORDING_ENRICHED',
        at: new Date().toISOString(),
        message: `${String(intelligence.candidates.length)} knowledge candidate(s) (${String(intelligence.aiCalls)} AI call(s)); ${String(intelligence.preserved)}/${String(intelligence.humanActions)} human action(s) preserved${intelligence.preservationVerified ? '' : ' — PRESERVATION CHECK FAILED'}`,
      });
      await write('recording-intelligence.json', json(intelligence));
      if (mode === 'HYBRID')
        await rememberRecordingCandidates(
          recordingCandidatesFile(config.output.reportsDir),
          intelligence.candidates,
        ).catch(() => undefined);
    } catch (error) {
      onEvent({
        type: 'RECORDING_ENRICHED',
        at: new Date().toISOString(),
        message: `recording enrichment skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    stopClock.mark('AI enrichment');
    semanticAudit = await runSemanticAudit(gateway);
    stopClock.mark('semantic audit');
    await gateway?.close();
  } else {
    semanticAudit = await runSemanticAudit(undefined);
    stopClock.mark('semantic audit');
  }
  if (semanticAudit) await write('semantic-audit.json', json(semanticAudit));

  let replay: ReplayOutcome = { status: 'NOT_VALIDATED' };
  if (request.validate ?? config.recording.validate) {
    onEvent({
      type: 'REPLAY_VALIDATION_STARTED',
      at: new Date().toISOString(),
      message: 'replaying the generated flow (dry run)',
    });
    replay = await validateReplay(request, directory, result, env);
    onEvent({
      type: replay.status === 'REPLAY_CONFIRMED' ? 'REPLAY_CONFIRMED' : 'REPLAY_FAILED',
      at: new Date().toISOString(),
      message: replay.reason ?? replay.status,
    });
    stopClock.mark('replay validation (--validate)');
  }
  result.session.status = 'COMPLETED';
  const stopTiming = stopTimingOf(stopClock, recorder.stopTimings, targetValidator?.deferredAudits ?? 0);
  onEvent({ type: 'RECORDING_STOP_TIMING', at: new Date().toISOString(), message: stopTiming.message });
  onEvent({
    type: 'RECORDING_COMPLETED',
    at: new Date().toISOString(),
    message: `${String(result.flow.steps.length)} step(s) · ${replay.status}`,
  });
  await write('recording-events.jsonl', log.toJsonLines());
  await write(
    'index.html',
    recordingHtml({
      result,
      replay,
      files: { ...files },
      generatedAt: new Date().toISOString(),
      ...(intelligence ? { intelligence } : {}),
      ...(semanticAudit ? { audit: semanticAudit } : {}),
    }),
  );
  return {
    result,
    directory,
    files,
    replay,
    stopReason,
    warnings,
    ...(semanticAudit ? { audit: semanticAudit } : {}),
  };
}

/** La mission (ou une cible donnée par --url seule). */
async function recordingConfig(
  request: RecordRequest,
  env: NodeJS.ProcessEnv,
): Promise<{ config: ScenarioConfig; warnings: string[] }> {
  const url = request.url;
  const absolute = url !== undefined && /^https?:\/\//i.test(url) ? new URL(url) : undefined;
  if (request.missionFile) {
    const loaded = await loadConfigFile(request.missionFile, request.overrides ?? {}, env);
    if (url === undefined) return loaded;
    const startAt = absolute ? `${absolute.pathname}${absolute.search}${absolute.hash}` : url;
    return {
      config: {
        ...loaded.config,
        target: {
          ...loaded.config.target,
          ...(absolute && request.overrides?.baseUrl === undefined ? { baseUrl: absolute.origin } : {}),
          startAt,
        },
      },
      warnings: loaded.warnings,
    };
  }
  if (!absolute && request.overrides?.baseUrl === undefined && env.QA_BASE_URL === undefined)
    throw new ConfigError('No application to record', [
      'give the address with --url https://…, or the mission with -c mission.yaml',
    ]);
  const base = absolute?.origin ?? request.overrides?.baseUrl ?? env.QA_BASE_URL ?? '';
  const startAt = absolute ? `${absolute.pathname}${absolute.search}${absolute.hash}` : (url ?? '/');
  const yaml = `mission: { name: ${JSON.stringify(request.name)} }\ntarget: { baseUrl: ${JSON.stringify(base)}, startAt: ${JSON.stringify(startAt)} }\n`;
  return parseConfig(yaml, request.overrides ?? {}, env);
}

/** La connaissance fonctionnelle (la même que les runs) : le workflow montré par l'humain, HUMAN_RECORDED. */
async function rememberRecording(
  config: ScenarioConfig,
  result: RecordingResult,
  env: NodeJS.ProcessEnv,
): Promise<void> {
  const intent = result.flow.intent;
  if (!intent.workflow || !intent.api || !intent.entity) return;
  const store = new FunctionalKnowledgeStore(
    path.join(path.dirname(path.resolve(config.output.reportsDir)), 'knowledge', 'functional'),
    {
      application: config.mission.name,
      ...((config.staticAnalysis.version ?? env.QA_VERSION)
        ? { version: config.staticAnalysis.version ?? env.QA_VERSION }
        : {}),
      ...((config.staticAnalysis.commit ?? env.QA_COMMIT)
        ? { commit: config.staticAnalysis.commit ?? env.QA_COMMIT }
        : {}),
      ...((config.baseline.environment ?? env.QA_ENVIRONMENT)
        ? { environment: config.baseline.environment ?? env.QA_ENVIRONMENT }
        : {}),
    },
  );
  await store.load();
  const trigger = result.normalized.kept.find((action) =>
    action.network.some(
      (exchange) =>
        `${exchange.method} ${exchange.path}`.length > 0 && intent.api?.startsWith(exchange.method),
    ),
  );
  store.rememberLearned({
    workflows: [
      {
        id: intent.workflow,
        api: intent.api,
        entityType: intent.entity,
        ...(trigger?.target?.label ? { triggerLabel: trigger.target.label } : {}),
        provenance: 'HUMAN_RECORDED',
        recordingSessionId: result.session.id,
      },
    ],
    states: [],
    transitions: intent.transitions.map((transition) => ({
      entityType: transition.entity,
      stateField: 'status',
      from: transition.from,
      to: transition.to,
      trigger: intent.workflow?.split(':')[0]?.toLowerCase() ?? 'update',
      api: intent.api ?? '',
    })),
  });
  await store.save([]);
}

/** Rejoue generated.flow.yaml avec le Dry Run existant (même SafetyPolicy) ; le fichier n'est jamais modifié. */
async function validateReplay(
  request: RecordRequest,
  directory: string,
  result: RecordingResult,
  env: NodeJS.ProcessEnv,
): Promise<ReplayOutcome> {
  const scenarioFile = path.join(directory, 'replay.flow.yaml');
  await writeFile(scenarioFile, result.files.yaml, 'utf8');
  try {
    const outcome = await runDryRun({
      scenarioFile,
      ...(request.missionFile ? { missionFile: request.missionFile } : {}),
      overrides: {
        ...request.overrides,
        ...(request.missionFile ? {} : { baseUrl: new URL(result.session.startUrl).origin }),
        reportsDir: path.join(directory, 'replay'),
        headless: true,
      },
      env,
      useHistory: false,
      isolatedMemory: true,
      outputFormat: 'yaml',
    });
    const confirmed = outcome.status === 'FULLY_MATCHED';
    const report = outcome.flows[0]
      ? path.relative(directory, path.join(outcome.flows[0].directory, 'index.html'))
      : undefined;
    return {
      status: confirmed ? 'REPLAY_CONFIRMED' : 'REPLAY_FAILED',
      dryRunStatus: outcome.status,
      reason: confirmed
        ? 'every step was found and executed on the application'
        : `the dry run of the generated flow is ${outcome.status}: see its report (the generated flow is unchanged)`,
      ...(report ? { report } : {}),
    };
  } catch (error) {
    return {
      status: 'REPLAY_FAILED',
      reason: `the replay could not run: ${error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error)}`,
    };
  }
}

/**
 * Le bilan du temps après « Stop » : le total, puis chaque phase (les phases de l'arrêt du recorder
 * en détail), les plus longues d'abord ; les audits IA non faits à cause de l'arrêt.
 */
export function stopTimingOf(
  clock: { start: number; phases: readonly { phase: string; ms: number }[] },
  recorderPhases: readonly { phase: string; ms: number }[],
  deferredAudits: number,
): { totalMs: number; phases: { phase: string; ms: number }[]; message: string } {
  const phases = [
    ...recorderPhases.map((entry) => ({ phase: `stop: ${entry.phase}`, ms: entry.ms })),
    ...clock.phases.filter((entry) => entry.phase !== 'recorder stop (total)' || recorderPhases.length === 0),
  ].filter((entry) => entry.ms >= 0);
  const totalMs = clock.start === 0 ? 0 : Date.now() - clock.start;
  const seconds = (ms: number): string => `${(ms / 1000).toFixed(1)} s`;
  const top = [...phases].sort((a, b) => b.ms - a.ms).filter((entry) => entry.ms >= 50);
  return {
    totalMs,
    phases,
    message: `after Stop: ${seconds(totalMs)} — ${top.map((entry) => `${entry.phase} ${seconds(entry.ms)}`).join(' · ') || 'nothing slow'}${deferredAudits > 0 ? ` · ${String(deferredAudits)} AI audit(s) skipped because of the stop` : ''}`,
  };
}

function sessionMeta(result: RecordingResult): Record<string, unknown> {
  const { session } = result;
  return {
    id: session.id,
    name: session.name,
    startedAt: session.startedAt,
    endedAt: session.endedAt,
    startUrl: session.startUrl,
    status: session.status,
    ...(session.version ? { version: session.version } : {}),
    ...(session.environment ? { environment: session.environment } : {}),
    ...(session.role ? { role: session.role } : {}),
    droppedEvents: session.droppedEvents,
    checkpoints: session.checkpoints,
    states: session.states,
    warnings: result.warnings,
  };
}

function json(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`;
}
