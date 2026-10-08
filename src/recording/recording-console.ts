import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { slug } from '../knowledge/signatures.js';
import type { ProgressUpdate } from '../progress/progress.js';
import type { FlowAuditReport } from './flow-audit.js';
import type { HumanFlowRecorder } from './human-flow-recorder.js';
import {
  summaryOf,
  reviewSteps,
  liveStep,
  type PanelAnalysis,
  type PanelReplay,
  type PanelState,
} from './panel-state.js';
import { generateFlowFiles } from './recorded-flow.js';
import { RecorderPanel, type PanelCommand } from './recorder-panel.js';
import type { RecordingIntelligence } from './recording-intelligence.js';
import type { RecordingResult } from './process-recording.js';
import { TEST_DATA_FILE } from './process-recording.js';

/** Ce que la revue sait faire (fourni par l'orchestrateur) : rejouer, retirer une étape, sauvegarder. */
export interface ReviewActions {
  replay: (onStep: (executed: number, total: number) => void) => Promise<PanelReplay>;
  remove: (stepId: string) => Promise<boolean>;
  save: () => Promise<{ directory: string; files: string[] }>;
}

/**
 * LA CONSOLE DU RECORDER : relie la fenêtre « QA-CRAWLER Recorder » au recorder (pendant
 * l'enregistrement) puis à la revue (après Stop). Elle construit l'état affiché ; elle ne décide
 * de rien : chaque commande passe par le recorder ou par l'orchestrateur.
 */
export class RecordingConsole {
  private phase: PanelState['phase'] = 'RECORDING';
  private progress: PanelState['progress'];
  private highlight: PanelState['highlight'];
  private notice: PanelState['notice'];
  private replay: PanelReplay | undefined;
  private saved: PanelState['saved'];
  private analysis: PanelAnalysis = { available: false, intents: [], findings: [], aiCandidates: 0 };
  private endedAt: number | undefined;
  private result: RecordingResult | undefined;
  private directory: string | undefined;
  private review: ((command: PanelCommand) => Promise<void>) | undefined;
  private busy = false;
  private preview: PanelState['preview'];
  private previewTimer: NodeJS.Timeout | undefined;
  private capturing = false;
  /** recording.panelPreview : l'aperçu de l'application dans la fenêtre. */
  withPreview = true;

  /** L'aperçu détaché dans sa propre fenêtre (plein écran possible). */
  private detached: RecorderPanel | undefined;
  private detaching = false;

  constructor(
    private readonly panel: RecorderPanel,
    private readonly recorder: HumanFlowRecorder,
    private readonly name: string,
    private readonly language: 'fr' | 'en',
    /** Ouvre une fenêtre isolée (un contexte séparé du navigateur) : pour détacher l'aperçu. */
    private readonly openWindow?: () => Promise<Page>,
  ) {
    panel.onCommand((command) => {
      void this.handle(command);
    });
  }

  /** La page de la fenêtre (tests, intégrations). */
  get page(): Page {
    return this.panel.page;
  }

  render(): void {
    const state = this.state();
    this.panel.render(state);
    this.detached?.render(state);
  }

  /** La fenêtre de l'aperçu détaché (tests, intégrations). */
  get detachedPage(): Page | undefined {
    return this.detached?.page;
  }

  /** ⧉ DÉTACHER : l'aperçu dans sa propre fenêtre ; la fermer (ou « Rattacher ») le remet à sa place. */
  private async detach(): Promise<void> {
    if (this.detached || this.detaching || !this.openWindow) return;
    this.detaching = true;
    try {
      const window = await RecorderPanel.open(await this.openWindow(), this.language, 'preview');
      this.detached = window;
      window.onCommand((command) => {
        void this.handle(command);
      });
      void window.closed.then(() => {
        if (this.detached === window) this.detached = undefined;
        this.render();
      });
      await window.page.bringToFront().catch(() => undefined);
    } finally {
      this.detaching = false;
    }
  }

  private async attach(): Promise<void> {
    const window = this.detached;
    this.detached = undefined;
    await window?.close();
    await this.panel.page.bringToFront().catch(() => undefined);
  }

  /** La timeline a changé (une action, une validation) : la fenêtre, puis un nouvel aperçu de la page. */
  timelineChanged(): void {
    this.render();
    this.schedulePreview();
  }

  /** L'aperçu se rafraîchit après les changements (au plus une image toutes les 800 ms), jamais pendant un rejeu. */
  private schedulePreview(): void {
    if (!this.withPreview || this.previewTimer || this.phase === 'FINALIZING') return;
    this.previewTimer = setTimeout(() => {
      this.previewTimer = undefined;
      void this.refreshPreview();
    }, 800);
    this.previewTimer.unref();
  }

  private async refreshPreview(highlight?: NonNullable<PanelState['preview']>['highlight']): Promise<void> {
    if (!this.withPreview || this.capturing) return;
    this.capturing = true;
    try {
      const shot = await this.recorder.preview();
      if (!shot) return;
      // Un cadre ne survit qu'à l'image où il a été mesuré (la page a pu bouger depuis).
      this.preview = { ...shot, ...(highlight ? { highlight } : {}) };
      this.render();
    } finally {
      this.capturing = false;
    }
  }

