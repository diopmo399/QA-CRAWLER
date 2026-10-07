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
    | 'finish';
  id?: string;
  candidate?: number;
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

  static async open(page: Page, language: 'fr' | 'en'): Promise<RecorderPanel> {
    const panel = new RecorderPanel(page);
    await page.exposeBinding('__qaPanelCommand', (_source, payload: unknown) => {
      const command = commandOf(payload);
      if (command) panel.handler?.(command);
    });
    await page.setContent(recorderPanelHtml(language), { waitUntil: 'domcontentloaded' });
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
  };
}
