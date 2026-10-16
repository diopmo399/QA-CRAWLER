import { REVIEWABLE_INTENTS } from './application/human-review.js';
import type { RecordingAnalysis } from './analysis/recording-analysis.js';
import { copyFile, mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ApplicationInteractionModel } from './application/model.js';
import type { Page } from 'playwright';
import type { ScenarioConfig } from '../config/config.js';
import { slug } from '../knowledge/signatures.js';
import type { ProgressUpdate } from '../progress/progress.js';
import type { FlowAuditReport } from './flow-audit.js';
import type { DockView, HumanFlowRecorder, StepShot } from './human-flow-recorder.js';
import {
  describeFlowStep,
  summaryOf,
  reviewSteps,
  liveStep,
  type PanelAnalysis,
  type PanelReplay,
  type PanelRowEdit,
  type PanelSearch,
  type PanelState,
  type PanelStep,
  type PanelTreeNode,
} from './panel-state.js';
import { generateFlowFiles } from './recorded-flow.js';
import { BINDING_GENERATORS, dataLineage, stepDataBinding } from './test-data-binding.js';
import { RecorderPanel, type PanelCommand } from './recorder-panel.js';
import {
  describeTarget,
  proposalTarget,
  proposeCorrection,
  recordedRowCells,
  rowOfColumns,
  useOfStep,
  type CorrectionContext,
  type CorrectionProposal,
  type KnownValue,
  type PickedElement,
  type RowBinding,
  type RowColumnChoice,
} from './target-correction.js';
import { scanTableRows } from '../flows/table-row-resolver.js';
import { availableVariables } from './test-data-binding.js';
import { isSensitiveKey } from '../data/test-data-set.js';
import type { RecordingIntelligence } from './recording-intelligence.js';
import type { RecordingResult } from './process-recording.js';
import { TEST_DATA_FILE } from './process-recording.js';

/** Ce que la revue sait faire (fourni par l'orchestrateur) : rejouer, retirer une étape, sauvegarder. */
export interface ReviewActions {
  replay: (onStep: (executed: number, total: number) => void) => Promise<PanelReplay>;
  remove: (stepId: string) => Promise<boolean>;
  save: () => Promise<{ directory: string; files: string[] }>;
  /** La revue humaine d'une intention : corriger, confirmer, réinitialiser (jamais l'action elle-même). */
  reviewIntent?: (input: {
    actionId: string;
    type: 'CORRECT' | 'CONFIRM' | 'RESET';
    intent?: string;
    reason?: string;
  }) => Promise<{ ok: true } | { error: string }>;
  /** LA LIAISON DE DONNÉES d'une saisie : sa source (fixe, générée, réutilisée), choisie par l'humain. */
  bindTestData?: (input: {
    stepId: string;
    source: 'FIXED' | 'GENERATED' | 'REFERENCE';
    variable?: string;
    generator?: string;
    value?: string;
  }) => Promise<{ ok: true } | { error: string }>;
  /**
   * CORRECTION MANAGER (revue) : ouvrir la page de l'application en mode sélection et attendre l'élément
   * désigné ; remplacer la cible de l'étape par cet élément ; restaurer l'original.
   */
  pickTarget?: (
    stepId: string,
    label: string,
    onProgress: (progress: PickProgress) => void,
  ) => Promise<PickOutcome>;
  correctTarget?: (input: {
    stepId: string;
    picked: PickedElement;
    /** Les valeurs connues du run (lier une ligne de tableau à une donnée) et l'option de ligne choisie. */
    known?: readonly KnownValue[];
    option?: string;
    binding?: RowBinding;
    /** columns : la ligne par ses colonnes (une nouvelle donnée s'ajoute au jeu de test). */
    columns?: RowColumnChoice[];
  }) => Promise<{ ok: true; resumable?: number } | { error: string }>;
  /** LA LIGNE, SANS NAVIGATEUR : redéfinie colonne par colonne à partir des cellules enregistrées. */
  editRow?: (input: {
    stepId: string;
    columns: RowColumnChoice[];
  }) => Promise<{ ok: true } | { error: string }>;
  /** REPRENDRE le rejeu à l'étape corrigée, dans la page tenue (contexte restauré ou reconstruit, puis vérifié). */
  resumeReplay?: (
    onStep?: (executed: number, total: number) => void,
  ) => Promise<PanelReplay | { error: string }>;
  restoreTarget?: (stepId: string) => Promise<{ ok: true } | { error: string }>;
  /** La session de correction (la page gardée ouverte) se ferme : après Valider, Annuler ou la revue. */
  releaseCorrection?: () => Promise<void>;
}

/** La session de correction avance : étapes précédentes rejouées, puis le mode sélection ouvert dans la page. */
export interface PickProgress {
  executed: number;
  total: number;
  /** true : les étapes précédentes sont faites, l'humain peut désigner l'élément. */
  picking?: boolean;
}

/** Ce que donne une sélection : l'élément désigné, une annulation, une page indisponible, ou un chemin arrêté avant l'étape. */
export type PickOutcome =
  | { picked: PickedElement; runData?: KnownValue[] }
  | { cancelled: true }
  | { unavailable: string }
  | { unreachable: { index: number; label: string; reason: string } };

/**
 * LA CONSOLE DU RECORDER : relie la fenêtre « QA-CRAWLER Recorder » au recorder (pendant
 * l'enregistrement) puis à la revue (après Stop). Elle construit l'état affiché ; elle ne décide
 * de rien : chaque commande passe par le recorder ou par l'orchestrateur.
 */
/** Les images d'étapes gardées en mémoire (les plus anciennes s'effacent au-delà). */
const STEP_SHOTS = 60;

export class RecordingConsole {
  private phase: PanelState['phase'] = 'RECORDING';
  private progress: PanelState['progress'];
  private highlight: PanelState['highlight'];
  private notice: PanelState['notice'];
  private replay: PanelReplay | undefined;
  /** CORRECTION MANAGER : le mode sélection en cours, puis la proposition (l'élément désigné, en mémoire). */
  private pick: PanelState['pick'];
  private picked: PickedElement | undefined;
  /** Les valeurs connues du run au moment de la sélection (mémoire seule) : la proposition de ligne s'en sert. */
  private pickKnown: KnownValue[] = [];
  /** L'aperçu de la ligne choisie : combien de lignes du tableau affiché correspondent. */
  private rowPreview: PanelState['rowPreview'];
  /** La reprise possible après une correction validée dans une page tenue. */
  private resume: PanelState['resume'];
  /** Les actions de la revue en cours (la session de correction se libère hors de la file des commandes). */
  private reviewActions: ReviewActions | undefined;
  private saved: PanelState['saved'];
  private analysis: PanelAnalysis = { available: false, intents: [], findings: [], aiCandidates: 0 };
  /** Les entrées de la dernière analyse affichée : la revue d'une intention la redessine. */
  private analysisInputs:
    { flowAudit?: FlowAuditReport; intelligence?: RecordingIntelligence; running: boolean } | undefined;
  private endedAt: number | undefined;
  private result: RecordingResult | undefined;
  private directory: string | undefined;
  private review: ((command: PanelCommand) => Promise<void>) | undefined;
  private busy = false;
  private preview: PanelState['preview'];
  private previewTimer: NodeJS.Timeout | undefined;
  /**
   * L'IMAGE DE CHAQUE ÉTAPE (en mémoire seulement, jamais écrite) : l'écran juste après l'action et le
   * cadre de son élément. La revue la montre quand on choisit l'étape (l'application est alors fermée).
   */
  private readonly stepShots = new Map<string, StepShot>();
  /** L'action dont l'image attend que l'écran se pose (une saisie se termine, une page se charge). */
  private pendingShot: { id: string; timer: NodeJS.Timeout } | undefined;
  private shotChain: Promise<void> = Promise.resolve();
  private capturing = false;
  /** recording.panelPreview : l'aperçu de l'application dans la fenêtre. */
  withPreview = true;

