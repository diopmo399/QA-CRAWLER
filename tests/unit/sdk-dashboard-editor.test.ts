import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type {
  RunLogEvent,
  AccessMe,
  GeneratedFileView,
  GeneratedTestsView,
  ProjectDetail,
  RecordingSnapshot,
  TestRunView,
} from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { codeOutline } from '../../src/sdk/editor/code-outline.js';
import { parseFlow } from '../../src/sdk/editor/flow-document.js';
import { parseFeature } from '../../src/sdk/editor/gherkin-document.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import {
  consoleSources,
  currentStep,
  emptyConsoleUi,
  emptyFilters,
  errorEvents,
  lineHtml,
  matches,
  shownEvents,
  stepRows,
  summaryOf,
} from '../../src/sdk/ui/dashboard-console.js';
import {
  diagnosticsOf,
  emptyEditorUi,
  kindOf,
  modeOf,
  runDiagnostics,
  type EditorBuffer,
  type EditorUi,
} from '../../src/sdk/ui/dashboard-editor.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * L'ÉCRAN ÉDITEUR (fonctions pures), sur de vrais fichiers générés : la barre (état de sauvegarde, de
 * vérification, actions et pourquoi elles sont inactives), l'explorateur en arbre, les onglets, la vue
 * visuelle du flow YAML et du .feature, l'absence de vue visuelle pour le code (dite), l'inspecteur par
 * format, les diagnostics par famille avec leur emplacement, les résultats, la comparaison, les
 * confirmations dans la page, les droits, l'échappement. Le parcours réel : sdk-dashboard-editor.
 */
const at = '2026-10-29T10:00:00.000Z';
const t = dashboardStrings('fr');
const fixture = (name: string): string =>
  readFileSync(path.join('tests', 'fixtures', 'generated-tests', name), 'utf8');
const YAML = 'ouvrir-une-fiche.flow.yaml';
const FEATURE = 'ouvrir-une-fiche.feature';
const SPEC = 'playwright/ouvrir-une-fiche.spec.ts';
const FLOW = fixture(YAML);
const GHERKIN = fixture(FEATURE);
const PLAYWRIGHT = fixture('ouvrir-une-fiche.spec.ts.txt');

const file = (format: GeneratedFileView['format'], filePath: string, content: string): GeneratedFileView => ({
  format,
  path: filePath,
  status: 'STATICALLY_VALIDATED',
  validation: { method: 'check', ok: true, messages: [] },
  assertions: [],
  limits: [],
  content,
  revision: 'r1',
});

const run = (extra: Partial<TestRunView>): TestRunView => ({
  id: 'tr-2026-10-29T10-00-00-000Z-abc123',
  recording: 'ouvrir-une-fiche',
  format: 'yaml',
  status: 'PASSED',
  tool: 'QA-CRAWLER 0.2.0 (Dry Run)',
  kind: 'ENGINE',
  target: 'http://127.0.0.1:9',
  queuedAt: at,
  startedAt: at,
  finishedAt: at,
  cases: [],
  counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
  output: '',
  mode: 'RUN',
  ...extra,
});

const view = (runs: TestRunView[] = []): GeneratedTestsView => ({
  recording: 'ouvrir-une-fiche',
  generatedAt: at,
  warnings: [],
  files: [file('yaml', YAML, FLOW), file('gherkin', FEATURE, GHERKIN), file('playwright', SPEC, PLAYWRIGHT)],
  runners: [
    { format: 'yaml', kind: 'ENGINE', tool: 'QA-CRAWLER 0.2.0', available: true },
    { format: 'gherkin', kind: 'ENGINE', tool: 'QA-CRAWLER 0.2.0', available: true },
    { format: 'playwright', kind: 'EXTERNAL', tool: 'Playwright Test 1.56.1', available: true },
  ],
  runs,
});

function buffer(filePath: string, draft?: string, extra: Partial<EditorBuffer> = {}): EditorBuffer {
  const kind = kindOf(filePath);
  const saved = filePath === YAML ? FLOW : filePath === FEATURE ? GHERKIN : PLAYWRIGHT;
  const text = draft ?? saved;
  return {
    path: filePath,
    format: filePath === YAML ? 'yaml' : filePath === FEATURE ? 'gherkin' : 'playwright',
    saved,
    draft: text,
    revision: 'r1',
    status: 'STATICALLY_VALIDATED',
    diagnostics: [],
    outline:
      kind === 'flow'
        ? { kind: 'flow', parse: parseFlow(text) }
        : kind === 'feature'
          ? { kind: 'feature', parse: parseFeature(text) }
          : { kind: 'code', entries: codeOutline(text, 'typescript') },
    ...extra,
  };
}

