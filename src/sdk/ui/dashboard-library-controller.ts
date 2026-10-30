import type { QaCrawlerClient } from '../core/client.js';
import { RECENT_MAX, type LibraryUi } from './dashboard-library.js';
import { SHEET_TABS, type SheetTab } from './dashboard-library-sheet.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';

/**
 * LE CONTRÔLEUR DE LA FICHE D'UN BLOC ET DE L'AFFICHAGE DU CATALOGUE. Ouvrir une fiche lit son détail
 * sur le serveur (étapes, groupes internes, données sans valeur) ; comparer avec la source refait
 * l'extraction côté serveur sans rien écrire ; mettre à jour depuis la source n'a lieu qu'après une
 * confirmation explicite, et le bloc passe « à revalider ». Les blocs récents et l'affichage (grille ou
 * liste) sont des préférences de la personne, gardées par son navigateur (jamais indispensables).
 */
export interface LibraryHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  navigate(route: DashboardRoute): void;
  /** Relit la bibliothèque (après une mise à jour). */
  refresh(): Promise<void>;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));

const storageKey = (projectId: string): string => `qa-crawler.library.${projectId}`;

export class LibraryController {
  private sequence = 0;
  private restoredFor: string | undefined;

  constructor(private readonly host: LibraryHost) {}

  private get ui(): LibraryUi {
    return this.host.state.lib;
  }

  private projectId(): string | undefined {
    return this.host.state.project?.id;
  }

