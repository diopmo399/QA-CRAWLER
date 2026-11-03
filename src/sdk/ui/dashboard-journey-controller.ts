import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import {
  edgePath,
  NODE_SIZE,
  portOf,
  type Journey,
  type JourneyBranch,
  type JourneyNode,
} from '../core/journey.js';
import {
  acceptVersion,
  addBlock,
  addShape,
  bounds,
  connect,
  duplicateNode,
  emptyJourneyUi,
  journeyText,
  logicKey,
  moveBlock,
  placeNode,
  redo,
  remember,
  removeEdge,
  removeNode,
  setBranch,
  setLabel,
  setParam,
  switchMode,
  undo,
  type JourneyUi,
} from './dashboard-journey.js';
import { can } from './dashboard-access.js';
import type { DashboardState } from './dashboard-view.js';

export interface JourneyHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  /** Relit le projet et la bibliothèque (après une création de scénarios). */
  refresh(): Promise<void>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const detailsOf = (error: unknown): string[] =>
  error instanceof QaCrawlerError && Array.isArray(error.details) ? error.details.map(String) : [];

type Drag =
  | {
      kind: 'node';
      id: string;
      x0: number;
      y0: number;
      nx: number;
      ny: number;
      moved: boolean;
      el: HTMLElement;
    }
  | { kind: 'pan'; x0: number; y0: number; px: number; py: number; moved: boolean; world: HTMLElement }
  | {
      kind: 'link';
      from: string;
      branch?: JourneyBranch;
      origin: { x: number; y: number };
      temp: SVGPathElement;
    };

type Carried =
  | { kind: 'block'; name: string }
  | { kind: 'node'; id: string }
  | { kind: 'shape'; shape: 'CONDITION' | 'JOIN' | 'END' };

const ZOOM_MIN = 0.3;
const ZOOM_MAX = 2;

/**
 * LE CONTRÔLEUR DU COMPOSITEUR VISUEL : les actions `jn-*`, les champs `data-jn`, le glisser-déposer natif
 * (palette → parcours, cartes entre elles), les gestes du diagramme (déplacer un nœud, relier depuis un
 * port, déplacer la vue, zoomer), le clavier (Suppr, Ctrl+Z / Ctrl+Y, Échap) et les appels au serveur
 * (vérifier, enregistrer, ouvrir, créer). Pendant un geste, seul le DOM concerné bouge ; l'état change à la
 * fin du geste, en une modification annulable.
 */
export class JourneyController {
  private drag: Drag | undefined;
  private carried: Carried | undefined;
  private checkTimer: ReturnType<typeof setTimeout> | undefined;
  private checkSequence = 0;
  /** Le paramètre « Relier à » choisi dans le panneau (cible, branche). */
  private connectTo = '';
  private connectBranch: JourneyBranch = 'YES';

  constructor(private readonly host: JourneyHost) {
    const root = host.root;
    root.addEventListener('pointerdown', (event) => {
      this.pointerDown(event as PointerEvent);
    });
    root.addEventListener('pointermove', (event) => {
      this.pointerMove(event as PointerEvent);
    });
    root.addEventListener('pointerup', (event) => {
      this.pointerUp(event as PointerEvent);
    });
    root.addEventListener('pointercancel', () => {
      this.cancelDrag();
    });
    root.addEventListener('dragstart', (event) => {
      this.dragStart(event as DragEvent);
    });
    root.addEventListener('dragover', (event) => {
      this.dragOver(event as DragEvent);
    });
    root.addEventListener('dragleave', (event) => {
      (event.target as Element | null)?.closest('.jn-gap')?.classList.remove('over');
    });
    root.addEventListener('drop', (event) => {
      this.drop(event as DragEvent);
    });
    root.addEventListener('dragend', () => {
      this.endCarry();
    });
    root.addEventListener(
      'wheel',
      (event) => {
        this.wheel(event as WheelEvent);
      },
      { passive: false },
    );
  }

  private get ui(): JourneyUi {
    return this.host.state.lib.journey;
  }