  /** recording.panelLayout : la disposition au démarrage (complète, mini-dock dans sa fenêtre, ou dock dans la page). */
  layout: 'full' | 'compact' | 'docked' = 'full';
  /** DOCK DANS LA PAGE : la fenêtre n'est pas ouverte pendant l'enregistrement ; ouverte à la demande, puis pour la revue. */
  private panel: RecorderPanel | undefined;
  private opening: Promise<RecorderPanel | undefined> | undefined;
  /** L'étape que la fenêtre montre à son ouverture depuis le dock (« Résoudre »). */
  private focus: string | undefined;

  /** L'aperçu détaché dans sa propre fenêtre (plein écran possible). */
  private detached: RecorderPanel | undefined;
  private detaching = false;

  constructor(
    /** La fenêtre du recorder ; absente : le dock dans la page la remplace (ouverte à la demande, puis pour la revue). */
    panel: RecorderPanel | undefined,
    private readonly recorder: HumanFlowRecorder,
    private readonly name: string,
    private readonly language: 'fr' | 'en',
    /** Ouvre une fenêtre isolée (un contexte séparé du navigateur) : pour détacher l'aperçu, ou ouvrir la fenêtre à la demande. */
    private readonly openWindow?: () => Promise<Page>,
  ) {
    this.panel = panel;
    panel?.onCommand((command) => {
      void this.handle(command);
    });
    if (!panel) {
      this.layout = 'docked';
      recorder.onWindowRequest = (stepId) => {
        void this.openPanel(stepId);
      };
    }
  }

  /** La page de la fenêtre (tests, intégrations) ; absente tant que le dock dans la page la remplace. */
  get page(): Page | undefined {
    return this.panel?.page;
  }

  /** Le dock dans la page remplace la fenêtre pendant l'enregistrement. */
  get docked(): boolean {
    return this.layout === 'docked';
  }

  render(): void {
    const state = this.state();
    this.panel?.render(state);
    this.detached?.render(state);
    if (this.docked && (this.phase === 'RECORDING' || this.phase === 'PAUSED'))
      this.recorder.showDock(dockViewOf(state));
  }

  /**
   * LA FENÊTRE À LA DEMANDE (dock dans la page) : « Fenêtre » ou « Résoudre » l'ouvrent pendant
   * l'enregistrement (fermée : le dock reste) ; la revue l'ouvre toujours.
   */
  async openPanel(focus?: string): Promise<RecorderPanel | undefined> {
    if (focus) this.focus = focus;
    if (this.panel) {
      this.render();
      await this.panel.page.bringToFront().catch(() => undefined);
      return this.panel;
    }
    const open = this.openWindow;
    if (!open) return undefined;
    this.opening ??= (async () => {
      try {
        const window = await RecorderPanel.open(await open(), this.language);
        window.onCommand((command) => {
          void this.handle(command);
        });
        this.panel = window;
        void window.closed.then(() => {
          // Fermée pendant l'enregistrement : le dock reste ; en revue, « Fermer » termine (runReview).
          if (this.panel === window && this.phase !== 'REVIEW') this.panel = undefined;
        });
        this.render();
        return window;
      } catch {
        return undefined;
      } finally {
        this.opening = undefined;
      }
    })();
    return this.opening;
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
    await this.panel?.page.bringToFront().catch(() => undefined);
  }

  private httpLive: PanelState['http'];

  /** Une passe d'analyse HTTP en direct (provisoire) : seulement des compteurs dans l'en-tête. */
  httpChanged(analysis: RecordingAnalysis): void {
    const { summary } = analysis;
    this.httpLive = {
      network: summary.network,
      correlated: summary.correlated,
      hypotheses: summary.hypotheses,
      inconsistencies: summary.inconsistencies,
      pending: summary.pending,
      failed: analysis.status === 'FAILED',
      ...(liveSearchOf(analysis) ? { search: liveSearchOf(analysis) } : {}),
    };
    this.render();
  }

  /** La timeline a changé (une action, une validation) : la fenêtre, puis un nouvel aperçu de la page. */
  timelineChanged(): void {
    this.render();
    this.schedulePreview();
    this.scheduleStepShot();
  }