  /** Les préférences gardées par le navigateur : lues une fois par projet, ignorées si illisibles. */
  restore(projectId: string): void {
    if (this.restoredFor === projectId) return;
    this.restoredFor = projectId;
    try {
      const raw = globalThis.localStorage.getItem(storageKey(projectId));
      const saved = raw ? (JSON.parse(raw) as { recent?: unknown; layout?: unknown }) : {};
      this.ui.recent = Array.isArray(saved.recent)
        ? saved.recent.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_MAX)
        : [];
      if (saved.layout === 'grid' || saved.layout === 'list') this.ui.layout = saved.layout;
    } catch {
      this.ui.recent = [];
    }
  }

  private save(): void {
    const projectId = this.projectId();
    if (!projectId) return;
    try {
      globalThis.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ recent: this.ui.recent, layout: this.ui.layout }),
      );
    } catch {
      // Stockage indisponible (navigation privée) : la préférence vaut pour la session.
    }
  }

  private focus(selector: string): void {
    this.host.root.querySelector<HTMLElement>(selector)?.focus();
  }

  /** Après un redessin asynchrone : le focus reste dans la fiche (Échap, Tab y restent utilisables). */
  private paintKeepingFocus(fallback: string): void {
    this.host.paint();
    const active = this.host.root.activeElement as HTMLElement | null;
    if (this.ui.sheet && !active?.closest('.lib-fiche')) {
      const target = this.host.root.querySelector<HTMLElement>(fallback);
      if (target && !(target as HTMLButtonElement).disabled) target.focus();
      else this.focus('.lib-fiche');
    }
  }

  /** Ouvre la fiche d'un bloc et lit son détail sur le serveur. */
  open(block: string, tab: SheetTab = 'overview'): void {
    const ui = this.ui;
    if (!ui.blocks?.some((entry) => entry.name === block)) return;
    ui.sheet = { block, tab };
    ui.confirmRemove = undefined;
    ui.contract = undefined;
    ui.error = undefined;
    ui.notice = undefined;
    ui.recent = [block, ...ui.recent.filter((entry) => entry !== block)].slice(0, RECENT_MAX);
    this.save();
    this.host.paint();
    this.focus(`#lib-tab-${tab}`);
    void this.loadDetails();
  }

  async loadDetails(): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !api || !projectId) return;
    const sequence = ++this.sequence;
    const block = sheet.block;
    sheet.loading = true;
    sheet.error = undefined;
    try {
      const details = await api.library.details(projectId, block);
      if (sequence !== this.sequence || this.ui.sheet?.block !== block) return;
      this.ui.sheet.details = details;
    } catch (error) {
      if (sequence !== this.sequence || this.ui.sheet?.block !== block) return;
      this.ui.sheet.error = message(error);
    }
    this.ui.sheet.loading = false;
    this.paintKeepingFocus(`#lib-tab-${this.ui.sheet.tab}`);
  }

  close(): void {
    const block = this.ui.sheet?.block;
    this.ui.sheet = undefined;
    this.ui.contract = undefined;
    this.ui.confirmRemove = undefined;
    this.host.paint();
    if (block) this.focus(`.lib-card[data-block="${CSS.escape(block)}"] .lib-title`);
  }

  private async compare(): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !api || !projectId || sheet.comparing) return;
    const block = sheet.block;
    sheet.comparing = true;
    sheet.comparison = undefined;
    sheet.confirmUpdate = false;
    this.host.paint();
    try {
      const comparison = await api.library.compareSource(projectId, block);
      if (this.ui.sheet?.block === block) this.ui.sheet.comparison = comparison;
    } catch (error) {
      this.ui.error = message(error);
    }
    if (this.ui.sheet) this.ui.sheet.comparing = false;
    this.paintKeepingFocus(
      this.ui.sheet?.comparison?.status === 'DIFFERENT'
        ? '[data-action="lib-update-ask"]'
        : '[data-action="lib-compare"]',
    );
  }

  /** La mise à jour demandée et confirmée : le nouveau contenu, à valider comme nouvelle version. */
  private async update(): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !api || !projectId || sheet.updating) return;
    const block = sheet.block;
    sheet.updating = true;
    this.host.paint();
    try {
      await api.library.updateFromSource(projectId, block);
      await this.host.refresh();
      if (this.ui.sheet?.block === block) {
        Object.assign(this.ui.sheet, { comparison: undefined, confirmUpdate: false, details: undefined });
        this.ui.notice = this.host.state.t.lib.sourceTaken(block);
      }
      void this.loadDetails();
    } catch (error) {
      this.ui.error = message(error);
    }
    if (this.ui.sheet) this.ui.sheet.updating = false;
    this.paintKeepingFocus('[data-action="lib-compare"]');
  }

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    const sheet = ui.sheet;
    switch (action) {
      case 'lib-open':
        this.open(target.dataset.block ?? '');
        return true;
      case 'lib-sheet-close':
        this.close();
        return true;
      case 'lib-sheet-tab': {
        const tab = SHEET_TABS.find((entry) => entry === target.dataset.tab);
        if (!sheet || !tab) return true;
        sheet.tab = tab;
        this.host.paint();
        this.focus(`#lib-tab-${tab}`);
        return true;
      }
      case 'lib-layout':
        ui.layout = target.dataset.layout === 'list' ? 'list' : 'grid';
        this.save();
        this.host.paint();
        this.focus(`[data-action="lib-layout"][data-layout="${ui.layout}"]`);
        return true;
      case 'lib-compare':
        void this.compare();
        return true;
      case 'lib-update-ask':
        if (sheet) sheet.confirmUpdate = true;
        this.host.paint();
        this.focus('[data-action="lib-update-yes"]');
        return true;
      case 'lib-update-no':
        if (sheet) sheet.confirmUpdate = false;
        this.host.paint();
        this.focus('[data-action="lib-update-ask"]');
        return true;
      case 'lib-update-yes':
        void this.update();
        return true;
      case 'nav-recording': {
        const projectId = this.projectId();
        const name = target.dataset.name;
        if (!projectId || !name) return true;
        ui.sheet = undefined;
        this.host.navigate({ view: 'recording', projectId, name });
        return true;
      }
      default:
        return false;
    }
  }

  /** Échap ferme la fiche ; les flèches passent d'un onglet à l'autre. */
  keydown(event: KeyboardEvent): boolean {
    const sheet = this.ui.sheet;
    if (!sheet || this.host.state.route.view !== 'library') return false;
    if (event.key === 'Escape') {
      this.close();
      return true;
    }
    const target = event.target as HTMLElement | null;
    if (target?.dataset.action !== 'lib-sheet-tab') return false;
    const at = SHEET_TABS.indexOf(sheet.tab);
    const next =
      event.key === 'ArrowRight'
        ? SHEET_TABS[(at + 1) % SHEET_TABS.length]
        : event.key === 'ArrowLeft'
          ? SHEET_TABS[(at - 1 + SHEET_TABS.length) % SHEET_TABS.length]
          : event.key === 'Home'
            ? SHEET_TABS[0]
            : event.key === 'End'
              ? SHEET_TABS[SHEET_TABS.length - 1]
              : undefined;
    if (!next) return false;
    event.preventDefault();
    sheet.tab = next;
    this.host.paint();
    this.focus(`#lib-tab-${next}`);
    return true;
  }
}
