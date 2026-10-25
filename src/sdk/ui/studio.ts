import { createQaCrawler, QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type { FlowStudioView, GroupCommandInput, StudioViolation } from '../core/contracts.js';
import { STUDIO_EVENTS } from '../core/contracts.js';
import {
  centerOn,
  fitView,
  layoutStudio,
  NODE_HEIGHT,
  NODE_WIDTH,
  searchStudio,
  zoomAt,
  type Offset,
} from './studio-layout.js';
import { studioStrings } from './studio-i18n.js';
import { STUDIO_CSS } from './studio-styles.js';
import {
  renderGraph,
  renderPanel,
  renderStudio,
  viewportTransform,
  type StudioState,
} from './studio-view.js';

/**
 * <qa-crawler-flow-studio> — le parcours d'un enregistrement en graphe : groupes métier, étapes,
 * données produites et citées, chemin du dernier rejeu.
 *
 * Attributs : endpoint (API du serveur SDK), project, recording, locale (fr | en). Propriétés : token
 * (jamais en attribut dans une page publique), client (un client déjà construit).
 *
 * Toute modification passe par une commande de groupe que le MOTEUR vérifie (dépendances de données
 * comprises) : un refus est affiché avec son explication, rien n'est changé en silence. Déplacer une
 * carte ne change que l'affichage ; déposer une étape sur un groupe, sur une étape du même groupe, ou
 * un groupe au-delà d'un autre, demande la commande correspondante au moteur.
 *
 * Événements (bubbles, composed) : qa-studio-selection, qa-studio-changed, qa-studio-refused, qa-error.
 */
const Base: typeof HTMLElement =
  'HTMLElement' in globalThis ? globalThis.HTMLElement : (Object as unknown as typeof HTMLElement);

interface Drag {
  kind: 'pan' | 'node' | 'frame';
  id: string;
  pointerId: number;
  startX: number;
  startY: number;
  origin: { x: number; y: number };
  moved: boolean;
  shift: boolean;
  target: Element;
}

const isViolation = (value: unknown): value is StudioViolation =>
  !!value &&
  typeof value === 'object' &&
  typeof (value as StudioViolation).stepId === 'string' &&
  typeof (value as StudioViolation).key === 'string' &&
  typeof (value as StudioViolation).producerStepId === 'string';

export class QaCrawlerFlowStudio extends Base {
  static get observedAttributes(): string[] {
    return ['endpoint', 'project', 'recording', 'locale'];
  }

  private root!: ShadowRoot;
  private state!: StudioState;
  private injectedClient?: QaCrawlerClient;
  private ownClient?: QaCrawlerClient;
  private tokenValue?: string;
  private connected = false;
  private loadQueued = false;
  private fitPending = false;
  private offsets = new Map<string, Offset>();
  private drag?: Drag;
  private frame = 0;

  constructor() {
    super();
    this.root = this.attachShadow({ mode: 'open' });
    this.state = {
      t: studioStrings(this.getAttribute('locale')),
      phase: 'idle',
      viewport: { x: 0, y: 0, k: 1 },
      selected: [],
      query: '',
      matches: [],
      matchIndex: 0,
      busy: false,
      moved: false,
    };
    this.root.addEventListener('click', (event) => {
      this.onClick(event);
    });
    this.root.addEventListener('input', (event) => {
      this.onInput(event);
    });
    this.root.addEventListener('change', (event) => {
      this.onChange(event);
    });
    this.root.addEventListener('submit', (event) => {
      this.onSubmit(event);
    });
    this.root.addEventListener('keydown', (event) => {
      this.onKey(event as KeyboardEvent);
    });
    this.root.addEventListener('pointerdown', (event) => {
      this.onPointerDown(event as PointerEvent);
    });
    this.root.addEventListener('pointermove', (event) => {
      this.onPointerMove(event as PointerEvent);
    });
    this.root.addEventListener('pointerup', (event) => {
      this.onPointerUp(event as PointerEvent);
    });
    this.root.addEventListener('pointercancel', () => {
      this.drag = undefined;
    });
    this.root.addEventListener(
      'wheel',
      (event) => {
        this.onWheel(event as WheelEvent);
      },
      { passive: false },
    );
  }

  set token(value: string | undefined) {
    if (value === this.tokenValue) return;
    this.tokenValue = value;
    this.resetClient();
    if (this.connected) this.queueLoad();
  }

  get token(): string | undefined {
    return this.tokenValue;
  }

  set client(value: QaCrawlerClient | undefined) {
    this.injectedClient = value;
    this.resetClient();
    if (this.connected) this.queueLoad();
  }

  /** La vue chargée (lecture seule). */
  get view(): FlowStudioView | undefined {
    return this.state.view ? structuredClone(this.state.view) : undefined;
  }

  /** Recharger depuis le serveur (après un enregistrement ou un rejeu fait ailleurs). */
  reload(): void {
    this.queueLoad();
  }

  connectedCallback(): void {
    this.connected = true;
    this.queueLoad();
  }

  disconnectedCallback(): void {
    this.connected = false;
    if (this.frame) cancelAnimationFrame(this.frame);
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  attributeChangedCallback(name: string, previous: string | null, next: string | null): void {
    if (previous === next) return;
    if (name === 'locale') {
      this.state.t = studioStrings(next);
      this.paint();
      return;
    }
    if (name === 'endpoint') this.resetClient();
    this.offsets.clear();
    this.state.selected = [];
    this.state.selectedGroup = undefined;
    if (this.connected) this.queueLoad();
  }

  private get api(): QaCrawlerClient | undefined {
    if (this.injectedClient) return this.injectedClient;
    if (!this.ownClient) {
      const endpoint = this.getAttribute('endpoint');
      if (!endpoint) return undefined;
      this.ownClient = createQaCrawler({ endpoint, ...(this.tokenValue ? { token: this.tokenValue } : {}) });
    }
    return this.ownClient;
  }

  private resetClient(): void {
    this.ownClient?.dispose();
    this.ownClient = undefined;
  }

  private queueLoad(): void {
    if (this.loadQueued) return;
    this.loadQueued = true;
    queueMicrotask(() => {
      this.loadQueued = false;
      if (this.connected) void this.load();
    });
  }

  private get ids(): { project: string; recording: string } | undefined {
    const project = this.getAttribute('project');
    const recording = this.getAttribute('recording');
    return project && recording ? { project, recording } : undefined;
  }

  private async load(): Promise<void> {
    const ids = this.ids;
    if (!ids) {
      this.state.phase = 'idle';
      this.paint();
      return;
    }
    if (!this.injectedClient && !this.tokenValue) return;
    const api = this.api;
    if (!api) {
      this.state.phase = 'error';
      this.state.error = 'endpoint attribute missing';
      this.paint();
      return;
    }
    this.state.phase = 'loading';
    this.paint();
    try {
      this.setView(await api.recordings.studio(ids.project, ids.recording));
      this.state.phase = 'ready';
      this.fitPending = true;
    } catch (error) {
      this.state.phase = 'error';
      this.state.error = error instanceof Error ? error.message : String(error);
      this.fail(error);
    }
    this.paint();
  }

  private setView(view: FlowStudioView): void {
    this.state.view = view;
    const known = new Set(view.steps.map((step) => step.id));
    this.state.selected = this.state.selected.filter((id) => known.has(id));
    if (this.state.selectedGroup && !view.groups.some((group) => group.id === this.state.selectedGroup))
      this.state.selectedGroup = undefined;
    this.relayout();
    this.state.matches = searchStudio(view, this.state.query);
    this.state.matchIndex = Math.min(this.state.matchIndex, Math.max(0, this.state.matches.length - 1));
  }

  private relayout(): void {
    if (this.state.view)
      this.state.layout = layoutStudio(this.state.view, { offsets: Object.fromEntries(this.offsets) });
  }

  // ———————————————————————————————————————————— rendu

  private paint(): void {
    const active = this.root.activeElement as HTMLElement | null;
    const focusKey = active ? focusKeyOf(active) : undefined;
    const caret =
      active instanceof HTMLInputElement ? [active.selectionStart ?? 0, active.selectionEnd ?? 0] : undefined;
    this.root.innerHTML = `<style>${STUDIO_CSS}</style>${renderStudio(this.state)}`;
    if (focusKey) {
      const element = this.root.querySelector<HTMLElement>(focusKey);
      element?.focus({ preventScroll: true });
      if (caret && element instanceof HTMLInputElement)
        element.setSelectionRange(caret[0] ?? 0, caret[1] ?? 0);
    }
    if (this.fitPending && this.state.phase === 'ready') {
      this.fitPending = false;
      this.fit();
    }
  }

  /** Le graphe, le panneau et les compteurs, sans toucher au champ de recherche (frappe en cours). */
  private paintParts(): void {
    const active = this.root.activeElement as HTMLElement | null;
    const focusKey = active ? focusKeyOf(active) : undefined;
    const group = this.root.querySelector('.vp');
    const side = this.root.querySelector('.side');
    if (!group || !side) {
      this.paint();
      return;
    }
    group.innerHTML = renderGraph(this.state);
    const inPanel = !!active && side.contains(active);
    if (!inPanel || !focusKey) side.innerHTML = renderPanel(this.state);
    const output = this.root.querySelector('.search output');
    if (output)
      output.textContent = this.state.query.trim()
        ? this.state.t.matches(
            this.state.matches.length === 0 ? 0 : this.state.matchIndex + 1,
            this.state.matches.length,
          )
        : '';
    if (focusKey && !inPanel) this.root.querySelector<HTMLElement>(focusKey)?.focus({ preventScroll: true });
  }

  private scheduleGraph(): void {
    if (this.frame) return;
    this.frame = requestAnimationFrame(() => {
      this.frame = 0;
      const group = this.root.querySelector('.vp');
      if (group) group.innerHTML = renderGraph(this.state);
    });
  }

  private applyViewport(): void {
    this.root.querySelector('.vp')?.setAttribute('transform', viewportTransform(this.state.viewport));
    const label = this.root.querySelector('.zv');
    if (label) label.textContent = `${String(Math.round(this.state.viewport.k * 100))} %`;
  }

  private canvasBox(): DOMRect | undefined {
    return this.root.querySelector('.canvas')?.getBoundingClientRect();
  }

  private fit(): void {
    const box = this.canvasBox();
    if (!box || !this.state.layout || box.width === 0) return;
    this.state.viewport = fitView(this.state.layout, box.width, box.height);
    this.applyViewport();
  }

  private zoomBy(factor: number, at?: { x: number; y: number }): void {
    const box = this.canvasBox();
    if (!box) return;
    this.state.viewport = zoomAt(this.state.viewport, factor, at ?? { x: box.width / 2, y: box.height / 2 });
    this.applyViewport();
  }

  private toGraph(clientX: number, clientY: number): { x: number; y: number } {
    const box = this.canvasBox();
    const { x, y, k } = this.state.viewport;
    return { x: (clientX - (box?.left ?? 0) - x) / k, y: (clientY - (box?.top ?? 0) - y) / k };
  }

  private focusStep(id: string): void {
    const layout = this.state.layout;
    const box = this.canvasBox();
    const node =
      layout?.steps.find((step) => step.id === id) ??
      layout?.summaries.find((summary) => summary.stepIds.includes(id));
    if (!node || !box) return;
    this.state.viewport = centerOn(
      this.state.viewport,
      { x: node.x + NODE_WIDTH / 2, y: node.y + NODE_HEIGHT / 2 },
      box.width,
      box.height,
    );
    this.applyViewport();
  }

  // ———————————————————————————————————————————— sélection

  private select(stepId: string, add: boolean): void {
    const selected = this.state.selected;
    this.state.selectedGroup = undefined;
    this.state.confirmDelete = undefined;
    this.state.selected = add
      ? selected.includes(stepId)
        ? selected.filter((id) => id !== stepId)
        : [...selected, stepId]
      : [stepId];
    this.emitSelection();
    this.paintParts();
  }

  private selectGroup(groupId: string | undefined): void {
    this.state.selectedGroup = groupId;
    this.state.selected = [];
    this.state.confirmDelete = undefined;
    this.emitSelection();
    this.paintParts();
  }

  private emitSelection(): void {
    this.emit(STUDIO_EVENTS.selection, {
      stepIds: [...this.state.selected],
      ...(this.state.selectedGroup ? { groupId: this.state.selectedGroup } : {}),
    });
  }

  // ———————————————————————————————————————————— commandes du moteur

  private async edit(commands: GroupCommandInput[]): Promise<void> {
    const ids = this.ids;
    const api = this.api;
    if (!ids || !api || commands.length === 0) return;
    this.state.busy = true;
    this.state.notice = undefined;
    this.state.confirmDelete = undefined;
    this.paintParts();
    let current: GroupCommandInput | undefined;
    try {
      const warnings: string[] = [];
      for (const command of commands) {
        current = command;
        warnings.push(...(await api.groups.edit(ids.project, ids.recording, command)).warnings);
      }
      this.state.notice = { kind: 'ok', message: warnings.join(' ') };
      this.emit(STUDIO_EVENTS.changed, { command: commands.length === 1 ? commands[0] : commands, warnings });
    } catch (error) {
      if (error instanceof QaCrawlerError && error.status === 422) {
        const violations = error.details
          .map((detail) => {
            try {
              return JSON.parse(detail) as unknown;
            } catch {
              return undefined;
            }
          })
          .filter(isViolation);
        this.state.notice = { kind: 'refused', message: error.message, violations };
        this.emit(STUDIO_EVENTS.refused, { command: current, message: error.message, violations });
      } else {
        this.state.notice = {
          kind: 'error',
          message: error instanceof Error ? error.message : String(error),
        };
        this.fail(error);
      }
    }
    // Le moteur a pu réordonner les étapes : la vue est relue, jamais devinée.
    try {
      this.setView(await api.recordings.studio(ids.project, ids.recording));
    } catch (error) {
      this.state.notice = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
      this.fail(error);
    }
    this.state.busy = false;
    this.paint();
  }

  private groupOfStep(stepId: string): string | undefined {
    return this.state.view?.steps.find((step) => step.id === stepId)?.groupId;
  }

  /** Les étapes d'action d'un groupe, dans l'ordre du flow (les vérifications suivent leur action). */
  private actionSteps(groupId: string): string[] {
    return (this.state.view?.steps ?? [])
      .filter((step) => step.groupId === groupId && step.kind !== 'expect')
      .map((step) => step.id);
  }

  private dropStep(id: string, at: { x: number; y: number }): void {
    const layout = this.state.layout;
    const view = this.state.view;
    if (!layout || !view) return;
    const inside = (box: { x: number; y: number }, w: number, h: number): boolean =>
      at.x >= box.x && at.x <= box.x + w && at.y >= box.y && at.y <= box.y + h;
    const own = this.groupOfStep(id);
    const target = layout.steps.find((step) => step.id !== id && inside(step, NODE_WIDTH, NODE_HEIGHT));
    const dragged = view.steps.find((step) => step.id === id);
    if (target && own && target.step.groupId === own && dragged?.kind !== 'expect') {
      const order = this.actionSteps(own).filter((stepId) => stepId !== id);
      const targetAction = target.step.kind === 'expect' ? undefined : target.id;
      if (targetAction) {
        order.splice(order.indexOf(targetAction), 0, id);
        this.offsets.delete(id);
        void this.edit([{ op: 'reorder-steps', groupId: own, stepIds: order }]);
        return;
      }
    }
    const frame = layout.groups.find(
      (group) => group.groupId !== own && inside(group, group.width, group.height),
    );
    if (frame) {
      const stepIds = this.state.selected.includes(id) ? this.state.selected : [id];
      for (const stepId of stepIds) this.offsets.delete(stepId);
      void this.edit([{ op: 'assign', groupId: frame.groupId, stepIds }]);
      return;
    }
    this.state.moved = true;
    this.paint();
  }

  private dropFrame(key: string): void {
    const layout = this.state.layout;
    const view = this.state.view;
    if (!layout || !view) return;
    const frame = layout.groups.find((group) => group.key === key);
    if (!frame) return;
    const order = view.groups.map((group) => group.id);
    const index = order.indexOf(frame.groupId);
    const center = frame.x + frame.width / 2;
    const others = layout.groups.filter((group) => group.groupId !== frame.groupId && !group.continued);
    const target = others.filter((group) => group.x + group.width / 2 < center).length;
    const delta = target - index;
    if (delta === 0 || index < 0) {
      this.state.moved = true;
      this.paint();
      return;
    }
    this.offsets.delete(key);
    const direction = delta < 0 ? 'up' : 'down';
    void this.edit(
      Array.from({ length: Math.abs(delta) }, () => ({
        op: 'move-group' as const,
        groupId: frame.groupId,
        direction,
      })),
    );
  }

  // ———————————————————————————————————————————— gestes

  private onPointerDown(event: PointerEvent): void {
    const target = event.target as Element;
    const canvas = target.closest('.canvas');
    if (!canvas || event.button !== 0 || this.state.busy) return;
    if (target.closest('[data-collapse]')) return;
    const node = target.closest('[data-node]');
    const summary = target.closest('[data-summary]');
    const header = target.closest('.fh');
    const frame = header?.closest('[data-frame]');
    const { viewport } = this.state;
    let drag: Drag;
    if (node || summary) {
      const id = node?.getAttribute('data-node') ?? `summary:${summary?.getAttribute('data-summary') ?? ''}`;
      const origin = this.offsets.get(id) ?? { dx: 0, dy: 0 };
      drag = {
        kind: 'node',
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: origin.dx, y: origin.dy },
        moved: false,
        shift: event.shiftKey || event.metaKey || event.ctrlKey,
        target,
      };
    } else if (frame) {
      const id = frame.getAttribute('data-frame') ?? '';
      const origin = this.offsets.get(id) ?? { dx: 0, dy: 0 };
      drag = {
        kind: 'frame',
        id,
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: origin.dx, y: origin.dy },
        moved: false,
        shift: false,
        target,
      };
    } else {
      drag = {
        kind: 'pan',
        id: '',
        pointerId: event.pointerId,
        startX: event.clientX,
        startY: event.clientY,
        origin: { x: viewport.x, y: viewport.y },
        moved: false,
        shift: false,
        target,
      };
    }
    this.drag = drag;
    (canvas as HTMLElement).setPointerCapture(event.pointerId);
  }

  private onPointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    const dx = event.clientX - drag.startX;
    const dy = event.clientY - drag.startY;
    if (!drag.moved && Math.hypot(dx, dy) < 4) return;
    drag.moved = true;
    if (drag.kind === 'pan') {
      this.root.querySelector('.canvas')?.classList.add('panning');
      this.state.viewport = { ...this.state.viewport, x: drag.origin.x + dx, y: drag.origin.y + dy };
      this.applyViewport();
      return;
    }
    const k = this.state.viewport.k;
    this.offsets.set(drag.id, { dx: drag.origin.x + dx / k, dy: drag.origin.y + dy / k });
    this.relayout();
    this.scheduleGraph();
  }

  private onPointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag || drag.pointerId !== event.pointerId) return;
    this.drag = undefined;
    this.root.querySelector('.canvas')?.classList.remove('panning');
    if (drag.moved) {
      if (drag.kind === 'node' && !drag.id.startsWith('summary:'))
        this.dropStep(drag.id, this.toGraph(event.clientX, event.clientY));
      else if (drag.kind === 'frame') this.dropFrame(drag.id);
      else if (drag.kind === 'node') {
        this.state.moved = true;
        this.paint();
      }
      return;
    }
    // Un clic : choisir une étape, un groupe, ou rien (fond du graphe).
    const node = drag.target.closest('[data-node]');
    const summary = drag.target.closest('[data-summary]');
    const group = drag.target.closest('[data-select-group]');
    if (node) this.select(node.getAttribute('data-node') ?? '', drag.shift);
    else if (summary) this.selectGroup(summary.getAttribute('data-summary') ?? undefined);
    else if (group) this.selectGroup(group.getAttribute('data-select-group') ?? undefined);
    else if (this.state.selected.length > 0 || this.state.selectedGroup) {
      this.state.selected = [];
      this.state.selectedGroup = undefined;
      this.emitSelection();
      this.paintParts();
    }
  }

  private onWheel(event: WheelEvent): void {
    if (!(event.target as Element).closest('.canvas')) return;
    event.preventDefault();
    const box = this.canvasBox();
    if (!box) return;
    this.zoomBy(Math.exp(-event.deltaY * 0.0015), {
      x: event.clientX - box.left,
      y: event.clientY - box.top,
    });
  }

  private onClick(event: Event): void {
    const target = event.target as Element;
    const collapse = target.closest('[data-collapse]');
    if (collapse) {
      const groupId = collapse.getAttribute('data-collapse') ?? '';
      const group = this.state.view?.groups.find((entry) => entry.id === groupId);
      if (group) void this.edit([{ op: 'collapse', groupId, collapsed: !group.collapsed }]);
      return;
    }
    if (target.closest('.canvas')) return;
    const link = target.closest('[data-select-group]');
    if (link) {
      this.selectGroup(link.getAttribute('data-select-group') ?? undefined);
      return;
    }
    const command = target.closest('[data-cmd]')?.getAttribute('data-cmd');
    if (!command) return;
    const stepId = this.state.selected[0];
    const groupId = this.state.selectedGroup;
    switch (command) {
      case 'retry':
        this.queueLoad();
        return;
      case 'zoom-in':
        this.zoomBy(1.2);
        return;
      case 'zoom-out':
        this.zoomBy(1 / 1.2);
        return;
      case 'fit':
        this.fit();
        return;
      case 'reset-positions':
        this.offsets.clear();
        this.state.moved = false;
        this.relayout();
        this.paint();
        return;
      case 'move-step-up':
      case 'move-step-down':
        if (stepId)
          void this.edit([{ op: 'move-step', stepId, direction: command.endsWith('up') ? 'up' : 'down' }]);
        return;
      case 'detach':
        if (this.state.selected.length > 0)
          void this.edit([{ op: 'detach', stepIds: [...this.state.selected] }]);
        return;
      case 'move-group-up':
      case 'move-group-down':
        if (groupId)
          void this.edit([{ op: 'move-group', groupId, direction: command.endsWith('up') ? 'up' : 'down' }]);
        return;
      case 'delete-group':
        if (!groupId) return;
        if (this.state.confirmDelete !== groupId) {
          this.state.confirmDelete = groupId;
          this.paintParts();
          return;
        }
        void this.edit([{ op: 'delete', groupId, keepSteps: true }]);
        return;
      default:
    }
  }

  private onInput(event: Event): void {
    const target = event.target as HTMLInputElement;
    if (target.id !== 'qa-search' || !this.state.view) return;
    this.state.query = target.value;
    this.state.matches = searchStudio(this.state.view, target.value);
    this.state.matchIndex = 0;
    this.paintParts();
  }

  private onChange(event: Event): void {
    const target = event.target as HTMLSelectElement;
    const mode = target.getAttribute('data-assign');
    if (!mode || !target.value || this.state.selected.length === 0) return;
    void this.edit([{ op: 'assign', groupId: target.value, stepIds: [...this.state.selected] }]);
  }

  private onSubmit(event: Event): void {
    event.preventDefault();
    const form = event.target as HTMLFormElement;
    const kind = form.getAttribute('data-form');
    const data = new FormData(form);
    const text = (field: string): string => {
      const value = data.get(field);
      return typeof value === 'string' ? value.trim() : '';
    };
    const name = text('name');
    const groupId = this.state.selectedGroup;
    if (kind === 'create' && name && this.state.selected.length > 0)
      void this.edit([{ op: 'create', name, stepIds: [...this.state.selected] }]);
    if (kind === 'rename' && name && groupId) void this.edit([{ op: 'rename', groupId, name }]);
    if (kind === 'describe' && groupId)
      void this.edit([{ op: 'describe', groupId, description: text('description') }]);
  }

  private onKey(event: KeyboardEvent): void {
    const target = event.target as Element;
    if (target instanceof HTMLInputElement && target.id === 'qa-search') {
      if (event.key === 'Enter' && this.state.matches.length > 0) {
        event.preventDefault();
        const id = this.state.matches[this.state.matchIndex];
        this.state.matchIndex = (this.state.matchIndex + 1) % this.state.matches.length;
        if (id) {
          this.focusStep(id);
          this.select(id, false);
        }
      }
      if (event.key === 'Escape') {
        target.value = '';
        this.onInput(event);
      }
      return;
    }
    if (!target.closest('.canvas')) return;
    const node = target.closest('[data-node]');
    const header = target.closest('[data-select-group]');
    const collapse = target.closest('[data-collapse]');
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      if (collapse) this.onClick(event);
      else if (node) this.select(node.getAttribute('data-node') ?? '', event.shiftKey);
      else if (header) this.selectGroup(header.getAttribute('data-select-group') ?? undefined);
      return;
    }
    if (event.key === 'Escape') {
      this.state.selected = [];
      this.state.selectedGroup = undefined;
      this.emitSelection();
      this.paintParts();
      return;
    }
    if (event.key === '+' || event.key === '=') this.zoomBy(1.2);
    else if (event.key === '-') this.zoomBy(1 / 1.2);
    else if (event.key === '0') this.fit();
    else if (event.key.startsWith('Arrow')) {
      event.preventDefault();
      if (node) {
        // D'une étape à la suivante (ou la précédente) dans l'ordre du parcours.
        const ids = this.state.layout?.steps.map((step) => step.id) ?? [];
        const index = ids.indexOf(node.getAttribute('data-node') ?? '');
        const next = ids[index + (event.key === 'ArrowRight' || event.key === 'ArrowDown' ? 1 : -1)];
        if (next) {
          this.focusStep(next);
          this.root
            .querySelector<HTMLElement>(`[data-node="${cssEscape(next)}"]`)
            ?.focus({ preventScroll: true });
        }
        return;
      }
      const step = 48;
      const { viewport } = this.state;
      this.state.viewport = {
        ...viewport,
        x: viewport.x + (event.key === 'ArrowLeft' ? step : event.key === 'ArrowRight' ? -step : 0),
        y: viewport.y + (event.key === 'ArrowUp' ? step : event.key === 'ArrowDown' ? -step : 0),
      };
      this.applyViewport();
    }
  }

  private emit(type: string, detail: unknown): void {
    this.dispatchEvent(new CustomEvent(type, { detail, bubbles: true, composed: true }));
  }

  private fail(error: unknown): void {
    const code = error instanceof QaCrawlerError ? error.code : 'ERROR';
    const message = error instanceof Error ? error.message : String(error);
    this.emit(STUDIO_EVENTS.error, { code, message });
  }
}

function cssEscape(value: string): string {
  return value.replace(/["\\]/g, '\\$&');
}

/** Un sélecteur qui retrouve l'élément après un nouveau rendu (focus clavier conservé). */
function focusKeyOf(element: HTMLElement): string | undefined {
  for (const attribute of [
    'data-node',
    'data-summary',
    'data-select-group',
    'data-collapse',
    'data-cmd',
    'data-assign',
  ]) {
    const value = element.getAttribute(attribute);
    if (value !== null) return `[${attribute}="${cssEscape(value)}"]`;
  }
  if (element.id) return `#${element.id}`;
  if (element.classList.contains('canvas')) return '.canvas';
  return undefined;
}

export function defineStudio(name = 'qa-crawler-flow-studio'): void {
  if (!('customElements' in globalThis)) return;
  if (!globalThis.customElements.get(name)) globalThis.customElements.define(name, QaCrawlerFlowStudio);
}
