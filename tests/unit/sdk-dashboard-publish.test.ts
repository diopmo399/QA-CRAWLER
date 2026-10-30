import { describe, expect, it } from 'vitest';
import type {
  ExtractionBlockPlan,
  ExtractionPlan,
  FlowStudioView,
  ProjectDetail,
} from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import {
  emptyPublishUi,
  extractionInputOf,
  missingProducers,
  planKey,
  type PublishUi,
} from '../../src/sdk/ui/dashboard-publish.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { emptyReviewUi } from '../../src/sdk/ui/dashboard-review.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * L'ONGLET PUBLIER DE LA REVUE (fonctions pures) : les groupes du Recorder avec leurs données, la
 * sélection (un, plusieurs, tous, une partie), l'alerte quand un producteur n'est pas coché, le résumé
 * et l'aperçu calculés par le serveur, publier seulement un plan valide et à jour ; un lecteur voit tout
 * sans pouvoir publier. Le parcours réel (serveur, enregistrement, publication) : intégration Chromium.
 */
const at = '2026-10-28T10:00:00.000Z';
const t = dashboardStrings('fr');

const project = {
  id: 'prj_a',
  name: 'Catalogue',
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

const step = (id: string, position: number, kind: string, description: string, groupId: string) => ({
  id,
  position,
  kind,
  description,
  groupId,
  consumes: [],
  produces: [],
});

const studio: FlowStudioView = {
  name: 'Créer puis chercher',
  startAt: '/items',
  steps: [
    step('s1', 1, 'click', 'Cliquer sur "Nouveau"', 'g1'),
    { ...step('s2', 2, 'fill', 'Saisir dans "Titre"', 'g1'), produces: ['item.title'] },
    step('s3', 3, 'expect', 'Vérifier : URL /items/', 'g1'),
    step('s4', 4, 'goto', 'go to /search', 'g2'),
    { ...step('s5', 5, 'fill', 'Saisir dans "<Recherche>"', 'g2'), consumes: ['item.title'] },
  ],
  groups: [
    {
      id: 'g1',
      name: 'Créer l’article',
      stepIds: ['s1', 's2', 's3'],
      positions: [1, 2, 3],
      startAt: '/items',
      checks: ['s3'],
      assertionIds: [],
      runnableAlone: { ok: true, missing: [] },
      data: { inputs: [], outputs: [{ key: 'item.title', consumerStepIds: ['s5'] }] },
    },
    {
      id: 'g2',
      name: 'Chercher <l’article>',
      stepIds: ['s4', 's5'],
      positions: [4, 5],
      startAt: '/items',
      checks: [],
      assertionIds: [],
      runnableAlone: { ok: false, missing: ['item.title'] },
      data: { inputs: [{ key: 'item.title', producerStepId: 's2', producerGroupId: 'g1' }], outputs: [] },
    },
  ],
  dependencies: [{ from: 's2', to: 's5', key: 'item.title' }],
  violations: [],
};

const block = (extra: Partial<ExtractionBlockPlan>): ExtractionBlockPlan => ({
  key: 'g2',
  name: 'Chercher l’article',
  composite: false,
  groups: [{ id: 'g2', name: 'Chercher <l’article>', steps: 2, partial: false }],
  startAt: '/items',
  steps: [
    { position: 1, kind: 'goto', label: 'go to /search', stepId: 's4' },
    { position: 2, kind: 'fill', label: 'Saisir dans "Recherche"', stepId: 's5' },
  ],
  assertions: 0,
  checks: 0,
  data: [],
  produces: [],
  consumes: ['item.title'],
  contract: {
    source: 'DERIVED',
    inputs: [{ key: 'item.title', required: true }],
    outputs: [],
    preconditions: [],
    postconditions: [],
  },
  dependencies: [
    { key: 'item.title', source: 'UNSELECTED_GROUP', group: { id: 'g1', name: 'Créer l’article' } },
  ],
  transformations: [],
  midway: false,
  validation: { ok: true, errors: [], warnings: ['consumes item.title…'] },
  ...extra,
});

const planOf = (blocks: ExtractionBlockPlan[], extra: Partial<ExtractionPlan> = {}): ExtractionPlan => ({
  recording: 'creer-puis-chercher',
  mode: 'separate',
  ok: blocks.every((entry) => entry.validation.ok),
  groups: [],
  blocks,
  summary: {
    groups: blocks.length,
    steps: blocks.reduce((sum, entry) => sum + entry.steps.length, 0),
    produced: 0,
    consumed: 1,
    external: ['item.title'],
    errors: blocks.reduce((sum, entry) => sum + entry.validation.errors.length, 0),
    warnings: 1,
  },
  errors: [],
  ...extra,
});

/** Une sélection et son plan à jour (le plan vaut pour cette sélection exacte). */
const withPlan = (ui: Partial<PublishUi>, plan?: ExtractionPlan): PublishUi => {
  const next = { ...emptyPublishUi(), ...ui };
  return plan ? { ...next, plan, planFor: planKey(next) } : next;
};

const base = (publish: PublishUi, extra: Partial<DashboardState> = {}): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'recording', projectId: 'prj_a', name: 'creer-puis-chercher', tab: 'publish' },
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
  lib: emptyLibraryUi(),
  tst: emptyTestsUi(),
  ed: emptyEditorUi(),
  studioUrl: '/studio',
  review: { ...emptyReviewUi('creer-puis-chercher'), studio, assertions: [], groupProposals: [], publish },
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