const project = {
  id: 'prj_a',
  name: 'Fiches',
  targetUrl: 'http://127.0.0.1:9/',
  framework: 'other',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 0, scenarios: 0, recordings: 1, executions: 0 },
  draft: {},
  environments: [],
  scenarios: [],
} as unknown as ProjectDetail;

const me = (role: AccessMe['role']): AccessMe => ({
  id: 'mbr_abcdefgh',
  name: 'Camille R.',
  kind: 'MEMBER',
  role,
  rights: [...ROLE_RIGHTS[role]],
  mode: 'named',
});

function base(ed: Partial<EditorUi> = {}, extra: Partial<DashboardState> = {}): DashboardState {
  const buffers = { [YAML]: buffer(YAML), [FEATURE]: buffer(FEATURE), [SPEC]: buffer(SPEC) };
  return {
    t,
    phase: 'ready',
    route: { view: 'editor', projectId: 'prj_a', recording: 'ouvrir-une-fiche' },
    days: 7,
    showArchived: false,
    launch: { kind: 'REPLAY', environmentId: '', scenarios: [], busy: false },
    projectId: 'prj_a',
    menuOpen: false,
    checks: {},
    cancellation: true,
    picked: [],
    severity: 'ALL',
    project,
    recordings: [
      { name: 'ouvrir-une-fiche', projectId: 'prj_a', status: 'COMPLETED', serverTime: at, lastSeq: 1 },
    ] as RecordingSnapshot[],
    req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
    signIn: false,
    access: emptyAccessUi(),
    recs: emptyRecordingsUi(),
    lib: emptyLibraryUi(),
    tst: emptyTestsUi(),
    ed: {
      ...emptyEditorUi(),
      recording: 'ouvrir-une-fiche',
      view: view(),
      open: [YAML, FEATURE],
      active: YAML,
      buffers,
      kit: 'ready',
      ...ed,
    },
    ...extra,
  };
}

const zone = (html: string, selector: string): string => {
  const start = html.indexOf(selector);
  return start < 0 ? '' : html.slice(start);
};

