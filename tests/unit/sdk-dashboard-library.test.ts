import { describe, expect, it } from 'vitest';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import type { CompositionCheck, LibraryBlockView, ProjectDetail } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import {
  compositionKey,
  emptyLibraryUi,
  runnableScenarios,
  visibleBlocks,
  type LibraryUi,
} from '../../src/sdk/ui/dashboard-library.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * LA BIBLIOTHÈQUE DANS LE DASHBOARD (fonctions pures) : le catalogue (version, provenance, entrées et
 * sorties, état du contrat, utilisation), sa recherche et ses critères tirés des données réelles, les
 * détails d'un bloc (historique, contrat, dépendants), le compositeur (ordre, d'où vient chaque entrée,
 * vérification), le panneau d'ajout (aperçu, validation du nom) ; dans Scénarios, les blocs ne se lancent
 * pas seuls, un bloc s'insère sur la version lue, un bloc changé se signale ; un lecteur ne voit aucune action.
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
      revision: 'abc123def456',
    },
  ],
} as unknown as ProjectDetail;

const block = (over: Partial<LibraryBlockView> & { name: string }): LibraryBlockView => ({
  id: over.name.toLowerCase().replace(/[^a-z0-9]+/g, '-'),
  file: `library/${over.name}/x.flow.yaml`,
  steps: 2,
  version: 1,
  hash: '0123456789abcdef',
  history: [{ version: 1, at: '2026-10-28T09:00:00.000Z', change: 'created from the scenario "Connexion"' }],
  state: 'VALID',
  problems: [],
  contract: { source: 'DERIVED', inputs: [], outputs: [], preconditions: [], postconditions: [] },
  data: [],
  assertions: 0,
  inputs: [],
  citations: [],
  usedBy: [],
  pinnedBy: [],
  ...over,
});

const blocks: LibraryBlockView[] = [
  block({
    name: 'Bloc connexion',
    file: 'library/bloc-connexion/bloc-connexion.flow.yaml',
    startAt: '/login',
    description: 'Se connecter',
    origin: { kind: 'scenario', name: 'Connexion' },
    version: 2,
    updatedAt: '2026-10-28T11:00:00.000Z',
    contract: {
      source: 'DECLARED',
      inputs: [],
      outputs: [{ key: 'user.name', dynamic: true }],
      preconditions: ['la page de connexion est ouverte'],
      postconditions: [],
    },
    data: [{ key: 'user.name', dynamic: true }],
    assertions: 1,
    usedBy: ['Composé'],
    pinnedBy: [{ scenario: 'Composé', version: 1, current: false }],
    history: [
      { version: 1, change: 'created from the scenario "Connexion"' },
      { version: 2, at: '2026-10-28T11:00:00.000Z', change: 'new content validated' },
    ],
  }),
  block({
    name: 'Bloc <x>',
    file: 'library/bloc-x/bloc-x.flow.yaml',
    steps: 1,
    origin: { kind: 'recording', name: 'creer', group: 'Création' },
    state: 'CHANGED',
    problems: ['its content changed since version 1'],
    contract: {
      source: 'DERIVED',
      inputs: [{ key: 'user.name', required: true }],
      outputs: [],
      preconditions: [],
      postconditions: [],
    },
  }),
  block({ name: 'Bloc seul', steps: 5 }),
];