describe('dashboard — publish business groups', () => {
  it('what the server receives: groups in recording order, a part, names, navigation, provided values', () => {
    expect(extractionInputOf(emptyPublishUi())).toEqual({ selection: [], mode: 'separate' });
    const input = extractionInputOf(
      withPlan({
        selected: ['g1', 'g2'],
        parts: { g1: ['s1', 's2'], g2: [] },
        mode: 'composite',
        names: { composite: { name: '  Créer et chercher ', description: '  ' }, g2: { description: '' } },
        navigate: true,
        provided: { 'item.title': 'Lampe' },
      }),
    );
    expect(input).toEqual({
      selection: [{ groupId: 'g1', stepIds: ['s1', 's2'] }, { groupId: 'g2' }],
      mode: 'composite',
      names: { composite: { name: 'Créer et chercher' } },
      navigate: true,
      provided: { 'item.title': 'Lampe' },
    });
    expect(missingProducers(studio.groups, ['g2']).map((entry) => [entry.key, entry.from.id])).toEqual([
      ['item.title', 'g1'],
    ]);
    expect(missingProducers(studio.groups, ['g1', 'g2'])).toEqual([]);
  });

  it('the groups: steps, main actions, data produced and read, standalone or not; a summary of the recording', () => {
    const html = renderDashboard(base(emptyPublishUi()));
    expect(html).toContain('aria-selected="true">Publier<');
    expect(html).toContain('data-pub="group" value="g1"');
    expect(html).toContain('Chercher &lt;l’article&gt;');
    expect(html).not.toContain('Chercher <l’article>');
    expect(html).toContain('2 action(s) · 1 vérification(s)');
    expect(html).toContain('Pas autonome');
    expect(html).toContain('Aucun groupe coché.');
    expect(html).toContain('data-action="pub-preview" disabled');
    expect(html).toContain('Publier dans la bibliothèque');
    expect(html).toContain('Choisissez un groupe pour voir ses étapes');
  });

  it('a group read from an unchosen producer: the warning, add the producer; the side panel lets a part be kept', () => {
    const plan = planOf([block({})]);
    const html = renderDashboard(base(withPlan({ selected: ['g2'], focus: 'g2' }, plan)));
    expect(html).toContain(
      '« Chercher &lt;l’article&gt; » lit item.title, produite par « Créer l’article », qui n’est pas coché : ce bloc ne sera pas autonome.',
    );
    expect(html).toContain('data-action="pub-add-group" data-group="g1"');
    expect(html).toContain('data-pub="step"');
    expect(html).toContain('(décochez pour n’en garder qu’une partie)');
    // Les diagnostics viennent du plan structuré, dans la langue du Dashboard (jamais le texte serveur).
    expect(html).toContain('item.title : produite par « Créer l’article », non coché — une entrée du bloc');
    expect(html).not.toContain('consumes item.title');
    expect(html).toContain('1 groupe(s) sélectionné(s)');
    expect(html).toContain('Dépendances externes : item.title');
  });

  it('the preview: each block with its contract, its dependencies and what can be done; publishing a fresh valid plan', () => {
    const plan = planOf([block({})]);
    const html = renderDashboard(base(withPlan({ selected: ['g2'], preview: true }, plan)));
    expect(html).toContain('1 bloc(s) à publier');
    expect(html).toContain('data-pub="name" data-key="g2" value="Chercher l’article"');
    expect(html).toContain('<code class="lib-key">item.title</code>');
    expect(html).toContain('data-action="pub-provide" data-key="item.title"');
    expect(html).toContain('sinon : une entrée obligatoire');
    expect(html).toMatch(/data-action="pub-publish"\s+aria-busy/);
    // Un plan d'une autre sélection ne se publie pas.
    const stale = { ...withPlan({ selected: ['g2'], preview: true }, plan), planFor: 'autre' };
    expect(renderDashboard(base(stale))).toMatch(/data-action="pub-publish" disabled/);
  });

  it('an invalid block is never publishable; its errors are localized by step; a mid-recording start is told', () => {
    const broken = block({
      midway: true,
      startAt: '/search',
      validation: { ok: false, errors: ['step 2 (fill) target.strategy: invalid option'], warnings: [] },
    });
    const html = renderDashboard(base(withPlan({ selected: ['g2'], preview: true }, planOf([broken]))));
    expect(html).toContain('1 erreur(s)');
    expect(html).toContain('step 2 (fill) target.strategy: invalid option');
    expect(html).toContain('Corrigez les erreurs avant de publier.');
    expect(html).toMatch(/data-action="pub-publish" disabled/);
    expect(html).toContain('sa page de départ /search n’est pas visitée');
    expect(html).toContain('1 problème(s) à corriger');
  });

  it('a value provided at publication, and the composite mode', () => {
    const provided = block({
      dependencies: [{ key: 'item.title', source: 'PROVIDED' }],
      contract: { source: 'DERIVED', inputs: [], outputs: [], preconditions: [], postconditions: [] },
    });
    const html = renderDashboard(
      base(
        withPlan(
          { selected: ['g2'], preview: true, provided: { 'item.title': 'Lampe' } },
          planOf([provided]),
        ),
      ),
    );
    expect(html).toContain('item.title : valeur fournie à la publication');
    expect(html).toContain('data-action="pub-unprovide" data-key="item.title"');
    const composite = block({
      key: 'composite',
      composite: true,
      name: 'Créer l’article + Chercher',
      groups: [
        { id: 'g1', name: 'Créer l’article', steps: 2, partial: true },
        { id: 'g2', name: 'Chercher', steps: 2, partial: false },
      ],
      dependencies: [],
    });
    const whole = renderDashboard(
      base(
        withPlan(
          { selected: ['g1', 'g2'], parts: { g1: ['s1', 's2'] }, mode: 'composite', preview: true },
          planOf([composite]),
        ),
      ),
    );
    expect(whole).toContain('aria-checked="true" data-action="pub-mode" data-mode="composite"');
    expect(whole).toContain('Bloc composé de 2 groupe(s)');
    expect(whole).toContain('Groupes : Créer l’article (2 étapes) · Chercher');
    expect(whole).toContain('Les groupes cochés forment un seul bloc');
  });

  it('after publishing: the notice and the way to the library', () => {
    const html = renderDashboard(
      base(withPlan({ notice: t.pub.published('Chercher l’article'), published: ['Chercher l’article'] })),
    );
    expect(html).toContain('Publié dans la bibliothèque : Chercher l’article');
    expect(html).toContain('data-action="nav" data-view="library"');
  });

  it('a reader sees the groups and the plan, never a way to publish', () => {
    const html = renderDashboard(
      base(withPlan({ selected: ['g2'], preview: true }, planOf([block({})])), reader),
    );
    expect(html).toMatch(/data-pub="group" value="g1"[^>]*disabled/);
    expect(html).not.toContain('data-action="pub-add-group"');
    expect(html).not.toContain('data-action="pub-provide"');
    expect(html).toMatch(/data-action="pub-publish" disabled/);
  });

  it('a recording without groups points to the journey to create them', () => {
    const html = renderDashboard(
      base(emptyPublishUi(), {
        review: {
          ...emptyReviewUi('creer-puis-chercher'),
          studio: { ...studio, groups: [] },
          assertions: [],
          groupProposals: [],
        },
      }),
    );
    expect(html).toContain('data-action="review-tab" data-tab="flow"');
    expect(html).not.toContain('data-pub="group"');
  });
});