  async close(): Promise<void> {
    await this.detached?.close();
    await this.panel.close();
  }

  /** La progression de la finalisation (après Stop). */
  onProgress(update: ProgressUpdate): void {
    if (this.phase === 'RECORDING' || this.phase === 'PAUSED') this.phase = 'FINALIZING';
    this.endedAt ??= Date.now();
    this.progress = {
      label: update.label,
      step: Math.min(update.step, update.total),
      total: update.total,
      ...(update.detail ? { detail: update.detail } : {}),
    };
    this.render();
  }

  stopped(): void {
    this.phase = 'FINALIZING';
    this.endedAt ??= Date.now();
    this.render();
  }

  /** L'ANALYSE (onglet séparé) : intention métier, constats, suggestions — jamais dans la timeline. */
  /** running : l'analyse du conseiller tourne encore (en arrière-plan) ; les constats déterministes sont déjà là. */
  setAnalysis(
    result: RecordingResult,
    flowAudit?: FlowAuditReport,
    intelligence?: RecordingIntelligence,
    running = false,
  ): void {
    const intent = result.flow.intent;
    this.analysis = {
      available: true,
      intents: intent.workflow
        ? [
            {
              label: intent.workflow,
              ...(intent.api ? { detail: intent.api } : {}),
              confidence: intent.confidence,
              evidence: [
                ...intent.evidence,
                ...intent.transitions.map(
                  (transition) => `${transition.entity}: ${transition.from} → ${transition.to}`,
                ),
              ],
            },
          ]
        : [],
      findings: (flowAudit?.findings ?? []).map((finding) => ({
        severity: finding.severity,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        origin: finding.origin,
      })),
      aiCandidates: intelligence?.candidates.length ?? 0,
      ...(running ? { running: true } : {}),
    };
    this.render();
  }

  /**
   * LA REVUE après Stop : Rejouer → Valider → Sauvegarder. Se termine sur « Fermer », la fermeture
   * de la fenêtre, ou quand `until` se termine (tests, intégrations).
   */
  async runReview(input: {
    result: RecordingResult;
    directory: string;
    actions: ReviewActions;
    /** Lancé une fois la revue prête (ses commandes acceptées) ; la revue se termine avec lui. */
    until?: () => Promise<unknown> | undefined;
  }): Promise<unknown> {
    this.result = input.result;
    this.directory = input.directory;
    this.phase = 'REVIEW';
    this.progress = undefined;
    this.endedAt ??= Date.now();
    this.render();
    let failure: unknown;
    await new Promise<void>((resolve) => {
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        this.review = undefined;
        resolve();
      };
      this.review = async (command) => {
        if (command.type === 'finish') {
          finish();
          return;
        }
        if (this.busy) return;
        this.busy = true;
        try {
          if (command.type === 'replay') {
            this.replay = { status: 'RUNNING', executed: 0, total: 0 };
            this.render();
            this.replay = await input.actions.replay((executed, total) => {
              this.replay = { status: 'RUNNING', executed, total };
              this.render();
            });
          } else if (command.type === 'remove' && command.id) {
            // Le flow change : un rejeu fait avant ne le valide plus.
            if (await input.actions.remove(command.id)) {
              this.replay = undefined;
              this.saved = undefined;
            }
          } else if (command.type === 'save') {
            this.saved = await input.actions.save();
          }
        } finally {
          this.busy = false;
          this.render();
        }
      };
      void this.panel.closed.then(finish);
      const driven = input.until?.();
      if (driven)
        void driven.then(finish, (error: unknown) => {
          failure = error;
          finish();
        });
    });
    // L'erreur du pilote (tests, intégrations) : rendue à l'appelant, jamais avalée.
    return failure;
  }

  private async handle(command: PanelCommand): Promise<void> {
    const recording = this.phase === 'RECORDING' || this.phase === 'PAUSED';
    switch (command.type) {
      case 'pause':
        if (recording) await this.recorder.pause();
        this.phase = this.recorder.isPaused ? 'PAUSED' : this.phase;
        break;
      case 'resume':
        if (recording) await this.recorder.resume();
        if (recording) this.phase = 'RECORDING';
        break;
      case 'stop':
        if (recording) this.recorder.requestStop('overlay');
        break;
      case 'undo':
        if (recording) this.recorder.undo();
        break;
      case 'select': {
        if (!command.id) break;
        // Après l'arrêt, l'application est fermée : les détails s'affichent, sans mise en évidence.
        if (!recording) {
          this.highlight = undefined;
          break;
        }
        const live = this.liveIdOf(command.id);
        const result = live ? await this.recorder.highlight(live) : { found: 'NOT_FOUND' as const };
        this.highlight = { actionId: command.id, result: result.found };
        // L'aperçu montre le même élément, à sa position réelle (jamais un cadre deviné).
        await this.refreshPreview(
          result.rect
            ? { actionId: command.id, ...result.rect, ...(result.label ? { label: result.label } : {}) }
            : undefined,
        );
        break;
      }
      case 'resolve': {
        if (!command.id) break;
        const outcome = this.recorder.resolveAmbiguity(command.id, command.candidate ?? -1);
        this.notice =
          'error' in outcome ? { actionId: command.id, kind: 'error', message: outcome.error } : undefined;
        break;
      }
      case 'ignore':
        if (command.id) this.recorder.ignoreAmbiguity(command.id);
        break;
      case 'refresh':
        await this.refreshPreview();
        break;
      case 'detach':
        await this.detach();
        break;
      case 'attach':
        await this.attach();
        break;
      default:
        await this.review?.(command);
        return;
    }
    this.render();
  }

  /** Une étape de la revue → l'action en direct qui vient des mêmes événements bruts (mise en évidence). */
  private liveIdOf(id: string): string | undefined {
    const live = this.recorder.timeline.actions;
    if (live.some((action) => action.id === id)) return id;
    const step = this.result?.flow.steps.find((item) => item.id === id);
    return step
      ? live.find((action) => action.rawEventIds.some((raw) => step.rawEventIds.includes(raw)))?.id
      : undefined;
  }

  state(): PanelState {
    const live = this.recorder.timeline;
    const inReview = this.phase === 'REVIEW' && this.result !== undefined;
    const review =
      inReview && this.result ? reviewSteps(this.result.flow, live.actions, this.language) : undefined;
    const actions = review ? review.actions : live.actions.map((action) => liveStep(action, this.language));
    const phase = this.phase === 'RECORDING' && this.recorder.isPaused ? 'PAUSED' : this.phase;
    return {
      language: this.language,
      name: this.name,
      phase,
      startedAt: this.recorder.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      actions,
      checks: review?.checks ?? [],
      summary: review ? summaryOf(actions) : live.summary(),
      quality: live.quality(),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.highlight ? { highlight: this.highlight } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
      ...(this.replay ? { replay: this.replay } : {}),
      ...(this.saved ? { saved: this.saved } : {}),
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.detached ? { previewDetached: true } : {}),
      analysis: this.analysis,
      ...(this.directory ? { directory: this.directory } : {}),
    };
  }
}

