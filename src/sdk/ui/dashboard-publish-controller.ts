import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import { emptyPublishUi, extractionInputOf, planKey, type PublishUi } from './dashboard-publish.js';
import type { DashboardState } from './dashboard-view.js';

/**
 * LE CONTRÔLEUR DE LA PUBLICATION DE GROUPES (onglet Publier de la revue). Chaque changement de la
 * sélection redemande le plan au serveur (un seul à la fois, le dernier gagne) ; publier refait le plan
 * côté serveur et écrit tous les blocs ou aucun. Rien n'est calculé ici qui ne vienne du serveur.
 */
export interface PublishHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  /** Après une publication : la bibliothèque et le projet (ses scénarios) sont relus. */
  refresh(): Promise<void>;
}

const PLAN_DELAY_MS = 200;

export class PublishController {
  private timer: ReturnType<typeof setTimeout> | undefined;
  private sequence = 0;

  constructor(private readonly host: PublishHost) {}

  private get ui(): PublishUi | undefined {
    const review = this.host.state.review;
    if (!review) return undefined;
    review.publish ??= emptyPublishUi();
    return review.publish;
  }

  private context(): { api: QaCrawlerClient; projectId: string; recording: string } | undefined {
    const route = this.host.state.route;
    const api = this.host.api();
    if (!api || route.view !== 'recording') return undefined;
    return { api, projectId: route.projectId, recording: route.name };
  }

  /** Les groupes cochés, dans l'ordre de l'enregistrement. */
  private ordered(selected: readonly string[]): string[] {
    const groups = this.host.state.review?.studio?.groups ?? [];
    return groups.map((group) => group.id).filter((id) => selected.includes(id));
  }

