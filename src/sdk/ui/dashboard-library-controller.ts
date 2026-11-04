import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import { DATA_TYPES, type FieldDeclaration } from '../core/contracts.js';
import { fieldsText } from './dashboard-library-fields.js';
import { newOutputForm, outputRequest, outputText, type OutputForm } from './dashboard-library-output.js';
import { OUTPUT_SOURCES } from '../core/contracts.js';
import { RECENT_MAX, type LibraryUi } from './dashboard-library.js';
import { PAGE_SIZES } from './dashboard-library-catalog.js';
import { journeyOfParts } from '../core/journey.js';
import { SHEET_TABS, type SheetTab } from './dashboard-library-sheet.js';
import { defaultWait, sanitizeWait } from '../core/wait.js';
import { journeyText } from './dashboard-journey.js';
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
      const saved = raw
        ? (JSON.parse(raw) as { recent?: unknown; layout?: unknown; pageSize?: unknown })
        : {};
      this.ui.recent = Array.isArray(saved.recent)
        ? saved.recent.filter((entry): entry is string => typeof entry === 'string').slice(0, RECENT_MAX)
        : [];
      if (saved.layout === 'grid' || saved.layout === 'list') this.ui.layout = saved.layout;
      if (PAGE_SIZES.some((size) => size === saved.pageSize)) this.ui.pageSize = saved.pageSize as number;
    } catch {
      this.ui.recent = [];
    }
  }

  /** Les préférences du catalogue (récents, affichage, blocs par page), gardées par le navigateur. */
  savePrefs(): void {
    this.save();
  }

  private save(): void {
    const projectId = this.projectId();
    if (!projectId) return;
    try {
      globalThis.localStorage.setItem(
        storageKey(projectId),
        JSON.stringify({ recent: this.ui.recent, layout: this.ui.layout, pageSize: this.ui.pageSize }),
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
    // Depuis le catalogue (ou sa fiche ancrée) : la fiche reste à côté du catalogue.
    ui.sheet = { block, tab, ...(ui.tab === 'catalog' ? { docked: true } : {}) };
    ui.confirmRemove = undefined;
    ui.contract = undefined;
    ui.error = undefined;
    ui.notice = undefined;
    ui.recent = [block, ...ui.recent.filter((entry) => entry !== block)].slice(0, RECENT_MAX);
    this.save();
    this.host.paint();
    this.focus(`#lib-tab-${tab}`);
    void this.loadDetails();
    void this.loadActivity();
  }

  /** La dernière exécution réelle qui a rejoué le bloc, et ce que sa trace a observé (rien n'est exécuté). */
  async loadActivity(): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !api || !projectId) return;
    const block = sheet.block;
    sheet.activityLoading = true;
    sheet.activityError = undefined;
    try {
      const activity = await api.library.activity(projectId, block);
      if (this.ui.sheet?.block !== block) return;
      this.ui.sheet.activity = activity;
    } catch (error) {
      if (this.ui.sheet?.block !== block) return;
      this.ui.sheet.activityError = message(error);
    }
    this.ui.sheet.activityLoading = false;
    this.paintKeepingFocus(`#lib-tab-${this.ui.sheet.tab}`);
  }

  /** « Prévisualiser » : l'aperçu statique réel d'un parcours fait de ce seul bloc (rien n'est exécuté). */
  private async preview(): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    const block = this.ui.blocks?.find((entry) => entry.name === sheet?.block);
    if (!sheet || !api || !projectId || !block || sheet.preview?.busy) return;
    sheet.preview = { busy: true };
    this.host.paint();
    try {
      const data = await api.journeys.preview(
        projectId,
        journeyOfParts(block.name, [{ block: block.name, version: block.version }]),
      );
      if (this.ui.sheet?.block === block.name) this.ui.sheet.preview = { data };
    } catch (error) {
      if (this.ui.sheet?.block === block.name) this.ui.sheet.preview = { error: message(error) };
    }
    this.paintKeepingFocus('[data-action="lib-preview-close"]');
  }

  /** « Dupliquer » : un nouveau bloc copié, puis sa fiche s'ouvre. */
  async duplicate(): Promise<void> {
    const sheet = this.ui.sheet;
    const form = sheet?.duplicate;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !form || !api || !projectId || form.busy) return;
    const source = sheet.block;
    form.busy = true;
    form.error = undefined;
    this.host.paint();
    try {
      const created = await api.library.duplicate(projectId, source, {
        name: form.name.trim(),
        ...(form.description.trim() ? { description: form.description.trim() } : {}),
      });
      await this.host.refresh();
      this.open(created.name);
      this.ui.notice =
        this.host.state.t.locale === 'en' ? `“${created.name}” created.` : `« ${created.name} » créé.`;
      this.host.paint();
    } catch (error) {
      if (this.ui.sheet?.duplicate) {
        this.ui.sheet.duplicate.busy = false;
        this.ui.sheet.duplicate.error = message(error);
      }
      this.paintKeepingFocus('[data-lib="dup.name"]');
    }
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

  /** Un réglage du formulaire « Insérer une attente » ; changer de type redessine ses champs. */
  waitField(key: string, value: string): void {
    const wait = this.ui.sheet?.wait;
    if (!wait) return;
    if (key === 'after') {
      wait.after = Number(value) || 0;
      return;
    }
    const spec: Record<string, unknown> = { ...wait.spec };
    if (key === 'timeoutS') {
      if (value.trim() === '' || Number.isNaN(Number(value))) return;
      spec.timeoutS = Number(value);
    } else if (key === 'status') spec.status = /^\d+$/.test(value) ? Number(value) : value;
    else if (key === 'method' && value === '') delete spec.method;
    else spec[key] = value;
    wait.spec = sanitizeWait(spec);
    wait.error = undefined;
    if (key === 'type') {
      this.host.paint();
      this.focus('[data-lib="wait.type"]');
    }
  }

  /** Un champ du formulaire « Ajouter une sortie ». Changer la source redessine les champs utiles. */
  outputField(key: string, value: string): void {
    const form = this.ui.sheet?.output;
    if (!form) return;
    if (key === 'source') {
      const source = OUTPUT_SOURCES.find((candidate) => candidate === value);
      if (source) form.source = source;
      form.error = undefined;
      this.host.paint();
      this.focus('[data-lib="output.source"]');
      return;
    }
    if (key === 'after') {
      form.after = Number(value) || 0;
      return;
    }
    if (key in form && key !== 'busy' && key !== 'error')
      (form as unknown as Record<string, string>)[key] = value;
    form.error = undefined;
  }

  /** Ajoute la sortie (serveur) : une étape est insérée, le bloc devient « modifié » (version à valider). */
  private async addOutput(): Promise<void> {
    const sheet = this.ui.sheet;
    const form: OutputForm | undefined = sheet?.output;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !form || !api || !projectId || form.busy) return;
    const block = sheet.block;
    const request = outputRequest(form);
    form.busy = true;
    this.host.paint();
    try {
      const view = await api.library.addOutput(projectId, block, request);
      await this.host.refresh();
      if (this.ui.sheet?.block === block) {
        this.ui.sheet.output = undefined;
        this.ui.sheet.details = undefined;
        this.ui.notice = outputText(this.host.state).done(request.key, view.version + 1);
        this.ui.error = undefined;
      }
      void this.loadDetails();
      this.paintKeepingFocus('[data-action="lib-output-open"]');
      return;
    } catch (error) {
      if (this.ui.sheet?.output) {
        this.ui.sheet.output.busy = false;
        this.ui.sheet.output.error = message(error);
      }
    }
    this.paintKeepingFocus('[data-action="lib-output-add"]');
  }

  /** Insère l'attente (serveur) : le bloc devient « modifié », sa version suivante est à valider. */
  private async insertWait(): Promise<void> {
    const sheet = this.ui.sheet;
    const wait = sheet?.wait;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !wait || !api || !projectId || wait.busy) return;
    const block = sheet.block;
    wait.busy = true;
    this.host.paint();
    try {
      const view = await api.library.insertWait(projectId, block, { after: wait.after, wait: wait.spec });
      await this.host.refresh();
      if (this.ui.sheet?.block === block) {
        this.ui.sheet.wait = undefined;
        this.ui.sheet.details = undefined;
        this.ui.notice = journeyText(this.host.state).insertWaitDone(view.version + 1);
      }
      void this.loadDetails();
      this.paintKeepingFocus('[data-action="lib-wait-open"]');
      return;
    } catch (error) {
      if (this.ui.sheet?.wait) {
        this.ui.sheet.wait.busy = false;
        this.ui.sheet.wait.error = message(error);
      }
    }
    this.paintKeepingFocus('[data-action="lib-wait-insert"]');
  }

  /** Un champ de la donnée en cours de correction (onglets Entrées / Sorties). */
  fieldInput(key: string, value: string): void {
    const edit = this.ui.sheet?.field;
    if (!edit || !['label', 'description', 'meaning', 'type', 'defaultValue'].includes(key)) return;
    (edit as unknown as Record<string, string>)[key] = value;
    edit.error = undefined;
  }

  /**
   * Envoie une déclaration de donnée au serveur. Un changement incompatible d'un bloc utilisé est refusé
   * (409) : la fiche le dit, avec les dépendants, et propose de le valider explicitement.
   */
  private async declare(
    declaration: FieldDeclaration,
    options: { acceptIncompatible?: boolean; focus: string },
  ): Promise<void> {
    const sheet = this.ui.sheet;
    const api = this.host.api();
    const projectId = this.projectId();
    if (!sheet || !api || !projectId) return;
    const block = sheet.block;
    const t = fieldsText(this.host.state);
    if (sheet.field) sheet.field.busy = true;
    this.host.paint();
    try {
      const result = await api.library.declareFields(projectId, block, [declaration], {
        ...(options.acceptIncompatible ? { acceptIncompatible: true } : {}),
      });
      await this.host.refresh();
      if (this.ui.sheet?.block === block) {
        this.ui.sheet.field = undefined;
        const changed = result.incompatible.find((item) => item.key === declaration.key);
        this.ui.notice = changed
          ? t.savedIncompatible(declaration.key, changed.version)
          : t.saved(declaration.key);
        this.ui.error = undefined;
      }
    } catch (error) {
      const refused = error instanceof QaCrawlerError ? error : undefined;
      if (this.ui.sheet?.field) {
        Object.assign(this.ui.sheet.field, {
          busy: false,
          error: message(error),
          details: refused?.details ?? [],
          needsAccept: refused?.status === 409,
        });
      } else this.ui.error = message(error);
    }
    this.paintKeepingFocus(options.focus);
  }

  private fieldOf(target: HTMLElement): { direction: 'input' | 'output'; key: string } | undefined {
    const direction =
      target.dataset.dir === 'output' ? 'output' : target.dataset.dir === 'input' ? 'input' : undefined;
    const key = target.dataset.key;
    return direction && key ? { direction, key } : undefined;
  }

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    const sheet = ui.sheet;
    switch (action) {
      case 'lib-field-edit': {
        const ref = this.fieldOf(target);
        const block = ui.blocks?.find((entry) => entry.name === sheet?.block);
        const fields = block?.contract.fields;
        const field = ref
          ? (ref.direction === 'input' ? fields?.inputs : fields?.outputs)?.find(
              (entry) => entry.key === ref.key,
            )
          : undefined;
        if (!sheet || !ref || !field) return true;
        sheet.field = {
          direction: ref.direction,
          key: ref.key,
          label: field.label ?? '',
          description: field.description ?? '',
          meaning: field.meaning ?? '',
          type: field.typeSource === 'DECLARED' ? field.type : '',
          defaultValue: field.defaultValue ?? '',
        };
        this.host.paint();
        this.focus('[data-lib="field.label"]');
        return true;
      }
      case 'lib-field-cancel':
        if (sheet) sheet.field = undefined;
        this.host.paint();
        return true;
      case 'lib-field-save':
      case 'lib-field-accept': {
        const edit = sheet?.field;
        if (!edit) return true;
        const type = DATA_TYPES.find((entry) => entry === edit.type);
        void this.declare(
          {
            direction: edit.direction,
            key: edit.key,
            ...(edit.label.trim() ? { label: edit.label } : {}),
            ...(edit.description.trim() ? { description: edit.description } : {}),
            ...(edit.meaning.trim() ? { meaning: edit.meaning } : {}),
            ...(type ? { type } : {}),
            ...(edit.direction === 'input' && edit.defaultValue.trim()
              ? { defaultValue: edit.defaultValue }
              : {}),
            ...(edit.confirmed !== undefined ? { confirmed: edit.confirmed } : {}),
          },
          {
            acceptIncompatible: action === 'lib-field-accept',
            focus: `[data-field="${CSS.escape(`${edit.direction}:${edit.key}`)}"] [data-action="lib-field-edit"]`,
          },
        );
        return true;
      }
      case 'lib-field-confirm': {
        const ref = this.fieldOf(target);
        if (ref)
          void this.declare(
            { ...ref, confirmed: true },
            {
              focus: `[data-field="${CSS.escape(`${ref.direction}:${ref.key}`)}"] [data-action="lib-field-edit"]`,
            },
          );
        return true;
      }
      case 'lib-field-expose': {
        const ref = this.fieldOf(target);
        if (!ref || !sheet) return true;
        const expose = target.dataset.value === '1';
        // Retirer une sortie d'un bloc utilisé est incompatible : la fiche l'explique avant de valider.
        sheet.field = {
          ...ref,
          label: '',
          description: '',
          meaning: '',
          type: '',
          defaultValue: '',
          confirmed: expose,
        };
        void this.declare(
          { ...ref, confirmed: expose },
          {
            focus: `[data-field="${CSS.escape(`${ref.direction}:${ref.key}`)}"] [data-action="lib-field-expose"]`,
          },
        );
        return true;
      }
      case 'lib-output-open':
        if (!sheet) return true;
        sheet.tab = 'outputs';
        sheet.output = newOutputForm(sheet.details?.steps.length ?? 0);
        this.host.paint();
        this.focus('[data-lib="output.key"]');
        return true;
      case 'lib-output-cancel':
        if (sheet) sheet.output = undefined;
        this.host.paint();
        this.focus('[data-action="lib-output-open"]');
        return true;
      case 'lib-output-add':
        void this.addOutput();
        return true;
      case 'lib-wait-open':
        if (!sheet) return true;
        sheet.wait = { after: sheet.details?.steps.length ?? 0, spec: defaultWait() };
        this.host.paint();
        this.focus('[data-lib="wait.after"]');
        return true;
      case 'lib-wait-cancel':
        if (sheet) sheet.wait = undefined;
        this.host.paint();
        this.focus('[data-action="lib-wait-open"]');
        return true;
      case 'lib-wait-insert':
        void this.insertWait();
        return true;
      case 'lib-open': {
        // Depuis la traçabilité : la fiche s'ouvre sur l'onglet demandé (les étapes du bloc).
        const tab = SHEET_TABS.find((entry) => entry === target.dataset.sheetTab) ?? 'overview';
        this.open(target.dataset.block ?? '', tab);
        return true;
      }
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
      case 'lib-page': {
        const page = Number(target.dataset.page);
        if (Number.isFinite(page) && page >= 1) ui.page = page;
        this.host.paint();
        this.focus(
          `.lib-pager [data-page="${String(ui.page)}"][aria-current="page"], .lib-pager [data-action="lib-page"]`,
        );
        return true;
      }
      case 'lib-reload':
        ui.error = undefined;
        void this.host.refresh();
        return true;
      case 'lib-preview':
        void this.preview();
        return true;
      case 'lib-preview-close':
        if (sheet) sheet.preview = undefined;
        this.host.paint();
        this.focus('[data-action="lib-preview"]');
        return true;
      case 'lib-edit':
        // Éditer : le contrat du bloc (entrées, sorties, conditions), comme le bouton de l'onglet Contrat.
        // Le formulaire lui-même est ouvert par le tableau de bord (comme « Déclarer le contrat »).
        if (sheet) sheet.tab = 'contract';
        return false;
      case 'lib-dup-open': {
        if (!sheet) return true;
        const text = this.host.state.t.locale === 'en' ? `${sheet.block} (copy)` : `${sheet.block} (copie)`;
        sheet.duplicate = sheet.duplicate ? undefined : { name: text, description: '' };
        this.host.paint();
        this.focus(sheet.duplicate ? '[data-lib="dup.name"]' : '[data-action="lib-dup-open"]');
        return true;
      }
      case 'lib-dup-cancel':
        if (sheet) sheet.duplicate = undefined;
        this.host.paint();
        this.focus('[data-action="lib-dup-open"]');
        return true;
      case 'lib-trace-pick':
        if (!sheet) return true;
        sheet.traceKey = target.dataset.key;
        sheet.tab = 'traceability';
        this.host.paint();
        this.focus(`[data-action="lib-trace-pick"][data-key="${CSS.escape(target.dataset.key ?? '')}"]`);
        return true;
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
    // Une fiche ancrée au catalogue, cachée dans un autre onglet : Échap ne la ferme pas en secret.
    if (sheet.docked && this.ui.tab !== 'catalog') return false;
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
