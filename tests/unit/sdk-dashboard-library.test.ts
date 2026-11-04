import { describe, expect, it } from 'vitest';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import type {
  BlockSourceComparison,
  CompositionCheck,
  LibraryBlockDetails,
  LibraryBlockView,
  ProjectDetail,
} from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { distanceToPoints, edgePoints, journeyOfParts } from '../../src/sdk/core/journey.js';
import {
  addBlock,
  emptyJourneyUi,
  insertOnEdge,
  logicKey,
  type JourneyUi,
} from '../../src/sdk/ui/dashboard-journey.js';
import {
  emptyLibraryUi,
  runnableScenarios,
  visibleBlocks,
  type LibraryUi,
} from '../../src/sdk/ui/dashboard-library.js';
import type { SheetTab } from '../../src/sdk/ui/dashboard-library-sheet.js';
import { checkKey, declaredOf, emptyWizard, nameProblem } from '../../src/sdk/ui/dashboard-library-wizard.js';
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
  ed: emptyEditorUi(),
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
    const html = renderDashboard(base('library', {}, { tab: 'catalog' }));
    expect(activeNav({ view: 'library', projectId: 'prj_a' })).toBe('library');
    expect(html).toContain('<h1>Bibliothèque de scénarios</h1>');
    expect(html).toContain('Demandes · 3 bloc(s) réutilisable(s)');
    expect(html).toContain('data-action="lib-panel-open"');
    // Un contrat valide : une coche discrète ; à revalider : une pastille.
    expect(html).toMatch(
      /<h3><button class="lib-title" data-action="lib-open" data-block="Bloc connexion" aria-haspopup="dialog">Bloc connexion<\/button><\/h3><span class="lib-ver"[^>]*>v2<\/span><span class="lib-ok" title="Contrat valide">/,
    );
    expect(html).toContain('<span class="lib-kind standalone">Autonome</span><span>2 étape(s)</span>');
    // L'origine, courte ; le détail au survol.
    expect(html).toContain(
      '<span class="lib-origin" title="Scénario « Connexion »">Scénario Connexion</span>',
    );
    expect(html).toContain(
      '<span class="lib-origin" title="Groupe « Création » de l’enregistrement creer">Enregistrement creer</span>',
    );
    // Le pied : la date, et l'utilisation seulement quand il y en a une.
    expect(html).toMatch(/<small class="mu">modifié le [^<]+ · Utilisé dans 1 scénario\(s\)<\/small>/);
    expect(html).not.toContain('Utilisé dans aucun scénario');
    expect(html).toContain('<code class="lib-key">user.name</code>');
    expect(html).toContain('Ni entrée ni sortie : il se joue seul.');
    expect(html).toContain(
      'class="btn small lib-add" data-action="lib-part-add" data-block="Bloc seul" title="Ajouter au parcours"',
    );
    expect(html).toContain('<span class="lib-state warn">À revalider</span>');
    expect(html).toContain('Bloc &lt;x&gt;');
    expect(html).toContain('<ul class="plain lib-cards grid">');
    // Le retrait est dans la fiche, jamais sur la carte.
    expect(html).not.toContain('data-action="lib-remove"');
    // Les onglets de la page : Catalogue (ici), Compositeur (par défaut), Diagnostics.
    expect(html).toMatch(/id="lib-tab-catalog"[^>]*aria-selected="true"/);
    // L'onglet Compositeur : modes, catalogue compact des vrais blocs, scène ; propriétés et validation à droite.
    const composer = renderDashboard(base('library'));
    expect(composer).toContain('id="lib-composer"');
    expect(composer).toMatch(/id="lib-tab-composer"[^>]*aria-selected="true"/);
    expect(composer).toMatch(/role="radio" id="jn-mode-LINEAR"[^>]*aria-checked="true"/);
    expect(composer).toContain('Mode libre (Diagramme)');
    expect(composer).toContain('Catalogue de blocs');
    expect(composer).toMatch(/<li class="jn-pal-item"[^>]*draggable="true" data-jn-block="Bloc seul">/);
    expect(composer).toContain('Aucun bloc : glissez-en un ici ou utilisez + dans le catalogue.');
    expect(composer).toContain('<p class="jn-props-k">Propriétés du parcours</p>');
    // Jamais « valide » sans vérification réelle.
    expect(composer).toContain('<h3 id="jn-val-t">Validation du parcours</h3>');
    expect(composer).toContain('Pas encore vérifié');
    expect(composer).not.toContain('jn-val-state ok');
    // Les actions du parcours en tête : Enregistrer, Vérifier, Créer.
    expect(composer).toMatch(/data-action="jn-save"[^]*data-action="jn-check"[^]*data-action="jn-publish"/);
  });

  it('display: grid or list, grouped by origin, recently opened, standalone or composite', () => {
    const composite = block({
      name: 'Parcours complet',
      steps: 6,
      origin: { kind: 'recording', name: 'creer', groups: ['Création', 'Recherche'], mode: 'composite' },
      groups: [
        { id: 'g1', name: 'Création', steps: 3 },
        { id: 'g2', name: 'Recherche', steps: 3 },
      ],
    });
    const all = [...blocks, composite];
    const ui = { ...emptyLibraryUi(), blocks: all };
    expect(visibleBlocks({ ...ui, kind: 'composite' }).map((entry) => entry.name)).toEqual([
      'Parcours complet',
    ]);
    expect(visibleBlocks({ ...ui, query: 'recherche' }).map((entry) => entry.name)).toEqual([
      'Parcours complet',
    ]);
    const html = renderDashboard(
      base(
        'library',
        {},
        { blocks: all, layout: 'list', groupBy: 'origin', recent: ['Bloc seul', 'disparu'], tab: 'catalog' },
      ),
    );
    expect(html).toContain('<ul class="plain lib-cards list">');
    expect(html).toContain('aria-checked="true" data-action="lib-layout" data-layout="list"');
    expect(html).toContain('<h3 class="lib-bucket-t">Enregistrement creer <small class="mu">2</small></h3>');
    expect(html).toContain('<h3 class="lib-bucket-t">Scénario Connexion <small class="mu">1</small></h3>');
    expect(html).toContain(
      '<h3 class="lib-bucket-t">Origine non enregistrée <small class="mu">1</small></h3>',
    );
    expect(html).toContain('<span class="lib-kind composite">Composé · 2 groupe(s)</span>');
    expect(html).toContain('<option value="composite" >Composés</option>');
    // Les récents : seulement les blocs qui existent encore.
    expect(html).toMatch(/lib-recent[^]*data-action="lib-open" data-block="Bloc seul"/);
    expect(html).not.toContain('disparu');
    // Un type absent des données n'est pas proposé.
    expect(renderDashboard(base('library', {}, { tab: 'catalog' }))).not.toContain('data-lib="kind"');
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
    const none = renderDashboard(base('library', {}, { query: 'rien', tab: 'catalog' }));
    expect(none).toContain('Aucun bloc ne correspond à cette recherche.');
    expect(none).toContain('data-action="lib-clear"');
  });

  it('the sheet: tabs, overview with the problems to fix, contract, versions, dependents with the version they pin', () => {
    const sheet = (tab: SheetTab, name = 'Bloc connexion', extra: Partial<LibraryUi> = {}): string =>
      renderDashboard(base('library', {}, { sheet: { block: name, tab }, ...extra }));
    const overview = sheet('overview');
    expect(overview).toContain('role="dialog" aria-modal="true" aria-labelledby="lib-fiche-t"');
    expect(overview).toContain('<h2 id="lib-fiche-t">Bloc connexion</h2>');
    expect(overview).toContain(
      'id="lib-tab-overview" data-action="lib-sheet-tab" data-tab="overview" aria-selected="true"',
    );
    for (const label of [
      'Vue d’ensemble',
      'Étapes',
      'Entrées',
      'Sorties',
      'Contrat',
      'Paramètres',
      'Dépendances',
      'Versions',
      'Provenance',
    ])
      expect(overview).toContain(`>${label}</button>`);
    expect(overview).toContain('<dt>Type</dt><dd>Autonome</dd>');
    expect(overview).toContain('2 étape(s) · départ /login');
    expect(overview).toContain('1 assertion(s) métier déclarée(s), vérifiée(s) au rejeu');
    // Un bloc rejoué par un scénario ne se retire pas ; un bloc libre, après confirmation.
    expect(overview).not.toContain('data-action="lib-remove"');
    expect(overview).toContain('Un bloc rejoué par un scénario ne se retire pas.');
    expect(sheet('overview', 'Bloc seul')).toContain('data-action="lib-remove" data-block="Bloc seul"');
    expect(sheet('overview', 'Bloc seul', { confirmRemove: 'Bloc seul' })).toContain(
      'data-action="lib-remove-yes" data-block="Bloc seul"',
    );
    expect(sheet('overview', 'Bloc <x>')).toContain(
      'data-action="lib-validate-version" data-block="Bloc &lt;x&gt;"',
    );
    const contract = sheet('contract');
    expect(contract).toContain('Contrat déclaré, comparé à son contenu à chaque lecture.');
    expect(contract).toContain(
      '<h4>Préconditions</h4><ul class="plain tight"><li>la page de connexion est ouverte</li>',
    );
    expect(contract).toContain('data-action="lib-contract-edit" data-block="Bloc connexion"');
    const versions = sheet('versions');
    expect(versions).toContain(
      'v2 · <code title="Empreinte du contenu exécutable de cette version">0123456789abcdef</code>',
    );
    expect(versions).toMatch(
      /<b>v2<\/b><span>nouveau contenu validé<\/span>[^]*<b>v1<\/b><span>créé à partir du scénario « Connexion »/,
    );
    const deps = sheet('dependencies');
    expect(deps).toContain('data-action="lib-open-scenario" data-name="Composé"');
    expect(deps).toContain('référence la v1 : le bloc a changé depuis');
    // Le graphe : user.name, sortie de « Bloc connexion », est lue par « Bloc <x> ».
    expect(deps).toMatch(
      /Ses sorties servent à[^]*user\.name<\/code><button class="lib-gnode" data-action="lib-open" data-block="Bloc &lt;x&gt;"/,
    );
    expect(sheet('dependencies', 'Bloc <x>')).toMatch(
      /Ses entrées viennent de[^]*user\.name<\/code><button class="lib-gnode" data-action="lib-open" data-block="Bloc connexion"/,
    );
    // Les étapes et les données attendent le serveur.
    expect(sheet('steps')).toContain('Lecture du bloc…');
    expect(
      renderDashboard(base('library', {}, { sheet: { block: 'disparu', tab: 'overview' } })),
    ).not.toContain('lib-fiche');
  });

  it('the sheet with the server details: steps by internal group, data strategies (never a value)', () => {
    const details: LibraryBlockDetails = {
      block: blocks[0] as LibraryBlockView,
      steps: [
        { position: 1, kind: 'goto', label: 'goto /login' },
        { position: 2, kind: 'fill', label: 'Saisir dans "Nom"' },
        { position: 3, kind: 'expect', label: 'Vérifier : URL /home' },
      ],
      groups: [
        { id: 'g1', name: 'Ouvrir', positions: [1] },
        { id: 'g2', name: 'Se <connecter>', positions: [2, 3] },
      ],
      data: [
        { key: 'user.name', strategy: 'GENERATE_AT_REPLAY', dynamic: true },
        { key: 'user.password', strategy: 'CREDENTIAL_REFERENCE', dynamic: false },
      ],
    };
    const steps = renderDashboard(
      base('library', {}, { sheet: { block: 'Bloc connexion', tab: 'steps', details } }),
    );
    expect(steps).toMatch(
      /lib-sgroup[^]*Ouvrir[^]*goto \/login[^]*lib-sgroup[^]*Se &lt;connecter&gt;[^]*Saisir dans/,
    );
    expect(steps).toContain('<li class="pub-step is-check"><span class="pub-pos">3</span>');
    const data = renderDashboard(
      base('library', {}, { sheet: { block: 'Bloc connexion', tab: 'data', details } }),
    );
    expect(data).toContain(
      '<td><code>user.name</code></td><td>générée au rejeu <small class="mu">· résolue au rejeu</small></td>',
    );
    expect(data).toContain('référence d’environnement (secret)');
    expect(data).toContain('Les valeurs ne sont jamais affichées ici.');
    const failed = renderDashboard(
      base('library', {}, { sheet: { block: 'Bloc connexion', tab: 'data', error: 'boom' } }),
    );
    expect(failed).toContain('<p class="err" role="alert">boom</p>');
  });

  it('provenance: the extraction, the comparison with the source, an update only after confirmation', () => {
    const extracted = block({
      name: 'Recherche',
      origin: {
        kind: 'recording',
        name: 'parcours',
        groups: ['Rechercher'],
        groupIds: ['g2'],
        stepIds: ['s3', 's4'],
        mode: 'separate',
        sessionId: 'ses_1',
        revision: 'aaaa1111bbbb2222',
        extractedAt: at,
        author: 'Alice',
        provided: ['q'],
        transformations: ['starts with goto /forms (its start page)'],
      },
      history: [
        { version: 1, at, change: 'extracted from the group "Rechercher" of the recording parcours' },
      ],
    });
    const all = [...blocks, extracted];
    const render = (sheet: LibraryUi['sheet'], who: Partial<DashboardState> = {}): string =>
      renderDashboard(base('library', who, { blocks: all, sheet }));
    const html = render({ block: 'Recherche', tab: 'provenance' });
    expect(html).toContain('<dt>Enregistrement</dt><dd><code>parcours</code></dd>');
    expect(html).toContain('<dt>Étapes d’origine</dt><dd><code>s3</code> <code>s4</code></dd>');
    expect(html).toContain('<dt>Mode</dt><dd>un bloc par groupe</dd>');
    expect(html).toContain('<dt>Auteur</dt><dd>Alice</dd>');
    expect(html).toContain('<dt>Valeurs fournies à la publication</dt><dd><code>q</code></dd>');
    expect(html).toContain('data-action="lib-compare" data-block="Recherche"');
    expect(html).toContain('data-action="nav-recording" data-name="parcours"');
    expect(render({ block: 'Recherche', tab: 'versions' })).toContain(
      'extrait du groupe « Rechercher » de l’enregistrement parcours',
    );
    const different: BlockSourceComparison = {
      block: 'Recherche',
      status: 'DIFFERENT',
      recording: 'parcours',
      revision: { extracted: 'aaaa1111bbbb2222', current: 'cccc3333dddd4444' },
      changes: ['step 2 changed'],
    };
    const compared = render({ block: 'Recherche', tab: 'provenance', comparison: different });
    expect(compared).toContain('<b>La source a changé</b>');
    expect(compared).toContain(
      'empreinte à l’extraction aaaa1111bbbb2222 · empreinte actuelle cccc3333dddd4444',
    );
    expect(compared).toContain('<li>step 2 changed</li>');
    expect(compared).toContain('data-action="lib-update-ask"');
    expect(compared).not.toContain('data-action="lib-update-yes"');
    const confirming = render({
      block: 'Recherche',
      tab: 'provenance',
      comparison: different,
      confirmUpdate: true,
    });
    expect(confirming).toContain('Il passera « À revalider »');
    expect(confirming).toContain('data-action="lib-update-yes" data-block="Recherche"');
    const same = render({
      block: 'Recherche',
      tab: 'provenance',
      comparison: { ...different, status: 'SAME', changes: [] },
    });
    expect(same).toContain('<b>Identique à la source</b>');
    expect(same).not.toContain('lib-update-ask');
    // Un lecteur compare, jamais ne met à jour.
    expect(render({ block: 'Recherche', tab: 'provenance', comparison: different }, reader)).not.toContain(
      'lib-update-ask',
    );
    // Un bloc venu d'un scénario ne se compare pas à un enregistrement.
    expect(render({ block: 'Bloc connexion', tab: 'provenance' })).not.toContain('lib-compare');
  });

  it('the composer: linear cards, instance parameters from the real contract, the path check on the cards', () => {
    const journey = journeyOfParts('Parcours', [
      { block: 'Bloc <x>', version: 1 },
      { block: 'Bloc connexion', version: 1 },
    ]);
    const [first, second] = journey.graph.nodes.filter((node) => node.kind === 'BLOCK');
    const ui: JourneyUi = {
      ...emptyJourneyUi(),
      journey,
      savedName: 'Parcours',
      savedRevision: 'abcd1234',
      selected: { kind: 'node', id: first?.id ?? '' },
      check: {
        ok: false,
        outputs: { guaranteed: [], partial: [] },
        linear: true,
        publishable: 'NONE',
        paths: [{ index: 0, nodes: [], choices: [], check: { ...check } }],
        nodes: {
          [first?.id ?? '']: {
            errors: ['entrée user.name manquante'],
            warnings: [],
            available: [],
            missing: [{ key: 'user.name', path: 1 }],
            produces: [],
            satisfied: [],
          },
          [second?.id ?? '']: {
            errors: [],
            warnings: [],
            available: ['user.name'],
            missing: [],
            produces: ['user.name'],
            satisfied: [],
          },
        },
        edges: {},
        errors: [],
        warnings: [],
      },
    };
    ui.checkedFor = logicKey(journey);
    const html = renderDashboard(base('library', {}, { journey: ui }));
    // La suite : début, cartes numérotées dans l'ordre, fin ; poignée, actions, zones de dépôt.
    expect(html).toMatch(
      /jn-term start[^]*<span class="jn-num"[^>]*>1<\/span>[^]*Bloc &lt;x&gt;[^]*<span class="jn-num"[^>]*>2<\/span>[^]*Bloc connexion[^]*jn-term end/,
    );
    expect(html).toContain('data-jn-gap="0"');
    expect(html).toMatch(/class="jn-card sel ko" data-jn-node="[^"]+" draggable="true"/);
    expect(html).toContain('<span class="jn-err">');
    expect(html).toContain('entrée user.name manquante');
    // La version retenue (v1) est plus ancienne que la version actuelle (v2) : à accepter explicitement.
    expect(html).toContain('Utiliser la version 2');
    expect(html).toMatch(/data-action="jn-move" data-node="[^"]+" data-to="-1"[^>]*disabled/);
    // Le panneau de propriétés : le bloc choisi, ses paramètres tirés de son contrat réel.
    expect(html).toContain('<h3 id="jn-props-t">Bloc &lt;x&gt;</h3>');
    expect(html).toContain('<code class="lib-key">user.name</code><small class="mu">obligatoire</small>');
    expect(html).toContain('<option value="INHERIT" selected>Amont ou données</option>');
    // La vérification est à jour (positions exclues) et le parcours ne tient pas : créer est refusé.
    expect(html).toContain('<li class="jn-chip ko">Parcours invalide</li>');
    expect(html).toMatch(/data-action="jn-publish" disabled/);
    // Un paramètre de valeur pour l'instance.
    if (first) first.params = { 'user.name': { mode: 'VALUE', value: 'alice' } };
    const valued = renderDashboard(base('library', {}, { journey: ui }));
    expect(valued).toContain('<option value="VALUE" selected>Valeur</option>');
    expect(valued).toContain('data-jn="param.value" data-key="user.name" value="alice"');
    expect(valued).toContain(
      '<li class="jn-chip warn">Vérification antérieure à la dernière modification</li>',
    );
    // Une erreur du serveur garde la saisie et détaille ses raisons.
    const failed = renderDashboard(
      base('library', {}, { journey: { ...ui, error: 'refused', details: ['raison 1', 'raison 2'] } }),
    );
    expect(failed).toContain('<li>raison 1</li><li>raison 2</li>');
    expect(failed).toContain('data-jn="name" value="Parcours"');
  });

  it('the diagram: nodes positioned, connections with Oui/Non, tools; the linear mode refused with its reason', () => {
    const journey = journeyOfParts('Parcours', [{ block: 'Bloc seul', version: 1 }]);
    journey.mode = 'DIAGRAM';
    journey.graph.nodes.push({ id: 'n9', kind: 'CONDITION', label: 'Urgent ?', x: 300, y: 100 });
    journey.graph.edges.push({ id: 'e9', from: 'n9', to: 'n2', branch: 'YES' });
    const ui: JourneyUi = {
      ...emptyJourneyUi(),
      journey,
      modeMessage: 'Le mode linéaire n’est pas possible sans perte : le parcours contient 1 condition(s).',
    };
    const html = renderDashboard(base('library', {}, { journey: ui }));
    expect(html).toMatch(/role="radio" id="jn-mode-DIAGRAM"[^>]*aria-checked="true"/);
    expect(html).toContain('data-jn-canvas');
    expect(html).toMatch(
      /class="jn-node condition" data-jn-node="n9" style="left:300px;top:100px;width:160px;height:92px"/,
    );
    expect(html).toContain('data-jn-port="n9" data-branch="YES"');
    expect(html).toContain('data-jn-port="n9" data-branch="NO"');
    expect(html).toMatch(/<g class="jn-edge yes" data-jn-edge="e9"><path class="jn-e" d="M/);
    expect(html).toContain('>Oui</text>');
    expect(html).toContain('data-action="jn-fit"');
    expect(html).toContain('data-jn-shape="CONDITION"');
    expect(html).toContain('Le mode linéaire n’est pas possible sans perte');
  });

  it('the journey outputs: guaranteed and per path; « Transformer en bloc » only for a saved, valid journey without conditions', () => {
    const journey = journeyOfParts('Parcours', [{ block: 'Bloc connexion', version: 1 }]);
    const valid = {
      ok: true,
      outputs: { guaranteed: ['user.name'], partial: [{ key: 'user.role', paths: [2] }] },
      linear: true,
      publishable: 'SINGLE' as const,
      paths: [{ index: 0, nodes: [], choices: [], check: { ...check } }],
      nodes: {},
      edges: {},
      errors: [],
      warnings: [],
    };
    const ui: JourneyUi = { ...emptyJourneyUi(), journey, savedName: 'Parcours', check: valid };
    ui.checkedFor = logicKey(journey);
    const html = renderDashboard(base('library', {}, { journey: ui }));
    expect(html).toContain('<h4 id="jn-out-t">Sorties du parcours</h4>');
    expect(html).toMatch(/Produites sur tous les chemins<\/dt><dd><code class="lib-key">user\.name<\/code>/);
    expect(html).toContain(
      '<code class="lib-key warn">user.role</code> <small class="mu">chemin(s) B</small>',
    );
    expect(html).toMatch(/<button type="button" class="btn small" data-action="jn-to-block" title="/);
    // Le formulaire : le nom du bloc proposé, puis « Créer le bloc ».
    const form = renderDashboard(base('library', {}, { journey: { ...ui, blockName: 'Parcours (bloc)' } }));
    expect(form).toContain('data-jn="blockName" value="Parcours (bloc)"');
    expect(form).toContain('data-action="jn-to-block-confirm"');
    // Modifié depuis l'enregistrement, ou avec des conditions : refusé, la raison est dite.
    const dirty = renderDashboard(base('library', {}, { journey: { ...ui, dirty: true } }));
    expect(dirty).toMatch(/data-action="jn-to-block" disabled/);
    expect(dirty).toContain('Enregistrez le parcours avant de créer ses scénarios.');
    const paths = renderDashboard(
      base(
        'library',
        {},
        { journey: { ...ui, check: { ...valid, linear: false, publishable: 'PER_PATH' } } },
      ),
    );
    expect(paths).toContain('Un parcours avec conditions ne devient pas un bloc');
  });

  it('adding a block in the diagram: picked in the catalogue, dropped without an ambiguous link, inserted on a connection only when confirmed', () => {
    const journey = journeyOfParts('Parcours', [{ block: 'Bloc seul', version: 1 }]);
    journey.mode = 'DIAGRAM';
    const ui: JourneyUi = { ...emptyJourneyUi(), journey, picked: 'Bloc connexion' };
    const [, only] = journey.graph.nodes;
    const edge = journey.graph.edges.find((entry) => entry.from === only?.id);
    // Déposé à un endroit : une instance indépendante, choisie, jamais reliée d'office.
    const id = addBlock(ui, { name: 'Bloc connexion', version: 2 }, { x: 400, y: 40 });
    expect(ui.selected).toEqual({ kind: 'node', id });
    expect(journey.graph.edges.some((entry) => entry.from === id || entry.to === id)).toBe(false);
    // Sur une connexion : insérée entre ses deux nœuds sur demande, les autres nœuds ne bougent pas.
    const before = journey.graph.nodes
      .filter((node) => node.id !== id)
      .map((node) => [node.id, node.x, node.y]);
    expect(insertOnEdge(ui, edge?.id ?? '', id)).toBeUndefined();
    expect(journey.graph.edges.filter((entry) => entry.from === id || entry.to === id)).toHaveLength(2);
    expect(journey.graph.edges.find((entry) => entry.to === id)?.from).toBe(only?.id);
    expect(
      journey.graph.nodes.filter((node) => node.id !== id).map((node) => [node.id, node.x, node.y]),
    ).toEqual(before);
    // Déjà relié : refusé, avec la raison.
    expect(insertOnEdge(ui, journey.graph.edges[0]?.id ?? '', id)).toMatch(/déjà relié/);
    // La géométrie : une connexion orthogonale, et un point posé dessus est reconnu.
    const from = journey.graph.nodes.find((node) => node.id === id);
    const to = journey.graph.nodes.find((node) => node.kind === 'END');
    if (!from || !to) throw new Error('nodes expected');
    const points = edgePoints(from, to);
    expect(
      points.every(
        (point, index) => index === 0 || point.x === points[index - 1]?.x || point.y === points[index - 1]?.y,
      ),
    ).toBe(true);
    const middle = points[1] ?? { x: 0, y: 0 };
    expect(distanceToPoints(points, middle)).toBe(0);
    // Le rendu : le bloc choisi est surligné dans le catalogue, la barre flottante et la confirmation réelles.
    ui.toast = 'Bloc « Bloc connexion » ajouté au parcours';
    ui.pendingInsert = undefined;
    const html = renderDashboard(base('library', {}, { journey: ui }));
    expect(html).toMatch(/<li class="jn-pal-item picked"[^>]*data-jn-block="Bloc connexion">/);
    expect(html).toContain('data-action="jn-tool-block"');
    expect(html).toMatch(
      /class="jn-node block sel[^"]*" data-jn-node="[^"]+"[^]*class="jn-float" role="toolbar"/,
    );
    expect(html).toContain('data-action="jn-edit"');
    expect(html).toContain('<div class="jn-toast" role="status">');
    expect(html).toContain('Bloc « Bloc connexion » ajouté au parcours');
    // Une proposition d'insertion en attente se dit au-dessus du canvas.
    const target = journey.graph.edges[0];
    const free = addBlock(ui, { name: 'Bloc seul', version: 1 }, { x: 600, y: 40 });
    ui.pendingInsert = { edge: target?.id ?? '', node: free };
    expect(renderDashboard(base('library', {}, { journey: ui }))).toContain('data-action="jn-insert-yes"');
  });

  it('the validation card follows the real check: four points, with the issues counted', () => {
    const journey = journeyOfParts('Parcours', [{ block: 'Bloc connexion', version: 1 }]);
    const [node] = journey.graph.nodes.filter((entry) => entry.kind === 'BLOCK');
    const ui: JourneyUi = {
      ...emptyJourneyUi(),
      journey,
      check: {
        ok: false,
        outputs: { guaranteed: [], partial: [] },
        linear: true,
        publishable: 'NONE',
        paths: [{ index: 0, nodes: [], choices: [], check: { ...check } }],
        nodes: {
          [node?.id ?? '']: {
            errors: ['entrée user.name manquante'],
            warnings: [],
            available: [],
            missing: [{ key: 'user.name', path: 1 }],
            produces: [],
            satisfied: [],
          },
        },
        edges: {},
        errors: [],
        warnings: [],
      },
    };
    ui.checkedFor = logicKey(journey);
    const html = renderDashboard(base('library', {}, { journey: ui }));
    expect(html).toContain('<p class="jn-val-state ko" role="status">');
    expect(html).toContain('Dépendances non satisfaites <small>· 1 problème(s)</small>');
    // Le bloc retenu en v1 alors que la v2 existe : la version est à accepter.
    expect(html).toContain('Versions à vérifier ou à accepter');
    expect(html).toContain('Structure et connexions correctes');
    // L'onglet Diagnostics détaille le nœud en cause.
    const diagnostics = renderDashboard(base('library', {}, { journey: ui, tab: 'diagnostics' }));
    expect(diagnostics).toMatch(/id="lib-tab-diagnostics"[^>]*aria-selected="true"/);
    expect(diagnostics).toContain('entrée user.name manquante');
  });

  it('wiring proposals from the check: reliable one to apply, ambiguous ones to choose, none; incompatible types said', () => {
    const journey = journeyOfParts('Parcours', [{ block: 'Bloc <x>', version: 1 }]);
    const [node] = journey.graph.nodes.filter((entry) => entry.kind === 'BLOCK');
    const id = node?.id ?? '';
    const withProposal = (proposal: object): string => {
      const ui: JourneyUi = {
        ...emptyJourneyUi(),
        journey,
        selected: { kind: 'node', id },
        check: {
          ok: false,
          outputs: { guaranteed: [], partial: [] },
          linear: true,
          publishable: 'NONE',
          paths: [{ index: 0, nodes: [], choices: [], check: { ...check } }],
          nodes: {
            [id]: {
              errors: ['entrée user.name manquante'],
              warnings: [],
              available: ['account.name', 'other.name'],
              missing: [{ key: 'user.name', path: 1 }],
              produces: [],
              satisfied: [],
              proposals: [proposal as never],
            },
          },
          edges: {},
          errors: [],
          warnings: [],
        },
      };
      ui.checkedFor = logicKey(journey);
      return renderDashboard(base('library', {}, { journey: ui }));
    };
    const unique = withProposal({
      input: 'user.name',
      type: 'text',
      status: 'UNIQUE',
      candidates: [
        {
          key: 'account.name',
          from: 'data',
          type: 'text',
          compatible: true,
          reason: 'même sens métier (« nom du compte »)',
        },
        {
          key: 'other.name',
          from: 'data',
          type: 'email',
          compatible: false,
          reason: 'types incompatibles (identifier ≠ email)',
        },
      ],
    });
    expect(unique).toContain('<div class="jn-proposal unique" role="note">');
    expect(unique).toContain('Correspondance proposée (fiable) : à retenir');
    expect(unique).toContain(
      'data-action="jn-apply-map" data-node="' +
        id +
        '" data-key="user.name" data-to="account.name">Utiliser account.name</button>',
    );
    expect(unique).toContain('types incompatibles (identifier ≠ email)');
    const ambiguous = withProposal({
      input: 'user.name',
      type: 'text',
      status: 'AMBIGUOUS',
      candidates: [
        {
          key: 'account.name',
          from: 'data',
          type: 'text',
          compatible: true,
          reason: 'même nom final (name)',
        },
        { key: 'other.name', from: 'data', type: 'text', compatible: true, reason: 'même nom final (name)' },
      ],
    });
    expect(ambiguous).toContain('Correspondance ambiguë : choisissez la donnée');
    expect(ambiguous.match(/data-action="jn-apply-map"/g)?.length).toBe(2);
    const none = withProposal({ input: 'user.name', type: 'text', status: 'NONE', candidates: [] });
    expect(none).toContain('Aucune donnée compatible en amont');
    expect(none).not.toContain('jn-apply-map');
  });

  it('the « Ajouter un bloc » window: four steps on the real source, the name checked, the contract derived or declared, creation only after a real check', () => {
    const preview = {
      scenario: 'Créer une demande',
      file: 'create/create.flow.yaml',
      steps: 3,
      startAt: '/requests',
      data: [{ key: 'request.title', dynamic: true }],
      contract: {
        source: 'DERIVED' as const,
        inputs: [{ key: 'user.name', required: true }],
        outputs: [{ key: 'request.title', dynamic: true }],
        preconditions: [],
        postconditions: [],
      },
      reusable: false,
    };
    const wizard = {
      ...emptyWizard('Créer une demande'),
      name: 'Composé',
      preview,
      previewFor: 's:Créer une demande',
    };
    const step1 = renderDashboard(base('library', {}, { wizard }));
    expect(step1).toContain('role="dialog" aria-modal="true" aria-labelledby="wz-t"');
    expect(step1).toContain('<h2 id="wz-t">Ajouter un bloc</h2>');
    expect(step1).toMatch(/aria-current="step" aria-label="Étape 1 : Informations \(en cours\)"/);
    expect(step1).toContain('3 étape(s) exécutable(s) · départ /requests');
    // Le nom est vérifié avant d'aller plus loin (même portée que le serveur).
    expect(step1).toContain(
      '<small id="wz-name-hint" class="err">« Composé » est déjà pris par un scénario ou un bloc.</small>',
    );
    expect(step1).toMatch(/data-action="wz-next" disabled/);
    // Ni type « Condition » ni « Boucle » : ce ne sont pas des blocs ; la version initiale suit la règle (v1).
    expect(step1).toContain('Bloc standard');
    expect(step1).not.toMatch(/value="(CONDITION|LOOP)"/);
    expect(step1).toContain('value="v1" readonly');
    const named = { ...wizard, name: 'Nouveau bloc' };
    expect(renderDashboard(base('library', {}, { wizard: named }))).not.toMatch(
      /data-action="wz-next" disabled/,
    );
    // Étape 2 : entrées et sorties du contrat déduit, avec leurs compteurs ; déclarer est un choix explicite.
    const step2 = renderDashboard(base('library', {}, { wizard: { ...named, step: 2 } }));
    expect(step2).toContain('Contrat déduit des étapes');
    expect(step2).toMatch(/Entrées nécessaires <small class="mu">\(1\)<\/small>/);
    expect(step2).toContain('générée au rejeu');
    // Étape 3 : les paramètres sont les entrées ; les rendre facultatives déclare le contrat.
    const step3 = renderDashboard(base('library', {}, { wizard: { ...named, step: 3 } }));
    expect(step3).toContain('data-wz="optional" value="user.name"');
    expect(declaredOf({ ...named, declare: true, optional: ['user.name'] }, preview.contract)).toEqual({
      inputs: [{ key: 'user.name', required: false }],
      outputs: ['request.title'],
      preconditions: [],
      postconditions: [],
    });
    // Étape 4 : « Créer le bloc » n'est possible qu'après une vérification réelle et réussie.
    const step4 = renderDashboard(base('library', {}, { wizard: { ...named, step: 4 } }));
    expect(step4).toMatch(/data-action="wz-create" disabled/);
    const checked = { ...named, step: 4 as const, check: { ok: true, errors: [], warnings: [] } };
    const ok = renderDashboard(
      base('library', {}, { wizard: { ...checked, checkFor: checkKey(checked, undefined) } }),
    );
    expect(ok).toContain('Le bloc peut être créé.');
    expect(ok).toContain('Le bloc attend 1 entrée(s)');
    expect(ok).not.toMatch(/data-action="wz-create" disabled/);
    const ko = {
      ...named,
      step: 4 as const,
      check: { ok: false, errors: ['no executable step'], warnings: [] },
    };
    const blocked = renderDashboard(
      base('library', {}, { wizard: { ...ko, checkFor: checkKey(ko, undefined) } }),
    );
    expect(blocked).toContain('Création impossible tant que ces erreurs restent.');
    expect(blocked).toMatch(/data-action="wz-create" disabled/);
    // Un échec du serveur garde la saisie ; fermer avec des changements demande confirmation.
    const failed = renderDashboard(
      base('library', {}, { wizard: { ...named, error: 'already exists', dirty: true, confirmClose: true } }),
    );
    expect(failed).toContain('<p class="err" role="alert">already exists</p>');
    expect(failed).toContain('value="Nouveau bloc"');
    expect(failed).toContain('Abandonner la création du bloc ?');
    expect(nameProblem(base('library'), { ...named, name: ' ' })).toBe('Le nom est obligatoire.');
  });

  it('the window from a recording: a group, the steps kept, the dependencies nothing produces', () => {
    const steps = [
      { position: 1, stepId: 's1', kind: 'click', label: 'click « Nouveau »', groupId: 'g1' },
      { position: 2, stepId: 's2', kind: 'fill', label: 'fill « Titre »', groupId: 'g1' },
    ];
    const plan = {
      recording: 'rec1',
      mode: 'separate' as const,
      ok: true,
      groups: [],
      blocks: [
        {
          key: 'g1',
          name: 'Bloc g1',
          composite: false,
          groups: [{ id: 'g1', name: 'Création', steps: 1, partial: true }],
          startAt: '/items',
          steps: [steps[1] ?? steps[0]],
          assertions: 0,
          checks: 0,
          data: [],
          produces: [],
          consumes: ['item.code'],
          contract: {
            source: 'DERIVED' as const,
            inputs: [{ key: 'item.code', required: true }],
            outputs: [],
            preconditions: [],
            postconditions: [],
          },
          dependencies: [{ key: 'item.code', source: 'NOWHERE' as const }],
          transformations: [],
          midway: true,
          gaps: [],
          validation: { ok: true, errors: [], warnings: [] },
        },
      ],
      summary: {
        groups: 1,
        steps: 1,
        produced: 0,
        consumed: 1,
        external: ['item.code'],
        errors: 0,
        warnings: 0,
      },
      errors: [],
    };
    const wizard = {
      ...emptyWizard(''),
      origin: 'recording' as const,
      recording: 'rec1',
      recordings: ['rec1'],
      groups: [
        {
          id: 'g1',
          name: 'Création',
          stepIds: ['s1', 's2'],
          positions: [1, 2],
          startAt: '/items',
          checks: [],
          assertionIds: [],
          runnableAlone: { ok: true, missing: [] },
        },
      ],
      groupsFor: 'rec1',
      groupId: 'g1',
      stepIds: ['s2'],
      groupSteps: steps,
      name: 'Bloc titre',
    };
    const html = renderDashboard(
      base('library', {}, { wizard: { ...wizard, plan, planFor: 'r:rec1:g1:s2' } as never }),
    );
    expect(html).toContain('<option value="g1" selected>Création · 2</option>');
    expect(html).toMatch(/data-wz="step" value="s1"><span>1\. click « Nouveau »/);
    expect(html).toMatch(/data-wz="step" value="s2" checked>/);
    expect(html).toContain('1 étape(s) exécutable(s) · départ /items');
    const io = renderDashboard(
      base('library', {}, { wizard: { ...wizard, step: 2, plan, planFor: 'r:rec1:g1:s2' } as never }),
    );
    expect(io).toContain('Données consommées que rien ne produit');
    expect(io).toContain('<code class="lib-key">item.code</code>');
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

  it('scenarios: a replay the server refuses is said beside the button, never silently dropped', () => {
    const html = renderDashboard(
      base('scenarios', {
        scenarioHistory: [],
        recordings: [],
        launch: {
          kind: 'REPLAY',
          environmentId: '',
          scenarios: ['Composé'],
          busy: false,
          error: 'invalid scenario',
        },
      }),
    );
    expect(html).toMatch(
      /data-action="replay-scenario" data-name="Composé"[^]*<p class="err" role="alert">invalid scenario<\/p>/,
    );
    const busy = renderDashboard(
      base('scenarios', {
        scenarioHistory: [],
        recordings: [],
        launch: { kind: 'REPLAY', environmentId: '', scenarios: ['Composé'], busy: true },
      }),
    );
    expect(busy).toContain('data-action="replay-scenario" data-name="Composé" disabled aria-busy="true"');
  });

  it('replaying a composed journey: « Navigateur visible » beside Rejouer, in Scénarios and in the library', () => {
    const screen = { capabilities: { visibleBrowser: true } as DashboardState['capabilities'] };
    const scenarios = renderDashboard(base('scenarios', { ...screen, scenarioHistory: [], recordings: [] }));
    expect(scenarios).toMatch(
      /data-action="replay-scenario" data-name="Composé"[^]*<input type="checkbox" data-bind="headed"/,
    );
    const headed = renderDashboard(
      base('scenarios', {
        ...screen,
        scenarioHistory: [],
        recordings: [],
        launch: {
          kind: 'REPLAY',
          environmentId: '',
          scenarios: [],
          busy: false,
          headed: true,
          slowMoMs: 250,
        },
      }),
    );
    expect(headed).toContain('data-bind="headed" checked');
    expect(headed).toContain('<option value="250" selected>');
    // Sans écran sur le serveur : la case est là, désactivée, avec la raison.
    const blind = renderDashboard(base('scenarios', { scenarioHistory: [], recordings: [] }));
    expect(blind).toMatch(/<input type="checkbox" data-bind="headed"\s+disabled>/);
    // La bibliothèque : le parcours tout juste créé se rejoue d'ici.
    const library = renderDashboard(
      base('library', screen, { composed: 'Composé', notice: t.lib.composed('Composé') }),
    );
    expect(library).toContain('data-action="replay-scenario" data-name="Composé"');
    expect(library).toContain('Rejouer « Composé »');
    expect(library).toMatch(/lib-replay[^]*data-bind="headed"/);
    // Un nom qui n'est plus un scénario jouable ne propose rien ; un lecteur non plus.
    expect(renderDashboard(base('library', screen, { composed: 'Bloc connexion' }))).not.toContain(
      'lib-replay',
    );
    expect(renderDashboard(base('library', { ...screen, ...reader }, { composed: 'Composé' }))).not.toContain(
      'lib-replay',
    );
  });

  it('a reader sees the library and the details, never an action', () => {
    const html = renderDashboard(
      base('library', reader, {
        sheet: { block: 'Bloc seul', tab: 'contract' },
        journey: { ...emptyJourneyUi(), journey: journeyOfParts('P', [{ block: 'Bloc seul', version: 1 }]) },
      }),
    );
    expect(html).toContain('Bloc connexion');
    expect(html).not.toMatch(
      /data-action="lib-(remove|panel-open|part-add|part-move|check|contract-edit|validate-version|update-ask|update-yes)"/,
    );
    expect(html).not.toMatch(/data-action="jn-(add|move|remove|duplicate|save|publish|check|shape)"/);
    expect(html).not.toContain('data-jn-gap');
    expect(html).not.toContain('Créer le scénario');
    const scenarios = renderDashboard(base('scenarios', { ...reader, scenarioHistory: [], recordings: [] }));
    expect(scenarios).not.toContain('data-action="lib-insert"');
    expect(scenarios).not.toContain('data-action="lib-from-scenario"');
    expect(scenarios).not.toContain('data-action="lib-accept"');
  });
});