  private schedulePlan(): void {
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = undefined;
      void this.plan();
    }, PLAN_DELAY_MS);
  }

  /** Le plan de la sélection en cours, calculé par le serveur (rien n'est écrit). */
  async plan(): Promise<void> {
    const ui = this.ui;
    const context = this.context();
    if (!ui || !context) return;
    if (ui.selected.length === 0) {
      ui.plan = undefined;
      ui.planFor = undefined;
      ui.planning = false;
      this.host.paint();
      return;
    }
    const sequence = ++this.sequence;
    const key = planKey(ui);
    ui.planning = true;
    this.host.paint();
    try {
      const plan = await context.api.library.planExtraction(
        context.projectId,
        context.recording,
        extractionInputOf(ui),
      );
      if (sequence !== this.sequence) return;
      ui.plan = plan;
      ui.planFor = key;
      ui.error = undefined;
      ui.details = undefined;
    } catch (error) {
      if (sequence !== this.sequence) return;
      ui.error = error instanceof Error ? error.message : String(error);
      ui.details = error instanceof QaCrawlerError ? error.details : undefined;
    }
    ui.planning = false;
    this.host.paint();
  }

  private async publish(): Promise<void> {
    const ui = this.ui;
    const context = this.context();
    if (!ui || !context || ui.busy || ui.selected.length === 0) return;
    ui.busy = true;
    ui.error = undefined;
    ui.details = undefined;
    this.host.paint();
    try {
      const blocks = await context.api.library.publishExtraction(
        context.projectId,
        context.recording,
        extractionInputOf(ui),
      );
      const names = blocks.map((block) => block.name);
      Object.assign(ui, {
        ...emptyPublishUi(),
        mode: ui.mode,
        navigate: ui.navigate,
        notice: this.host.state.t.pub.published(names.join(', ')),
        published: names,
      });
      await this.host.refresh();
    } catch (error) {
      // La sélection reste ; le serveur dit, bloc par bloc, ce qui ne va pas.
      ui.error = error instanceof Error ? error.message : String(error);
      ui.details = error instanceof QaCrawlerError ? error.details : undefined;
      void this.plan();
    }
    ui.busy = false;
    this.host.paint();
  }

  private focusOn(selector: string): void {
    this.host.root.querySelector<HTMLElement>(selector)?.focus();
  }

  click(action: string, target: HTMLElement): boolean {
    const ui = this.ui;
    if (!ui || !action.startsWith('pub-')) return false;
    const group = target.dataset.group ?? '';
    const key = target.dataset.key ?? '';
    switch (action) {
      case 'pub-focus':
        ui.focus = group;
        this.host.paint();
        this.focusOn(`[data-action="pub-focus"][data-group="${group}"]`);
        return true;
      case 'pub-all':
        ui.selected = this.ordered((this.host.state.review?.studio?.groups ?? []).map((entry) => entry.id));
        ui.notice = undefined;
        this.schedulePlan();
        this.host.paint();
        return true;
      case 'pub-none':
        Object.assign(ui, { selected: [], parts: {}, plan: undefined, planFor: undefined, preview: false });
        this.host.paint();
        return true;
      case 'pub-mode':
        ui.mode = target.dataset.mode === 'composite' ? 'composite' : 'separate';
        this.schedulePlan();
        this.host.paint();
        this.focusOn(`[data-action="pub-mode"][data-mode="${ui.mode}"]`);
        return true;
      case 'pub-add-group':
        if (group && !ui.selected.includes(group)) ui.selected = this.ordered([...ui.selected, group]);
        this.schedulePlan();
        this.host.paint();
        return true;
      case 'pub-preview':
        ui.preview = true;
        ui.notice = undefined;
        if (ui.planFor !== planKey(ui)) void this.plan();
        else this.host.paint();
        this.focusOn('#pub-sheet-t');
        return true;
      case 'pub-preview-close':
        ui.preview = false;
        ui.providing = undefined;
        this.host.paint();
        this.focusOn('[data-action="pub-preview"]');
        return true;
      case 'pub-provide':
        ui.providing = { key, value: ui.provided[key] ?? '' };
        this.host.paint();
        this.focusOn('[data-pub="provide"]');
        return true;
      case 'pub-provide-cancel':
        ui.providing = undefined;
        this.host.paint();
        return true;
      case 'pub-provide-ok': {
        const value = ui.providing?.key === key ? ui.providing.value.trim() : '';
        ui.providing = undefined;
        // Une valeur vide ne remplace rien : la donnée reste une entrée du bloc.
        if (value) {
          ui.provided = { ...ui.provided, [key]: value };
          this.schedulePlan();
        }
        this.host.paint();
        return true;
      }
      case 'pub-unprovide': {
        const { [key]: _removed, ...rest } = ui.provided;
        ui.provided = rest;
        this.schedulePlan();
        this.host.paint();
        return true;
      }
      case 'pub-publish':
        void this.publish();
        return true;
      default:
        return false;
    }
  }

  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    const field = target.dataset.pub;
    const ui = this.ui;
    if (!field || !ui) return false;
    const box = target as HTMLInputElement;
    switch (field) {
      case 'group': {
        const id = target.value;
        if (box.checked) {
          ui.selected = this.ordered([...ui.selected, id]);
          ui.focus ??= id;
        } else {
          ui.selected = ui.selected.filter((entry) => entry !== id);
          const { [id]: _removed, ...rest } = ui.parts;
          ui.parts = rest;
        }
        ui.notice = undefined;
        this.schedulePlan();
        this.host.paint();
        this.focusOn(`[data-pub="group"][value="${id}"]`);
        return true;
      }
      case 'step': {
        const group = target.dataset.group ?? '';
        const members = (this.host.state.review?.studio?.steps ?? [])
          .filter((step) => step.groupId === group)
          .map((step) => step.id);
        const current = ui.parts[group] && ui.parts[group].length > 0 ? ui.parts[group] : members;
        const next = box.checked
          ? members.filter((id) => current.includes(id) || id === target.value)
          : current.filter((id) => id !== target.value);
        const { [group]: _previous, ...rest } = ui.parts;
        ui.parts = next.length === members.length ? rest : { ...rest, [group]: next };
        this.schedulePlan();
        this.host.paint();
        this.focusOn(`[data-pub="step"][value="${target.value}"]`);
        return true;
      }
      case 'navigate':
        ui.navigate = box.checked;
        this.schedulePlan();
        this.host.paint();
        return true;
      case 'name':
      case 'description': {
        const key = target.dataset.key ?? '';
        ui.names = { ...ui.names, [key]: { ...ui.names[key], [field]: target.value } };
        this.schedulePlan();
        return true;
      }
      case 'provide':
        return true;
      default:
        return false;
    }
  }

  input(target: HTMLInputElement): boolean {
    const ui = this.ui;
    if (target.dataset.pub !== 'provide' || !ui?.providing) return false;
    ui.providing.value = target.value;
    return true;
  }

  keydown(event: KeyboardEvent): boolean {
    const ui = this.ui;
    if (event.key !== 'Escape' || !ui?.preview || this.host.state.route.view !== 'recording') return false;
    ui.preview = false;
    ui.providing = undefined;
    this.host.paint();
    return true;
  }
}
