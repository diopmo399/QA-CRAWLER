import { describe, expect, it } from 'vitest';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import type {
  AccessMe,
  GeneratedTestsView,
  ProjectDetail,
  RecordingSnapshot,
  TestRunView,
} from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { activeRuns, emptyTestsUi, type TestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * L'ÉCRAN TESTS GÉNÉRÉS (fonctions pures) : l'enregistrement, la génération par formats, l'outil de chaque
 * format et ce qu'il garantit, l'exécution refusée quand l'outil manque, que rien n'est généré ou que le
 * rôle ne le permet pas, les exécutions avec leurs cas, leur sortie et leur rapport. Le parcours complet
 * dans Chromium, avec de vraies exécutions : sdk-dashboard-tests (intégration).
 */
const at = '2026-10-28T10:00:00.000Z';
const t = dashboardStrings('fr');

const project = {
  id: 'prj_a',
  name: 'Fiches',
  targetUrl: 'http://127.0.0.1:9/',
  framework: 'other',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 1, scenarios: 0, recordings: 2, executions: 0 },
  draft: {},
  environments: [
    {
      id: 'env_r',
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.1:9',
      createdAt: at,
      updatedAt: at,
    },
  ],
  scenarios: [],
} as unknown as ProjectDetail;

const recordings = [
  { name: 'ouvrir-une-fiche', projectId: 'prj_a', status: 'COMPLETED', serverTime: at, lastSeq: 3 },
  { name: 'chercher', projectId: 'prj_a', status: 'STORED', serverTime: at, lastSeq: 0 },
  { name: 'en-cours', projectId: 'prj_a', status: 'RECORDING', serverTime: at, lastSeq: 1 },
] as RecordingSnapshot[];

const run = (extra: Partial<TestRunView>): TestRunView => ({
  id: 'tr-2026-10-28T10-00-00-000Z-abc123',
  recording: 'ouvrir-une-fiche',
  format: 'playwright',
  status: 'PASSED',
  tool: 'Playwright Test 1.56.1',
  kind: 'EXTERNAL',
  target: 'http://127.0.0.1:9',
  queuedAt: at,
  startedAt: at,
  finishedAt: '2026-10-28T10:00:04.200Z',
  durationMs: 4200,
  cases: [{ name: 'ouvrir une fiche', status: 'PASSED', durationMs: 1250 }],
  counts: { passed: 1, failed: 0, skipped: 0, total: 1 },
  output: '1 passed (4.2s)\n',
  ...extra,
});

const view = (extra: Partial<GeneratedTestsView> = {}): GeneratedTestsView => ({
  recording: 'ouvrir-une-fiche',
  generatedAt: at,
  warnings: [],
  files: [
    {
      format: 'yaml',
      path: 'ouvrir-une-fiche.flow.yaml',
      status: 'STATICALLY_VALIDATED',
      validation: { method: 'flow schema', ok: true, messages: [] },
      assertions: [{ id: 'a1', description: 'La fiche est ouverte', support: 'NATIVE', status: 'APPROVED' }],
      limits: [],
      content: 'name: ouvrir-une-fiche\nsteps: []\n',
      revision: 'aaaaaaaaaaaa',
    },
    {
      format: 'playwright',
      path: 'playwright/ouvrir-une-fiche.spec.ts',
      status: 'STATICALLY_VALIDATED',
      validation: { method: 'typescript syntax', ok: true, messages: [] },
      assertions: [],
      limits: ['a2 is verified by the QA-CRAWLER replay only (run the flow YAML)'],
      content: "test('x', async () => { /* <script>alert(1)</script> */ });",
      revision: 'bbbbbbbbbbbb',
    },
  ],
  runners: [
    { format: 'yaml', kind: 'ENGINE', tool: 'QA-CRAWLER 4.0.0', available: true },
    { format: 'gherkin', kind: 'ENGINE', tool: 'QA-CRAWLER 4.0.0', available: true },
    { format: 'playwright', kind: 'EXTERNAL', tool: 'Playwright Test 1.56.1', available: true },
    {
      format: 'java',
      kind: 'EXTERNAL',
      tool: 'Apache Maven',
      available: false,
      reason: 'Maven (mvn) is not available on this server',
    },
  ],
  runs: [run({})],
  ...extra,
});

const me = (role: AccessMe['role']): AccessMe => ({
  id: 'mbr_abcdefgh',
  name: 'Camille R.',
  kind: 'MEMBER',
  role,
  rights: [...ROLE_RIGHTS[role]],
  mode: 'named',
});

const base = (tst: Partial<TestsUi> = {}, extra: Partial<DashboardState> = {}): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'tests', projectId: 'prj_a' },
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
  recordings,
  req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
  signIn: false,
  access: emptyAccessUi(),
  recs: emptyRecordingsUi(),
  lib: emptyLibraryUi(),
  tst: { ...emptyTestsUi(), recording: 'ouvrir-une-fiche', view: view(), ...tst },
  ed: emptyEditorUi(),
  ...extra,
});

