import { QaCrawlerError, type QaCrawlerClient } from '../core/client.js';
import type { GeneratedFileView, GenerationFormatName, TestRunView } from '../core/contracts.js';
import type { FlowEdit, NewFlowStep, StepPatch, TargetStrategy } from '../editor/flow-document.js';
import type { GherkinEdit } from '../editor/gherkin-document.js';
import {
  diagnosticsOf,
  dirtyPaths,
  emptyEditorUi,
  firstFile,
  isDirty,
  kindOf,
  languageOf,
  modeOf,
  type CompareSide,
  type EditorBuffer,
  type EditorOutline,
  type EditorUi,
} from './dashboard-editor.js';
import { can } from './dashboard-access.js';
import { finishedRecordings } from './dashboard-tests.js';
import type { DashboardRoute, DashboardState } from './dashboard-view.js';
import type * as Kit from './editor-kit.js';
import { RunConsole } from './dashboard-console-controller.js';

/**
 * LE CONTRÔLEUR DE L'ÉDITEUR : il relie l'écran aux services réels — le SDK pour lire, vérifier,
 * enregistrer, restaurer, lancer un Dry Run ou une exécution ; le kit (chargé à la demande) pour
 * l'éditeur de code, la comparaison et les modèles par format. Une édition visuelle passe toujours par
 * le modèle (`editFlow`, `editFeature`) et devient le brouillon : la source, la vue visuelle,
 * l'explorateur et l'inspecteur montrent ce même texte. Rien n'est écrit sans « Enregistrer ».
 */

export interface EditorHost {
  readonly state: DashboardState;
  readonly root: ShadowRoot;
  api(): QaCrawlerClient | undefined;
  paint(): void;
  navigate(route: DashboardRoute): void;
}

const message = (error: unknown): string => (error instanceof Error ? error.message : String(error));
const ACTIVE = new Set(['QUEUED', 'RUNNING']);

export class EditorController {
  private kit?: typeof Kit;
  private kitLoading?: Promise<void>;
  private readonly editors = new Map<string, Kit.CodeEditorHandle>();
  private diff?: { key: string; handle: Kit.DiffHandle };
  private outlineTimer?: ReturnType<typeof setTimeout>;
  private pollTimer?: ReturnType<typeof setTimeout>;
  /** Les exécutions vues en cours : leur fin se dit une fois, quel que soit le rafraîchissement qui la voit. */
  private readonly activeRuns = new Set<string>();
  private pendingGoTo?: { path: string; line: number; column?: number };
  private editorHadFocus = false;
  private pendingLeave?: DashboardRoute;
  private dragging?: { index: number; scenario?: number };
  private readonly beforeUnload = (event: BeforeUnloadEvent): void => {
    if (dirtyPaths(this.ui).length === 0) return;
    event.preventDefault();
  };

  /** La console d'exécution (panneau inférieur). */
  private readonly console: RunConsole;

  constructor(private readonly host: EditorHost) {
    this.console = new RunConsole({
      get state() {
        return host.state;
      },
      root: host.root,
      api: () => host.api(),
      paint: () => {
        host.paint();
      },
      context: () => this.context(),
      notice: (tone, text) => {
        this.notice(tone, text);
      },
      refresh: () => this.refreshView(),
      activePath: () => this.ui.active ?? '',
      rerun: (run) => this.execute(run.mode ?? 'RUN'),
    });
    globalThis.addEventListener('beforeunload', this.beforeUnload);
    const root = host.root;
    root.addEventListener('dragstart', (event) => {
      this.dragStart(event as DragEvent);
    });
    root.addEventListener('dragover', (event) => {
      if (this.dragging && (event.target as Element).closest('.ed-step')) event.preventDefault();
    });
    root.addEventListener('drop', (event) => {
      this.drop(event as DragEvent);
    });
    root.addEventListener('dragend', () => {
      this.dragging = undefined;
    });
  }

  private get ui(): EditorUi {
    return this.host.state.ed;
  }

  private get t(): DashboardState['t']['ed'] {
    return this.host.state.t.ed;
  }

  dispose(): void {
    globalThis.removeEventListener('beforeunload', this.beforeUnload);
    this.reset();
  }

  /** Tout ce que l'écran tenait : éditeurs, comparaison, minuteries, flux de la console. */
  private reset(): void {
    this.console.dispose();
    for (const editor of this.editors.values()) editor.destroy();
    this.editors.clear();
    this.diff?.handle.destroy();
    this.diff = undefined;
    if (this.outlineTimer) clearTimeout(this.outlineTimer);
    if (this.pollTimer) clearTimeout(this.pollTimer);
    this.outlineTimer = undefined;
    this.pollTimer = undefined;
    this.activeRuns.clear();
  }

  // ── Navigation ────────────────────────────────────────────────────────────────────────────

  /**
   * Quitter l'éditeur avec des modifications non enregistrées : la page le demande d'abord (jamais
   * une boîte de dialogue du navigateur). `true` : la navigation peut se faire.
   */
  guard(route: DashboardRoute): boolean {
    const current = this.host.state.route;
    if (current.view !== 'editor' || route.view === 'editor') return true;
    if (dirtyPaths(this.ui).length === 0) {
      this.leave();
      return true;
    }
    this.pendingLeave = route;
    this.ui.confirm = { kind: 'leave' };
    this.host.paint();
    this.host.root.querySelector<HTMLElement>('[data-action="ed-save-all"]')?.focus();
    return false;
  }

  private leave(): void {
    this.reset();
    // Sur place : les appelants gardent une référence à l'état de l'éditeur.
    const { explorer, inspector } = this.ui;
    const fresh: EditorUi = { ...emptyEditorUi(), explorer, inspector };
    for (const key of Object.keys(this.ui)) if (!(key in fresh)) Reflect.deleteProperty(this.ui, key);
    Object.assign(this.ui, fresh);
  }

  // ── Chargement ────────────────────────────────────────────────────────────────────────────

  private ensureKit(): Promise<void> {
    if (this.kit) return Promise.resolve();
    this.kitLoading ??= (async () => {
      this.ui.kit = 'loading';
      try {
        this.kit = await import('./editor-kit.js');
        this.ui.kit = 'ready';
        for (const buffer of Object.values(this.ui.buffers)) buffer.outline = this.outlineOf(buffer);
      } catch (error) {
        this.ui.kit = 'error';
        this.ui.kitError = message(error);
      }
      this.host.paint();
    })();
    return this.kitLoading;
  }

