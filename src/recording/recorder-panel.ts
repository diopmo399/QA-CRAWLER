import type { Page } from 'playwright';
import type { PanelState } from './panel-state.js';
import type { RowColumnChoice } from './target-correction.js';
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
    | 'correct-restore'
    | 'resume-replay'
    | 'row-preview'
    | 'row-edit'
    | 'assertion-decide'
    | 'group'
    | 'generate';
  id?: string;
  /** generate : les formats demandés (yaml, gherkin, playwright, java) et les groupes choisis (tous sans sélection). */
  formats?: string[];
  groupIds?: string[];
  /** group : l'opération sur les groupes métier (créer, renommer, affecter, déplacer, supprimer…). */
  op?: string;
  name?: string;
  description?: string;
  groupId?: string;
  stepIds?: string[];
  direction?: 'up' | 'down';
  collapsed?: boolean;
  keepSteps?: boolean;
  force?: boolean;
  /** assertion-decide : la décision sur une proposition d'assertion. */
  decision?: 'ACCEPT' | 'REJECT' | 'DISABLE' | 'RESET' | 'MODIFY';
  candidate?: number;
  /** La revue d'une intention : l'intention choisie et sa justification (facultative). */
  intent?: string;
  reason?: string;
  /** La liaison de données d'une saisie : sa source, sa variable, son générateur, sa valeur fixe. */
  source?: 'FIXED' | 'GENERATED' | 'REFERENCE';
  variable?: string;
  generator?: string;
  value?: string;
  /** La correction d'une cible dans une ligne de tableau : l'option de ligne choisie (bound, key, manual). */
  option?: string;
  /** manual : la colonne liée (la donnée du run est `variable`). */
  column?: string;
  /** columns, row-preview, row-edit : la ligne par ses colonnes, chacune avec la source de sa valeur. */
  columns?: RowColumnChoice[];
}

const COMMANDS = new Set<PanelCommand['type']>([
  'assertion-decide',
  'group',
  'generate',
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
  'resume-replay',
  'row-preview',
  'row-edit',
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

/** La commande d'un message de la fenêtre : type connu, chaque champ vérifié et borné ; sinon rien. */
export function commandOf(payload: unknown): PanelCommand | undefined {
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
    ...(typeof raw.option === 'string' && /^[a-z]{1,20}$/.test(raw.option) ? { option: raw.option } : {}),
    ...(typeof raw.column === 'string' && raw.column.length <= 60 ? { column: raw.column } : {}),
    ...columnsOf(raw.columns),
    // Les décisions sur les propositions, les groupes métier et la génération : chaque champ borné.
    ...(typeof raw.decision === 'string' && DECISIONS.has(raw.decision)
      ? { decision: raw.decision as PanelCommand['decision'] }
      : {}),
    ...(typeof raw.op === 'string' && GROUP_OPS.has(raw.op) ? { op: raw.op } : {}),
    ...(typeof raw.name === 'string' && raw.name.trim().length > 0
      ? { name: raw.name.trim().slice(0, 120) }
      : {}),
    ...(typeof raw.description === 'string' ? { description: raw.description.slice(0, 500) } : {}),
    ...(typeof raw.groupId === 'string' && /^g\d{1,6}$/.test(raw.groupId) ? { groupId: raw.groupId } : {}),
    ...idsOf('stepIds', raw.stepIds, /^s\d{1,6}$/),
    ...(raw.direction === 'up' || raw.direction === 'down' ? { direction: raw.direction } : {}),
    ...(typeof raw.collapsed === 'boolean' ? { collapsed: raw.collapsed } : {}),
    ...(typeof raw.keepSteps === 'boolean' ? { keepSteps: raw.keepSteps } : {}),
    ...(typeof raw.force === 'boolean' ? { force: raw.force } : {}),
    ...idsOf('formats', raw.formats, /^(yaml|gherkin|playwright|java)$/),
    ...idsOf('groupIds', raw.groupIds, /^g\d{1,6}$/),
  };
}

const DECISIONS = new Set<string>(['ACCEPT', 'REJECT', 'DISABLE', 'RESET', 'MODIFY']);
const GROUP_OPS = new Set<string>([
  'create',
  'rename',
  'describe',
  'assign',
  'detach',
  'move-step',
  'reorder-steps',
  'move-group',
  'collapse',
  'delete',
]);

/** Une liste d'identifiants bornée (50 au plus), chacun au format attendu ; une entrée mal formée invalide la liste. */
function idsOf<K extends string>(key: K, raw: unknown, pattern: RegExp): Partial<Record<K, string[]>> {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 50) return {};
  const ids: string[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'string' || !pattern.test(entry)) return {};
    ids.push(entry);
  }
  return { [key]: ids } as Partial<Record<K, string[]>>;
}

const SOURCES = new Set<RowColumnChoice['source']>(['recorded', 'value', 'variable', 'new-variable']);

/** Les colonnes d'une ligne : 6 au plus, chaque champ borné ; une entrée mal formée invalide la liste. */
function columnsOf(raw: unknown): { columns?: RowColumnChoice[] } {
  if (!Array.isArray(raw) || raw.length === 0 || raw.length > 6) return {};
  const columns: RowColumnChoice[] = [];
  for (const entry of raw as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return {};
    const item = entry as Record<string, unknown>;
    const { column, source, value, key, match } = item;
    if (typeof column !== 'string' || column.length === 0 || column.length > 60) return {};
    if (typeof source !== 'string' || !SOURCES.has(source as RowColumnChoice['source'])) return {};
    if (value !== undefined && (typeof value !== 'string' || value.length > 200)) return {};
    if (key !== undefined && (typeof key !== 'string' || key.length > 80)) return {};
    if (match !== undefined && match !== 'exact' && match !== 'contains') return {};
    columns.push({
      column,
      source: source as RowColumnChoice['source'],
      ...(typeof value === 'string' ? { value } : {}),
      ...(typeof key === 'string' ? { key } : {}),
      ...(match ? { match } : {}),
    });
  }
  return { columns };
}
