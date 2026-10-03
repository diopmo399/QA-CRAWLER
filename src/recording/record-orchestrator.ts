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
import { auditRecordingSemantics, type SemanticAuditReport } from './semantic-audit.js';

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
  const recorder = new HumanFlowRecorder({ name: request.name, config, onEvent, ...identity });
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
    await recorder.stop();
  } catch (error) {
    recorder.session.status = 'FAILED';
    onEvent({
      type: 'RECORDING_FAILED',
      at: new Date().toISOString(),
      message: error instanceof Error ? error.message : String(error),
    });
    throw error;
  } finally {
    detach?.();
    await browser.close();
  }

  const language =
    request.language ?? config.recording.language ?? (config.report.language === 'fr' ? 'fr' : 'en');
  const result = processRecording(recorder.session, config, {
    language,
    snapshot: (observationId) => recorder.snapshot(observationId),
    onEvent,
    typedValues: recorder.typedValues,
  });
  // Les textes saisis ne servent plus : effacés de la mémoire du recorder.
  recorder.typedValues.clear();
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
  if (format !== 'gherkin') await write('generated.flow.yaml', result.files.yaml);
  // Le flow raccourci est un AUTRE fichier : generated.flow.yaml reste le parcours enseigné.
  if (result.optimized && format !== 'gherkin')
    await write('optimized.flow.yaml', result.optimized.files.yaml);
  if (format !== 'yaml') await write('generated.feature', result.files.feature);

  if (config.recording.knowledge) await rememberRecording(config, result, env).catch(() => undefined);

  // RECORDING INTELLIGENCE : comprendre (jamais modifier) le parcours humain, après la capture.
  let intelligence: RecordingIntelligence | undefined;
  const mode = effectiveMode(config.ai);
  // RECORDING SEMANTIC AUDIT : le déterministe toujours ; le conseiller seulement si ai.mode ≠ OFF.
  let audit: SemanticAuditReport | undefined;
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
    const gateway = createIntelligenceGateway(config.ai, {
      env,
      ...(request.intelligenceProvider ? { provider: request.intelligenceProvider } : {}),
      emit: (record) => {
        log.log('INFO', record.event, record.message);
      },
    });
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
    audit = await runSemanticAudit(gateway);
    await gateway?.close();
  } else audit = await runSemanticAudit(undefined);
  if (audit) await write('semantic-audit.json', json(audit));

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
  }
  result.session.status = 'COMPLETED';
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
      ...(audit ? { audit } : {}),
    }),
  );
  return { result, directory, files, replay, stopReason, warnings, ...(audit ? { audit } : {}) };
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