  /**
   * L'image de la dernière action, prise quand l'écran s'est posé (600 ms sans nouveau changement) ;
   * une nouvelle action prend aussitôt celle de la précédente si elle attendait encore.
   */
  private scheduleStepShot(): void {
    if (!this.withPreview || (this.phase !== 'RECORDING' && this.phase !== 'PAUSED')) return;
    const last = this.recorder.timeline.actions.at(-1);
    if (!last) return;
    const pending = this.pendingShot;
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingShot = undefined;
      if (pending.id !== last.id) void this.queueStepShot(pending.id);
    }
    const timer = setTimeout(() => {
      this.pendingShot = undefined;
      void this.queueStepShot(last.id);
    }, 600);
    timer.unref();
    this.pendingShot = { id: last.id, timer };
  }

  private queueStepShot(id: string): Promise<void> {
    this.shotChain = this.shotChain.then(async () => {
      const shot = await this.recorder.stepShot(id).catch(() => undefined);
      if (!shot) return;
      this.stepShots.delete(id);
      this.stepShots.set(id, shot);
      // Bornées : les plus anciennes s'effacent au-delà de STEP_SHOTS images.
      while (this.stepShots.size > STEP_SHOTS) {
        const oldest = this.stepShots.keys().next().value;
        if (oldest === undefined) break;
        this.stepShots.delete(oldest);
      }
    });
    return this.shotChain;
  }

  /** À l'arrêt, avant que l'application se ferme : l'image de la dernière action si elle attendait encore. */
  async flushStepShots(): Promise<void> {
    const pending = this.pendingShot;
    if (pending) {
      clearTimeout(pending.timer);
      this.pendingShot = undefined;
      void this.queueStepShot(pending.id);
    }
    await Promise.race([this.shotChain, new Promise((resolve) => setTimeout(resolve, 2000).unref())]);
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
    await this.panel?.close();
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
    this.analysisInputs = {
      ...(flowAudit ? { flowAudit } : {}),
      ...(intelligence ? { intelligence } : {}),
      running,
    };
    const intent = result.flow.intent;
    this.analysis = {
      available: true,
      intents: intent.workflow
        ? [
            {
              label: intent.workflow,
              ...(intent.api ? { detail: `${intent.api}${correlationOf(result)}` } : {}),
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
      ...(result.http ? { http: httpPanelOf(result.http.consolidated, result) } : {}),
      ...(result.application ? { intentReview: intentReviewOf(result, this.language) } : {}),
      ...(result.http && searchesOf(result.http.consolidated, result).length
        ? { searchIntents: searchesOf(result.http.consolidated, result) }
        : {}),
      technicalIntents: (intent.technical ?? []).map((entry) => ({
        label: `${entry.intent} · ${entry.api}`,
        detail: `${entry.classification} · ${entry.category} · ${entry.operation}`,
        evidence: [entry.reason, ...(entry.status !== undefined ? [`status ${String(entry.status)}`] : [])],
      })),
      findings: (flowAudit?.findings ?? []).map((finding) => ({
        severity: finding.severity,
        message: finding.message,
        ...(finding.suggestion ? { suggestion: finding.suggestion } : {}),
        origin: finding.origin,
      })),
      aiCandidates: intelligence?.candidates.length ?? 0,
      ...(running ? { running: true } : {}),
      ...(result.business ? { business: businessOf(result) } : {}),
      ...(result.application
        ? { application: { tree: applicationTreeOf(result), counts: result.application.summary.actions } }
        : {}),
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
    this.reviewActions = input.actions;
    this.phase = 'REVIEW';
    this.progress = undefined;
    this.endedAt ??= Date.now();
    // Le dock dans la page a remplacé la fenêtre pendant l'enregistrement : la revue l'ouvre elle-même.
    const panel = this.panel ?? (await this.openPanel());
    if (!panel) return new Error('the recorder window could not open for the review');
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
          if (command.type === 'resume-replay' && this.resume && input.actions.resumeReplay) {
            const resume = this.resume;
            this.resume = { ...resume, running: true };
            this.replay = { status: 'RUNNING', executed: 0, total: 0 };
            this.render();
            const outcome = await input.actions.resumeReplay((executed, total) => {
              this.replay = { status: 'RUNNING', executed, total };
              this.render();
            });
            // Une reprise manuelle laisse la page tenue au même endroit : « Reprendre ici » reste offert.
            this.resume =
              !('error' in outcome) && outcome.recovery?.strategy === 'MANUAL_RECOVERY'
                ? { ...resume, running: false }
                : undefined;
            if ('error' in outcome) {
              this.replay = undefined;
              this.notice = { actionId: resume.stepId, kind: 'error', message: outcome.error };
            } else this.replay = outcome;
          } else if (command.type === 'replay') {
            // Rejouer depuis le début : la page tenue n'est plus utile.
            if (this.resume) {
              this.resume = undefined;
              await input.actions.releaseCorrection?.();
            }
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
          } else if (
            command.type === 'data-bind' &&
            command.id &&
            command.source &&
            input.actions.bindTestData
          ) {
            const outcome = await input.actions.bindTestData({
              stepId: command.id,
              source: command.source,
              ...(command.variable ? { variable: command.variable } : {}),
              ...(command.generator ? { generator: command.generator } : {}),
              ...(command.value !== undefined ? { value: command.value } : {}),
            });
            // Le flow change : un rejeu fait avant ne le valide plus.
            if ('error' in outcome)
              this.notice = { actionId: command.id, kind: 'error', message: outcome.error };
            else {
              this.notice = undefined;
              this.replay = undefined;
              this.saved = undefined;
              // L'analyse se relit : les intents métier citent la variable choisie, pas une clé abandonnée.
              if (this.result && this.analysisInputs)
                this.setAnalysis(
                  this.result,
                  this.analysisInputs.flowAudit,
                  this.analysisInputs.intelligence,
                  this.analysisInputs.running,
                );
            }
          } else if (command.type === 'correct-pick' && command.id && input.actions.pickTarget) {
            const pickTarget = input.actions.pickTarget;
            const stepId = command.id;
            await this.startPick(stepId, (label) =>
              pickTarget(stepId, label, (progress) => {
                this.preparing(stepId, progress);
              }),
            );
          } else if (command.type === 'correct-apply' && command.id && input.actions.correctTarget) {
            const picked = this.picked;
            if (picked && this.pick?.stepId === command.id && this.pick.status === 'PICKED') {
              const outcome = await input.actions.correctTarget({
                stepId: command.id,
                picked,
                known: this.pickKnown,
                ...(command.option ? { option: command.option } : {}),
                ...(command.column && command.variable
                  ? { binding: { column: command.column, key: command.variable } }
                  : {}),
                ...(command.columns ? { columns: command.columns } : {}),
              });
              if ('error' in outcome)
                this.notice = { actionId: command.id, kind: 'error', message: outcome.error };
              else {
                this.notice = undefined;
                this.pick = undefined;
                this.picked = undefined;
                this.rowPreview = undefined;
                // Le flow change : un rejeu fait avant ne le valide plus.
                this.replay = undefined;
                this.saved = undefined;
                const step = this.state().actions.find((entry) => entry.id === command.id);
                if (outcome.resumable !== undefined && input.actions.resumeReplay)
                  // La page tenue est devant l'étape corrigée : « Reprendre ici » garde le contexte.
                  this.resume = {
                    stepId: command.id,
                    // Le numéro que montre le parcours (la position du flow compte les vérifications ajoutées).
                    index: step?.index ?? outcome.resumable,
                    description: step?.description ?? `#${String(outcome.resumable)}`,
                  };
                // Sinon la session (navigateur, fin de mission) se ferme en arrière-plan, sans bloquer la revue.
                else void input.actions.releaseCorrection?.();
              }
            }
          } else if (command.type === 'row-edit' && command.id && command.columns && input.actions.editRow) {
            const outcome = await input.actions.editRow({ stepId: command.id, columns: command.columns });
            if ('error' in outcome)
              this.notice = { actionId: command.id, kind: 'error', message: outcome.error };
            else {
              this.notice = undefined;
              this.rowPreview = undefined;
              // Le flow change : un rejeu fait avant ne le valide plus.
              this.replay = undefined;
              this.saved = undefined;
            }
          } else if (command.type === 'correct-restore' && command.id && input.actions.restoreTarget) {
            const outcome = await input.actions.restoreTarget(command.id);
            if ('error' in outcome)
              this.notice = { actionId: command.id, kind: 'error', message: outcome.error };
            else {
              this.notice = undefined;
              this.replay = undefined;
              this.saved = undefined;
            }
          } else if (
            (command.type === 'intent-correct' ||
              command.type === 'intent-confirm' ||
              command.type === 'intent-reset') &&
            command.id &&
            input.actions.reviewIntent
          ) {
            const outcome = await input.actions.reviewIntent({
              actionId: command.id,
              type:
                command.type === 'intent-correct'
                  ? 'CORRECT'
                  : command.type === 'intent-confirm'
                    ? 'CONFIRM'
                    : 'RESET',
              ...(command.intent ? { intent: command.intent } : {}),
              ...(command.reason ? { reason: command.reason } : {}),
            });
            this.notice =
              'error' in outcome
                ? { actionId: command.id, kind: 'error', message: outcome.error }
                : undefined;
            // L'analyse se relit dans le modèle revu (l'intention finale, sa provenance, l'historique).
            if (this.result && this.analysisInputs)
              this.setAnalysis(
                this.result,
                this.analysisInputs.flowAudit,
                this.analysisInputs.intelligence,
                this.analysisInputs.running,
              );
          }
        } finally {
          this.busy = false;
          this.render();
        }
      };
      void panel.closed.then(finish);
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
        // Après l'arrêt, l'application est fermée : l'aperçu montre l'image de l'étape, prise pendant
        // l'enregistrement (l'écran juste après l'action, son élément encadré s'il était visible).
        if (!recording) {
          this.highlight = undefined;
          const live = this.liveIdOf(command.id);
          const shot = live ? this.stepShots.get(live) : undefined;
          if (shot)
            this.preview = {
              image: shot.image,
              url: shot.url,
              width: shot.width,
              height: shot.height,
              step: command.id,
              ...(shot.rect
                ? {
                    highlight: {
                      actionId: command.id,
                      ...shot.rect,
                      ...(shot.label ? { label: shot.label } : {}),
                    },
                  }
                : {}),
            };
          else if (this.preview) this.preview = { ...this.preview, step: command.id, missing: true };
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
      // CORRECTION MANAGER : quitter le mode sélection vaut dans les deux phases (même pendant l'attente de la revue).
      case 'row-preview':
        if (command.id && command.columns)
          this.rowPreview = await this.previewRow(command.id, command.columns);
        break;
      case 'correct-cancel':
        this.recorder.cancelPick();
        this.pick = undefined;
        this.picked = undefined;
        this.rowPreview = undefined;
        this.resume = undefined;
        if (!recording) await this.reviewActions?.releaseCorrection?.();
        break;
      case 'correct-test': {
        const picked = this.picked;
        if (!picked) break;
        const shown = await this.recorder.highlightPicked(picked);
        await this.refreshPreview(
          shown.rect && this.pick
            ? { actionId: this.pick.stepId, ...shown.rect, ...(shown.label ? { label: shown.label } : {}) }
            : undefined,
        );
        break;
      }
      case 'correct-pick':
        if (!command.id) break;
        if (!recording) {
          await this.review?.(command);
          return;
        }
        await this.startPick(command.id, async (label) => {
          if (!this.recorder.correctionPage) return { unavailable: 'no page' };
          const picked = await this.recorder.pickTarget(label);
          return picked ? { picked } : { cancelled: true };
        });
        break;
      case 'correct-apply': {
        if (!command.id) break;
        if (!recording) {
          await this.review?.(command);
          return;
        }
        const picked = this.picked;
        if (!picked || this.pick?.stepId !== command.id || this.pick.status !== 'PICKED') break;
        const outcome = this.recorder.correctTarget(
          command.id,
          picked,
          { known: this.pickKnown },
          command.option,
          command.column && command.variable ? { column: command.column, key: command.variable } : undefined,
          command.columns,
        );
        this.notice =
          'error' in outcome ? { actionId: command.id, kind: 'error', message: outcome.error } : undefined;
        if (!('error' in outcome)) {
          this.pick = undefined;
          this.picked = undefined;
        }
        break;
      }
      case 'correct-restore':
        if (!command.id) break;
        if (!recording) {
          await this.review?.(command);
          return;
        }
        this.recorder.restoreTarget(command.id);
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

  /**
   * MODE SÉLECTION : la fenêtre dit « Mode sélection actif », la page encadre l'élément survolé ; au clic,
   * la proposition (nouvelle cible, replis, ordre de résolution) s'affiche à côté de l'ancienne cible.
   */
  /** Les étapes précédentes se rejouent (session de correction) : la fenêtre montre la progression. */
  private preparing(stepId: string, progress: PickProgress): void {
    const current = this.pick;
    if (!current || current.stepId !== stepId) return;
    if (current.status !== 'PICKING' && current.status !== 'PREPARING') return;
    this.pick = progress.picking
      ? { ...current, status: 'PICKING' }
      : { ...current, status: 'PREPARING', progress: { executed: progress.executed, total: progress.total } };
    this.render();
  }

  private async startPick(stepId: string, picker: (label: string) => Promise<PickOutcome>): Promise<void> {
    const step = this.state().actions.find((entry) => entry.id === stepId);
    if (!step) return;
    const label = step.technical.name ?? step.technical.label ?? step.technical.text ?? step.description;
    const previous = step.correction?.current ?? step.technical.target;
    // En revue, la session de correction rejoue d'abord les étapes précédentes (le navigateur s'ouvre).
    const review = this.phase === 'REVIEW';
    this.pick = {
      stepId,
      status: review ? 'PREPARING' : 'PICKING',
      label,
      ...(previous ? { previous } : {}),
      ...(review ? { progress: { executed: 0, total: 0 } } : {}),
    };
    this.picked = undefined;
    this.render();
    const outcome = await picker(label);
    // Une autre commande a quitté le mode sélection pendant l'attente : rien à proposer.
    if (!this.isPicking(stepId)) return;
    if (!('picked' in outcome)) {
      this.pick = {
        stepId,
        status:
          'cancelled' in outcome ? 'CANCELLED' : 'unreachable' in outcome ? 'UNREACHABLE' : 'UNAVAILABLE',
        label,
        ...(previous ? { previous } : {}),
        ...('unreachable' in outcome ? { stoppedAt: outcome.unreachable } : {}),
        ...('unavailable' in outcome ? { reason: outcome.unavailable } : {}),
      };
      this.render();
      return;
    }
    const picked = outcome.picked;
    // Les valeurs connues du run : produites par la session de correction (revue), saisies (enregistrement),
    // et celles du jeu de données des étapes précédentes — pour lier une ligne de tableau à une donnée.
    this.pickKnown = [...(outcome.runData ?? []), ...this.knownValues(stepId, review)];
    const context: CorrectionContext = { known: this.pickKnown, ...this.previousTargetOf(stepId, review) };
    const proposal = proposeCorrection(
      picked.element,
      useOfStep(step.kind),
      this.language,
      context,
      picked.rowCells ?? [],
    );
    this.picked = picked;
    this.pick = {
      stepId,
      status: 'PICKED',
      label,
      ...(previous ? { previous } : {}),
      proposal: panelProposalOf(proposal, review && this.result?.testData !== undefined),
    };
    this.render();
    // L'aperçu se rafraîchit SANS retenir la revue : « Valider » cliqué aussitôt la proposition affichée
    // est accepté (une commande reçue pendant que la revue est occupée serait abandonnée).
    void this.refreshPreview(
      picked.rect ? { actionId: stepId, ...picked.rect, label: proposal.label } : undefined,
    );
  }

  /** Les valeurs connues hors session : le jeu de données (revue, clés non sensibles) ou les saisies (enregistrement). */
  private knownValues(stepId: string, review: boolean): KnownValue[] {
    if (!review) return this.recorder.knownValues();
    const result = this.result;
    if (!result?.testData) return [];
    const set = result.testData.set;
    return availableVariables(result, stepId)
      .map((variable) => ({ key: variable.key, value: set.values[variable.key]?.value ?? '' }))
      .filter((entry) => entry.value.trim() !== '');
  }

  /** REVUE : la ligne d'une étape, modifiable sans navigateur (sa cible vise une ligne, ses cellules sont connues). */
  private rowEditOf(result: RecordingResult, stepId: string): PanelRowEdit | undefined {
    const item = result.flow.steps.find((entry) => entry.id === stepId);
    const row = item && 'target' in item.step ? item.step.target.row : undefined;
    if (!item || !row) return undefined;
    const cells = recordedRowCells(result.session.rawEvents, item.rawEventIds);
    if (cells.length === 0) return undefined;
    return {
      cells,
      variables: rowVariables(result, stepId),
      current: { ...row },
      canCreate: result.testData !== undefined,
    };
  }

  /**
   * Les cellules de la ligne et les données du run d'une étape : celles de l'élément désigné (mode
   * sélection), sinon celles enregistrées avec l'action (revue, sans navigateur).
   */
  private rowSource(stepId: string): {
    cells: { column: string; value: string }[];
    variables: { key: string; value: string }[];
  } {
    const keyed = (known: readonly KnownValue[]): { key: string; value: string }[] =>
      known
        .filter((entry): entry is { key: string; value: string } => entry.key !== undefined)
        .filter((entry, index, all) => all.findIndex((other) => other.key === entry.key) === index);
    if (this.picked && this.pick?.stepId === stepId)
      return { cells: this.picked.rowCells ?? [], variables: keyed(this.pickKnown) };
    const item = this.result?.flow.steps.find((entry) => entry.id === stepId);
    if (this.phase !== 'REVIEW' || !item || !this.result) return { cells: [], variables: [] };
    return {
      cells: recordedRowCells(this.result.session.rawEvents, item.rawEventIds),
      variables: rowVariables(this.result, stepId),
    };
  }

  /**
   * L'APERÇU DE LA LIGNE : les colonnes choisies (les données du run remplacées par leur valeur actuelle)
   * sont cherchées dans le tableau de la page ouverte — combien de lignes correspondent. Rien n'est cliqué.
   */
  private async previewRow(
    stepId: string,
    columns: readonly RowColumnChoice[],
  ): Promise<NonNullable<PanelState['rowPreview']>> {
    const { cells, variables } = this.rowSource(stepId);
    const outcome = rowOfColumns(cells, variables, columns, { taken: [] });
    if ('error' in outcome) return { stepId, status: 'INVALID', message: outcome.error };
    const values = new Map([
      ...variables.map((entry) => [entry.key, entry.value] as const),
      ...outcome.created.map((entry) => [entry.key, entry.value] as const),
    ]);
    const page = this.recorder.correctionPage;
    if (!page) return { stepId, status: 'UNAVAILABLE' };
    // Une donnée générée au rejeu n'a pas encore de valeur : rien à chercher dans la page.
    const unknown = columns.find(
      (choice) => choice.source === 'variable' && !values.get(choice.key ?? '')?.trim(),
    );
    if (unknown)
      return {
        stepId,
        status: 'INVALID',
        message:
          this.language === 'fr'
            ? `« ${unknown.key ?? ''} » n'a pas de valeur avant le rejeu : aperçu impossible.`
            : `"${unknown.key ?? ''}" has no value before the replay: no preview.`,
      };
    const criteria = Object.fromEntries(
      Object.entries(outcome.row).map(([column, value]) => [
        column,
        value.replace(/\$\{testData:([^}]+)\}/g, (_, key: string) => values.get(key) ?? ''),
      ]),
    );
    try {
      const scan = await scanTableRows(page, criteria, 'unique', `preview-${String(Date.now())}`);
      return scan.status === 'NONE'
        ? { stepId, status: 'NONE', matches: 0 }
        : { stepId, status: scan.status, matches: scan.matches };
    } catch {
      return { stepId, status: 'UNAVAILABLE' };
    }
  }

  /** L'ancienne cible de l'étape (structurée) : une clé de ligne propre au run se reconnaît par elle. */
  private previousTargetOf(stepId: string, review: boolean): Pick<CorrectionContext, 'previous'> {
    const previous = review ? this.result?.flow.steps.find((item) => item.id === stepId)?.step : undefined;
    const target = review
      ? previous && 'target' in previous
        ? previous.target
        : undefined
      : this.recorder.currentTarget(stepId);
    return target ? { previous: target } : {};
  }

  /** Le mode sélection attend encore pour cette étape (une autre commande peut l'avoir quitté entre-temps). */
  private isPicking(stepId: string): boolean {
    const current: PanelState['pick'] = this.pick;
    return (
      current !== undefined &&
      current.stepId === stepId &&
      (current.status === 'PICKING' || current.status === 'PREPARING')
    );
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
    const actions = enrichSteps(
      review ? review.actions : live.actions.map((action) => liveStep(action, this.language)),
      {
        // Les événements bruts de chaque étape : ceux du flow (revue) ou de l'action en direct.
        rawIds: (step) =>
          (review
            ? this.result?.flow.steps.find((item) => item.id === step.id)?.rawEventIds
            : live.actions.find((action) => action.id === step.id)?.rawEventIds) ?? [],
        analysis: review ? this.result?.http?.consolidated : this.recorder.lastLiveAnalysis(),
        ...(review && this.result ? { business: this.result.business?.model.steps } : {}),
      },
    );
    // LIAISON DES DONNÉES (revue) : la source de la valeur de chaque saisie et la lignée des variables.
    const result = review ? this.result : undefined;
    const steps = result
      ? actions.map((step) => {
          const binding = stepDataBinding(result, step.id);
          const rowEdit = this.rowEditOf(result, step.id);
          if (rowEdit) step = { ...step, rowEdit };
          return binding
            ? {
                ...step,
                data: {
                  ...binding,
                  options: binding.options.map((option) => ({
                    key: option.key,
                    stepIndex: option.stepIndex,
                    label: option.label,
                  })),
                  generators: [...BINDING_GENERATORS],
                },
              }
            : step;
        })
      : actions;
    const analysis: PanelAnalysis = result
      ? {
          ...this.analysis,
          dataLineage: dataLineage(result).map((entry) => ({
            key: entry.key,
            strategy: entry.strategy,
            ...(entry.generator ? { generator: entry.generator } : {}),
            ...(entry.producedBy
              ? { producedBy: `${String(entry.producedBy.stepIndex)} — ${entry.producedBy.label}` }
              : {}),
            uses: entry.usedBy.map(
              (use) =>
                `${String(use.stepIndex)} — ${use.label}${use.how === 'CITATION' ? (this.language === 'fr' ? ' (citée)' : ' (cited)') : ''}`,
            ),
          })),
        }
      : this.analysis;
    const phase = this.phase === 'RECORDING' && this.recorder.isPaused ? 'PAUSED' : this.phase;
    return {
      language: this.language,
      name: this.name,
      phase,
      startedAt: this.recorder.startedAt,
      ...(this.endedAt !== undefined ? { endedAt: this.endedAt } : {}),
      actions: steps,
      checks: review?.checks ?? [],
      summary: review ? summaryOf(steps) : live.summary(),
      quality: live.quality(),
      ...(this.progress ? { progress: this.progress } : {}),
      ...(this.highlight ? { highlight: this.highlight } : {}),
      ...(this.notice ? { notice: this.notice } : {}),
      ...(this.replay ? { replay: this.replay } : {}),
      ...(this.pick ? { pick: this.pick } : {}),
      ...(this.rowPreview ? { rowPreview: this.rowPreview } : {}),
      ...(this.saved ? { saved: this.saved } : {}),
      ...(this.preview ? { preview: this.preview } : {}),
      ...(this.detached ? { previewDetached: true } : {}),
      analysis,
      ...(this.httpLive ? { http: this.httpLive } : {}),
      ...(this.directory ? { directory: this.directory } : {}),
      // Le cockpit s'ouvre complet quand le dock dans la page a demandé la fenêtre.
      layout: this.layout === 'docked' ? 'full' : this.layout,
      ...(this.focus ? { focus: this.focus } : {}),
      ...(this.resume ? { resume: this.resume } : {}),
    };
  }
}

/** Ce que le dock dans la page montre : les trois dernières actions et les compteurs (jamais une valeur saisie). */
function dockViewOf(state: PanelState): DockView {
  return {
    steps: state.actions.slice(-3).map((step) => ({
      id: step.id,
      index: step.index,
      kind: step.kind,
      description: step.description,
      status: step.status,
    })),
    counts: {
      actions: state.summary.actions,
      confirmed: state.summary.confirmed,
      ambiguous: state.summary.ambiguous,
      failed: state.summary.failed,
    },
  };
}

/**
 * Les étapes enrichies pour la fenêtre : leur GROUPE (l'étape métier en revue, l'écran en direct) et
 * les REQUÊTES reliées (critères, tri, pagination) — lus dans l'analyse, jamais une valeur saisie.
 */
function enrichSteps(
  steps: PanelStep[],
  context: {
    rawIds: (step: PanelStep) => readonly string[];
    analysis: RecordingAnalysis | undefined;
    business?: readonly {
      action: string;
      entity?: string;
      entityKey?: string;
      recordedActions: readonly string[];
    }[];
  },
): PanelStep[] {
  const groupOf = (step: PanelStep): string | undefined => {
    const owner = context.business?.find((entry) => entry.recordedActions.includes(step.id));
    if (owner)
      return `${owner.action.toLowerCase()} ${owner.entity ?? owner.entityKey?.split(':').at(-2) ?? ''}`.trim();
    if (context.business) return undefined;
    return step.technical.page;
  };
  return steps.map((step) => {
    const group = groupOf(step);
    const raw = new Set(context.rawIds(step));
    const linked: { networkIds: string[]; kind: string; confidence: number }[] = (
      context.analysis?.correlations ?? []
    ).filter((correlation) => raw.has(correlation.actionId));
    // Une SAISIE dont la valeur est envoyée comme critère : la requête de la recherche lui est reliée aussi.
    for (const business of context.analysis?.business ?? [])
      for (const criterion of business.searchCriteria)
        if (
          criterion.ui &&
          raw.has(criterion.ui.actionId) &&
          !linked.some((link) => link.networkIds.includes(business.networkId))
        )
          linked.push({
            networkIds: [business.networkId],
            kind: 'VALUE_SENT',
            confidence: criterion.confidence,
          });
    const network = linked.flatMap((correlation) =>
      correlation.networkIds.flatMap((networkId) => {
        const business = context.analysis?.business.find((entry) => entry.networkId === networkId);
        if (!business || business.operation === 'TECHNICAL') return [];
        const logic = business.searchCriteria.find((criterion) => criterion.logicalGroup)?.logicalGroup
          ?.operator;
        return [
          {
            api: business.api,
            ...(business.result?.status !== undefined ? { status: business.result.status } : {}),
            operation: business.operation,
            link: `${correlation.kind} · ${String(Math.round(correlation.confidence * 100))} %`,
            criteria: business.searchCriteria.map(
              (criterion) =>
                `${criterion.ui ? `"${criterion.ui.label}" → ` : ''}${criterion.propertyName}${criterion.operator ? ` ${criterion.operator}` : ''}${logic ? ` · ${logic}` : ''}`,
            ),
            extras: [
              ...business.sort.map(
                (sort) => `sort ${sort.property ?? sort.path} ${sort.direction.toUpperCase()}`,
              ),
              ...(business.pagination
                ? [
                    `page ${String(business.pagination.index?.value ?? 0)} / ${String(business.pagination.size?.value ?? '?')}`,
                  ]
                : []),
              ...business.options.map((option) => `option ${option.replace(/^\?/, '')}`),
            ],
          },
        ];
      }),
    );
    return {
      ...step,
      ...(group ? { group } : {}),
      ...(network.length ? { network } : {}),
    };
  });
}

/**
 * ✎ MODIFIER : retire une étape d'ACTION du flow (et les vérifications qui en dépendent), puis
 * régénère flow.yaml et .feature depuis le même modèle. Une vérification seule n'est jamais retirée ici.
 */
/** La proposition de correction, telle que la fenêtre la montre (des mots, jamais une valeur saisie). */
function panelProposalOf(
  proposal: CorrectionProposal,
  canCreate = false,
): NonNullable<PanelState['pick']>['proposal'] {
  return {
    target: describeTarget(proposal.target),
    ...(proposal.target.row ? { row: proposal.target.row } : {}),
    ...(canCreate && proposal.rowCells ? { canCreate: true } : {}),
    ...(proposal.rowOptions && proposal.rowOptions.length > 0
      ? {
          rowOptions: proposal.rowOptions.map((option) => ({
            id: option.id,
            target: describeTarget(proposalTarget(proposal, option.id)),
            row: Object.entries(option.row)
              .map(([column, value]) => `${column} = ${value}`)
              .join(', '),
            ...(option.via ? { via: option.via } : {}),
            ...(option.match ? { match: option.match } : {}),
            ...(option.fixed ? { fixed: true } : {}),
          })),
        }
      : {}),
    ...(proposal.rowCells ? { rowCells: proposal.rowCells } : {}),
    ...(proposal.rowCells ? { baseTarget: describeTarget(withoutRow(proposal.target)) } : {}),
    ...(proposal.variables ? { variables: proposal.variables } : {}),
    quality: proposal.quality,
    label: proposal.label,
    order: proposal.order,
    alternatives: proposal.alternatives.map((target) => describeTarget(target)),
    ambiguous: proposal.ambiguous,
    traits: proposal.traits,
  };
}

/** Une cible sans sa ligne de tableau (la liaison manuelle de la fenêtre y ajoute la sienne). */
function withoutRow(target: CorrectionProposal['target']): CorrectionProposal['target'] {
  const { row: _row, ...rest } = target;
  return rest;
}

/** Les fichiers du flow (YAML, .feature) régénérés après un changement du flow en revue. */
/**
 * Les données du run qu'une ligne peut citer avant cette étape (jamais une donnée sensible) ; la valeur
 * est vide pour une donnée générée au rejeu (elle n'existe qu'au rejeu).
 */
export function rowVariables(result: RecordingResult, stepId: string): { key: string; value: string }[] {
  const set = result.testData?.set;
  if (!set) return [];
  return availableVariables(result, stepId)
    .filter((variable) => !isSensitiveKey(variable.key))
    .map((variable) => ({ key: variable.key, value: set.values[variable.key]?.value ?? '' }));
}

export function regenerateFlowFiles(result: RecordingResult, language: 'fr' | 'en'): void {
  const hasTestData = result.testData !== undefined && Object.keys(result.testData.set.values).length > 0;
  result.files = generateFlowFiles(result.flow, {
    language,
    recordedAt: result.session.startedAt,
    ...(hasTestData ? { testDataFile: TEST_DATA_FILE } : {}),
  });
}

export function removeFlowStep(result: RecordingResult, stepId: string, language: 'fr' | 'en'): boolean {
  const target = result.flow.steps.find((item) => item.id === stepId);
  if (!target || target.step.kind === 'expect') return false;
  const actionIds = new Set(target.actionIds);
  result.flow.steps = result.flow.steps.filter(
    (item) =>
      item !== target && !(item.step.kind === 'expect' && item.actionIds.some((id) => actionIds.has(id))),
  );
  regenerateFlowFiles(result, language);
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

/** Le flow métier, dit pour la fenêtre : chaque étape, ses actions enregistrées, l'observé et le déduit. */
function businessOf(result: RecordingResult): NonNullable<PanelAnalysis['business']> {
  const model = result.business?.model;
  const labels = new Map(
    result.flow.steps.map((step, index) => [step.id, `${String(index + 1)}. ${step.label}`]),
  );
  const recorded = (ids: readonly string[]): string[] => ids.map((id) => labels.get(id) ?? id);
  return {
    steps: (model?.steps ?? []).map((step) => ({
      action: step.action,
      entity: step.entity ?? step.entityKey?.split(':').at(-1) ?? '?',
      ...(step.provenance ? { provenance: step.provenance } : {}),
      status: step.status,
      confidence: step.confidence,
      ...(step.outputs ? { output: step.outputs.id } : {}),
      ...(step.outputs?.value !== undefined ? { outputValue: step.outputs.value } : {}),
      ...(step.reference ? { reference: step.reference } : {}),
      recorded: recorded(step.recordedActions),
      observed: [...step.evidence.network, ...step.evidence.dom, ...step.evidence.navigation],
      deduced: step.evidence.context,
      ai: step.analyzer === 'AI_PROPOSAL',
    })),
    unresolved: (model?.unresolved ?? []).map((event) => ({
      type: event.type,
      status: event.status,
      ...(event.candidates ? { candidates: event.candidates } : {}),
      recorded: recorded(event.stepIds),
    })),
    // Seules les entités MÉTIER démontrées : les observations (UNKNOWN, technique) restent dans
    // l'arbre de l'application, jamais présentées comme métier.
    entities: (model?.entities ?? []).flatMap((entity) =>
      entity.key && entity.provenance && entity.type === 'business_entity'
        ? [
            {
              key: entity.key,
              name: entity.name,
              ...(entity.identity?.value !== undefined ? { identity: entity.identity.value } : {}),
              provenance: entity.provenance.classification,
              confidence: entity.provenance.confidence,
              reason: entity.provenance.reason,
              lifecycle: (entity.lifecycle ?? []).map((step) => step.kind),
              ...(entity.provenance.contradictions
                ? { contradictions: entity.provenance.contradictions }
                : {}),
            },
          ]
        : [],
    ),
  };
}

/**
 * Un intent métier n'est qu'une ÉCRITURE OBSERVÉE tant que la couche métier ne l'a pas corrélée :
 * un CREATE:… sans ENTITY_CREATED prouvé reste « création non prouvée ».
 */
function correlationOf(result: RecordingResult): string {
  const workflow = result.flow.intent.workflow;
  const model = result.business?.model;
  if (!workflow?.startsWith('CREATE:') || !model) return '';
  return model.steps.some((step) => step.action === 'create')
    ? ' · creation proven (ENTITY_CREATED)'
    : ' · write observed, creation NOT proven (no converging evidence: at most a POSSIBLE_CREATE)';
}

/**
 * L'arbre de l'application pour la fenêtre : Workspace → Task → contexte ouvert → entité → actions
 * métier ; les entités sans task à la racine. Chaque nœud garde son statut, ses preuves et les
 * actions enregistrées (les actions techniques restent accessibles dans le parcours).
 */
function applicationTreeOf(result: RecordingResult): PanelTreeNode[] {
  const model = result.application;
  if (!model) return [];
  const labels = new Map(
    result.flow.steps.map((step, index) => [step.id, `${String(index + 1)}. ${step.label}`]),
  );
  const stepOfAction = (id: string): string | undefined =>
    result.flow.steps.find((step) => step.actionIds.includes(id))?.id;
  const recorded = (actionIds: readonly string[]): string[] => [
    ...new Set(actionIds.map((id) => labels.get(stepOfAction(id) ?? '') ?? id)),
  ];
  const evidenceText = (ids: readonly string[]): string[] =>
    ids.map((id) => model.evidence.find((entry) => entry.id === id)?.description ?? id).slice(0, 8);
  const contextName = (key: string): string =>
    model.contexts.find((context) => context.key === key)?.name ?? key;
  const actionNode = (action: ApplicationInteractionModel['businessActions'][number]): PanelTreeNode => ({
    label: action.kind,
    detail: action.reason,
    status: action.status,
    confidence: action.confidence,
    evidence: evidenceText(action.evidenceIds),
    recorded: recorded(action.actionIds),
    children: [],
  });
  const entityNode = (
    key: string,
    via?: ApplicationInteractionModel['relationships'][number],
  ): PanelTreeNode => {
    const entity = model.entities.find((entry) => entry.key === key);
    const identity = entity?.identity;
    return {
      label: `${entity?.type ?? 'entity'} ${identity?.value ?? key.split(':').at(-1) ?? ''}`,
      detail: [
        entity ? entity.classification.classification : '',
        identity ? `${identity.type}${identity.field ? ` (${identity.field})` : ''}` : '',
        entity ? `provenance ${entity.provenance.classification}` : '',
        via ? `${via.type}: ${via.reason}` : '',
      ]
        .filter(Boolean)
        .join(' · '),
      ...(via ? { status: via.status, confidence: via.confidence } : {}),
      evidence: evidenceText(via?.evidenceIds ?? []),
      recorded: [],
      children: [
        ...model.businessActions
          .filter((action) => action.subject === key && action.kind !== 'SWITCH_CONTEXT')
          .map(actionNode),
        // Retrouvée par ses données métier (EntityCorrelation) : la preuve, et l'identité découverte.
        ...model.relationships
          .filter((relation) => relation.type === 'SEARCH_MATCH' && relation.source === key)
          .map((relation) => ({
            label: 'SEARCH_MATCH',
            detail: relation.reason,
            status: relation.status,
            confidence: relation.confidence,
            evidence: evidenceText(relation.evidenceIds),
            recorded: recorded(relation.actionIds),
            children: [],
          })),
      ],
    };
  };
  const placed = new Set<string>();
  const isBusiness = (key: string): boolean =>
    model.entities.some(
      (entity) => entity.key === key && entity.classification.classification === 'BUSINESS_ENTITY',
    );
  const workspaces: PanelTreeNode[] = model.workspaces.map((workspace) => ({
    label: `TASK WORKSPACE · ${workspace.source.type === 'NETWORK' ? workspace.collectionKey.replace(/^collection:/, '') : 'DOM'}`,
    detail: [
      workspace.reason,
      workspace.source.type === 'NETWORK' && workspace.source.bffCandidate
        ? `BFF candidate: ${workspace.source.bffCandidate.reasons.join('; ')}`
        : '',
    ]
      .filter(Boolean)
      .join(' · '),
    status: workspace.status,
    confidence: workspace.confidence,
    evidence: evidenceText(workspace.evidenceIds),
    recorded: [],
    children: workspace.taskKeys.flatMap((taskKey) => {
      const task = model.tasks.find((entry) => entry.key === taskKey);
      if (!task) return [];
      const own = model.relationships.filter(
        (relation) => relation.source === taskKey || relation.target === taskKey,
      );
      const entityLinks = own.filter(
        (relation) =>
          (relation.type === 'REFERENCES' ||
            relation.type === 'RESULTS_IN' ||
            relation.type === 'CREATE_RESULT') &&
          [relation.source, relation.target].some((key) => key.startsWith('entity:')),
      );
      const entityKeys = [
        ...new Set(
          entityLinks.map((relation) =>
            relation.source.startsWith('entity:') ? relation.source : relation.target,
          ),
        ),
        // OBSERVED ≠ BUSINESS : sous une task, seulement une entité MÉTIER démontrée ; une entité
        // UNKNOWN qu'elle référence reste dans les observations.
      ].filter(isBusiness);
      for (const key of entityKeys) placed.add(key);
      const opened = own.filter((relation) => relation.type === 'NAVIGATES_TO');
      const entities = entityKeys.map((key) =>
        entityNode(
          key,
          entityLinks.find((relation) => relation.source === key || relation.target === key),
        ),
      );
      return [
        {
          label: `Task #${task.primary.value ?? '?'}`,
          detail: task.identityCandidates
            .map((candidate) => `${candidate.type} ${candidate.field ?? ''}=${candidate.value ?? '(digest)'}`)
            .join(' · '),
          status: task.status,
          confidence: task.confidence,
          evidence: evidenceText(task.evidenceIds),
          recorded: recorded(task.selectedBy),
          children: opened.length
            ? opened.map((relation) => ({
                label: `MFE ${contextName(relation.target)}`,
                detail: relation.reason,
                status: relation.status,
                confidence: relation.confidence,
                evidence: evidenceText(relation.evidenceIds),
                recorded: recorded(relation.actionIds),
                children: entities,
              }))
            : entities,
        },
      ];
    }),
  }));
  // TROIS NIVEAUX : APPLICATION CONTEXT (workspace → task → MFE), BUSINESS CONTEXT (seulement des
  // entités métier démontrées), TECHNICAL CONTEXT (des preuves, jamais le flow métier). Les
  // observations non classées (UNKNOWN) sont gardées à part : jamais présentées comme métier.
  const tree: PanelTreeNode[] = [];
  if (workspaces.length)
    tree.push({
      label: 'APPLICATION CONTEXT',
      detail: 'task workspaces, tasks and the application contexts (micro-frontends) they open',
      evidence: [],
      recorded: [],
      children: workspaces,
    });
  const loose = model.entities.filter(
    (entity) => !placed.has(entity.key) && entity.classification.classification === 'BUSINESS_ENTITY',
  );
  if (loose.length)
    tree.push({
      label: 'BUSINESS CONTEXT',
      detail: 'business entities demonstrated by converging functional evidence',
      evidence: [],
      recorded: [],
      children: loose.map((entity) => entityNode(entity.key)),
    });
  const observed = model.entities.filter(
    (entity) => entity.classification.classification !== 'BUSINESS_ENTITY',
  );
  if (observed.length)
    tree.push({
      label: 'OBSERVED · NOT CLASSIFIED',
      detail: `${String(observed.length)} observation(s) kept with their evidence: no business role demonstrated (UNKNOWN), never a business entity`,
      evidence: [],
      recorded: [],
      children: observed.map((entity) =>
        entityNode(
          entity.key,
          model.relationships.find(
            (relation) =>
              relation.type === 'REFERENCES' &&
              (relation.source === entity.key || relation.target === entity.key),
          ),
        ),
      ),
    });
  // TECHNICAL CONTEXT : des observations, jamais des étapes métier (OIDC, configuration, statique…).
  const items = model.technicalContext.items;
  if (items.length) {
    const categories = [...new Set(items.map((item) => item.category))];
    tree.push({
      label: 'TECHNICAL CONTEXT',
      detail: `${String(items.length)} technical / infrastructure observation(s), kept as evidence, outside the business flow`,
      evidence: [],
      recorded: [],
      children: categories.map((category) => ({
        label: category,
        evidence: [],
        recorded: [],
        children: items
          .filter((item) => item.category === category)
          .map((item) => ({
            label: `${item.operation ? `${item.operation} · ` : ''}${item.label}`,
            detail: [item.classification, item.intent ? `TECHNICAL_INTENT ${item.intent}` : '', item.reason]
              .filter(Boolean)
              .join(' · '),
            status: item.confidence >= 0.85 ? ('CONFIRMED' as const) : ('DEDUCED' as const),
            confidence: item.confidence,
            evidence: evidenceText(item.evidenceIds),
            recorded: recorded(item.actionIds),
            children: [],
          })),
      })),
    });
  }
  return tree;
}

/** L'analyse HTTP consolidée, pour la fenêtre : ce qui est validé n'est jamais mélangé aux hypothèses. */
/** La revue des intentions : chaque action du modèle, son intention finale et sa provenance. */
function intentReviewOf(
  result: RecordingResult,
  language: 'fr' | 'en',
): NonNullable<PanelAnalysis['intentReview']> {
  // L'action telle qu'un humain la dit (« Cliquer sur "Search" »), décrite depuis l'étape du flow.
  const labels = new Map(result.flow.steps.map((step) => [step.id, describeFlowStep(step.step, language)]));
  const time = (at: string): string => (at ? new Date(at).toISOString().slice(11, 16) : '—');
  return {
    choices: [...REVIEWABLE_INTENTS],
    rows: (result.application?.actions ?? []).map((view) => {
      const review = view.review;
      const human = review?.source === 'HUMAN' ? review : undefined;
      return {
        actionId: view.actionId,
        kind: view.type,
        label:
          view.stepIds.map((id) => labels.get(id)).find((label) => label !== undefined) ??
          `${view.type}${view.label ? ` "${view.label}"` : ''}`,
        intent: human ? human.finalIntent : view.interpretation.join(' + '),
        status: review?.status ?? 'INFERRED',
        source: human ? 'HUMAN' : 'SYSTEM',
        ...(view.confidence !== undefined ? { confidence: view.confidence } : {}),
        ...(human ? { original: human.originalIntent.join(' + ') } : {}),
        ...(human?.originalConfidence !== undefined ? { originalConfidence: human.originalConfidence } : {}),
        ...(human?.correction?.reason ? { reason: human.correction.reason } : {}),
        ...(review?.proposal
          ? { proposal: `${review.proposal.intent.join(' + ')} (${review.proposal.source})` }
          : {}),
        history: (review?.history ?? []).map(
          (entry) =>
            `${time(entry.at)} — ${entry.source} → ${entry.intent.join(' + ')}${entry.reason ? ` « ${entry.reason} »` : ''}`,
        ),
      };
    }),
  };
}

/** La dernière recherche reconnue en direct, en une ligne (jamais une valeur saisie). */
function liveSearchOf(analysis: RecordingAnalysis): string | undefined {
  const search = analysis.business.filter((entry) => entry.operation === 'SEARCH').at(-1);
  if (!search) return undefined;
  const criteria = search.searchCriteria.map(
    (criterion) =>
      `${criterion.ui ? `"${criterion.ui.label}" → ` : ''}${criterion.propertyName}${criterion.operator ? ` ${criterion.operator}` : ''}`,
  );
  return `SEARCH ${search.api}${criteria.length ? ` · ${criteria.join(' · ')}` : ''}`;
}

/**
 * Les recherches reconnues, pour la fenêtre. La valeur montrée est celle de la DONNÉE DE TEST (déjà
 * écrite dans test-data.yaml, jamais une donnée sensible), un jeton de structure, ou « saisie » :
 * l'analyse elle-même ne garde que des empreintes.
 */
function searchesOf(analysis: RecordingAnalysis, result: RecordingResult): PanelSearch[] {
  const values = result.testData?.set.values ?? {};
  return analysis.business
    .filter((entry) => entry.operation === 'SEARCH' && entry.searchCriteria.length > 0)
    .slice(0, 6)
    .map((entry) => {
      const roles = new Map<string, string[]>();
      for (const parameter of entry.parameters)
        if (parameter.role !== 'SORT')
          roles.set(parameter.role, [...(roles.get(parameter.role) ?? []), parameter.path]);
      return {
        api: entry.api,
        ...(entry.technical
          ? { technical: `${entry.technical.category} · ${entry.technical.operation}` }
          : {}),
        ...(entry.searchCriteria.find((criterion) => criterion.logicalGroup)
          ? {
              logic:
                entry.searchCriteria.find((criterion) => criterion.logicalGroup)?.logicalGroup?.operator ??
                '',
            }
          : {}),
        criteria: entry.searchCriteria.map((criterion) => {
          const datum = criterion.testData ? values[criterion.testData.key]?.value : undefined;
          const clear = criterion.value.clear;
          return {
            ...(criterion.ui ? { label: criterion.ui.label } : {}),
            property: criterion.propertyName,
            ...(criterion.operator ? { operator: criterion.operator } : {}),
            value:
              datum ??
              (clear !== undefined && clear !== null ? String(clear) : criterion.ui ? '(typed)' : '(masked)'),
            ...(criterion.testData ? { testData: criterion.testData.reference } : {}),
            ...(criterion.fromCreation ? { fromCreation: true } : {}),
            state: criterion.state,
            confidence: criterion.confidence,
          };
        }),
        sort: entry.sort.map((sort) => `${sort.property ?? sort.path} ${sort.direction.toUpperCase()}`),
        parameters: [...roles.entries()].map(([role, paths]) => ({ role, paths })),
        ...(entry.interpretation ? { interpretation: entry.interpretation } : {}),
        evidence: [
          ...entry.evidence,
          ...entry.searchCriteria.flatMap((criterion) => criterion.evidence),
          ...entry.relations.flatMap((relation) => relation.evidence),
        ],
        confidence: entry.confidence,
        state: entry.state,
      };
    });
}

function httpPanelOf(
  analysis: RecordingAnalysis,
  result?: RecordingResult,
): NonNullable<PanelAnalysis['http']> {
  const { summary } = analysis;
  return {
    status: analysis.status,
    errors: analysis.errors,
    counts: {
      events: summary.events,
      network: summary.network,
      correlated: summary.correlated,
      independent: summary.independent,
      hypotheses: summary.hypotheses,
      inconsistencies: summary.inconsistencies,
      revisions: summary.revisions,
    },
    operations: Object.entries(summary.operations).map(
      ([operation, count]) => `${operation} ${String(count)}`,
    ),
    mappings: analysis.fieldMappings.slice(0, 12).map((mapping) => ({
      label: mapping.uiLabel,
      property: mapping.candidates
        ? mapping.candidates.join(' | ')
        : `${mapping.property} (${mapping.jsonPath})`,
      state: mapping.state,
      transformation: mapping.transformation,
    })),
    inconsistencies: analysis.inconsistencies.slice(0, 8).map((entry) => entry.message),
    revisions: analysis.revisions
      .slice(0, 8)
      .map((entry) => `${entry.ref}: ${entry.from} → ${entry.to} (${entry.reason})`),
    ...(result ? { searches: searchesOf(analysis, result) } : {}),
  };
}