  async load(
    api: QaCrawlerClient,
    route: Extract<DashboardRoute, { view: 'editor' }>,
    isCurrent: () => boolean,
  ): Promise<void> {
    const ui = this.ui;
    const recordings = await api.recordings.list(route.projectId);
    if (!isCurrent()) return;
    this.host.state.recordings = recordings;
    const names = finishedRecordings(this.host.state);
    const recording =
      [route.recording, ui.recording, this.host.state.tst.recording].find(
        (entry) => entry !== undefined && names.includes(entry),
      ) ?? names[0];
    if (recording !== ui.recording) {
      this.leave();
      ui.recording = recording;
    }
    void this.ensureKit();
    if (!recording) {
      ui.view = { recording: '', files: [], warnings: [], runners: [], runs: [] };
      return;
    }
    const view = await api.generation.view(route.projectId, recording);
    if (!isCurrent()) return;
    ui.view = view;
    this.syncSaved(view.files);
    const path = firstFile(view.files, route.file ?? ui.active);
    if (path) this.open(path);
    if (route.compare && path) {
      const file = view.files.find((entry) => entry.path === path);
      if (file) {
        ui.preview = await api.generation
          .preview(route.projectId, recording, { formats: [file.format] })
          .catch(() => undefined);
        if (!isCurrent()) return;
        ui.notice = { tone: 'info', text: this.t.conflictNotice };
        await this.startCompare(path, ui.preview ? 'preview' : 'generated', 'saved');
      }
    }
    if (view.runs.some((run) => ACTIVE.has(run.status))) this.poll();
  }

  /** Les fichiers relus du serveur : un brouillon intact suit le contenu enregistré, un brouillon modifié reste. */
  private syncSaved(files: readonly GeneratedFileView[]): void {
    for (const file of files) {
      const buffer = this.ui.buffers[file.path];
      if (!buffer) continue;
      if (file.revision === buffer.revision) continue;
      const pristine = !isDirty(buffer);
      buffer.saved = file.content;
      buffer.revision = file.revision;
      buffer.status = file.status;
      buffer.editedAt = file.editedAt;
      buffer.savedDiagnostics = file.diagnostics;
      if (pristine) this.setDraft(buffer, file.content);
    }
  }

  private outlineOf(buffer: EditorBuffer): EditorOutline | undefined {
    const kit = this.kit;
    if (!kit) return undefined;
    switch (kindOf(buffer.path)) {
      case 'flow':
        return { kind: 'flow', parse: kit.parseFlow(buffer.draft) };
      case 'feature':
        return { kind: 'feature', parse: kit.parseFeature(buffer.draft) };
      case 'code':
        return {
          kind: 'code',
          entries: kit.codeOutline(buffer.draft, buffer.path.endsWith('.java') ? 'java' : 'typescript'),
        };
      default:
        return { kind: 'text' };
    }
  }

  open(path: string): void {
    const ui = this.ui;
    const file = ui.view?.files.find((entry) => entry.path === path);
    if (!file) return;
    let buffer = ui.buffers[path];
    if (!buffer) {
      buffer = {
        path,
        format: file.format,
        saved: file.content,
        draft: file.content,
        ...(file.revision ? { revision: file.revision } : {}),
        ...(file.editedAt ? { editedAt: file.editedAt } : {}),
        status: file.status,
        ...(file.validation ? { validationMethod: file.validation.method } : {}),
        diagnostics: file.diagnostics ?? [],
        ...(file.diagnostics ? { checkedFor: file.content, savedDiagnostics: file.diagnostics } : {}),
      };
      ui.buffers[path] = buffer;
    }
    if (!buffer.outline) {
      const outline = this.outlineOf(buffer);
      if (outline) buffer.outline = outline;
    }
    if (!ui.open.includes(path)) ui.open.push(path);
    if (ui.active !== path) {
      ui.active = path;
      ui.adding = undefined;
      if (!ui.selected?.startsWith(`${path}#`)) ui.selected = undefined;
      this.syncConsole();
    }
  }

  // ── Le brouillon ──────────────────────────────────────────────────────────────────────────

  /** Le brouillon change : le plan est recalculé, l'éditeur de code reçoit le texte (hors frappe). */
  private setDraft(buffer: EditorBuffer, text: string, fromEditor = false): void {
    buffer.draft = text;
    if (!fromEditor) {
      this.editors.get(buffer.path)?.setText(text);
      const outline = this.outlineOf(buffer);
      if (outline) buffer.outline = outline;
    }
  }

  /** La frappe dans l'éditeur de code : le plan et l'écran suivent après une courte pause. */
  private typed(path: string, text: string): void {
    const buffer = this.ui.buffers[path];
    if (!buffer) return;
    const wasDirty = isDirty(buffer);
    this.setDraft(buffer, text, true);
    if (wasDirty !== isDirty(buffer)) this.host.paint();
    if (this.outlineTimer) clearTimeout(this.outlineTimer);
    this.outlineTimer = setTimeout(() => {
      this.outlineTimer = undefined;
      const outline = this.outlineOf(buffer);
      if (outline) buffer.outline = outline;
      this.host.paint();
    }, 400);
  }

  private active(): EditorBuffer | undefined {
    return this.ui.active ? this.ui.buffers[this.ui.active] : undefined;
  }

  private notice(tone: 'ok' | 'err' | 'info', text: string, details?: string[]): void {
    this.ui.notice = { tone, text, ...(details && details.length > 0 ? { details } : {}) };
  }

  // ── Éditions structurées ───────────────────────────────────────────────────────────────────

  private flowEdit(edit: FlowEdit, select?: number): void {
    const buffer = this.active();
    if (!buffer || !this.kit) return;
    const result = this.kit.editFlow(buffer.draft, edit);
    if ('error' in result) {
      this.notice('err', this.t.editRefused, [result.error]);
      this.host.paint();
      return;
    }
    this.setDraft(buffer, result.text);
    this.ui.notice = result.notes.length > 0 ? { tone: 'info', text: result.notes.join(' · ') } : undefined;
    if (select !== undefined) this.ui.selected = `${buffer.path}#${String(select)}`;
    this.host.paint();
  }

