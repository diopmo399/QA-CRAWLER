import type { Page } from 'playwright';
import type { PanelState } from './panel-state.js';
import { recorderPanelHtml } from './recorder-panel-html.js';

/** Une commande de la fenêtre du recorder (un bouton) : Node décide, la fenêtre n'agit jamais seule. */
export interface PanelCommand {
  type:
    | 'pause'
    | 'resume'
    | 'stop'
    | 'undo'
    | 'select'
    | 'resolve'
    | 'ignore'
    | 'replay'
    | 'save'
    | 'remove'
    | 'finish'
    | 'refresh'
    | 'detach'
    | 'attach'
    | 'intent-correct'
    | 'intent-confirm'
    | 'intent-reset'
    | 'data-bind'
    | 'correct-pick'
    | 'correct-cancel'
    | 'correct-apply'
    | 'correct-test'
    | 'correct-restore';
  id?: string;
  candidate?: number;
  /** La revue d'une intention : l'intention choisie et sa justification (facultative). */
  intent?: string;
  reason?: string;
  /** La liaison de données d'une saisie : sa source, sa variable, son générateur, sa valeur fixe. */
  source?: 'FIXED' | 'GENERATED' | 'REFERENCE';
  variable?: string;
  generator?: string;
  value?: string;
}

const COMMANDS = new Set<PanelCommand['type']>([
  'pause',
  'resume',
  'stop',
  'undo',
  'select',
  'resolve',
  'ignore',
  'replay',
  'save',
  'remove',
  'finish',
  'refresh',
  'detach',
  'attach',
  'intent-correct',
  'intent-confirm',
  'intent-reset',
  'data-bind',
  'correct-pick',
  'correct-cancel',
  'correct-apply',
  'correct-test',
  'correct-restore',
]);

/**
 * LA FENÊTRE « QA-CRAWLER Recorder » : une page dans un contexte isolé du navigateur (jamais
 * enregistrée). L'état est poussé (au plus une fois par tour de boucle : les rafales se regroupent),
 * les commandes remontent par un binding et sont vérifiées.
 */
export class RecorderPanel {
  private handler: ((command: PanelCommand) => void) | undefined;
  private pending: PanelState | undefined;
  private flushing = false;
  readonly closed: Promise<void>;

  private constructor(readonly page: Page) {
    this.closed = new Promise((resolve) => {
      page.once('close', () => {
        resolve();
      });
    });
  }

  /** mode preview : la fenêtre détachée (l'aperçu de l'application seul, plein écran possible). */
  static async open(
    page: Page,
    language: 'fr' | 'en',
    mode: 'main' | 'preview' = 'main',
  ): Promise<RecorderPanel> {
    const panel = new RecorderPanel(page);
    await page.exposeBinding('__qaPanelCommand', (_source, payload: unknown) => {
      const command = commandOf(payload);
      if (command) panel.handler?.(command);
    });
    await page.setContent(recorderPanelHtml(language, mode), { waitUntil: 'domcontentloaded' });
    await page.bringToFront().catch(() => undefined);
    return panel;
  }

  onCommand(handler: (command: PanelCommand) => void): void {
    this.handler = handler;
  }

  /** Redessine la fenêtre (le dernier état gagne). */
  render(state: PanelState): void {
    this.pending = state;
    if (this.flushing) return;
    this.flushing = true;
    setImmediate(() => {
      this.flushing = false;
      const next = this.pending;
      this.pending = undefined;
      if (!next || this.page.isClosed()) return;
      void this.page
        .evaluate((value) => {
          (window as unknown as { __qaPanelRender?: (state: unknown) => void }).__qaPanelRender?.(value);
        }, next)
        .catch(() => undefined);
    });
  }

  async close(): Promise<void> {
    if (!this.page.isClosed())
      await this.page
        .context()
        .close()
        .catch(() => undefined);
  }
}

function commandOf(payload: unknown): PanelCommand | undefined {
  if (typeof payload !== 'object' || payload === null) return undefined;
  const raw = payload as Record<string, unknown>;
  const type = raw.type;
  if (typeof type !== 'string' || !COMMANDS.has(type as PanelCommand['type'])) return undefined;
  return {
    type: type as PanelCommand['type'],
    ...(typeof raw.id === 'string' && raw.id.length <= 40 ? { id: raw.id } : {}),
    ...(typeof raw.candidate === 'number' && Number.isInteger(raw.candidate)
      ? { candidate: raw.candidate }
      : {}),
    ...(typeof raw.intent === 'string' && /^[A-Z_]{2,40}$/.test(raw.intent) ? { intent: raw.intent } : {}),
    ...(typeof raw.reason === 'string' ? { reason: raw.reason.slice(0, 500) } : {}),
    ...(raw.source === 'FIXED' || raw.source === 'GENERATED' || raw.source === 'REFERENCE'
      ? { source: raw.source }
      : {}),
    ...(typeof raw.variable === 'string' && raw.variable.length <= 80 ? { variable: raw.variable } : {}),
    ...(typeof raw.generator === 'string' && /^[A-Za-z]{1,30}$/.test(raw.generator)
      ? { generator: raw.generator }
      : {}),
    ...(typeof raw.value === 'string' ? { value: raw.value.slice(0, 500) } : {}),
  };
}