const card = (html: string, format: string): string => {
  const start = html.indexOf(`<article class="tst-fmt" data-format="${format}">`);
  return html.slice(start, html.indexOf('</article>', start));
};

describe('dashboard — generated tests', () => {
  it('is an entry of the menu; only finished recordings are offered', () => {
    expect(activeNav({ view: 'tests', projectId: 'prj_a' })).toBe('tests');
    const html = renderDashboard(base());
    expect(html).toContain('data-view="tests" aria-current="page"');
    expect(html).toContain('>Tests générés<');
    expect(html).toContain('Fiches · 2 enregistrement(s)');
    expect(html).toContain('<option value="ouvrir-une-fiche" selected>');
    expect(html).toContain('<option value="chercher" >');
    expect(html).not.toContain('value="en-cours"');
  });

  it('without a finished recording, says how to get one', () => {
    const html = renderDashboard(base({ view: undefined, recording: undefined }, { recordings: [] }));
    expect(html).toContain(t.tst.noRecording);
    expect(html).not.toContain('data-action="tst-generate"');
  });

  it('each format says its tool and what it guarantees; a missing tool or no generation blocks the run', () => {
    const html = renderDashboard(base());
    const yaml = card(html, 'yaml');
    expect(yaml).toContain('QA-CRAWLER 4.0.0');
    expect(yaml).toContain(t.tst.engineSafety);
    expect(yaml).toContain('data-tst="environment"');
    expect(yaml).toMatch(/data-action="tst-run" data-format="yaml"\s+>/);
    const playwright = card(html, 'playwright');
    expect(playwright).toContain(t.tst.externalSafety);
    expect(playwright).not.toContain('data-tst="environment"');
    expect(playwright).toContain('Dernière exécution');
    expect(playwright).toContain('1 réussi(s), 0 échoué(s), 0 ignoré(s) sur 1');
    const gherkin = card(html, 'gherkin');
    expect(gherkin).toContain('data-format="gherkin" disabled');
    expect(gherkin).toContain(t.tst.notGenerated);
    const java = card(html, 'java');
    expect(java).toContain('data-format="java" disabled');
    expect(java).toContain('Maven (mvn) is not available on this server');
  });

  it('a generated file keeps its generation status; never a run verdict', () => {
    const html = renderDashboard(base({ file: 'playwright/ouvrir-une-fiche.spec.ts' }));
    expect(html).toContain('Vérifié statiquement');
    expect(html).toContain('a2 is verified by the QA-CRAWLER replay only');
    // Le contenu est échappé.
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('aria-expanded="true"');
  });

  it('a run opened: tool, target, cases with their message, output; the report only for an engine replay', () => {
    const failed = run({
      status: 'FAILED',
      cases: [
        { name: 'ouvrir une fiche', status: 'FAILED', message: 'locator.click: Timeout 5000ms exceeded' },
      ],
      counts: { passed: 0, failed: 1, skipped: 0, total: 1 },
    });
    let html = renderDashboard(base({ view: view({ runs: [failed] }), run: failed.id }));
    expect(html).toContain('>Échoué<');
    expect(html).toContain('locator.click: Timeout 5000ms exceeded');
    expect(html).toContain('Playwright Test 1.56.1');
    expect(html).toContain('<code>http://127.0.0.1:9</code>');
    expect(html).toContain('Sortie de l’outil');
    expect(html).not.toContain('data-action="tst-report"');
    const replay = run({ format: 'yaml', kind: 'ENGINE', tool: 'QA-CRAWLER 4.0.0', report: 'index.html' });
    html = renderDashboard(base({ view: view({ runs: [replay] }), run: replay.id }));
    expect(html).toContain('data-action="tst-report"');
  });

  it('an active run can be cancelled, and is followed', () => {
    const running = run({
      status: 'RUNNING',
      cases: [],
      counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
    });
    const state = base({ view: view({ runs: [running] }) });
    expect(activeRuns(state.tst.view)).toHaveLength(1);
    const html = renderDashboard(state);
    expect(card(html, 'playwright')).toContain('data-action="tst-cancel"');
    expect(html).toContain('>En cours<');
  });

  it('an unavailable or failed tool is never shown as passed', () => {
    const unavailable = run({
      status: 'UNAVAILABLE',
      cases: [],
      counts: { passed: 0, failed: 0, skipped: 0, total: 0 },
    });
    const html = renderDashboard(base({ view: view({ runs: [unavailable] }) }));
    expect(html).toContain('>Indisponible<');
    expect(html).not.toContain('>Réussi<');
  });

  it('rights: a reader generates and runs nothing; an analyst replays with the engine only', () => {
    let html = renderDashboard(base({}, { me: me('READER') }));
    expect(html).toMatch(/type="submit" disabled/);
    expect(card(html, 'yaml')).toContain('data-format="yaml" disabled');
    html = renderDashboard(base({}, { me: me('ANALYST') }));
    expect(card(html, 'yaml')).not.toContain('data-format="yaml" disabled');
    expect(card(html, 'playwright')).toContain('data-format="playwright" disabled');
    expect(card(html, 'playwright')).toContain(t.tst.noRight);
    html = renderDashboard(base({}, { me: me('PILOT') }));
    expect(card(html, 'playwright')).not.toContain('data-format="playwright" disabled');
  });

  it('no format chosen: generation waits for one', () => {
    const html = renderDashboard(base({ formats: [] }));
    expect(html).toContain(t.tst.pickFormat);
    expect(html).toMatch(/type="submit" disabled/);
  });

  it('a file opens in the editor; an edited file is marked and its generated version can be restored', () => {
    let html = renderDashboard(base({ file: 'ouvrir-une-fiche.flow.yaml' }));
    expect(html).toContain('data-action="tst-open-editor" data-path="ouvrir-une-fiche.flow.yaml"');
    expect(html).not.toContain('data-action="tst-restore"');
    // L'en-tête mène aussi à l'éditeur.
    expect(html).toContain('<button class="btn" data-action="tst-open-editor">');
    const edited = view({
      files: view().files.map((file) =>
        file.format === 'yaml' ? { ...file, editedAt: '2026-10-28T11:00:00.000Z' } : file,
      ),
    });
    html = renderDashboard(base({ view: edited, file: 'ouvrir-une-fiche.flow.yaml' }));
    expect(html).toContain('>Modifié à la main<');
    expect(card(html, 'yaml')).toContain('Modifié à la main');
    expect(html).toContain('data-action="tst-restore" data-path="ouvrir-une-fiche.flow.yaml"');
    html = renderDashboard(
      base({
        view: edited,
        file: 'ouvrir-une-fiche.flow.yaml',
        confirmRestore: 'ouvrir-une-fiche.flow.yaml',
      }),
    );
    expect(html).toContain(t.tst.restoreConfirm);
    expect(html).toContain('data-action="tst-restore-confirm"');
  });

  it('a regeneration that would replace files edited by hand waits for a confirmation', () => {
    const html = renderDashboard(base({ overwrite: ['ouvrir-une-fiche.flow.yaml'] }));
    expect(html).toContain(t.tst.overwriteWarn);
    expect(html).toContain('data-action="tst-overwrite"');
    expect(html).toContain('data-action="tst-overwrite-compare"');
    expect(html).toContain('<code>ouvrir-une-fiche.flow.yaml</code>');
  });

  it('a run played with edited files says so', () => {
    const played = run({ edited: ['playwright/ouvrir-une-fiche.spec.ts'] });
    const html = renderDashboard(base({ view: view({ runs: [played] }), run: played.id }));
    expect(html).toContain(
      'Joué avec des fichiers modifiés à la main : playwright/ouvrir-une-fiche.spec.ts.',
    );
  });

  it('rights: anyone who sees a file can open it; restoring a Playwright test needs RUN_WRITES', () => {
    const edited = view({
      files: view().files.map((file) => ({ ...file, editedAt: '2026-10-28T11:00:00.000Z' })),
    });
    const open = (file: string, role?: AccessMe['role']): string =>
      renderDashboard(base({ view: edited, file }, role ? { me: me(role) } : {}));
    const restore = (file: string): string => `data-action="tst-restore" data-path="${file}"`;
    expect(open('ouvrir-une-fiche.flow.yaml', 'READER')).toContain('data-action="tst-open-editor"');
    expect(open('ouvrir-une-fiche.flow.yaml', 'READER')).not.toContain(restore('ouvrir-une-fiche.flow.yaml'));
    expect(open('ouvrir-une-fiche.flow.yaml', 'ANALYST')).toContain(restore('ouvrir-une-fiche.flow.yaml'));
    expect(open('playwright/ouvrir-une-fiche.spec.ts', 'ANALYST')).not.toContain(
      restore('playwright/ouvrir-une-fiche.spec.ts'),
    );
    expect(open('playwright/ouvrir-une-fiche.spec.ts', 'PILOT')).toContain(
      restore('playwright/ouvrir-une-fiche.spec.ts'),
    );
  });

  it('English strings exist for every French one', () => {
    const fr = dashboardStrings('fr').tst;
    const en = dashboardStrings('en').tst;
    expect(Object.keys(en).sort()).toEqual(Object.keys(fr).sort());
    expect(dashboardStrings('en').nav.tests).toBe('Generated tests');
  });
});