  private get publish(): boolean {
    const state = this.host.state;
    return can(state, 'PUBLISH') && state.project !== undefined && state.project.state !== 'ARCHIVED';
  }

  private projectId(): string | undefined {
    return this.host.state.project?.id;
  }

  private focus(selector: string): void {
    this.host.root.querySelector<HTMLElement>(selector)?.focus();
  }

  // ── Chargement ─────────────────────────────────────────────────────────────────────────────

  /** Les parcours enregistrés du projet (un autre projet repart d'un parcours vide). */
  async loadList(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    if (!api || !projectId) return;
    if (this.ui.projectId !== projectId) this.host.state.lib.journey = { ...emptyJourneyUi(), projectId };
    try {
      const list = await api.journeys.list(projectId);
      if (this.projectId() !== projectId) return;
      this.ui.list = list;
      this.host.paint();
    } catch {
      // La liste n'est qu'une aide : le compositeur reste utilisable sans elle.
    }
  }

  // ── Vérification ───────────────────────────────────────────────────────────────────────────

  /** Une vérification du serveur après chaque modification de la logique (regroupées). */
  scheduleCheck(delay = 350): void {
    if (this.checkTimer) clearTimeout(this.checkTimer);
    this.checkTimer = setTimeout(() => {
      this.checkTimer = undefined;
      void this.check();
    }, delay);
  }