  private featureEdit(edit: GherkinEdit, select?: { scenario: number; index: number }): void {
    const buffer = this.active();
    if (!buffer || !this.kit) return;
    const result = this.kit.editFeature(buffer.draft, edit);
    if ('error' in result) {
      this.notice('err', this.t.editRefused, [result.error]);
      this.host.paint();
      return;
    }
    this.setDraft(buffer, result.text);
    this.ui.notice = undefined;
    if (select) this.ui.selected = `${buffer.path}#${String(select.scenario)}:${String(select.index)}`;
    this.host.paint();
  }

  private moveStep(index: number, to: number, scenario?: number): void {
    const buffer = this.active();
    if (!buffer || to < 0) return;
    if (kindOf(buffer.path) === 'flow') this.flowEdit({ op: 'move', from: index, to }, to);
    else if (scenario !== undefined)
      this.featureEdit({ op: 'move', scenario, from: index, to }, { scenario, index: to });
    this.host.root.querySelector<HTMLElement>(`.ed-step.sel .ed-sm`)?.focus();
  }

  /** Un champ de l'inspecteur : appliqué au brouillon par le modèle, jamais en réécrivant le fichier. */
  private fieldChanged(target: HTMLInputElement | HTMLSelectElement): void {
    const buffer = this.active();
    const name = target.dataset.edField;
    if (!buffer || !name) return;
    const index = Number(target.dataset.index);
    const value = target.value;
    const checked = (target as HTMLInputElement).checked;
    if (kindOf(buffer.path) === 'feature') {
      const scenario = Number(target.dataset.scenario);
      if (name === 'keyword')
        this.featureEdit({ op: 'update', scenario, index, keyword: value }, { scenario, index });
      if (name === 'sentence')
        this.featureEdit({ op: 'update', scenario, index, text: value }, { scenario, index });
      return;
    }
    const number = (raw: string): number | null => (raw.trim() === '' ? null : Number(raw));
    const patches: Record<string, () => StepPatch | undefined> = {
      name: () => ({ name: value.trim() === '' ? null : value }),
      strategy: () => ({ target: { strategy: value as TargetStrategy } }),
      targetValue: () => ({ target: { value } }),
      targetName: () => ({ target: { name: value === '' ? null : value } }),
      exact: () => ({ target: { exact: checked ? true : null } }),
      nth: () => ({ target: { nth: number(value) } }),
      option: () => ({ option: value }),
      url: () => ({ url: value }),
      text: () => ({ text: value }),
      expectText: () => ({ expect: { text: value === '' ? null : value } }),
      expectUrl: () => ({ expect: { url: value === '' ? null : value } }),
      optional: () => ({ optional: checked }),
      timeoutMs: () => ({ timeoutMs: number(value) }),
      valueKind: () => {
        const outline =
          buffer.outline?.kind === 'flow' && buffer.outline.parse.ok
            ? buffer.outline.parse.outline
            : undefined;
        const current = outline?.steps[index]?.value;
        return { value: { kind: value as 'literal' | 'testData' | 'env', text: current?.text ?? '' } };
      },
      valueText: () => {
        const outline =
          buffer.outline?.kind === 'flow' && buffer.outline.parse.ok
            ? buffer.outline.parse.outline
            : undefined;
        return { value: { kind: outline?.steps[index]?.value?.kind ?? 'literal', text: value } };
      },
      allow: () => {
        const boxes = [
          ...this.host.root.querySelectorAll<HTMLInputElement>(
            `[data-ed-field="allow"][data-index="${String(index)}"]`,
          ),
        ];
        return { allow: boxes.filter((box) => box.checked).map((box) => box.dataset.value ?? '') };
      },
    };
    if (name === 'group') {
      this.flowEdit({ op: 'group', index, group: value === '' ? null : value }, index);
      return;
    }
    const patch = patches[name]?.();
    if (patch) this.flowEdit({ op: 'update', index, patch }, index);
  }

  private addSubmit(): void {
    const buffer = this.active();
    const form = this.ui.adding;
    if (!buffer || !form) return;
    for (const input of this.host.root.querySelectorAll<HTMLInputElement | HTMLSelectElement>(
      '[data-ed-add]',
    )) {
      const key = input.dataset.edAdd as keyof typeof form | undefined;
      if (key && key !== 'path' && key !== 'after' && key !== 'scenario') form[key] = input.value;
    }
    if (kindOf(buffer.path) === 'feature') {
      const scenario = form.scenario ?? 0;
      this.ui.adding = undefined;
      this.featureEdit(
        { op: 'add', scenario, after: form.after, keyword: form.keyword, text: form.text },
        { scenario, index: form.after + 1 },
      );
      return;
    }
    const targeted = ['click', 'fill', 'select', 'check', 'uncheck'].includes(form.action);
    const step: NewFlowStep = {
      action: form.action as NewFlowStep['action'],
      ...(targeted
        ? {
            target: {
              strategy: form.strategy as TargetStrategy,
              value: form.value,
              ...(form.strategy === 'role' && form.name ? { name: form.name } : {}),
            },
          }
        : {}),
      ...(form.action === 'fill' ? { value: form.text } : {}),
      ...(form.action === 'select' ? { option: form.text } : {}),
      ...(form.action === 'goto' ? { url: form.text } : {}),
      ...(form.action === 'expect' || form.action === 'manual' ? { text: form.text } : {}),
    };
    this.ui.adding = undefined;
    this.flowEdit({ op: 'add', after: form.after, step }, form.after + 1);
  }

  // ── Services : vérifier, enregistrer, restaurer, exécuter ───────────────────────────────────

  private context(): { api: QaCrawlerClient; projectId: string; recording: string } | undefined {
    const api = this.host.api();
    const route = this.host.state.route;
    const recording = this.ui.recording;
    if (!api || route.view !== 'editor' || !recording) return undefined;
    return { api, projectId: route.projectId, recording };
  }

  private async refreshView(): Promise<void> {
    const context = this.context();
    if (!context) return;
    const view = await context.api.generation.view(context.projectId, context.recording);
    if (this.ui.recording !== context.recording) return;
    this.ui.view = view;
    this.syncSaved(view.files);
    this.syncConsole();
    this.announceFinished(view.runs);
    if (view.runs.some((run) => ACTIVE.has(run.status))) this.poll();
  }

