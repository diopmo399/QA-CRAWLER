import { describe, expect, it } from 'vitest';
import type { LibraryBlockView, ProjectDetail } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyLibraryUi, runnableScenarios, type LibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * LA BIBLIOTHÈQUE DANS LE DASHBOARD (fonctions pures) : les blocs (données, origine, scénarios qui les
 * rejouent), retirer un bloc libre seulement, ajouter un scénario, composer un parcours ; dans
 * Scénarios, les blocs ne se lancent pas seuls, un bloc s'insère ; un lecteur ne voit aucune action.
 */
const at = '2026-10-28T10:00:00.000Z';
const t = dashboardStrings('fr');

const project = {
  id: 'prj_a',
  name: 'Demandes',
  targetUrl: 'http://127.0.0.1:9/',
  framework: 'other',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 0, scenarios: 3, recordings: 0, executions: 0 },
  draft: { exploration: { ignoredPaths: [] } },
  environments: [],
  scenarios: [
    { name: 'Créer une demande', file: 'create/create.flow.yaml', format: 'yaml', steps: 3 },
    {
      name: 'Bloc connexion',
      file: 'library/bloc-connexion/bloc-connexion.flow.yaml',
      format: 'yaml',
      steps: 2,
      reusable: true,
    },
    {
      name: 'Composé',
      file: 'composed/compose/compose.flow.yaml',
      format: 'yaml',
      steps: 2,
      uses: ['Bloc connexion', 'Bloc <x>'],
    },
  ],
} as unknown as ProjectDetail;

const blocks: LibraryBlockView[] = [
  {
    name: 'Bloc connexion',
    file: 'library/bloc-connexion/bloc-connexion.flow.yaml',
    steps: 2,
    startAt: '/login',
    description: 'Se connecter',
    origin: { kind: 'scenario', name: 'Connexion' },
    inputs: ['user.name'],
    citations: [],
    usedBy: ['Composé'],
  },
  {
    name: 'Bloc <x>',
    file: 'library/bloc-x/bloc-x.flow.yaml',
    steps: 1,
    origin: { kind: 'recording', name: 'creer', group: 'Création' },
    inputs: [],
    citations: ['item.title'],
    usedBy: [],
  },
];

const base = (
  view: 'library' | 'scenarios',
  extra: Partial<DashboardState> = {},
  lib: Partial<LibraryUi> = {},
): DashboardState => ({
  t,
  phase: 'ready',
  route:
    view === 'library' ? { view, projectId: 'prj_a' } : { view, projectId: 'prj_a', scenario: 'Composé' },
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
  req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
  signIn: false,
  access: emptyAccessUi(),
  recs: emptyRecordingsUi(),
  lib: { ...emptyLibraryUi(), blocks, ...lib },
  ...extra,
});

const reader = {
  me: {
    id: 'm',
    name: 'N',
    kind: 'MEMBER' as const,
    role: 'READER' as const,
    rights: [...ROLE_RIGHTS.READER],
    mode: 'named' as const,
  },
};

describe('dashboard — scenario library', () => {
  it('lists the blocks: origin, data, who replays them; only an unused block can be removed', () => {
    const html = renderDashboard(base('library'));
    expect(activeNav({ view: 'library', projectId: 'prj_a' })).toBe('library');
    expect(html).toContain('data-view="library"');
    expect(html).toContain('Demandes · 2 bloc(s) réutilisable(s)');
    expect(html).toContain('Vient du scénario « Connexion »');
    expect(html).toContain('Vient du groupe « Création » de l’enregistrement creer');
    expect(html).toContain('◆ saisit <code>user.name</code>');
    expect(html).toContain('◇ cite <code>item.title</code>');
    expect(html).toContain('Rejoué par : Composé');
    expect(html).toContain('Bloc &lt;x&gt;');
    expect(html).not.toContain('data-action="lib-remove" data-block="Bloc connexion"');
    expect(html).toContain('Un bloc rejoué par un scénario ne se retire pas.');
    expect(html).toContain('data-action="lib-remove" data-block="Bloc &lt;x&gt;"');
    const confirming = renderDashboard(base('library', {}, { confirmRemove: 'Bloc <x>' }));
    expect(confirming).toContain('data-action="lib-remove-yes" data-block="Bloc &lt;x&gt;"');
  });

  it('adds a scenario (never a block) and composes a journey from blocks, in order', () => {
    const html = renderDashboard(
      base('library', {}, { compose: { name: 'Parcours', parts: ['Bloc connexion', 'Bloc <x>'], pick: '' } }),
    );
    expect(html).toContain('<form class="col" data-action="lib-add">');
    expect(html).toContain('<option value="Créer une demande"');
    expect(html).not.toContain(
      '<option value="Bloc connexion" selected>Bloc connexion</option></select></label><label class="field">Nom du bloc',
    );
    expect(html).toContain('data-action="lib-compose"');
    expect(html).toMatch(/lib-parts[^]*Bloc connexion[^]*Bloc &lt;x&gt;/);
    expect(html).toContain('data-action="lib-part-move" data-index="1" data-direction="up"');
    const empty = renderDashboard(base('library', {}, { compose: { name: '', parts: [], pick: '' } }));
    expect(empty).toContain('Aucun bloc choisi.');
    expect(empty).toMatch(/data-action="lib-compose"[^]*type="submit" class="btn primary"\s+disabled/);
  });

  it('scenarios: a block is not run alone; the chosen scenario says what it replays, a block inserts there', () => {
    expect(runnableScenarios(project.scenarios).map((scenario) => scenario.name)).toEqual([
      'Créer une demande',
      'Composé',
    ]);
    const html = renderDashboard(base('scenarios', { scenarioHistory: [], recordings: [] }));
    expect(html).not.toContain('data-name="Bloc connexion"');
    expect(html).toContain('1 bloc(s) réutilisable(s) sont dans la bibliothèque.');
    expect(html).toContain('Rejoue : Bloc connexion, Bloc &lt;x&gt;');
    expect(html).toContain('data-action="lib-insert" data-scenario="Composé"');
    expect(html).toContain('data-action="lib-from-scenario" data-name="Composé"');
  });

  it('a reader sees the library, never an action', () => {
    const html = renderDashboard(base('library', reader));
    expect(html).toContain('Bloc connexion');
    expect(html).not.toMatch(/data-action="lib-(remove|add|compose|part-add)"/);
    const scenarios = renderDashboard(base('scenarios', { ...reader, scenarioHistory: [], recordings: [] }));
    expect(scenarios).not.toContain('data-action="lib-insert"');
    expect(scenarios).not.toContain('data-action="lib-from-scenario"');
  });
});
