import { buildApplicationModel } from './application/application-model.js';
import { buildBusinessFlow } from './business/business-flow.js';
import { LlmBusinessAnalyzer, gatewayEntityChooser } from './business/business-semantic-analyzer.js';
import { effectiveRecordingMode } from './sources/recording-coordinator.js';
import { RecordingSourceSet } from './sources/recording-sources.js';
import { annotateFlowYaml, auditGeneratedFlow, flowAuditText, type FlowAuditReport } from './flow-audit.js';
import { screenInventorySummary, screenInventoryText } from './screen-inventory.js';
import { timelineLines } from './recording-consistency.js';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import { ProgressTracker, type ProgressSink } from '../progress/progress.js';
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
import type { RecordedIntent, RecordingEvent, TechnicalIntentRecord } from './model.js';
import type { IntelligenceProvider } from '../ai/provider.js';
import {
  describeFieldIdentity,
  processRecording,
  TEST_DATA_FILE,
  type RecordingResult,
} from './process-recording.js';
import { fieldIdentityKey, fieldIdentityOfEvent } from './field-identity.js';
import { validateFieldMerges } from './field-merge-validator.js';
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
import { recorderTrace } from './recorder-trace.js';
import { RecorderPanel } from './recorder-panel.js';
import { RecordingConsole, removeFlowStep, saveRecordedFlow } from './recording-console.js';
import { describeFlowStep, reviewSteps, type PanelReplay } from './panel-state.js';

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
  drive?: (session: { page: Page; recorder: HumanFlowRecorder; panel?: Page }) => Promise<void>;
  /**
   * LA REVUE après Stop, dans la fenêtre du recorder : rejouer, modifier, sauvegarder ; la fenêtre du
   * recorder reste ouverte jusqu'à « Fermer » (celle de l'application se ferme dès l'arrêt). La commande record l'active en
   * mode interactif ; sans elle, l'enregistrement se termine comme avant.
   */
  review?: boolean;
  /** Tests, intégrations : pilote la fenêtre pendant la revue ; la revue se termine quand il se termine. */
  reviewDriver?: (session: { panel: Page; recorder: HumanFlowRecorder }) => Promise<void>;
  /** Un fournisseur d'intelligence injecté (tests, intégrations) : remplace ai.provider. */
  intelligenceProvider?: IntelligenceProvider;
  /** Le terminal : Entrée pour arrêter, « c » pour un point de contrôle… ; renvoie de quoi se détacher. */
  control?: (recorder: HumanFlowRecorder) => () => void;
  /** La progression après l'arrêt (finalisation, flow, audits, rejeu, rapport) : le système travaille. */
  onProgress?: ProgressSink;
}

/** Les phases après l'arrêt, dans l'ordre. */
export const RECORDING_PHASES = {
  capture: 'Finishing the capture',
  browser: 'Closing the browser',
  flow: 'Building the flow',
  files: 'Writing the files',
  audit: 'Auditing the flow',
  replay: 'Validating by replay',
  report: 'Writing the report',
} as const;

export interface RecordOutcome {
  result: RecordingResult;
  directory: string;
  files: Record<string, string>;
  replay: ReplayOutcome;
  stopReason: StopReason;
  warnings: string[];
  /** RECORDING SEMANTIC AUDIT (semantic-audit.json). */
  audit?: SemanticAuditReport;
  /** « Sauvegarder » (revue) : où le flow a été copié. */
  saved?: { directory: string; files: string[] };
}