  /** À leur fin, l'écran dit le verdict des exécutions qu'il a vues en cours. */
  private announceFinished(runs: TestRunView[]): void {
    for (const run of runs) {
      if (ACTIVE.has(run.status)) {
        this.activeRuns.add(run.id);
        continue;
      }
      if (!this.activeRuns.delete(run.id)) continue;
      this.notice(
        run.status === 'PASSED' ? 'ok' : run.status === 'CANCELLED' ? 'info' : 'err',
        this.t.finished(
          `${run.mode === 'DRY_RUN' ? this.t.dryRun : this.t.run} · ${this.host.state.t.tst.statuses[run.status] ?? run.status}${run.dryRunStatus ? ` (${this.t.dryRunStatuses[run.dryRunStatus] ?? run.dryRunStatus})` : ''}`,
        ),
      );
    }
  }

  /**
   * La console suit l'exécution choisie ; sinon, la dernière du format du fichier ouvert (son journal
   * conservé se relit). Changer de format change d'exécution : jamais deux journaux mêlés.
   */
  private syncConsole(): void {
    const ui = this.ui;
    const buffer = this.active();
    const runs = ui.view?.runs ?? [];
    const followed = ui.console.runId ? runs.find((run) => run.id === ui.console.runId) : undefined;
    if (followed) ui.console.run = followed;
    if (!buffer) return;
    if (ui.console.run?.format === buffer.format) return;
    this.console.follow(runs.find((run) => run.format === buffer.format));
  }

  async check(): Promise<void> {
    const context = this.context();
    const buffer = this.active();
    if (!context || !buffer || this.ui.busy) return;
    this.ui.busy = 'check';
    this.ui.notice = undefined;
    this.host.paint();
    const content = buffer.draft;
    try {
      const result = await context.api.generation.checkFile(context.projectId, context.recording, {
        path: buffer.path,
        content,
      });
      buffer.diagnostics = result.diagnostics;
      buffer.checkedFor = content;
      buffer.checkedStatus = result.status;
      const errors = result.diagnostics.filter((entry) => entry.severity === 'error').length;
      this.notice(
        errors > 0 || result.blocking ? 'err' : 'ok',
        errors > 0 || result.blocking ? this.t.checkedErrors(Math.max(errors, 1)) : this.t.checkedOk,
      );
      if (errors > 0) {
        this.ui.console.tab = 'diagnostics';
        this.ui.console.open = true;
      }
    } catch (error) {
      this.notice('err', message(error));
    }
    this.ui.busy = undefined;
    this.host.paint();
  }

  async save(path = this.ui.active): Promise<boolean> {
    const context = this.context();
    const buffer = path ? this.ui.buffers[path] : undefined;
    if (!context || !buffer || !isDirty(buffer) || this.ui.busy || !buffer.revision) return false;
    this.ui.busy = 'save';
    this.ui.notice = undefined;
    this.host.paint();
    const content = buffer.draft;
    let ok = false;
    try {
      const saved = await context.api.generation.editFile(context.projectId, context.recording, {
        path: buffer.path,
        content,
        revision: buffer.revision,
      });
      buffer.saved = saved.content;
      buffer.revision = saved.revision;
      buffer.status = saved.status;
      buffer.editedAt = saved.editedAt;
      buffer.diagnostics = saved.diagnostics ?? [];
      buffer.savedDiagnostics = buffer.diagnostics;
      buffer.checkedFor = saved.content;
      buffer.checkedStatus = saved.status;
      if (buffer.draft === content && saved.content !== content) this.setDraft(buffer, saved.content);
      this.notice('ok', this.t.savedNotice(buffer.path));
      this.ui.busy = undefined;
      await this.refreshView().catch(() => undefined);
      ok = true;
    } catch (error) {
      this.ui.busy = undefined;
      if (error instanceof QaCrawlerError && error.code === 'FILE_CHANGED')
        this.notice('err', this.t.changedElsewhere);
      else if (error instanceof QaCrawlerError && error.status === 422) {
        buffer.diagnostics = error.diagnostics;
        buffer.checkedFor = content;
        this.notice(
          'err',
          this.t.refusedNotice(buffer.path),
          error.diagnostics.length > 0 ? undefined : error.details,
        );
        this.ui.console.tab = 'diagnostics';
        this.ui.console.open = true;
      } else this.notice('err', message(error));
    }
    this.host.paint();
    return ok;
  }

  private async saveAll(): Promise<void> {
    for (const path of dirtyPaths(this.ui)) if (!(await this.save(path))) return;
    const route = this.pendingLeave;
    this.ui.confirm = undefined;
    this.pendingLeave = undefined;
    if (route) {
      this.leave();
      this.host.navigate(route);
    } else this.host.paint();
  }

  private async execute(mode: 'RUN' | 'DRY_RUN'): Promise<TestRunView | undefined> {
    const context = this.context();
    const buffer = this.active();
    if (!context || !buffer || this.ui.busy) return undefined;
    this.ui.busy = mode === 'RUN' ? 'run' : 'dry-run';
    this.ui.notice = undefined;
    this.host.paint();
    let started: TestRunView | undefined;
    try {
      started = await context.api.generation.execute(context.projectId, context.recording, {
        format: buffer.format,
        ...(mode === 'DRY_RUN'
          ? {
              mode: 'DRY_RUN' as const,
              path: buffer.path,
              ...(isDirty(buffer) ? { content: buffer.draft } : {}),
            }
          : {}),
      });
      this.notice('info', mode === 'RUN' ? this.t.runStarted : this.t.dryRunStarted);
      this.activeRuns.add(started.id);
      // La console suit CE run (un nouveau run : son propre journal, rien de l'ancien).
      this.ui.console.tab = 'console';
      this.ui.console.open = true;
      this.console.follow(started);
      this.ui.busy = undefined;
      await this.refreshView();
    } catch (error) {
      this.ui.busy = undefined;
      this.notice('err', message(error), error instanceof QaCrawlerError ? error.details : undefined);
    }
    this.host.paint();
    return started;
  }