/**
 * ✎ MODIFIER : retire une étape d'ACTION du flow (et les vérifications qui en dépendent), puis
 * régénère flow.yaml et .feature depuis le même modèle. Une vérification seule n'est jamais retirée ici.
 */
export function removeFlowStep(result: RecordingResult, stepId: string, language: 'fr' | 'en'): boolean {
  const target = result.flow.steps.find((item) => item.id === stepId);
  if (!target || target.step.kind === 'expect') return false;
  const actionIds = new Set(target.actionIds);
  result.flow.steps = result.flow.steps.filter(
    (item) =>
      item !== target && !(item.step.kind === 'expect' && item.actionIds.some((id) => actionIds.has(id))),
  );
  const hasTestData = result.testData !== undefined && Object.keys(result.testData.set.values).length > 0;
  result.files = generateFlowFiles(result.flow, {
    language,
    recordedAt: result.session.startedAt,
    ...(hasTestData ? { testDataFile: TEST_DATA_FILE } : {}),
  });
  return true;
}

/**
 * 💾 SAUVEGARDER : le brouillon (recordings/<nom>/) devient un flow de la mission, copié dans
 * `recording.flowsDirectory` (par défaut flows/ à côté des rapports) avec son jeu de données.
 */
export async function saveRecordedFlow(input: {
  config: ScenarioConfig;
  name: string;
  directory: string;
  result: RecordingResult;
  replayStatus: string;
}): Promise<{ directory: string; files: string[] }> {
  const base = slug(input.name) || 'recording';
  const root =
    input.config.recording.flowsDirectory ??
    path.join(path.dirname(path.resolve(input.config.output.reportsDir)), 'flows');
  const target = path.join(root, base);
  await mkdir(target, { recursive: true });
  const files: string[] = [];
  const format = input.config.recording.outputFormat;
  if (format !== 'gherkin') {
    await writeFile(path.join(target, `${base}.flow.yaml`), input.result.files.yaml, 'utf8');
    files.push(`${base}.flow.yaml`);
  }
  if (format !== 'yaml') {
    await writeFile(path.join(target, `${base}.feature`), input.result.files.feature, 'utf8');
    files.push(`${base}.feature`);
  }
  const hasTestData =
    input.result.testData !== undefined && Object.keys(input.result.testData.set.values).length > 0;
  if (hasTestData) {
    await copyFile(path.join(input.directory, TEST_DATA_FILE), path.join(target, TEST_DATA_FILE));
    files.push(TEST_DATA_FILE);
  }
  await writeFile(
    path.join(input.directory, 'recording-status.json'),
    `${JSON.stringify(
      {
        status: 'SAVED',
        savedAt: new Date().toISOString(),
        savedTo: target,
        files,
        replay: input.replayStatus,
      },
      null,
      2,
    )}\n`,
    'utf8',
  );
  return { directory: target, files };
}