describe('dashboard — generated test editor', () => {
  it('is an entry of the menu; while loading it says so; without a file it leads to the generation', () => {
    expect(activeNav({ view: 'editor', projectId: 'prj_a' })).toBe('editor');
    expect(renderDashboard(base({ view: undefined }))).toContain('aria-busy="true"');
    const empty = renderDashboard(
      base({ view: { ...view(), files: [] }, open: [], active: undefined, buffers: {} }),
    );
    expect(empty).toContain(t.ed.noFiles);
    expect(empty).toContain('data-action="ed-back"');
  });

  it('the bar: file, format, saved and checked state; Save is off without a change, Dry Run only for YAML and Gherkin', () => {
    const html = renderDashboard(base());
    const top = zone(html, '<header class="ed-top">');
    expect(top).toContain('<b>ouvrir-une-fiche.flow.yaml</b>');
    expect(top).toContain('>YML<');
    expect(top).toContain('>Enregistré<');
    expect(top).toContain('Vérifié statiquement');
    expect(top).toContain(t.ed.staticOnly);
    expect(top).toMatch(/data-action="ed-save" disabled title="Rien à enregistrer\./);
    expect(top).toContain('data-action="ed-dry-run"');
    const code = renderDashboard(base({ active: SPEC, open: [SPEC] }));
    expect(zone(code, '<header class="ed-top">')).not.toContain('data-action="ed-dry-run"');
  });

  it('unsaved changes: marked in the bar and the tab; a run waits for the save; the check is out of date', () => {
    const draft = FLOW.replace('name: Utilisateurs', 'name: Membres');
    const state = base({
      buffers: { [YAML]: buffer(YAML, draft, { checkedFor: FLOW }), [FEATURE]: buffer(FEATURE) },
    });
    const html = renderDashboard(state);
    expect(html).toContain(t.ed.unsaved);
    expect(zone(html, 'class="ed-tabs"')).toContain('class="ed-dot"');
    expect(html).toMatch(/data-action="ed-run" disabled title="Enregistrez d’abord/);
    expect(html).toContain(t.ed.notCheckedSince);
    expect(html).not.toMatch(/data-action="ed-save" disabled/);
  });

  it('back to the saved content (changes discarded): the saved state and its diagnostics count again', () => {
    const broken = FLOW.replace('name: Utilisateurs', 'label: Utilisateurs');
    const problem = {
      severity: 'error' as const,
      category: 'schema' as const,
      message: 'exactly one of testId, role, label',
      source: 'flow schema',
      line: 9,
    };
    const state = base({
      buffers: {
        [YAML]: buffer(YAML, FLOW, { checkedFor: broken, diagnostics: [problem], savedDiagnostics: [] }),
      },
    });
    const html = renderDashboard(state);
    expect(html).not.toContain(t.ed.notCheckedSince);
    expect(html).not.toContain('exactly one of');
    expect(zone(html, 'class="ed-top"')).toContain(t.tst.fileStatuses.STATICALLY_VALIDATED);
  });

  it('the visual view of the flow YAML: groups, numbered steps, action, tools; the source keeps the other views', () => {
    const html = renderDashboard(base());
    expect(modeOf(base().ed, YAML)).toBe('visual');
    const visual = zone(html, 'class="ed-visual"');
    expect(visual).toContain('<b>Aller à la liste</b>');
    expect(visual).toContain('<b>Ouvrir la fiche</b>');
    expect(visual).toContain('Cliquer sur le lien « Utilisateurs »');
    expect(visual.match(/<li class="ed-step/g)).toHaveLength(3);
    expect(visual).toContain('draggable="true"');
    expect(visual).toContain('data-action="ed-move"');
    expect(visual).toContain('aria-label="Dupliquer l’étape"');
    // Le premier pas ne monte pas, le dernier ne descend pas.
    expect(visual).toMatch(/data-index="0" data-to="-1" disabled/);
  });

  it('code has no visual view, and the screen says why; a broken YAML neither, until fixed in the source', () => {
    const code = renderDashboard(base({ active: SPEC, open: [SPEC] }));
    expect(code).toMatch(/data-mode="visual" disabled title="Pas de vue visuelle pour du code/);
    expect(code).toContain('data-cm-host');
    const broken = 'name: x\nsteps:\n  - click: { role: link\n';
    const html = renderDashboard(
      base({
        buffers: { [YAML]: buffer(YAML, broken), [FEATURE]: buffer(FEATURE) },
        console: { ...emptyConsoleUi(), tab: 'diagnostics' },
      }),
    );
    expect(html).toMatch(/data-mode="visual" disabled title="Le fichier ne se lit pas/);
    expect(zone(html, 'class="ed-panel')).toContain('Syntaxe');
  });

  it('the inspector of a flow step: sections, target, permissions, group; read only for a reader', () => {
    const html = renderDashboard(base({ selected: `${YAML}#1` }));
    const inspector = zone(html, 'class="ed-inspector"');
    for (const section of [
      'Action et intention',
      'Élément cible',
      'Paramètres',
      'Assertions',
      'Dépendances',
      'Métadonnées',
    ])
      expect(inspector).toContain(section);
    expect(inspector).toContain('data-ed-field="strategy"');
    expect(inspector).toMatch(/<option value="role" selected>Rôle<\/option>/);
    expect(inspector).toContain('value="Utilisateur 1"');
    expect(inspector).toContain('data-ed-field="allow" data-value="MUTATION"');
    expect(inspector).toContain('fiche-ouverte');
    expect(inspector).toMatch(/<option value="g-fiche" selected>Ouvrir la fiche<\/option>/);
    expect(inspector).toContain('OPEN_USER');
    const reader = renderDashboard(base({ selected: `${YAML}#1` }, { me: me('READER') }));
    expect(zone(reader, 'class="ed-inspector"')).toMatch(
      /data-ed-field="name" data-index="1" value="" disabled/,
    );
    expect(zone(reader, 'class="ed-visual"')).not.toContain('data-action="ed-move"');
    expect(reader).toMatch(/data-action="ed-save" disabled title="Votre rôle ne le permet pas\./);
  });

  it('the inspector of a Gherkin step: keyword of the file language, sentence; code: edited in the source only', () => {
    const html = renderDashboard(base({ active: FEATURE, selected: `${FEATURE}#0:2` }));
    const inspector = zone(html, 'class="ed-inspector"');
    expect(inspector).toMatch(
      /data-ed-field="keyword"[^>]*>[\s\S]*<option value="Alors " selected>Alors<\/option>/,
    );
    expect(inspector).toContain('value="l&#39;URL contient &quot;/users/&quot;"');
    const code = renderDashboard(base({ active: SPEC, open: [SPEC], selected: undefined }));
    expect(zone(code, 'class="ed-inspector"')).toContain(t.ed.codeInspector);
  });

  it('diagnostics grouped by family, with the place; a step in error is marked on its row', () => {
    const state = base({ console: { ...emptyConsoleUi(), tab: 'diagnostics' } });
    const yaml = state.ed.buffers[YAML];
    if (!yaml) throw new Error('no buffer');
    yaml.diagnostics = [
      {
        severity: 'error',
        category: 'schema',
        message: 'steps.0.click: exactly one of …',
        source: 'flow schema',
        line: 8,
        step: 1,
      },
      {
        severity: 'warning',
        category: 'references',
        message: 'à revoir',
        source: 'gherkin dictionary',
        line: 30,
      },
    ];
    yaml.checkedFor = yaml.draft;
    const html = renderDashboard(state);
    const panel = zone(html, 'class="ed-panel');
    expect(panel).toContain('Schéma');
    expect(panel).toContain('Références');
    expect(panel).toContain('ligne 8 · étape 1 · flow schema');
    expect(panel).toContain('data-action="ed-diag" data-path="ouvrir-une-fiche.flow.yaml" data-line="8"');
    expect(panel).toContain('>Erreur<');
    expect(panel).toContain('>Avertissement<');
    expect(zone(html, 'class="ed-visual"')).toContain('class="ed-st ko"');
    expect(zone(html, '<header class="ed-top">')).toContain('1 erreur(s)');
    // Une vérification plus ancienne que le brouillon ne compte plus.
    yaml.draft = `${yaml.draft}\n`;
    expect(diagnosticsOf(state.ed, YAML)).toEqual([]);
  });

  it('results: the last Dry Run and run; failures become execution diagnostics placed by step or line', () => {
    const dry = run({
      mode: 'DRY_RUN',
      status: 'FAILED',
      dryRunStatus: 'PARTIALLY_MATCHED',
      cases: [
        { name: 'Utilisateurs', status: 'PASSED', detail: 'MATCHED', step: 1 },
        { name: 'Utilisateur 1', status: 'FAILED', detail: 'MISSING', step: 2, message: 'not found' },
      ],
    });
    const played = run({
      id: 'tr-2026-10-29T09-00-00-000Z-abc124',
      format: 'playwright',
      tool: 'Playwright Test 1.56.1',
      kind: 'EXTERNAL',
      status: 'FAILED',
      cases: [
        { name: 'Ouvrir une fiche', status: 'FAILED', message: 'Error at ouvrir-une-fiche.spec.ts:20:5' },
      ],
    });
    const state = base({
      view: view([dry, played]),
      console: { ...emptyConsoleUi(), tab: 'summary', runId: dry.id, run: dry, connection: 'ended' },
    });
    const html = renderDashboard(state);
    const panel = zone(html, 'class="ed-panel');
    expect(panel).toContain(t.ed.con.dryRunVerdict);
    expect(panel).toContain('Partiellement retrouvé');
    expect(panel).toContain('MISSING');
    expect(zone(html, 'class="ed-visual"')).toContain('class="ed-st ok"');
    expect(runDiagnostics(state.ed, YAML)).toEqual([
      expect.objectContaining({ category: 'execution', step: 2, source: 'Dry Run' }),
    ]);
    expect(runDiagnostics(state.ed, SPEC)).toEqual([
      expect.objectContaining({ category: 'execution', line: 20 }),
    ]);
  });

  it('the comparison: two versions chosen, the summary, restore and discard, the new generation when it exists', () => {
    const edited = buffer(YAML, `${FLOW}# brouillon\n`, { editedAt: at });
    const html = renderDashboard(
      base({
        buffers: { [YAML]: edited, [FEATURE]: buffer(FEATURE) },
        mode: { [YAML]: 'compare' },
        compare: {
          path: YAML,
          left: 'generated',
          right: 'draft',
          texts: {},
          summary: { added: 1, removed: 0, changes: 1 },
        },
        preview: { warnings: [], files: [{ format: 'yaml', path: YAML, content: FLOW }] },
      }),
    );
    const compare = zone(html, 'class="ed-compare"');
    expect(compare).toMatch(/<option value="generated" selected>Version générée<\/option>/);
    expect(compare).toMatch(/<option value="draft" selected>Modifications en cours<\/option>/);
    expect(compare).toContain('<option value="preview" >Nouvelle génération</option>');
    expect(compare).toContain('>+1<');
    expect(compare).toContain('data-action="ed-restore"');
    expect(compare).toContain('data-action="ed-discard"');
    expect(compare).toContain('data-action="ed-overwrite"');
    expect(compare).toContain('data-diff-host');
  });

  it('confirmations stay in the page: leaving, closing, removing a step', () => {
    const dirty = { [YAML]: buffer(YAML, `${FLOW}#\n`), [FEATURE]: buffer(FEATURE) };
    expect(renderDashboard(base({ buffers: dirty, confirm: { kind: 'leave' } }))).toContain(
      '1 fichier(s) avec des modifications non enregistrées.',
    );
    expect(renderDashboard(base({ confirm: { kind: 'close', path: YAML } }))).toContain(
      'Fermer ouvrir-une-fiche.flow.yaml sans enregistrer',
    );
    const remove = renderDashboard(base({ confirm: { kind: 'remove', path: YAML, index: 1 } }));
    expect(remove).toContain('role="alertdialog"');
    expect(remove).toContain('Retirer l’étape 2 ?');
  });

  it('the explorer is a tree: levels, current file, the outline of the open file, search without loss', () => {
    const html = renderDashboard(base({ selected: `${YAML}#2` }));
    const tree = zone(html, 'role="tree"');
    expect(tree).toContain('aria-level="1"');
    expect(tree).toMatch(/aria-level="2"[^>]*aria-current="true"/);
    expect(tree).toContain('3. Vérifier url « /users/ »');
    expect(tree.match(/tabindex="0"/g)).toHaveLength(1);
    const searched = zone(renderDashboard(base({ query: 'Utilisateur 1' })), 'role="tree"');
    expect(searched).toContain('2. Cliquer sur le lien « Utilisateur 1 »');
    expect(searched).not.toContain('1. Cliquer sur le lien « Utilisateurs »');
  });

  it('escapes the content of the files and of the diagnostics', () => {
    const state = base({ console: { ...emptyConsoleUi(), tab: 'diagnostics' } });
    const yaml = state.ed.buffers[YAML];
    if (!yaml) throw new Error('no buffer');
    yaml.diagnostics = [
      { severity: 'error', category: 'schema', message: '<img src=x onerror=alert(1)>', source: 'x' },
    ];
    yaml.checkedFor = yaml.draft;
    const html = renderDashboard(state);
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('English strings exist for every French one', () => {
    expect(Object.keys(dashboardStrings('en').ed).sort()).toEqual(Object.keys(t.ed).sort());
    expect(dashboardStrings('en').nav.editor).toBe('Editor');
  });
});

describe('dashboard — execution console', () => {
  let seq = 0;
  const event = (extra: Partial<RunLogEvent>): RunLogEvent => {
    seq += 1;
    return {
      seq,
      at: `2026-10-29T10:00:${String(seq % 60).padStart(2, '0')}.000Z`,
      runId: 'tr-2026-10-29T10-00-00-000Z-abc123',
      level: 'INFO',
      category: 'ENGINE',
      type: 'PHASE',
      message: 'phase',
      source: 'engine',
      ...extra,
    };
  };
  const live = run({ status: 'RUNNING', mode: 'RUN', tool: 'QA-CRAWLER 0.2.0', finishedAt: undefined });
  const story = (): RunLogEvent[] => {
    seq = 0;
    return [
      event({ category: 'SYSTEM', type: 'RUN_CREATED', status: 'REQUESTED', message: 'run created' }),
      event({
        category: 'ACTION',
        type: 'STEP_STARTED',
        status: 'RUNNING',
        step: 1,
        line: 8,
        message: 'step 1: click',
      }),
      event({
        category: 'NETWORK',
        type: 'HTTP_REQUEST',
        step: 1,
        line: 8,
        message: 'GET /users → 200',
        level: 'DEBUG',
      }),
      event({
        category: 'ACTION',
        type: 'STEP_FINISHED',
        status: 'CONFIRMED',
        step: 1,
        line: 8,
        durationMs: 120,
        message: 'step 1 PASSED',
      }),
      event({
        category: 'ACTION',
        type: 'STEP_STARTED',
        status: 'RUNNING',
        step: 2,
        line: 25,
        message: 'step 2: click <b>Utilisateur 1</b>',
      }),
    ];
  };

  it('filters by level, category, step, type, status, text and period; the reset shows everything again', () => {
    const events = story();
    const all = { ...emptyFilters(), levels: ['DEBUG', 'INFO', 'WARN', 'ERROR'] as RunLogEvent['level'][] };
    expect(events.filter((entry) => matches(entry, emptyFilters())).length).toBe(4);
    expect(events.filter((entry) => matches(entry, all)).length).toBe(5);
    expect(events.filter((entry) => matches(entry, { ...all, category: 'NETWORK' })).length).toBe(1);
    expect(events.filter((entry) => matches(entry, { ...all, step: '2' })).length).toBe(1);
    expect(events.filter((entry) => matches(entry, { ...all, type: 'STEP_FINISHED' })).length).toBe(1);
    expect(events.filter((entry) => matches(entry, { ...all, status: 'RUNNING' })).length).toBe(2);
    expect(events.filter((entry) => matches(entry, { ...all, text: 'utilisateur 1' })).length).toBe(1);
    const time = (iso: string): string => {
      const date = new Date(iso);
      return [date.getHours(), date.getMinutes(), date.getSeconds()]
        .map((part) => String(part).padStart(2, '0'))
        .join(':');
    };
    const from = time(events[2]?.at ?? '');
    expect(events.filter((entry) => matches(entry, { ...all, from })).length).toBe(3);
  });

  it('step progress as the tool says it: running, confirmed, a failure wins, no end reported once the run is over', () => {
    const events = story();
    expect(stepRows(events).map((row) => [row.step, row.status, row.line])).toEqual([
      [1, 'CONFIRMED', 8],
      [2, 'RUNNING', 25],
    ]);
    expect(currentStep(events)?.step).toBe(2);
    const failed = [
      ...events,
      event({
        category: 'ACTION',
        type: 'STEP_FINISHED',
        status: 'FAILED',
        step: 2,
        level: 'ERROR',
        errorKind: 'SELECTOR',
        message: 'not found',
      }),
    ];
    expect(stepRows(failed)[1]).toMatchObject({ status: 'FAILED', errors: 1 });
    expect(errorEvents(failed).map((entry) => entry.errorKind)).toEqual(['SELECTOR']);
    // Fini sans fin rapportée pour l'étape 2 : jamais « confirmée » par défaut.
    const ended = [
      ...events,
      event({
        category: 'SYSTEM',
        type: 'RUN_FINISHED',
        message: 'run finished: ERROR',
        level: 'ERROR',
        data: { status: 'ERROR' },
      }),
    ];
    expect(stepRows(ended)[1]?.status).toBe('UNFINISHED');
    expect(currentStep(ended)).toBeUndefined();
    expect(summaryOf(ended)).toMatchObject({ total: 6, steps: { CONFIRMED: 1, UNFINISHED: 1 } });
  });

  it('a line: time, level, category, a status in words (not only a color), its step and line, escaped', () => {
    const events = story();
    const html = lineHtml(base(), events[4] as RunLogEvent, YAML, false);
    expect(html).toContain('lv-INFO');
    expect(html).toContain(t.ed.con.statuses.RUNNING);
    expect(html).toContain('data-action="ed-diag"');
    expect(html).toContain('data-step="2"');
    expect(html).toContain('data-line="25"');
    expect(html).toContain('&lt;b&gt;Utilisateur 1&lt;/b&gt;');
    expect(html).not.toContain('<b>Utilisateur 1</b>');
  });

  it('the panel: tabs by source (no network nor browser tab for Playwright Test), state of the log, current step', () => {
    const events = story();
    const engine = renderDashboard(
      base({ console: { ...emptyConsoleUi(), runId: live.id, run: live, events, connection: 'live' } }),
    );
    const tabs = zone(engine, 'class="ed-ptabs"');
    for (const label of ['Console', 'Étapes', 'Erreurs', 'Réseau', 'Navigateur', 'Résumé', 'Diagnostics'])
      expect(tabs).toContain(label);
    expect(engine).toContain('data-log-host');
    expect(engine).toContain(t.ed.con.connections.live);
    expect(engine).toContain(`${t.ed.con.currentStep} · ${t.ed.step(2)}`);
    expect(engine).toContain('data-action="ed-con-stop"');
    expect(consoleSources(run({ kind: 'EXTERNAL', format: 'playwright' }))).toEqual({
      network: false,
      browser: false,
    });
    expect(consoleSources(run({ kind: 'EXTERNAL', format: 'java' }))).toEqual({
      network: false,
      browser: true,
    });
    const external = run({ kind: 'EXTERNAL', format: 'playwright', tool: 'Playwright Test 1.56.1' });
    const html = renderDashboard(
      base({
        active: SPEC,
        console: { ...emptyConsoleUi(), runId: external.id, run: external, connection: 'ended' },
      }),
    );
    expect(zone(html, 'class="ed-ptabs"')).not.toContain('Réseau');
    expect(zone(html, 'class="ed-ptabs"')).not.toContain('Navigateur');
  });

  it('says when no log was kept, when the stream was cut (with a way to resume), and what was cleared locally', () => {
    const old = run({ logs: { state: 'UNAVAILABLE', count: 0 } });
    expect(
      renderDashboard(
        base({ console: { ...emptyConsoleUi(), runId: old.id, run: old, connection: 'unavailable' } }),
      ),
    ).toContain(t.ed.con.logsUnavailable);
    const events = story();
    const cut = renderDashboard(
      base({
        console: {
          ...emptyConsoleUi(),
          runId: live.id,
          run: live,
          events,
          connection: 'interrupted',
          cleared: 2,
        },
      }),
    );
    expect(cut).toContain('data-action="ed-con-resume"');
    expect(cut).toContain(t.ed.con.clearedNote);
    expect(shownEvents({ ...emptyConsoleUi(), events, cleared: 2 }).map((entry) => entry.seq)).toEqual([
      4, 5,
    ]);
    const stored = run({ logs: { state: 'STORED', count: 97 } });
    expect(
      renderDashboard(
        base({
          console: { ...emptyConsoleUi(), runId: stored.id, run: stored, events, connection: 'ended' },
        }),
      ),
    ).toContain(t.ed.con.logsStored(97));
  });

  it('the steps tab marks the current and failed steps; errors are grouped with their family and a diagnostic hint', () => {
    const events = [
      ...story(),
      event({
        category: 'ACTION',
        type: 'STEP_FINISHED',
        status: 'FAILED',
        step: 2,
        line: 25,
        level: 'ERROR',
        errorKind: 'SELECTOR',
        message: 'not found',
        data: { suggestions: '- click: { name: Fiche 1 }' },
      }),
    ];
    const steps = renderDashboard(
      base({
        console: { ...emptyConsoleUi(), tab: 'steps', runId: live.id, run: live, events, connection: 'live' },
      }),
    );
    expect(zone(steps, 'class="ed-con-table"')).toContain('class="ko"');
    const errors = renderDashboard(
      base({
        console: {
          ...emptyConsoleUi(),
          tab: 'errors',
          runId: live.id,
          run: live,
          events,
          connection: 'live',
        },
      }),
    );
    const list = zone(errors, 'class="ed-con-errors"');
    expect(list).toContain(t.ed.con.errorKinds.SELECTOR);
    expect(list).toContain(t.ed.con.hints.SELECTOR);
    expect(list).toContain('Fiche 1');
    expect(list).toContain('data-action="ed-con-step-events" data-step="2"');
  });

  it('a large log stays fast to filter and to sum up', () => {
    seq = 0;
    const events = Array.from({ length: 20_000 }, (_, index) =>
      event({
        level: index % 10 === 0 ? 'DEBUG' : 'INFO',
        step: (index % 30) + 1,
        status: index % 2 ? 'RUNNING' : 'CONFIRMED',
        message: `event ${String(index)}`,
      }),
    );
    const started = performance.now();
    const shown = shownEvents({
      ...emptyConsoleUi(),
      events,
      filters: { ...emptyFilters(), text: 'event 19' },
    });
    const rows = stepRows(events);
    const summary = summaryOf(events);
    expect(performance.now() - started).toBeLessThan(1500);
    expect(shown.length).toBeGreaterThan(0);
    expect(rows.length).toBe(30);
    expect(summary.total).toBe(20_000);
  });
});