  /** Les exécutions en cours se suivent ; à leur fin, l'écran dit leur verdict (`announceFinished`). */
  private poll(): void {
    if (this.pollTimer) return;
    this.pollTimer = setTimeout(() => {
      this.pollTimer = undefined;
      if (this.host.state.route.view !== 'editor') return;
      void this.refreshView()
        .then(() => {
          this.host.paint();
        })
        .catch(() => {
          this.poll();
        });
    }, 1500);
  }

  private async restore(path: string): Promise<void> {
    const context = this.context();
    const buffer = this.ui.buffers[path];
    if (!context || !buffer?.revision) return;
    this.ui.busy = 'restore';
    this.host.paint();
    try {
      const restored = await context.api.generation.restoreFile(context.projectId, context.recording, {
        path,
        revision: buffer.revision,
      });
      buffer.saved = restored.content;
      buffer.revision = restored.revision;
      buffer.status = restored.status;
      buffer.editedAt = undefined;
      buffer.diagnostics = restored.diagnostics ?? [];
      buffer.savedDiagnostics = buffer.diagnostics;
      buffer.checkedFor = restored.content;
      this.setDraft(buffer, restored.content);
      this.notice('ok', this.t.restoredNotice);
      if (this.ui.compare?.path === path)
        await this.startCompare(path, this.ui.compare.left, this.ui.compare.right, true);
      await this.refreshView().catch(() => undefined);
    } catch (error) {
      this.notice('err', message(error));
    }
    this.ui.busy = undefined;
    this.host.paint();
  }

  private async overwrite(): Promise<void> {
    const context = this.context();
    const buffer = this.active();
    if (!context || !buffer) return;
    try {
      await context.api.generation.run(context.projectId, context.recording, {
        formats: [buffer.format],
        overwriteManual: true,
      });
      // Les fichiers du format sont remplacés : les brouillons repartent de la nouvelle version.
      for (const entry of Object.values(this.ui.buffers))
        if (entry.format === buffer.format) entry.revision = undefined;
      this.ui.preview = undefined;
      await this.refreshView();
      for (const entry of Object.values(this.ui.buffers))
        if (entry.format === buffer.format) {
          const file = this.ui.view?.files.find((candidate) => candidate.path === entry.path);
          if (file) this.setDraft(entry, file.content);
        }
      this.ui.mode[buffer.path] = 'source';
      this.notice(
        'ok',
        this.host.state.t.tst.generated(
          this.ui.view?.files.filter((file) => file.format === buffer.format).length ?? 0,
        ),
      );
    } catch (error) {
      this.notice('err', message(error));
    }
    this.host.paint();
  }

  // ── Comparaison ───────────────────────────────────────────────────────────────────────────

  private async textOf(path: string, side: CompareSide, reload = false): Promise<string | undefined> {
    const buffer = this.ui.buffers[path];
    if (!buffer) return undefined;
    if (side === 'saved') return buffer.saved;
    if (side === 'draft') return buffer.draft;
    if (side === 'preview') return this.ui.preview?.files.find((file) => file.path === path)?.content;
    const cached = this.ui.compare?.path === path ? this.ui.compare.texts.generated : undefined;
    if (cached !== undefined && !reload) return cached;
    if (!buffer.editedAt) return buffer.saved;
    const context = this.context();
    if (!context) return undefined;
    return (await context.api.generation.original(context.projectId, context.recording, path)).content;
  }

  private async startCompare(
    path: string,
    left: CompareSide,
    right: CompareSide,
    reload = false,
  ): Promise<void> {
    const ui = this.ui;
    ui.mode[path] = 'compare';
    const previous = ui.compare?.path === path ? ui.compare.texts : {};
    ui.compare = { path, left, right, texts: reload ? {} : previous, loading: true };
    this.host.paint();
    try {
      const [a, b] = await Promise.all([this.textOf(path, left, reload), this.textOf(path, right, reload)]);
      if (ui.compare.path !== path) return;
      ui.compare.texts = { ...ui.compare.texts, [left]: a, [right]: b };
      ui.compare.loading = false;
      if (a !== undefined && b !== undefined && this.kit) ui.compare.summary = this.kit.diffSummary(a, b);
    } catch (error) {
      ui.compare.loading = false;
      this.notice('err', message(error));
    }
    this.host.paint();
  }

  // ── Événements ────────────────────────────────────────────────────────────────────────────