  async check(): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    if (!api || !projectId) return;
    const ui = this.ui;
    const sequence = ++this.checkSequence;
    const key = logicKey(ui.journey);
    // Le nom ne compte pas pour la vérification : un parcours sans nom se vérifie aussi.
    const journey: Journey = { ...ui.journey, name: ui.journey.name.trim() || 'parcours' };
    ui.checking = true;
    this.host.paint();
    try {
      const check = await api.journeys.check(projectId, journey);
      if (sequence !== this.checkSequence) return;
      ui.check = check;
      ui.checkedFor = key;
    } catch (error) {
      if (sequence !== this.checkSequence) return;
      ui.error = message(error);
      ui.details = detailsOf(error);
    }
    ui.checking = false;
    this.host.paint();
  }

  /** Après une modification : redessin, puis vérification. */
  private changed(focus?: string): void {
    this.ui.error = undefined;
    this.ui.details = undefined;
    this.host.paint();
    if (focus) this.focus(focus);
    this.scheduleCheck();
  }

  // ── Actions ────────────────────────────────────────────────────────────────────────────────

  /** Ajoute un bloc de la bibliothèque au parcours (bouton d'une carte, de la fiche ou de la palette). */
  addBlockNamed(name: string): void {
    const block = this.host.state.lib.blocks?.find((entry) => entry.name === name);
    if (!block || !this.publish) return;
    const id = addBlock(this.ui, block);
    this.changed();
    this.focus(
      `[data-jn-node="${CSS.escape(id)}"] [data-action="jn-select"], .jn-node[data-jn-node="${CSS.escape(id)}"]`,
    );
  }

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    const data = target.dataset;
    switch (action) {
      case 'jn-add':
        if (data.block) this.addBlockNamed(data.block);
        return true;
      case 'jn-shape': {
        if (!this.publish) return true;
        const kind = data.kind;
        if (kind === 'CONDITION' || kind === 'JOIN' || kind === 'END') {
          const center = this.visibleCenter();
          addShape(ui, kind, center ? center.x - NODE_SIZE[kind].w / 2 : undefined, center?.y);
          this.changed();
        }
        return true;
      }
      case 'jn-select':
        if (data.node) {
          ui.selected = { kind: 'node', id: data.node };
          this.host.paint();
        }
        return true;
      case 'jn-select-edge':
        if (data.edge) {
          ui.selected = { kind: 'edge', id: data.edge };
          this.host.paint();
        }
        return true;
      case 'jn-deselect':
        ui.selected = undefined;
        this.host.paint();
        return true;
      case 'jn-move':
        if (data.node && moveBlock(ui, data.node, Number(data.to)))
          this.changed(`.jn-card[data-jn-node="${CSS.escape(data.node)}"] [data-action="jn-select"]`);
        return true;
      case 'jn-remove':
        if (data.node && removeNode(ui, data.node)) this.changed();
        return true;
      case 'jn-duplicate':
        if (data.node && duplicateNode(ui, data.node)) this.changed();
        return true;
      case 'jn-edge-remove':
        if (data.edge && removeEdge(ui, data.edge)) this.changed();
        return true;
      case 'jn-connect': {
        if (!data.node || !this.connectTo) return true;
        const refused = connect(ui, data.node, this.connectTo, this.connectBranch);
        if (refused) {
          ui.error = refused;
          this.host.paint();
          return true;
        }
        this.connectTo = '';
        this.changed();
        return true;
      }
      case 'jn-accept-version':
        if (data.node) {
          acceptVersion(ui, data.node, Number(data.version));
          this.changed();
        }
        return true;
      case 'jn-mode': {
        const mode = data.mode === 'DIAGRAM' ? 'DIAGRAM' : 'LINEAR';
        const refused = switchMode(ui, mode);
        const t = journeyText(this.host.state);
        ui.modeMessage = refused ? t.linearRefused(refused) : undefined;
        this.host.paint();
        if (!refused && mode === 'DIAGRAM') this.fit();
        this.focus(`#jn-mode-${ui.journey.mode}`);
        return true;
      }
      case 'jn-undo':
        if (undo(ui)) this.changed();
        return true;
      case 'jn-redo':
        if (redo(ui)) this.changed();
        return true;
      case 'jn-check':
        void this.check();
        return true;
      case 'jn-save':
        void this.save();
        return true;
      case 'jn-publish':
        if (ui.check?.publishable === 'PER_PATH') {
          ui.confirmPerPath = true;
          this.host.paint();
          this.focus('[data-action="jn-publish-paths"]');
        } else void this.publishNow(false);
        return true;
      case 'jn-publish-paths':
        ui.confirmPerPath = false;
        void this.publishNow(true);
        return true;
      case 'jn-publish-cancel':
        ui.confirmPerPath = false;
        this.host.paint();
        return true;
      case 'jn-new':
        if (ui.dirty) {
          ui.confirmDiscard = '\u0000new';
          this.host.paint();
        } else this.reset();
        return true;
      case 'jn-discard-yes': {
        const target1 = ui.confirmDiscard;
        ui.confirmDiscard = undefined;
        if (target1 === '\u0000new') this.reset();
        else if (target1) void this.open(target1);
        return true;
      }
      case 'jn-discard-no':
        ui.confirmDiscard = undefined;
        this.host.paint();
        return true;
      case 'jn-zoom':
        this.zoomBy(Number(data.step) > 0 ? 1.2 : 1 / 1.2);
        return true;
      case 'jn-fit':
        this.fit();
        return true;
      case 'jn-actual':
        ui.zoom = 1;
        this.host.paint();
        return true;
      case 'jn-group': {
        // Le repli natif de <details> suit ce clic : l'état est gardé pour les redessins.
        const group = data.group ?? '';
        ui.paletteClosed = ui.paletteClosed.includes(group)
          ? ui.paletteClosed.filter((entry) => entry !== group)
          : [...ui.paletteClosed, group];
        return true;
      }
      default:
        return false;
    }
  }

  /** Un champ `data-jn` (saisie ou choix). `true` : traité. */
  field(target: HTMLInputElement | HTMLSelectElement | HTMLTextAreaElement, committed: boolean): boolean {
    const key = target.dataset.jn;
    if (key === undefined) return false;
    const ui = this.ui;
    const value = target.value;
    const selected = ui.selected?.kind === 'node' ? ui.selected.id : undefined;
    switch (key) {
      case 'name':
        // Jamais de redessin pour le nom : un redessin à la perte du focus avalerait le clic qui la provoque
        // (le bouton serait remplacé entre l'appui et le relâchement). « Enregistrer » dit s'il manque.
        if (ui.journey.name !== value) {
          if (!ui.dirty) remember(ui);
          ui.journey.name = value.slice(0, 80);
          ui.dirty = true;
        }
        return true;
      case 'description':
        ui.journey.description = value.slice(0, 500);
        ui.dirty = true;
        return true;
      case 'palette':
        ui.paletteQuery = value;
        // La recherche se redessine sans perdre le focus du champ.
        this.host.paint();
        this.focus('[data-jn="palette"]');
        return true;
      case 'open':
        if (!committed || !value) return true;
        if (ui.dirty) {
          ui.confirmDiscard = value;
          this.host.paint();
        } else void this.open(value);
        return true;
      case 'label':
        if (selected) {
          setLabel(ui, selected, value);
          if (committed) this.changed();
        }
        return true;
      case 'param.mode':
        if (selected && committed && target.dataset.key) {
          const mode = value;
          setParam(
            ui,
            selected,
            target.dataset.key,
            mode === 'VALUE'
              ? { mode: 'VALUE', value: '' }
              : mode === 'MAP'
                ? { mode: 'MAP', key: '' }
                : undefined,
          );
          this.changed(
            `[data-jn="param.${mode === 'MAP' ? 'key' : 'value'}"][data-key="${CSS.escape(target.dataset.key)}"]`,
          );
        }
        return true;
      case 'param.value':
      case 'param.key':
        if (selected && target.dataset.key) {
          setParam(
            ui,
            selected,
            target.dataset.key,
            key === 'param.value' ? { mode: 'VALUE', value } : { mode: 'MAP', key: value.trim() },
          );
          if (committed) this.changed();
        }
        return true;
      case 'connect.to':
        this.connectTo = value;
        return true;
      case 'connect.branch':
        this.connectBranch = value === 'NO' ? 'NO' : 'YES';
        return true;
      case 'edge.branch':
        if (ui.selected?.kind === 'edge' && committed) {
          setBranch(ui, ui.selected.id, value === 'NO' ? 'NO' : 'YES');
          this.changed();
        }
        return true;
      default:
        return false;
    }
  }

  keydown(event: KeyboardEvent): boolean {
    if (this.host.state.route.view !== 'library') return false;
    const target = event.composedPath()[0] as HTMLElement | undefined;
    if (!target?.closest('#lib-composer')) return false;
    const typing = target.closest('input, textarea, select') !== null;
    const ui = this.ui;
    if (
      (event.ctrlKey || event.metaKey) &&
      !typing &&
      (event.key === 'z' || event.key === 'Z' || event.key === 'y')
    ) {
      event.preventDefault();
      if (event.key === 'y' || event.shiftKey ? redo(ui) : undo(ui)) this.changed();
      return true;
    }
    if (typing) return false;
    if ((event.key === 'Delete' || event.key === 'Backspace') && ui.selected && this.publish) {
      event.preventDefault();
      const done =
        ui.selected.kind === 'node' ? removeNode(ui, ui.selected.id) : removeEdge(ui, ui.selected.id);
      if (done) this.changed('[data-jn-stage]');
      return true;
    }
    if (event.key === 'Escape' && ui.selected) {
      ui.selected = undefined;
      this.host.paint();
      return true;
    }
    if ((event.key === 'Enter' || event.key === ' ') && target.classList.contains('jn-node')) {
      event.preventDefault();
      const id = target.dataset.node;
      if (id) {
        ui.selected = { kind: 'node', id };
        this.host.paint();
        this.focus(`.jn-node[data-jn-node="${CSS.escape(id)}"]`);
      }
      return true;
    }
    return false;
  }

  // ── Serveur ────────────────────────────────────────────────────────────────────────────────

  private reset(): void {
    const projectId = this.ui.projectId;
    const list = this.ui.list;
    this.host.state.lib.journey = {
      ...emptyJourneyUi(),
      ...(projectId ? { projectId } : {}),
      ...(list ? { list } : {}),
    };
    this.host.paint();
    this.focus('[data-jn="name"]');
  }

  async open(name: string): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    if (!api || !projectId) return;
    try {
      const journey = await api.journeys.open(projectId, name);
      const list = this.ui.list;
      this.host.state.lib.journey = {
        ...emptyJourneyUi(),
        projectId,
        ...(list ? { list } : {}),
        journey,
        savedName: journey.name,
        ...(journey.revision ? { savedRevision: journey.revision } : {}),
      };
      this.host.paint();
      if (journey.mode === 'DIAGRAM') this.fit();
      void this.check();
    } catch (error) {
      this.ui.error = message(error);
      this.host.paint();
    }
  }

  async save(): Promise<boolean> {
    const api = this.host.api();
    const projectId = this.projectId();
    const ui = this.ui;
    const t = journeyText(this.host.state);
    if (!api || !projectId || ui.saving) return false;
    if (ui.journey.name.trim() === '') {
      ui.error = t.nameRequired;
      this.host.paint();
      this.focus('[data-jn="name"]');
      return false;
    }
    ui.saving = true;
    ui.error = undefined;
    ui.details = undefined;
    this.host.paint();
    let ok = false;
    try {
      const saved = await api.journeys.save(projectId, ui.journey, {
        ...(ui.savedRevision ? { revision: ui.savedRevision } : {}),
        ...(ui.savedName ? { previous: ui.savedName } : {}),
      });
      ui.journey = { ...ui.journey, ...saved };
      ui.savedName = saved.name;
      if (saved.revision) ui.savedRevision = saved.revision;
      ui.dirty = false;
      ui.saveState = 'saved';
      ui.notice = t.savedNotice(saved.name);
      ok = true;
      void this.loadList();
    } catch (error) {
      ui.saveState = 'failed';
      ui.error = message(error);
      ui.details = detailsOf(error);
    }
    ui.saving = false;
    this.host.paint();
    return ok;
  }

  private async publishNow(perPath: boolean): Promise<void> {
    const api = this.host.api();
    const projectId = this.projectId();
    const ui = this.ui;
    const t = journeyText(this.host.state);
    if (!api || !projectId || ui.publishing || !ui.savedName) return;
    ui.publishing = true;
    ui.error = undefined;
    ui.details = undefined;
    this.host.paint();
    try {
      const result = await api.journeys.publish(projectId, ui.savedName, { perPath });
      ui.journey.published = [...new Set([...(ui.journey.published ?? []), ...result.scenarios])];
      ui.notice = t.createdNotice(result.scenarios.join(', '));
      this.host.state.lib.composed = result.scenarios[0];
      await this.host.refresh();
      void this.loadList();
    } catch (error) {
      ui.error = message(error);
      ui.details = detailsOf(error);
    }
    ui.publishing = false;
    this.host.paint();
  }

  // ── Glisser-déposer natif (palette → parcours, cartes entre elles) ─────────────────────────

  private dragStart(event: DragEvent): void {
    const target = event.target as Element | null;
    if (!target?.closest || !this.publish) return;
    const block = target.closest<HTMLElement>('[data-jn-block]');
    const card = target.closest<HTMLElement>('.jn-card[data-jn-node]');
    const shape = target.closest<HTMLElement>('[data-jn-shape]');
    if (block?.dataset.jnBlock) this.carried = { kind: 'block', name: block.dataset.jnBlock };
    else if (card?.dataset.jnNode) {
      this.carried = { kind: 'node', id: card.dataset.jnNode };
      card.classList.add('moving');
    } else if (shape?.dataset.jnShape) {
      const kind = shape.dataset.jnShape;
      if (kind === 'CONDITION' || kind === 'JOIN' || kind === 'END')
        this.carried = { kind: 'shape', shape: kind };
    }
    if (!this.carried) return;
    event.dataTransfer?.setData(
      'text/plain',
      this.carried.kind === 'block' ? this.carried.name : this.carried.kind,
    );
    if (event.dataTransfer) event.dataTransfer.effectAllowed = this.carried.kind === 'node' ? 'move' : 'copy';
    this.host.root.querySelector('.jn-line')?.classList.add('jn-dragging');
  }

  private dropZone(event: DragEvent): { gap?: number; canvas?: HTMLElement; line?: boolean } | undefined {
    const target = event.target as Element | null;
    if (!target?.closest || !this.carried) return undefined;
    const gap = target.closest<HTMLElement>('.jn-gap');
    if (gap?.dataset.jnGap !== undefined) return { gap: Number(gap.dataset.jnGap) };
    const canvas = target.closest<HTMLElement>('[data-jn-canvas]');
    if (canvas && this.carried.kind !== 'node') return { canvas };
    if (target.closest('.jn-line') && this.carried.kind !== 'shape') return { line: true };
    return undefined;
  }

  private dragOver(event: DragEvent): void {
    const zone = this.dropZone(event);
    if (!zone) return;
    event.preventDefault();
    const target = event.target as Element;
    for (const element of this.host.root.querySelectorAll('.jn-gap.over')) element.classList.remove('over');
    target.closest('.jn-gap')?.classList.add('over');
    target.closest('[data-jn-canvas]')?.classList.add('drop');
  }

  private drop(event: DragEvent): void {
    const zone = this.dropZone(event);
    const carried = this.carried;
    if (!zone || !carried) return;
    event.preventDefault();
    const ui = this.ui;
    const blocks = this.host.state.lib.blocks ?? [];
    if (zone.canvas) {
      const point = this.worldPoint(zone.canvas, event.clientX, event.clientY);
      if (carried.kind === 'block') {
        const block = blocks.find((entry) => entry.name === carried.name);
        if (block)
          addBlock(ui, block, { x: point.x - NODE_SIZE.BLOCK.w / 2, y: point.y - NODE_SIZE.BLOCK.h / 2 });
      } else if (carried.kind === 'shape')
        addShape(
          ui,
          carried.shape,
          point.x - NODE_SIZE[carried.shape].w / 2,
          point.y - NODE_SIZE[carried.shape].h / 2,
        );
    } else {
      const order = blocks;
      const index = zone.gap ?? Number.MAX_SAFE_INTEGER;
      if (carried.kind === 'block') {
        const block = order.find((entry) => entry.name === carried.name);
        if (block) addBlock(ui, block, { index });
      } else if (carried.kind === 'node') {
        const cards = [...this.host.root.querySelectorAll<HTMLElement>('.jn-card[data-jn-node]')].map(
          (element) => element.dataset.jnNode,
        );
        const from = cards.indexOf(carried.id);
        const to = index === Number.MAX_SAFE_INTEGER ? cards.length - 1 : from < index ? index - 1 : index;
        moveBlock(ui, carried.id, to);
      }
    }
    this.endCarry();
    this.changed();
  }

  private endCarry(): void {
    this.carried = undefined;
    for (const element of this.host.root.querySelectorAll(
      '.jn-gap.over, .jn-card.moving, .jn-dragging, .jn-canvas.drop',
    ))
      element.classList.remove('over', 'moving', 'jn-dragging', 'drop');
  }

  // ── Gestes du diagramme ────────────────────────────────────────────────────────────────────

  private worldPoint(canvas: HTMLElement, clientX: number, clientY: number): { x: number; y: number } {
    const rect = canvas.getBoundingClientRect();
    const ui = this.ui;
    return { x: (clientX - rect.left - ui.panX) / ui.zoom, y: (clientY - rect.top - ui.panY) / ui.zoom };
  }

  private visibleCenter(): { x: number; y: number } | undefined {
    const canvas = this.host.root.querySelector<HTMLElement>('[data-jn-canvas]');
    if (!canvas) return undefined;
    const rect = canvas.getBoundingClientRect();
    return this.worldPoint(canvas, rect.left + rect.width / 2, rect.top + rect.height / 3);
  }

  private pointerDown(event: PointerEvent): void {
    if (event.button !== 0 || this.ui.journey.mode !== 'DIAGRAM') return;
    const target = event.target as Element | null;
    const canvas = target?.closest<HTMLElement>('[data-jn-canvas]');
    if (!target || !canvas || target.closest('.jn-tools')) return;
    const ui = this.ui;
    const port = target.closest<HTMLElement>('[data-jn-port]');
    if (port && this.publish) {
      const from = ui.journey.graph.nodes.find((node) => node.id === port.dataset.jnPort);
      const temp = canvas.querySelector<SVGPathElement>('.jn-temp');
      if (!from || !temp) return;
      const branch = port.dataset.branch === 'NO' ? 'NO' : port.dataset.branch === 'YES' ? 'YES' : undefined;
      this.drag = {
        kind: 'link',
        from: from.id,
        ...(branch ? { branch } : {}),
        origin: portOf(from, branch),
        temp,
      };
      event.preventDefault();
      return;
    }
    const nodeElement = target.closest<HTMLElement>('.jn-node');
    if (nodeElement?.dataset.jnNode) {
      const node = ui.journey.graph.nodes.find((entry) => entry.id === nodeElement.dataset.jnNode);
      if (!node || !this.publish) return;
      this.drag = {
        kind: 'node',
        id: node.id,
        x0: event.clientX,
        y0: event.clientY,
        nx: node.x,
        ny: node.y,
        moved: false,
        el: nodeElement,
      };
      return;
    }
    if (target.closest('.jn-hit')) return;
    const world = canvas.querySelector<HTMLElement>('.jn-world');
    if (!world) return;
    this.drag = {
      kind: 'pan',
      x0: event.clientX,
      y0: event.clientY,
      px: ui.panX,
      py: ui.panY,
      moved: false,
      world,
    };
    canvas.classList.add('panning');
  }

  private pointerMove(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    const ui = this.ui;
    if (drag.kind === 'pan') {
      const dx = event.clientX - drag.x0;
      const dy = event.clientY - drag.y0;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      ui.panX = drag.px + dx;
      ui.panY = drag.py + dy;
      drag.world.style.transform = `translate(${String(ui.panX)}px,${String(ui.panY)}px) scale(${String(ui.zoom)})`;
      return;
    }
    if (drag.kind === 'node') {
      const dx = (event.clientX - drag.x0) / ui.zoom;
      const dy = (event.clientY - drag.y0) / ui.zoom;
      if (!drag.moved && Math.hypot(dx, dy) < 3) return;
      drag.moved = true;
      drag.el.classList.add('dragging');
      const x = Math.round(drag.nx + dx);
      const y = Math.round(drag.ny + dy);
      drag.el.style.left = `${String(x)}px`;
      drag.el.style.top = `${String(y)}px`;
      // Les connexions du nœud suivent, sans redessiner l'écran.
      const graph = ui.journey.graph;
      const moved = (node: JourneyNode): JourneyNode => (node.id === drag.id ? { ...node, x, y } : node);
      for (const edge of graph.edges) {
        if (edge.from !== drag.id && edge.to !== drag.id) continue;
        const from = graph.nodes.find((node) => node.id === edge.from);
        const to = graph.nodes.find((node) => node.id === edge.to);
        if (!from || !to) continue;
        const d = edgePath(moved(from), moved(to), edge.branch);
        for (const path of this.host.root.querySelectorAll(`[data-jn-edge="${CSS.escape(edge.id)}"] path`))
          path.setAttribute('d', d);
      }
      return;
    }
    const canvas =
      drag.temp.closest<HTMLElement>('[data-jn-canvas]') ??
      this.host.root.querySelector<HTMLElement>('[data-jn-canvas]');
    if (!canvas) return;
    const point = this.worldPoint(canvas, event.clientX, event.clientY);
    drag.temp.setAttribute(
      'd',
      `M${String(drag.origin.x)} ${String(drag.origin.y)} L${String(point.x)} ${String(point.y)}`,
    );
    for (const element of this.host.root.querySelectorAll('.jn-node.target'))
      element.classList.remove('target');
    this.nodeAt(event.clientX, event.clientY)?.classList.add('target');
  }

  private nodeAt(clientX: number, clientY: number): HTMLElement | undefined {
    const element = this.host.root.elementFromPoint(clientX, clientY);
    return element?.closest<HTMLElement>('.jn-node') ?? undefined;
  }

  private pointerUp(event: PointerEvent): void {
    const drag = this.drag;
    if (!drag) return;
    this.drag = undefined;
    const ui = this.ui;
    if (drag.kind === 'pan') {
      this.host.root.querySelector('[data-jn-canvas]')?.classList.remove('panning');
      if (!drag.moved && ui.selected) {
        ui.selected = undefined;
        this.host.paint();
      }
      return;
    }
    if (drag.kind === 'node') {
      drag.el.classList.remove('dragging');
      if (!drag.moved) return;
      const x = drag.nx + (event.clientX - drag.x0) / ui.zoom;
      const y = drag.ny + (event.clientY - drag.y0) / ui.zoom;
      placeNode(ui, drag.id, x, y);
      ui.selected = { kind: 'node', id: drag.id };
      // Une position ne change pas la logique : pas de nouvelle vérification.
      this.host.paint();
      return;
    }
    drag.temp.setAttribute('d', '');
    const target = this.nodeAt(event.clientX, event.clientY);
    for (const element of this.host.root.querySelectorAll('.jn-node.target'))
      element.classList.remove('target');
    const to = target?.dataset.jnNode;
    if (!to || to === drag.from) return;
    const refused = connect(ui, drag.from, to, drag.branch);
    if (refused) {
      ui.error = refused;
      this.host.paint();
      return;
    }
    this.changed();
  }

  private cancelDrag(): void {
    const drag = this.drag;
    this.drag = undefined;
    if (drag?.kind === 'link') drag.temp.setAttribute('d', '');
    if (drag) this.host.paint();
  }

  private wheel(event: WheelEvent): void {
    if (!(event.ctrlKey || event.metaKey)) return;
    const canvas = (event.target as Element | null)?.closest<HTMLElement>('[data-jn-canvas]');
    if (!canvas) return;
    event.preventDefault();
    const rect = canvas.getBoundingClientRect();
    this.zoomBy(event.deltaY < 0 ? 1.1 : 1 / 1.1, {
      x: event.clientX - rect.left,
      y: event.clientY - rect.top,
    });
  }

  /** Zoome autour d'un point de la vue (le centre par défaut). */
  private zoomBy(factor: number, around?: { x: number; y: number }): void {
    const ui = this.ui;
    const canvas = this.host.root.querySelector<HTMLElement>('[data-jn-canvas]');
    const point = around ?? { x: (canvas?.clientWidth ?? 600) / 2, y: (canvas?.clientHeight ?? 400) / 2 };
    const zoom = Math.max(ZOOM_MIN, Math.min(ZOOM_MAX, ui.zoom * factor));
    const wx = (point.x - ui.panX) / ui.zoom;
    const wy = (point.y - ui.panY) / ui.zoom;
    ui.zoom = zoom;
    ui.panX = point.x - wx * zoom;
    ui.panY = point.y - wy * zoom;
    this.host.paint();
  }

  /** Ajuste la vue au diagramme entier. */
  fit(): void {
    const ui = this.ui;
    const canvas = this.host.root.querySelector<HTMLElement>('[data-jn-canvas]');
    if (!canvas || ui.journey.graph.nodes.length === 0) return;
    const box = bounds(ui.journey.graph);
    const width = Math.max(1, box.maxX - box.minX);
    const height = Math.max(1, box.maxY - box.minY);
    const zoom = Math.max(
      ZOOM_MIN,
      Math.min(1, (canvas.clientWidth - 80) / width, (canvas.clientHeight - 90) / height),
    );
    ui.zoom = Math.round(zoom * 100) / 100;
    ui.panX = Math.round((canvas.clientWidth - width * ui.zoom) / 2 - box.minX * ui.zoom);
    ui.panY = Math.round(Math.max(48, (canvas.clientHeight - height * ui.zoom) / 2) - box.minY * ui.zoom);
    this.host.paint();
  }
}