/**
 * RECORD : ouvrir Chromium (connecté si la mission le demande), laisser l'humain faire,
 * puis RAW → SEMANTIC → FINAL et écrire sous `<reportsDir>/recordings/<nom>/` :
 * raw-recording.json, semantic-recording.json, recorded-flow.json, semantic-intents.json, generated.flow.yaml,
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
    if (event.type !== 'RAW_EVENT_CAPTURED' && event.type !== 'RECORDER_DEBUG')
      log.log('INFO', event.type, event.message);
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
  const language =
    request.language ?? config.recording.language ?? (config.report.language === 'fr' ? 'fr' : 'en');
  // LES SOURCES DE CAPTURE (recording.mode) : en CURRENT, aucune — le recorder reste celui d'avant.
  const recordingMode = effectiveRecordingMode(config.recording);
  if (recordingMode.warning) warnings.push(recordingMode.warning);
  const sources =
    recordingMode.mode === 'CURRENT'
      ? undefined
      : new RecordingSourceSet(recordingMode.mode, (type, message) => {
          onEvent({ type, at: new Date().toISOString(), message });
        });
  const recorder = new HumanFlowRecorder({
    name: request.name,
    config,
    language,
    onEvent,
    ...(sources ? { sources } : {}),
    ...identity,
    ...(targetValidator ? { targetValidator } : {}),
    // La timeline en direct : la fenêtre se redessine tout de suite (jamais après une analyse).
    onTimeline: () => {
      consoleUi?.timelineChanged();
    },
  });
  const browser = new BrowserManager(config.browser);
  let consoleUi: RecordingConsole | undefined;
  const validate = request.validate ?? config.recording.validate;
  // La progression commence à l'arrêt : finalisation, flow, audits, rejeu, rapport.
  const progress = new ProgressTracker(
    'Finalizing the recording',
    Object.values(RECORDING_PHASES).filter((phase) => validate || phase !== RECORDING_PHASES.replay),
    (update) => {
      consoleUi?.onProgress(update);
      request.onProgress?.(update);
    },
  );
  let stopReason: StopReason = 'api';
  let detach: (() => void) | undefined;
  let reviewing = request.review === true || request.reviewDriver !== undefined;
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
    // LA FENÊTRE DU RECORDER : un contexte séparé (jamais capturé) ; elle ne bloque jamais l'enregistrement.
    if (config.recording.panel && config.recording.overlay) {
      try {
        // À l'écran, la fenêtre suit sa VRAIE taille (jamais une page plus grande que l'écran : les
        // boutons du bas sortaient de l'écran d'un portable) ; sans écran (headless), une taille fixe.
        const windowSize = config.browser.headless
          ? { viewport: { width: 1360, height: 900 } }
          : { viewport: null };
        const panelPage = await browser.newIsolatedPage(windowSize);
        consoleUi = new RecordingConsole(
          await RecorderPanel.open(panelPage, language),
          recorder,
          request.name,
          language,
          // ⧉ Détacher l'aperçu : une autre fenêtre isolée du même navigateur.
          () => browser.newIsolatedPage(windowSize),
        );
        consoleUi.withPreview = config.recording.panelPreview;
        consoleUi.timelineChanged();
        await page.bringToFront().catch(() => undefined);
      } catch (error) {
        warnings.push(
          `the recorder window could not open: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    detach = request.control?.(recorder);
    if (request.drive) {
      await request.drive({ page, recorder, ...(consoleUi ? { panel: consoleUi.page } : {}) });
      recorder.requestStop('api');
    }
    stopReason = await recorder.stopped;
    stopClock.start = Date.now();
    progress.start(RECORDING_PHASES.capture);
    await recorder.stop((detail) => {
      progress.detail(detail);
    });
    stopClock.mark('recorder stop (total)');
  } catch (error) {
    recorder.session.status = 'FAILED';
    progress.fail(error instanceof Error ? (error.message.split('\n')[0] ?? error.message) : String(error));
    onEvent({
      type: 'RECORDING_FAILED',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    await gateway?.close();
    reviewing = false;
    throw error;
  } finally {
    detach?.();
    consoleUi?.stopped();
    // La revue garde la fenêtre du recorder jusqu'à « Fermer » ; la fenêtre de l'APPLICATION se ferme
    // dès l'arrêt (le rejeu ouvre sa propre fenêtre, propre : jamais deux applications ouvertes).
    progress.start(RECORDING_PHASES.browser);
    if (reviewing) await browser.closeApplication();
    else await browser.close();
    stopClock.mark('browser close');
  }
  stopClock.mark('(pre-processing)');
  const result = await progress.run(RECORDING_PHASES.flow, () =>
    processRecording(recorder.session, config, {
      language,
      snapshot: (observationId) => recorder.snapshot(observationId),
      onEvent,
      typedValues: recorder.typedValues,
      digest: (value) => recorder.digest(value),
    }),
  );
  // Une ambiguïté métier peut encore être soumise à l'IA (analyse en arrière-plan) : les saisies
  // restent en mémoire jusque-là seulement (jamais écrites).
  const businessTyped =
    mode !== 'OFF' &&
    config.recording.business.ai &&
    result.business?.model.unresolved.some((event) => event.status === 'AMBIGUOUS') === true
      ? new Map(recorder.typedValues)
      : undefined;
  // Les textes saisis ne servent plus : effacés de la mémoire du recorder.
  recorder.typedValues.clear();
  // QA_DEBUG : chaque interaction humaine, enregistrée (élément, validation, stabilisation) ou ignorée (raison).
  for (const line of recorderTrace({
    events: result.session.rawEvents,
    accounts: result.journey.accounts,
    kept: result.normalized.kept,
    steps: result.flow.steps,
  }))
    onEvent({ type: 'RECORDER_DEBUG', at: new Date().toISOString(), message: line });
  stopClock.mark('processing (journey, flow, test data)');
  const format = request.outputFormat ?? config.recording.outputFormat;
  progress.start(RECORDING_PHASES.files);
  await mkdir(directory, { recursive: true });
  const files: Record<string, string> = {};
  const write = async (name: string, content: string): Promise<void> => {
    await writeFile(path.join(directory, name), content, 'utf8');
    files[name] = name;
  };
  // La trace brute ne contient aucune saisie : formes, empreintes salées (le sel n'est jamais écrit), libellés.
  // Toute la trace, y compris les événements annulés par l'humain (marqués `undone`, exclus du flow).
  await write('raw-recording.json', json({ ...sessionMeta(result), rawEvents: recorder.session.rawEvents }));
  // LE FLOW MÉTIER : une couche au-dessus du flow enregistré (jamais à sa place).
  const writeBusiness = async (): Promise<void> => {
    if (!result.business) return;
    const { model, detection } = result.business;
    await write(
      'business-flow.json',
      // Les entités (provenance expliquée, cycle de vie) sont dans model.entities ; leurs preuves
      // structurées dans evidence (jamais une valeur saisie : une saisie n'a qu'une empreinte).
      json({
        ...model,
        events: detection.events,
        memory: detection.memory.all,
        evidence: detection.evidence,
      }),
    );
  };
  await writeBusiness();
  // LE MODÈLE DE L'APPLICATION : contextes, tasks, entités, relations, actions métier (avec preuves).
  const writeApplication = async (): Promise<void> => {
    if (result.application) await write('application-model.json', json(result.application));
  };
  await writeApplication();
  // Les sources et leurs corrélations (PLAYWRIGHT, HYBRID) : ce que chaque source a vu, une action par geste.
  if (sources) await write('recording-sources.json', json(sources.report()));
  await write(
    'semantic-recording.json',
    json({
      ...sessionMeta(result),
      stats: result.normalized.stats,
      negative: result.normalized.negative,
      actions: result.normalized.actions,
    }),
  );
  // NIVEAU 2 (actions humaines validées) et NIVEAU 3 (intention) séparés : recorded-flow.json ne porte
  // aucune intention ; l'intention métier déduite après coup est dans semantic-intents.json.
  const { intent: semanticIntent, ...recordedFlow } = result.flow;
  await write('recorded-flow.json', json(recordedFlow));
  await write(
    'semantic-intents.json',
    json(semanticIntentsOf(result.flow.recordingSessionId, semanticIntent)),
  );
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
  // SCREEN ELEMENT INVENTORY : chaque écran inventorié avant les interactions (sélecteurs, ambiguïté).
  if (recorder.inventories.length > 0) {
    await write(
      'screen-inventory.json',
      json({ summary: screenInventorySummary(recorder.inventories), screens: recorder.inventories }),
    );
    await write('screen-inventory.txt', `${screenInventoryText(recorder.inventories).join('\n')}\n`);
  }
  // FIELD IDENTITY : chaque saisie, l'identité de son champ ; chaque fusion, sa décision et ses raisons.
  await write('typing-merge-decisions.json', json(typingMergeReport(result)));
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
  // CAUSE → EFFET : chaque attente avec sa causalité, la contamination détectée, la chronologie.
  await write(
    'recording-validation.json',
    json({ ...result.consistency, timelineText: timelineLines(result.consistency) }),
  );
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

  progress.start(RECORDING_PHASES.audit, mode !== 'OFF' ? 'with the intelligence advisor' : undefined);
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
  let flowAudit: FlowAuditReport | undefined;
  const runFlowAudit = async (
    gateway: IntelligenceGateway | undefined,
  ): Promise<FlowAuditReport | undefined> => {
    try {
      const report = await auditGeneratedFlow({
        result,
        settings: config.recording.flowAudit,
        intelligenceMode: mode,
        ...(gateway ? { gateway } : {}),
        minProposalConfidence: config.ai.thresholds.minProposalConfidence,
      });
      onEvent({
        type: 'RECORDING_FLOW_AUDITED',
        at: new Date().toISOString(),
        message: `flow audit: ${String(report.summary.errors)} error(s), ${String(report.summary.warnings)} warning(s), ${String(report.summary.infos)} info(s) (${String(report.aiCalls)} AI call(s), ${String(report.summary.aiConfirmed)} confirmed, ${String(report.summary.aiProposals)} AI proposal(s)) — the flow is never modified`,
      });
      return report;
    } catch (error) {
      onEvent({
        type: 'RECORDING_FLOW_AUDITED',
        at: new Date().toISOString(),
        message: `flow audit skipped: ${error instanceof Error ? error.message : String(error)}`,
      });
      return undefined;
    }
  };
  // 1) LE DÉTERMINISTE, tout de suite (règles, sans appel) : le flow, ses constats et la revue
  //    n'attendent jamais le conseiller.
  semanticAudit = await runSemanticAudit(undefined);
  stopClock.mark('semantic audit (deterministic)');
  flowAudit = await runFlowAudit(undefined);
  stopClock.mark('flow audit (deterministic)');
  const writtenYaml = result.files.yaml;
  const writeAudits = async (): Promise<void> => {
    if (semanticAudit) await write('semantic-audit.json', json(semanticAudit));
    // FLOW AUDIT : le flow généré relu dans son ensemble (règles toujours ; conseiller si ai.mode ≠ OFF).
    if (flowAudit) {
      await write('flow-audit.json', json(flowAudit));
      await write('flow-audit.txt', `${flowAuditText(flowAudit).join('\n')}\n`);
      // Les commentaires de l'audit ne vont que sur le flow qu'il a relu (jamais sur un flow modifié depuis).
      if (format !== 'gherkin' && flowAudit.findings.length > 0 && result.files.yaml === writtenYaml)
        await write('generated.flow.yaml', annotateFlowYaml(result.files.yaml, flowAudit));
    }
  };
  await writeAudits();
  // 2) LE CONSEILLER (ai.mode ≠ OFF) : enrichissement, audit sémantique, audit du flow — des avis,
  //    jamais une modification. Pendant la revue, en ARRIÈRE-PLAN (l'onglet Analyse se complète) ;
  //    sinon comme avant, avant le rapport.
  const runAiAnalysis = async (): Promise<void> => {
    const started = Date.now();
    // Une durée totale bornée, et plus aucun appel après un délai dépassé : jamais des minutes d'attente.
    gateway?.limitTo({ deadlineAt: started + config.recording.aiAnalysisBudgetMs, stopOnFailure: true });
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
    semanticAudit = (await runSemanticAudit(gateway)) ?? semanticAudit;
    flowAudit = (await runFlowAudit(gateway)) ?? flowAudit;
    // UNE AMBIGUÏTÉ MÉTIER (plusieurs entités possibles, ou une provenance contradictoire) : l'IA
    // choisit parmi les candidats observés, le détecteur revalide ; jamais au-delà de PROBABLE.
    if (gateway && config.recording.business.ai && result.business && businessTyped) {
      const analyzer = new LlmBusinessAnalyzer(gatewayEntityChooser(gateway, result.session.id));
      const detection = await analyzer
        .analyze({
          actions: result.normalized.kept,
          states: result.session.states,
          rawEvents: result.session.rawEvents,
          steps: result.flow.steps,
          ...(result.session.initialStateId ? { initialStateId: result.session.initialStateId } : {}),
          typedValues: businessTyped,
          digest: (value) => recorder.digest(value),
        })
        .catch(() => undefined);
      businessTyped.clear();
      if (detection) {
        result.business = { detection, model: buildBusinessFlow(result.session.name, detection) };
        await writeBusiness();
        if (result.application) {
          result.application = buildApplicationModel({
            actions: result.normalized.kept,
            states: result.session.states,
            rawEvents: result.session.rawEvents,
            steps: result.flow.steps,
            entities: detection.entities,
            entityEvidence: detection.evidence,
            correlations: detection.correlations,
            ...(result.session.initialStateId ? { initialStateId: result.session.initialStateId } : {}),
            digest: (value) => recorder.digest(value),
          });
          await writeApplication();
        }
        onEvent({
          type: 'BUSINESS_FLOW_DETECTED',
          at: new Date().toISOString(),
          message: `AI on ${String(analyzer.consultations.length)} ambiguity(ies): ${
            analyzer.consultations
              .map(
                (entry) =>
                  `${entry.eventId} → ${entry.answer ?? 'no answer'}${entry.accepted ? '' : ' (rejected)'}`,
              )
              .join(', ') || 'none'
          }`,
        });
      }
    }
    const stoppedBecause = gateway?.stoppedBecause;
    if (stoppedBecause)
      onEvent({
        type: 'RECORDING_STOP_TIMING',
        at: new Date().toISOString(),
        message: `AI analysis cut short (${stoppedBecause}, budget ${String(config.recording.aiAnalysisBudgetMs / 1000)} s): the deterministic findings are kept`,
      });
    await gateway?.close();
    await writeAudits();
    consoleUi?.setAnalysis(result, flowAudit, intelligence);
    aiAnalysisMs = Date.now() - started;
  };
  let aiAnalysisMs = 0;
  let aiAnalysis: Promise<void> | undefined;
  if (mode !== 'OFF') {
    if (reviewing && consoleUi) {
      consoleUi.setAnalysis(result, flowAudit, intelligence, true);
      aiAnalysis = runAiAnalysis().catch(() => undefined);
    } else {
      await runAiAnalysis();
      stopClock.mark('AI analysis (enrichment, semantic audit, flow audit)');
    }
  }

  let replay: ReplayOutcome = { status: 'NOT_VALIDATED' };
  let saved: RecordOutcome['saved'];
  // UN BROUILLON tant que l'humain ne l'a pas sauvegardé (revue) : jamais un flow de la mission d'office.
  await write('recording-status.json', json({ status: 'DRAFT', recordedAt: result.session.startedAt }));
  // L'ANALYSE (onglet séparé) : disponible une fois le flow écrit, jamais dans la timeline.
  if (!aiAnalysis) consoleUi?.setAnalysis(result, flowAudit, intelligence);
  const runReplay = async (onStep?: (executed: number, total: number) => void): Promise<ReplayOutcome> => {
    onEvent({
      type: 'REPLAY_VALIDATION_STARTED',
      at: new Date().toISOString(),
      message: 'replaying the generated flow (dry run)',
    });
    replay = await validateReplay(request, directory, result, env, {
      // Rejoué depuis la revue : visible comme l'enregistrement (sinon sans fenêtre, comme avant).
      headless: reviewing ? config.browser.headless : true,
      ...(onStep ? { onStep } : {}),
    });
    onEvent({
      type: replay.status === 'REPLAY_CONFIRMED' ? 'REPLAY_CONFIRMED' : 'REPLAY_FAILED',
      at: new Date().toISOString(),
      message: replay.reason ?? replay.status,
    });
    return replay;
  };
  if (validate) {
    progress.start(RECORDING_PHASES.replay, 'the generated flow is replayed in a new browser');
    await runReplay();
    stopClock.mark('replay validation (--validate)');
  }
  // LA REVUE : Rejouer → Valider → Sauvegarder, dans la fenêtre du recorder (l'application est fermée).
  if (reviewing && consoleUi) {
    const ui = consoleUi;
    const driverFailure = await ui.runReview({
      result,
      directory,
      ...(request.reviewDriver ? { until: () => request.reviewDriver?.({ panel: ui.page, recorder }) } : {}),
      actions: {
        replay: async (onStep) => panelReplayOf(await runReplay(onStep), result, recorder, language),
        remove: async (stepId) => {
          if (!removeFlowStep(result, stepId, language)) return false;
          if (format !== 'gherkin') await write('generated.flow.yaml', result.files.yaml);
          if (format !== 'yaml') await write('generated.feature', result.files.feature);
          const { intent: _intent, ...recordedFlow } = result.flow;
          await write('recorded-flow.json', json(recordedFlow));
          onEvent({
            type: 'RECORDING_STEP_REMOVED',
            at: new Date().toISOString(),
            message: `step ${stepId} removed by the user: ${String(result.flow.steps.length)} step(s) left`,
          });
          replay = { status: 'NOT_VALIDATED' };
          saved = undefined;
          return true;
        },
        save: async () => {
          saved = await saveRecordedFlow({
            config,
            name: request.name,
            directory,
            result,
            replayStatus: replay.status,
          });
          files['recording-status.json'] = 'recording-status.json';
          onEvent({
            type: 'RECORDING_SAVED',
            at: new Date().toISOString(),
            message: `flow saved to ${saved.directory} (${saved.files.join(', ')}); replay ${replay.status}`,
          });
          return saved;
        },
      },
    });
    // L'analyse du conseiller a tourné pendant la revue : le rapport attend seulement ce qui reste.
    if (aiAnalysis) {
      progress.start(RECORDING_PHASES.audit, 'finishing the intelligence advisor analysis');
      await aiAnalysis;
      onEvent({
        type: 'RECORDING_STOP_TIMING',
        at: new Date().toISOString(),
        message: `AI analysis ran in the background during the review (${(aiAnalysisMs / 1000).toFixed(1)} s)`,
      });
    }
    await ui.close();
    await browser.close();
    stopClock.mark('review');
    if (driverFailure !== undefined)
      throw driverFailure instanceof Error ? driverFailure : new Error('the review driver failed');
  }
  result.session.status = 'COMPLETED';
  const stopTiming = stopTimingOf(stopClock, recorder.stopTimings, targetValidator?.deferredAudits ?? 0);
  onEvent({ type: 'RECORDING_STOP_TIMING', at: new Date().toISOString(), message: stopTiming.message });
  onEvent({
    type: 'RECORDING_COMPLETED',
    at: new Date().toISOString(),
    message: `${String(result.flow.steps.length)} step(s) · ${replay.status}`,
  });
  progress.start(RECORDING_PHASES.report);
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
  progress.done(
    `${String(result.flow.steps.length)} step(s)${replay.status === 'NOT_VALIDATED' ? '' : ` · ${replay.status}`}`,
  );
  return {
    result,
    directory,
    files,
    replay,
    stopReason,
    warnings,
    ...(semanticAudit ? { audit: semanticAudit } : {}),
    ...(saved ? { saved } : {}),
  };
}

/** Le résultat d'un rejeu, dit pour la fenêtre : l'étape qui échoue en mots simples, le détail ensuite. */
function panelReplayOf(
  outcome: ReplayOutcome,
  result: RecordingResult,
  recorder: HumanFlowRecorder,
  language: 'fr' | 'en',
): PanelReplay {
  const french = language === 'fr';
  // Les ACTIONS rejouées (les vérifications ajoutées ne sont pas des actions de l'humain).
  const steps = (outcome.steps ?? []).filter(
    (step) => result.flow.steps[step.index - 1]?.step.kind !== 'expect',
  );
  const total = steps.length;
  const executed = steps.filter((step) => step.outcome === 'MATCHED').length;
  const review = reviewSteps(result.flow, recorder.timeline.actions, language);
  const describe = (index: number): { description: string; stepId?: string } => {
    const flowStep = result.flow.steps[index - 1];
    if (!flowStep) return { description: `#${String(index)}` };
    const twin = review.actions.find((action) => action.id === flowStep.id);
    return {
      description: twin?.description ?? describeFlowStep(flowStep.step, language),
      stepId: flowStep.id,
    };
  };
  if (outcome.status === 'REPLAY_CONFIRMED')
    return {
      status: 'PASSED',
      executed,
      total,
      checks: [
        { ok: true, text: french ? 'Toutes les cibles retrouvées' : 'Every target found' },
        {
          ok: !steps.some((step) => step.outcome === 'AMBIGUOUS'),
          text: french ? 'Aucune ambiguïté' : 'No ambiguity',
        },
        { ok: true, text: french ? 'Navigation conforme' : 'Navigation as recorded' },
      ],
      ...(outcome.report ? { report: outcome.report } : {}),
    };
  const failing =
    steps.find((step) => step.outcome !== 'MATCHED') ??
    (outcome.steps ?? []).find((step) => step.outcome !== 'MATCHED');
  const cause: Record<string, [string, string]> = {
    NOT_FOUND: ['élément introuvable', 'element not found'],
    AMBIGUOUS: ['plusieurs éléments correspondent', 'several elements match'],
    BLOCKED_BY_POLICY: ['bloquée par la politique de sécurité', 'blocked by the safety policy'],
    ASSERTION_MISMATCH: ['le résultat attendu n’est pas observé', 'the expected result is not observed'],
    NOT_VERIFIED: ['étape non atteinte', 'step not reached'],
  };
  const index = failing?.index ?? Math.min(executed + 1, Math.max(total, 1));
  const said = describe(index);
  const reason = failing ? cause[failing.outcome] : undefined;
  return {
    status: 'FAILED',
    executed,
    total,
    failure: {
      index,
      ...(said.stepId ? { stepId: said.stepId } : {}),
      description: said.description,
      cause: reason ? reason[french ? 0 : 1] : (outcome.reason ?? outcome.status),
      details: [
        ...(failing
          ? [`${failing.outcome} — ${failing.label}`, ...failing.reasons, ...failing.evidence]
          : []),
        ...(outcome.reason ? [outcome.reason] : []),
        ...(outcome.report ? [outcome.report] : []),
      ],
    },
    ...(outcome.report ? { report: outcome.report } : {}),
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

/**
 * SEMANTIC INTENT (niveau 3) : une couche POST-ENREGISTREMENT, déduite des échanges réseau observés,
 * jamais écrite dans le flow (aucune étape `intent:`) et jamais relue pour en produire un.
 */
export function semanticIntentsOf(
  recordingSessionId: string,
  intent: RecordedIntent,
): {
  layer: 'SEMANTIC_POST_RECORDING';
  recordingSessionId: string;
  modifiesRecording: false;
  intents: (Omit<RecordedIntent, 'technical'> & { source: 'NETWORK_OBSERVATION' })[];
  technicalIntents: TechnicalIntentRecord[];
} {
  // Les intents MÉTIER et TECHNIQUES sont séparés : un POST /token est ACQUIRE_TOKEN, jamais CREATE.
  const { technical, ...business } = intent;
  return {
    layer: 'SEMANTIC_POST_RECORDING',
    recordingSessionId,
    modifiesRecording: false,
    intents: business.workflow ? [{ ...business, source: 'NETWORK_OBSERVATION' }] : [],
    technicalIntents: technical ?? [],
  };
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
  options: { headless?: boolean; onStep?: (executed: number, total: number) => void } = {},
): Promise<ReplayOutcome> {
  const total = result.flow.steps.filter((item) => item.step.kind !== 'expect').length;
  let executed = 0;
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
        headless: options.headless ?? true,
      },
      env,
      useHistory: false,
      isolatedMemory: true,
      outputFormat: 'yaml',
      // La progression étape par étape (la fenêtre de revue).
      onEvent: (event) => {
        if (event.type !== 'INTENT_MATCHED') return;
        const position = Number(event.intentId?.split('#').pop());
        if (result.flow.steps[position - 1]?.step.kind === 'expect') return;
        executed += 1;
        options.onStep?.(Math.min(executed, total), total);
      },
    });
    const flow = outcome.flows[0];
    const steps: NonNullable<ReplayOutcome['steps']> = flow
      ? flow.graph.intents.map((intent) => {
          const finding = flow.outcome.findings.find((entry) => entry.intentId === intent.id);
          return {
            index: intent.index,
            label: intent.label,
            outcome: finding?.outcome ?? 'NOT_VERIFIED',
            reasons: finding?.reasons ?? [],
            evidence: finding?.evidence ?? [],
          };
        })
      : [];
    const confirmed = outcome.status === 'FULLY_MATCHED';
    const report = outcome.flows[0]
      ? path.relative(directory, path.join(outcome.flows[0].directory, 'index.html'))
      : undefined;
    return {
      status: confirmed ? 'REPLAY_CONFIRMED' : 'REPLAY_FAILED',
      steps,
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

/** h013 → { identité, valeur (forme et longueur seulement), action } ; puis les décisions de fusion. */
function typingMergeReport(result: RecordingResult): Record<string, unknown> {
  const inputs = result.session.rawEvents
    .filter((event) => (event.type === 'input' || event.type === 'change') && event.element)
    .map((event) => {
      const identity = fieldIdentityOfEvent(event);
      const action = result.normalized.actions.find((candidate) => candidate.rawEventIds.includes(event.id));
      return {
        rawEventId: event.id,
        ...(action ? { actionId: action.id } : {}),
        ...(action?.dropped ? { status: `DROPPED: ${action.dropped}` } : action ? { status: 'KEPT' } : {}),
        ...(identity
          ? {
              fieldKey: fieldIdentityKey(identity) ?? null,
              fieldIdentity: describeFieldIdentity(identity),
              recorderElementId: identity.domInstance,
              valueProfile: identity.valueProfile,
              locatorUniqueness: identity.locatorUniqueness,
            }
          : {}),
        ...(action?.value?.testData ? { testData: action.value.testData } : {}),
      };
    });
  return {
    inputs,
    validation: validateFieldMerges(result.normalized.actions, result.session.rawEvents),
    decisions: result.normalized.mergeDecisions.map(
      ({ previousIdentity: _previous, currentIdentity: _current, ...decision }) => decision,
    ),
  };
}