  click(action: string, target: HTMLElement): boolean {
    if (action.startsWith('ed-con-')) return this.console.click(action, target);
    const ui = this.ui;
    const buffer = this.active();
    const index = Number(target.dataset.index);
    const scenario = target.dataset.scenario !== undefined ? Number(target.dataset.scenario) : undefined;
    switch (action) {
      case 'ed-back': {
        const route = this.host.state.route;
        if (route.view === 'editor')
          this.host.navigate({
            view: 'tests',
            projectId: route.projectId,
            ...(ui.recording ? { recording: ui.recording } : {}),
          });
        return true;
      }
      case 'ed-open':
      case 'ed-tab':
        if (target.dataset.path) {
          this.open(target.dataset.path);
          this.host.paint();
          this.host.root
            .querySelector<HTMLElement>(
              `[data-action="${action}"][data-path="${CSS.escape(target.dataset.path)}"]`,
            )
            ?.focus();
        }
        return true;
      case 'ed-close': {
        const path = target.dataset.path ?? '';
        if (isDirty(ui.buffers[path])) ui.confirm = { kind: 'close', path };
        else this.close(path);
        this.host.paint();
        return true;
      }
      case 'ed-close-confirm':
        if (ui.confirm?.kind === 'close') this.close(ui.confirm.path);
        ui.confirm = undefined;
        this.host.paint();
        return true;
      case 'ed-mode': {
        const mode = target.dataset.mode as 'visual' | 'source' | 'compare';
        if (!buffer) return true;
        if (mode === 'compare')
          void this.startCompare(
            buffer.path,
            buffer.editedAt ? 'generated' : 'saved',
            isDirty(buffer) ? 'draft' : 'saved',
          );
        else {
          ui.mode[buffer.path] = mode;
          this.host.paint();
          if (mode === 'source') this.editors.get(buffer.path)?.view.focus();
        }
        return true;
      }
      case 'ed-compare':
        if (buffer) {
          if (modeOf(ui, buffer.path) === 'compare') {
            ui.mode[buffer.path] = 'source';
            this.host.paint();
          } else
            void this.startCompare(
              buffer.path,
              buffer.editedAt ? 'generated' : 'saved',
              isDirty(buffer) ? 'draft' : 'saved',
            );
        }
        return true;
      case 'ed-select': {
        const path = target.dataset.path ?? buffer?.path;
        const key = target.dataset.key;
        if (!path || key === undefined) return true;
        if (path !== ui.active) this.open(path);
        ui.selected = `${path}#${key}`;
        const target$ = ui.buffers[path];
        if (target$ && modeOf(ui, path) === 'source') {
          const line = this.lineOfKey(target$, key);
          if (line) this.pendingGoTo = { path, line };
        }
        this.host.paint();
        this.host.root
          .querySelector<HTMLElement>(`[data-action="ed-select"][data-key="${CSS.escape(key)}"]`)
          ?.focus();
        return true;
      }
      case 'ed-goto': {
        const path = target.dataset.path ?? buffer?.path;
        const line = Number(target.dataset.line);
        if (!path || !line) return true;
        this.open(path);
        ui.mode[path] = 'source';
        this.pendingGoTo = { path, line };
        this.host.paint();
        return true;
      }
      case 'ed-diag':
        this.goToDiagnostic(target);
        return true;
      case 'ed-collapse': {
        const key = target.dataset.key ?? '';
        ui.collapsed = ui.collapsed.includes(key)
          ? ui.collapsed.filter((entry) => entry !== key)
          : [...ui.collapsed, key];
        this.host.paint();
        this.host.root
          .querySelector<HTMLElement>(`[data-action="ed-collapse"][data-key="${CSS.escape(key)}"]`)
          ?.focus();
        return true;
      }
      case 'ed-toggle-explorer':
        ui.explorer = !ui.explorer;
        this.host.paint();
        return true;
      case 'ed-toggle-inspector':
        ui.inspector = !ui.inspector;
        this.host.paint();
        return true;
      case 'ed-notice-close':
        ui.notice = undefined;
        this.host.paint();
        return true;
      case 'ed-confirm-cancel':
        ui.confirm = undefined;
        this.pendingLeave = undefined;
        this.host.paint();
        return true;
      case 'ed-leave-confirm': {
        const route = this.pendingLeave;
        ui.confirm = undefined;
        this.pendingLeave = undefined;
        this.leave();
        if (route) this.host.navigate(route);
        return true;
      }
      case 'ed-save-all':
        void this.saveAll();
        return true;
      case 'ed-save':
        void this.save();
        return true;
      case 'ed-check':
        void this.check();
        return true;
      case 'ed-dry-run':
        void this.execute('DRY_RUN');
        return true;
      case 'ed-run':
        void this.execute('RUN');
        return true;
      case 'ed-cancel-run': {
        const context = this.context();
        const id = target.dataset.run;
        if (context && id)
          void context.api.generation
            .cancel(context.projectId, context.recording, id)
            .then(() => this.refreshView())
            .catch((error: unknown) => {
              this.notice('err', message(error));
              this.host.paint();
            });
        return true;
      }
      case 'ed-report': {
        const context = this.context();
        const id = target.dataset.run;
        if (context && id)
          context.api.generation
            .reportLink(context.projectId, context.recording, id)
            .then((link) => {
              globalThis.open(link.url, '_blank', 'noopener');
            })
            .catch((error: unknown) => {
              this.notice('err', message(error));
              this.host.paint();
            });
        return true;
      }
      case 'ed-restore':
        if (buffer) ui.confirm = { kind: 'restore', path: buffer.path };
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-restore-confirm"]')?.focus();
        return true;
      case 'ed-restore-confirm':
        if (ui.confirm?.kind === 'restore') void this.restore(ui.confirm.path);
        ui.confirm = undefined;
        return true;
      case 'ed-discard':
        if (buffer) ui.confirm = { kind: 'discard', path: buffer.path };
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-discard-confirm"]')?.focus();
        return true;
      case 'ed-discard-confirm':
        if (ui.confirm?.kind === 'discard') {
          const entry = ui.buffers[ui.confirm.path];
          if (entry) this.setDraft(entry, entry.saved);
          this.notice('info', this.t.discardedNotice);
          if (ui.compare && entry)
            void this.startCompare(
              entry.path,
              ui.compare.left,
              ui.compare.right === 'draft' ? 'saved' : ui.compare.right,
            );
        }
        ui.confirm = undefined;
        this.host.paint();
        return true;
      case 'ed-overwrite':
        void this.overwrite();
        return true;
      case 'ed-move':
        this.moveStep(index, Number(target.dataset.to), scenario);
        return true;
      case 'ed-duplicate':
        if (buffer && kindOf(buffer.path) === 'flow') this.flowEdit({ op: 'duplicate', index }, index + 1);
        else if (scenario !== undefined)
          this.featureEdit({ op: 'duplicate', scenario, index }, { scenario, index: index + 1 });
        return true;
      case 'ed-remove':
        if (buffer)
          ui.confirm = {
            kind: 'remove',
            path: buffer.path,
            index,
            ...(scenario !== undefined ? { scenario } : {}),
          };
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-action="ed-remove-confirm"]')?.focus();
        return true;
      case 'ed-remove-confirm': {
        const confirm = ui.confirm;
        ui.confirm = undefined;
        if (confirm?.kind !== 'remove') return true;
        ui.selected = undefined;
        if (confirm.scenario !== undefined)
          this.featureEdit({ op: 'remove', scenario: confirm.scenario, index: confirm.index });
        else this.flowEdit({ op: 'remove', index: confirm.index });
        return true;
      }
      case 'ed-add': {
        if (!buffer) return true;
        const keywords =
          buffer.outline?.kind === 'feature' && buffer.outline.parse.ok
            ? buffer.outline.parse.outline.keywords.and
            : [];
        ui.adding = {
          path: buffer.path,
          after: Number(target.dataset.after),
          ...(scenario !== undefined ? { scenario } : {}),
          action: 'click',
          strategy: 'role',
          value: '',
          name: '',
          text: '',
          keyword: keywords[0] ?? 'And ',
        };
        this.host.paint();
        this.host.root.querySelector<HTMLElement>('[data-ed-add]')?.focus();
        return true;
      }
      case 'ed-add-cancel':
        ui.adding = undefined;
        this.host.paint();
        return true;
      default:
        return false;
    }
  }

  private close(path: string): void {
    const ui = this.ui;
    ui.open = ui.open.filter((entry) => entry !== path);
    this.editors.get(path)?.destroy();
    this.editors.delete(path);
    ui.buffers = Object.fromEntries(Object.entries(ui.buffers).filter(([key]) => key !== path));
    ui.mode = Object.fromEntries(Object.entries(ui.mode).filter(([key]) => key !== path));
    if (ui.compare?.path === path) ui.compare = undefined;
    if (ui.active === path) ui.active = ui.open[ui.open.length - 1];
  }

  private lineOfKey(buffer: EditorBuffer, key: string): number | undefined {
    const outline = buffer.outline;
    if (outline?.kind === 'flow' && outline.parse.ok) return outline.parse.outline.steps[Number(key)]?.line;
    if (outline?.kind === 'feature' && outline.parse.ok) {
      const [scenario, index] = key.split(':').map(Number);
      return outline.parse.outline.scenarios[scenario ?? 0]?.steps[index ?? 0]?.line;
    }
    return undefined;
  }

  /** Un diagnostic ou un cas : son fichier, puis l'étape (vue visuelle) ou la ligne (source). */
  private goToDiagnostic(target: HTMLElement): void {
    const ui = this.ui;
    const path = target.dataset.path ?? ui.active;
    if (!path) return;
    const known = ui.view?.files.some((file) => file.path === path);
    const file = known ? path : ui.view?.files.find((entry) => entry.path.endsWith(path))?.path;
    if (!file) return;
    this.open(file);
    const buffer = ui.buffers[file];
    const line = target.dataset.line ? Number(target.dataset.line) : undefined;
    const column = target.dataset.column ? Number(target.dataset.column) : undefined;
    const step = target.dataset.step ? Number(target.dataset.step) : undefined;
    if (!buffer) return;
    const mode = modeOf(ui, file);
    if (mode === 'visual' && buffer.outline?.kind === 'flow' && buffer.outline.parse.ok) {
      const node = buffer.outline.parse.outline.steps.find(
        (entry) =>
          (step !== undefined && entry.position === step) ||
          (line !== undefined && line >= entry.line && line <= entry.endLine),
      );
      if (node) {
        ui.selected = `${file}#${String(node.index)}`;
        this.host.paint();
        this.host.root
          .querySelector<HTMLElement>(`[data-action="ed-select"][data-key="${String(node.index)}"]`)
          ?.focus();
        return;
      }
    }
    if (
      mode === 'visual' &&
      buffer.outline?.kind === 'feature' &&
      buffer.outline.parse.ok &&
      line !== undefined
    ) {
      const scenarios = buffer.outline.parse.outline.scenarios;
      for (const [scenarioIndex, scenario] of scenarios.entries()) {
        const node = scenario.steps.find((entry) => line >= entry.line && line <= entry.endLine);
        if (!node) continue;
        ui.selected = `${file}#${String(scenarioIndex)}:${String(node.index)}`;
        this.host.paint();
        this.host.root
          .querySelector<HTMLElement>(
            `[data-action="ed-select"][data-key="${String(scenarioIndex)}:${String(node.index)}"]`,
          )
          ?.focus();
        return;
      }
    }
    let goal = line;
    if (
      goal === undefined &&
      step !== undefined &&
      buffer.outline?.kind === 'flow' &&
      buffer.outline.parse.ok
    )
      goal = buffer.outline.parse.outline.steps.find((entry) => entry.position === step)?.line;
    if (goal === undefined) {
      this.host.paint();
      return;
    }
    ui.mode[file] = 'source';
    this.pendingGoTo = { path: file, line: goal, ...(column !== undefined ? { column } : {}) };
    this.host.paint();
  }

  change(target: HTMLInputElement | HTMLSelectElement): boolean {
    if (this.console.change(target)) return true;
    const ui = this.ui;
    if (target.dataset.edField) {
      this.fieldChanged(target);
      return true;
    }
    if (target.dataset.edAdd && ui.adding) {
      const key = target.dataset.edAdd as 'action' | 'strategy' | 'value' | 'name' | 'text' | 'keyword';
      ui.adding[key] = target.value;
      if (key === 'action' || key === 'strategy') {
        this.host.paint();
        this.host.root.querySelector<HTMLElement>(`[data-ed-add="${key}"]`)?.focus();
      }
      return true;
    }
    const field = target.dataset.ed;
    if (field === 'compare-left' || field === 'compare-right') {
      const compare = ui.compare;
      if (!compare) return true;
      const side = target.value as CompareSide;
      void this.startCompare(
        compare.path,
        field === 'compare-left' ? side : compare.left,
        field === 'compare-right' ? side : compare.right,
      );
      return true;
    }
    return field === 'query';
  }

  input(target: HTMLInputElement): boolean {
    if (this.console.input(target)) return true;
    if (target.dataset.ed === 'query') {
      this.ui.query = target.value;
      this.host.paint();
      const search = this.host.root.querySelector<HTMLInputElement>('[data-ed="query"]');
      search?.focus();
      search?.setSelectionRange(target.value.length, target.value.length);
      return true;
    }
    if (target.dataset.edAdd && this.ui.adding) {
      const key = target.dataset.edAdd as 'value' | 'name' | 'text';
      this.ui.adding[key] = target.value;
      return true;
    }
    return false;
  }

  submit(form: HTMLFormElement): boolean {
    if (form.dataset.action !== 'ed-add-submit') return false;
    this.addSubmit();
    return true;
  }

  /** La poignée de la console (sa hauteur). */
  pointerDown(event: PointerEvent): boolean {
    if (this.host.state.route.view !== 'editor') return false;
    return this.console.pointerDown(event);
  }

  /** Clavier : Ctrl+S, déplacement d'étape (Alt+↑/↓), retrait (Suppr), arbre de l'explorateur, Échap. */
  keydown(event: KeyboardEvent): boolean {
    if (this.host.state.route.view !== 'editor') return false;
    if (this.console.keydown(event)) return true;
    const ui = this.ui;
    const target = event.target as HTMLElement;
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's') {
      event.preventDefault();
      if (!event.defaultPrevented || !target.closest('.cm-editor')) void this.save();
      return true;
    }
    if (event.key === 'Escape' && (ui.confirm || ui.adding)) {
      ui.confirm = undefined;
      ui.adding = undefined;
      this.pendingLeave = undefined;
      this.host.paint();
      return true;
    }
    const row = target.closest<HTMLElement>('.ed-step');
    if (row && target.dataset.action === 'ed-select') {
      const index = Number(row.dataset.index);
      const scenario = row.dataset.scenario !== undefined ? Number(row.dataset.scenario) : undefined;
      if (
        event.altKey &&
        (event.key === 'ArrowUp' || event.key === 'ArrowDown') &&
        can(this.host.state, 'DECIDE')
      ) {
        event.preventDefault();
        this.moveStep(index, index + (event.key === 'ArrowUp' ? -1 : 1), scenario);
        return true;
      }
      if (event.key === 'Delete' && can(this.host.state, 'DECIDE')) {
        event.preventDefault();
        const remove = this.host.root.querySelector<HTMLElement>(
          `.ed-step[data-index="${String(index)}"]${scenario !== undefined ? `[data-scenario="${String(scenario)}"]` : ''} [data-action="ed-remove"]`,
        );
        if (remove) this.click('ed-remove', remove);
        return true;
      }
    }
    if (
      target.hasAttribute('data-tree') &&
      ['ArrowDown', 'ArrowUp', 'Home', 'End', 'ArrowRight', 'ArrowLeft'].includes(event.key)
    ) {
      const items = [...this.host.root.querySelectorAll<HTMLElement>('[data-tree]')];
      const at = items.indexOf(target);
      const item = target.closest('[role="treeitem"]');
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const expanded = item?.getAttribute('aria-expanded');
        if (
          (event.key === 'ArrowRight' && expanded === 'false') ||
          (event.key === 'ArrowLeft' && expanded === 'true')
        ) {
          event.preventDefault();
          this.click('ed-collapse', target);
        }
        return true;
      }
      event.preventDefault();
      const next =
        event.key === 'Home'
          ? 0
          : event.key === 'End'
            ? items.length - 1
            : Math.min(Math.max(at + (event.key === 'ArrowDown' ? 1 : -1), 0), items.length - 1);
      for (const entry of items) entry.tabIndex = -1;
      const focus = items[next];
      if (focus) {
        focus.tabIndex = 0;
        focus.focus();
      }
      return true;
    }
    return false;
  }

  private dragStart(event: DragEvent): void {
    const row = (event.target as Element).closest<HTMLElement>('.ed-step');
    if (!row || !can(this.host.state, 'DECIDE')) return;
    this.dragging = {
      index: Number(row.dataset.index),
      ...(row.dataset.scenario !== undefined ? { scenario: Number(row.dataset.scenario) } : {}),
    };
    event.dataTransfer?.setData('text/plain', row.dataset.index ?? '');
    if (event.dataTransfer) event.dataTransfer.effectAllowed = 'move';
  }

  private drop(event: DragEvent): void {
    const row = (event.target as Element).closest<HTMLElement>('.ed-step');
    const from = this.dragging;
    this.dragging = undefined;
    if (!row || !from) return;
    event.preventDefault();
    const scenario = row.dataset.scenario !== undefined ? Number(row.dataset.scenario) : undefined;
    // Un .feature : seulement dans le même scénario (une étape ne change pas de scénario).
    if (scenario !== from.scenario) return;
    const to = Number(row.dataset.index);
    if (to !== from.index) this.moveStep(from.index, to, scenario);
  }

  // ── Le rendu : l'éditeur de code et la comparaison dans la page redessinée ───────────────────

  beforePaint(): void {
    this.console.beforePaint();
    const buffer = this.active();
    this.editorHadFocus = buffer ? (this.editors.get(buffer.path)?.hasFocus() ?? false) : false;
  }

  afterPaint(): void {
    if (this.host.state.route.view !== 'editor') return;
    this.console.afterPaint();
    if (!this.kit) return;
    const ui = this.ui;
    const buffer = this.active();
    if (!buffer) return;
    const mode = modeOf(ui, buffer.path);
    if (mode === 'source') {
      const host = this.host.root.querySelector('[data-cm-host]');
      if (!host) return;
      let editor = this.editors.get(buffer.path);
      const readOnly = !(
        can(this.host.state, 'DECIDE') &&
        (buffer.format === 'yaml' || buffer.format === 'gherkin' || can(this.host.state, 'RUN_WRITES'))
      );
      if (!editor) {
        const path = buffer.path;
        editor = this.kit.createCodeEditor({
          root: this.host.root,
          text: buffer.draft,
          language: languageOf(path),
          locale: this.host.state.t.locale,
          label: `${this.t.source} ${path}`,
          readOnly,
          onChange: (text) => {
            this.typed(path, text);
          },
          onSave: () => {
            void this.save(path);
          },
        });
        this.editors.set(path, editor);
      } else editor.setText(buffer.draft);
      editor.attach(host);
      editor.setDiagnostics(diagnosticsOf(ui, buffer.path));
      const goTo = this.pendingGoTo;
      this.pendingGoTo = undefined;
      if (goTo?.path === buffer.path) editor.goTo(goTo.line, goTo.column);
      else if (this.editorHadFocus) editor.view.focus();
      return;
    }
    if (mode === 'compare' && ui.compare?.path === buffer.path && !ui.compare.loading) {
      const host = this.host.root.querySelector('[data-diff-host]');
      const left = ui.compare.texts[ui.compare.left];
      const right = ui.compare.texts[ui.compare.right];
      if (!host || left === undefined || right === undefined) return;
      const key = `${buffer.path}|${ui.compare.left}|${ui.compare.right}|${String(left.length)}|${String(right.length)}|${left === right ? '=' : '≠'}|${right.slice(-64)}|${left.slice(-64)}`;
      if (this.diff?.key !== key) {
        this.diff?.handle.destroy();
        this.diff = {
          key,
          handle: this.kit.createDiff({
            root: this.host.root,
            left,
            right,
            language: languageOf(buffer.path),
            locale: this.host.state.t.locale,
          }),
        };
      }
      this.diff.handle.attach(host);
    }
  }
}

/** Les formats que l'écran sait lancer : pour la barre (le serveur reste seul juge). */
export const isEngineFormat = (format: GenerationFormatName): boolean =>
  format === 'yaml' || format === 'gherkin';