const check: CompositionCheck = {
  ok: false,
  name: 'Parcours',
  blocks: 2,
  steps: 3,
  order: [
    {
      position: 1,
      block: 'Bloc <x>',
      version: 1,
      steps: 1,
      inputs: [{ key: 'user.name', required: true }],
      outputs: [],
      satisfied: [],
      missing: ['user.name'],
    },
    {
      position: 2,
      block: 'Bloc connexion',
      version: 2,
      steps: 2,
      inputs: [],
      outputs: [{ key: 'user.name', dynamic: true }],
      satisfied: [],
      missing: [],
    },
  ],
  dependencies: [],
  missing: [],
  conflicts: [
    {
      key: 'item.title',
      blocks: ['A', 'B'],
      detail: 'item.title: fixed value "X" in "A", generated at replay (words) in "B"',
    },
  ],
  shared: [],
  dynamic: ['user.name'],
  errors: ['#1 "Bloc <x>" needs user.name, produced only later by #2', 'test data item.title: …'],
  warnings: ['#1 "Bloc <x>" changed since its version 1: validate the new version first'],
};

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
  tst: emptyTestsUi(),
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
  it('the catalog: version, provenance, inputs and outputs, contract state, usage; the composer beside it', () => {
    const html = renderDashboard(base('library'));
    expect(activeNav({ view: 'library', projectId: 'prj_a' })).toBe('library');
    expect(html).toContain('<h1>Bibliothèque de scénarios</h1>');
    expect(html).toContain('Demandes · 3 bloc(s) réutilisable(s)');
    expect(html).toContain('data-action="lib-panel-open"');
    expect(html).toMatch(
      /<h3>Bloc connexion<\/h3><span class="lib-ver"[^>]*>v2<\/span><span class="lib-state ok">Contrat valide<\/span>/,
    );
    expect(html).toContain('2 étape(s) · Scénario « Connexion » · Utilisé dans 1 scénario(s)');
    expect(html).toContain('Groupe « Création » de l’enregistrement creer');
    expect(html).toContain('<code class="lib-key" title="résolue au rejeu">user.name ⟳</code>');
    expect(html).toContain('<span class="lib-state warn">À revalider</span>');
    expect(html).toContain('Bloc &lt;x&gt;');
    expect(html).toContain(
      '<code class="lib-file" title="Fichier">library/bloc-connexion/bloc-connexion.flow.yaml</code>',
    );
    // Un bloc utilisé ne propose pas de retrait ; un bloc libre le propose, après confirmation.
    expect(html).not.toContain('data-action="lib-remove" data-block="Bloc connexion"');
    expect(html).toContain('data-action="lib-remove" data-block="Bloc seul"');
    expect(renderDashboard(base('library', {}, { confirmRemove: 'Bloc seul' }))).toContain(
      'data-action="lib-remove-yes" data-block="Bloc seul"',
    );
    expect(html).toContain('id="lib-composer"');
    expect(html).toContain('Ajoutez des blocs depuis le catalogue');
  });

  it('search, criteria and sort run on the real data; only the choices the data allows are offered', () => {
    const ui = { ...emptyLibraryUi(), blocks };
    expect(visibleBlocks({ ...ui, query: 'CONNEXION' }).map((entry) => entry.name)).toEqual([
      'Bloc connexion',
    ]);
    expect(visibleBlocks({ ...ui, query: 'se connecter' }).map((entry) => entry.name)).toEqual([
      'Bloc connexion',
    ]);
    expect(visibleBlocks({ ...ui, origin: 'recording' }).map((entry) => entry.name)).toEqual(['Bloc <x>']);
    expect(visibleBlocks({ ...ui, origin: 'none' }).map((entry) => entry.name)).toEqual(['Bloc seul']);
    expect(visibleBlocks({ ...ui, state: 'CHANGED' }).map((entry) => entry.name)).toEqual(['Bloc <x>']);
    expect(visibleBlocks({ ...ui, usage: 'used' }).map((entry) => entry.name)).toEqual(['Bloc connexion']);
    expect(visibleBlocks({ ...ui, sort: 'steps' }).map((entry) => entry.name)).toEqual([
      'Bloc seul',
      'Bloc connexion',
      'Bloc <x>',
    ]);
    expect(visibleBlocks({ ...ui, sort: 'updated' })[0]?.name).toBe('Bloc connexion');
    const html = renderDashboard(base('library'));
    expect(html).toContain('<option value="CHANGED" >À revalider</option>');
    expect(html).not.toContain('value="INVALID"');
    expect(html).toContain('3 sur 3');
    const none = renderDashboard(base('library', {}, { query: 'rien' }));
    expect(none).toContain('Aucun bloc ne correspond à cette recherche.');
    expect(none).toContain('data-action="lib-clear"');
  });

  it('details: provenance, version and fingerprint, contract, history, dependents with the version they pin', () => {
    const html = renderDashboard(base('library', {}, { open: 'Bloc connexion' }));
    expect(html).toContain('aria-expanded="true" aria-controls="lib-d-bloc-connexion"');
    expect(html).toContain('<dt>Identifiant</dt><dd><code>bloc-connexion</code></dd>');
    expect(html).toContain(
      'v2 · <code title="Empreinte du contenu exécutable de cette version">0123456789abcdef</code>',
    );
    expect(html).toContain('Contrat <small class="mu">déclaré</small>');
    expect(html).toContain('<b>Préconditions</b> la page de connexion est ouverte');
    expect(html).toContain('1 assertion(s) métier déclarée(s), vérifiée(s) au rejeu');
    expect(html).toContain('créé à partir du scénario « Connexion »');
    expect(html).toContain('<b>v2</b> nouveau contenu validé');
    expect(html).toContain('data-action="lib-open-scenario" data-name="Composé"');
    expect(html).toContain('référence la v1 : le bloc a changé depuis');
    expect(html).toContain('data-action="lib-contract-edit" data-block="Bloc connexion"');
    const changed = renderDashboard(base('library', {}, { open: 'Bloc <x>' }));
    expect(changed).toContain('data-action="lib-validate-version" data-block="Bloc &lt;x&gt;"');
  });

  it('the composer: order, where each input comes from, the server check, create only when it holds', () => {
    const compose = { name: 'Parcours', parts: ['Bloc <x>', 'Bloc connexion'] };
    const html = renderDashboard(
      base('library', {}, { compose, check, checkedFor: compositionKey(compose) }),
    );
    expect(html).toMatch(
      /lib-steps[^]*<span class="n" aria-hidden="true">1<\/span>[^]*Bloc &lt;x&gt;[^]*<span class="n" aria-hidden="true">2<\/span>[^]*Bloc connexion/,
    );
    expect(html).toContain('<li class="lib-miss">user.name : non disponible</li>');
    expect(html).toContain('Produit : user.name');
    expect(html).toContain(
      'data-action="lib-part-move" data-index="0" data-direction="up" aria-label="Monter" title="Monter" disabled',
    );
    expect(html).toContain('aria-label="Retirer « Bloc connexion » du parcours"');
    expect(html).toContain('Le parcours ne peut pas être créé tel quel.');
    expect(html).toContain('2 bloc(s) · 3 étape(s) · Ordre : #1 Bloc &lt;x&gt; → #2 Bloc connexion');
    expect(html).toContain('item.title est définie autrement par « A » et « B »');
    expect(html).toContain('#1 &quot;Bloc &lt;x&gt;&quot; needs user.name');
    expect(html).toContain('<code>user.name</code>');
    expect(html).toMatch(/type="submit" class="btn primary" disabled aria-busy="false">Créer le scénario/);
    const ok = {
      ...check,
      ok: true,
      conflicts: [],
      errors: [],
      warnings: [],
      dependencies: [{ key: 'user.name', from: 1, to: 2 }],
      order: check.order.map((entry) => ({
        ...entry,
        missing: [],
        satisfied: entry.position === 2 ? [{ key: 'user.name', from: 1 }] : [],
      })),
    };
    const ready = renderDashboard(
      base('library', {}, { compose, check: ok, checkedFor: compositionKey(compose) }),
    );
    expect(ready).toContain('Parcours vérifié : il peut être créé.');
    expect(ready).toContain('user.name : produite par #1, utilisée par #2');
    expect(ready).toContain('<li class="lib-src">user.name ← produite par #1</li>');
    expect(ready).toMatch(/type="submit" class="btn primary" {2}aria-busy="false">Créer le scénario/);
    // Une soumission en cours : le bouton le dit et ne se reclique pas.
    const creating = renderDashboard(
      base('library', {}, { compose, check: ok, checkedFor: compositionKey(compose), creating: true }),
    );
    expect(creating).toMatch(/type="submit" class="btn primary" disabled aria-busy="true">Création…/);
    // Changé depuis la vérification : la vérification le dit.
    const stale = renderDashboard(
      base(
        'library',
        {},
        { compose: { ...compose, name: 'Autre' }, check: ok, checkedFor: compositionKey(compose) },
      ),
    );
    expect(stale).toContain('Le parcours a changé depuis cette vérification.');
    // Une erreur du serveur garde la saisie et détaille ses raisons.
    const failed = renderDashboard(
      base('library', {}, { compose, error: 'refused', details: ['raison 1', 'raison 2'] }),
    );
    expect(failed).toContain('<li>raison 1</li><li>raison 2</li>');
    expect(failed).toContain('value="Parcours"');
  });

  it('the add panel: source preview (no value), name checked before sending, busy while adding', () => {
    const preview = {
      scenario: 'Créer une demande',
      file: 'create/create.flow.yaml',
      steps: 3,
      startAt: '/requests',
      data: [{ key: 'request.title', dynamic: true }],
      contract: {
        source: 'DERIVED' as const,
        inputs: [],
        outputs: [{ key: 'request.title', dynamic: true }],
        preconditions: [],
        postconditions: [],
      },
      reusable: false,
    };
    const html = renderDashboard(
      base(
        'library',
        {},
        {
          panel: {
            scenario: 'Créer une demande',
            name: 'Composé',
            description: '',
            preview,
            previewFor: 'Créer une demande',
          },
        },
      ),
    );
    expect(html).toContain('role="dialog" aria-modal="true" aria-labelledby="lib-sheet-t"');
    expect(html).toContain('Aperçu de la source');
    expect(html).toContain('3 étape(s) · départ /requests');
    expect(html).toContain(
      '<small id="lib-name-hint" class="err">« Composé » est déjà pris par un scénario ou un bloc.</small>',
    );
    expect(html).toMatch(/type="submit" class="btn primary" disabled/);
    const busy = renderDashboard(
      base(
        'library',
        {},
        { panel: { scenario: 'Créer une demande', name: 'Nouveau bloc', description: '', busy: true } },
      ),
    );
    expect(busy).toMatch(/disabled aria-busy="true">Ajout…/);
    const failed = renderDashboard(
      base(
        'library',
        {},
        {
          panel: {
            scenario: 'Créer une demande',
            name: 'Nouveau bloc',
            description: 'd',
            error: 'already exists',
          },
        },
      ),
    );
    expect(failed).toContain('<p class="err" role="alert">already exists</p>');
    expect(failed).toContain('value="Nouveau bloc"');
  });

  it('scenarios: a block is not run alone; insertion carries the revision read; a changed block is shown', () => {
    expect(runnableScenarios(project.scenarios).map((scenario) => scenario.name)).toEqual([
      'Créer une demande',
      'Composé',
    ]);
    const html = renderDashboard(base('scenarios', { scenarioHistory: [], recordings: [] }));
    expect(html).not.toContain('data-name="Bloc connexion"');
    expect(html).toContain('1 bloc(s) réutilisable(s) sont dans la bibliothèque.');
    expect(html).toContain('Rejoue : Bloc connexion, Bloc &lt;x&gt;');
    expect(html).toContain('data-action="lib-insert" data-scenario="Composé" data-revision="abc123def456"');
    expect(html).toContain('data-action="lib-from-scenario" data-name="Composé"');
    expect(html).toContain('Un bloc de ce parcours a changé depuis sa composition');
    expect(html).toContain('« Bloc connexion » : v1 référencée, v2 disponible');
    expect(html).toContain('data-action="lib-accept" data-name="Composé"');
  });

  it('a reader sees the library and the details, never an action', () => {
    const html = renderDashboard(
      base('library', reader, { open: 'Bloc connexion', compose: { name: 'P', parts: ['Bloc seul'] } }),
    );
    expect(html).toContain('Bloc connexion');
    expect(html).not.toMatch(
      /data-action="lib-(remove|panel-open|part-add|part-move|check|contract-edit|validate-version)"/,
    );
    expect(html).not.toContain('Créer le scénario');
    const scenarios = renderDashboard(base('scenarios', { ...reader, scenarioHistory: [], recordings: [] }));
    expect(scenarios).not.toContain('data-action="lib-insert"');
    expect(scenarios).not.toContain('data-action="lib-from-scenario"');
    expect(scenarios).not.toContain('data-action="lib-accept"');
  });
});
