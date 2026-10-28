import { describe, expect, it } from 'vitest';
import type {
  AssertionProposalView,
  FlowStudioView,
  ProjectDetail,
  TestDataView,
} from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { assertionBuckets, emptyReviewUi, type ReviewUi } from '../../src/sdk/ui/dashboard-review.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * LA REVUE D'UN ENREGISTREMENT DANS LE DASHBOARD (fonctions pures) : le rejeu, le parcours en groupes
 * (découpage proposé, vérifications suggérées, déplacer, détacher, retirer avec confirmation), les
 * assertions rangées comme dans la fenêtre du recorder, la source des données, la génération ; un rôle
 * sans droit de décision voit tout, sans aucune action. Le parcours complet : intégration Chromium.
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
  counts: { environments: 0, scenarios: 0, recordings: 1, executions: 0 },
  draft: {},
  environments: [],
  scenarios: [],
} as unknown as ProjectDetail;

const studio: FlowStudioView = {
  name: 'Créer puis chercher',
  startAt: '/items',
  steps: [
    {
      id: 's1',
      position: 1,
      kind: 'click',
      description: 'Cliquer sur "Nouveau"',
      groupId: 'g1',
      consumes: [],
      produces: [],
    },
    {
      id: 's2',
      position: 2,
      kind: 'fill',
      description: 'Saisir dans "Titre"',
      groupId: 'g1',
      consumes: [],
      produces: ['item.title'],
      replay: { outcome: 'MATCHED', reasons: [] },
    },
    {
      id: 's3',
      position: 3,
      kind: 'expect',
      description: 'Vérifier : URL /items/',
      groupId: 'g1',
      consumes: [],
      produces: [],
    },
    {
      id: 's4',
      position: 4,
      kind: 'fill',
      description: 'Saisir dans "<Recherche>"',
      consumes: ['item.title'],
      produces: [],
      replay: { outcome: 'NOT_FOUND', reasons: ['aucun champ Recherche'] },
    },
  ],
  groups: [
    {
      id: 'g1',
      name: 'Création',
      stepIds: ['s1', 's2', 's3'],
      positions: [1, 2, 3],
      startAt: '/items',
      checks: ['s3'],
      assertionIds: [],
      runnableAlone: { ok: true, missing: [] },
    },
  ],
  dependencies: [{ from: 's2', to: 's4', key: 'item.title' }],
  violations: [],
};

const proposal = (id: string, extra: Partial<AssertionProposalView>): AssertionProposalView => ({
  id,
  origin: 'OBSERVED',
  category: 'SCREEN',
  description: `vérifier ${id}`,
  why: 'observé',
  verificationMethod: 'UI_EXPECT',
  evidence: [],
  limits: [],
  confidence: 0.9,
  needsConfirmation: false,
  recommended: true,
  status: 'PROPOSED',
  inFlow: false,
  verdict: { status: 'NOT_EXECUTED', reasons: [] },
  ...extra,
});

const assertions = [
  proposal('p1', {}),
  proposal('p2', { origin: 'DEDUCED', confidence: 0.6 }),
  proposal('p3', { verificationMethod: 'REPORT_ONLY' }),
  proposal('p4', { status: 'APPROVED', inFlow: true, verdict: { status: 'VERIFIED_PASS', reasons: [] } }),
];

const data: TestDataView = {
  variables: [
    {
      key: 'item.title',
      strategy: 'GENERATE_AT_REPLAY',
      generator: 'words',
      producedBy: { stepId: 's2', position: 2, label: 'Titre' },
      usedBy: [{ stepId: 's4', position: 3, label: 'Recherche', how: 'INPUT' }],
    },
  ],
  inputs: [
    {
      stepId: 's2',
      position: 2,
      label: 'Titre',
      source: 'GENERATED',
      key: 'item.title',
      generator: 'words',
      options: [],
      manual: false,
    },
    {
      stepId: 's4',
      position: 3,
      label: 'Recherche',
      source: 'FIXED',
      recordedValue: 'demo',
      options: [
        { stepId: 's2', position: 2, label: 'Titre', key: 'item.title', strategy: 'GENERATE_AT_REPLAY' },
      ],
      manual: false,
    },
    { stepId: 's5', position: 4, label: 'Mot de passe', source: 'SENSITIVE', options: [], manual: false },
  ],
  missing: [],
  generators: ['words', 'email'],
};

const review = (extra: Partial<ReviewUi> = {}): ReviewUi => ({
  ...emptyReviewUi('creer-puis-chercher'),
  studio,
  assertions,
  data,
  groupProposals: [],
  checks: [{ groupId: 'g1', groupName: 'Création', key: 'item.title', afterStepId: 's2' }],
  replay: { status: 'NONE', last: { status: 'PARTIALLY_MATCHED', at, stale: true } },
  ...extra,
});

const base = (
  tab: 'flow' | 'assertions' | 'data' | 'tests',
  extra: Partial<DashboardState> = {},
): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'recording', projectId: 'prj_a', name: 'creer-puis-chercher', tab },
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
  studioUrl: '/studio',
  review: review(),
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

describe('dashboard — recording review', () => {
  it('the journey: tabs with counts, replay, groups, data badges, suggested check, studio link', () => {
    const html = renderDashboard(base('flow'));
    expect(activeNav({ view: 'recording', projectId: 'prj_a', name: 'x' })).toBe('recordings');
    expect(html).toContain('Revue de l’enregistrement · <code>creer-puis-chercher</code>');
    expect(html).toContain('1. Parcours · 3 étapes · 1 groupe(s)');
    expect(html).toContain('2. Assertions · 3 à décider');
    expect(html).toContain('Données · 3 saisie(s)');
    expect(html).toContain('Dernier rejeu : partiellement conforme');
    expect(html).toContain('Le flow a changé depuis ce rejeu');
    expect(html).toContain('data-action="review-replay"');
    expect(html).toContain('<b>Création</b>');
    expect(html).toContain('>Jouable seul<');
    expect(html).toContain('Hors groupe');
    expect(html).toContain('Saisir dans &quot;&lt;Recherche&gt;&quot;');
    expect(html).toContain('◆ produit <code>item.title</code>');
    expect(html).toContain('>Introuvable<');
    expect(html).toContain('aucun champ Recherche');
    expect(html).toContain('La donnée testData.item.title est visible à la fin de « Création »');
    expect(html).toContain('data-action="review-add-check" data-group="g1" data-key="item.title"');
    // Une vérification ne se retire pas ni ne se coche : seules les actions.
    expect(html).toContain('data-action="review-remove" data-step="s2"');
    expect(html).not.toContain('data-action="review-remove" data-step="s3"');
    expect(html).not.toContain('data-review-pick="s3"');
    expect(html).toContain('href="/studio?project=prj_a&amp;recording=creer-puis-chercher"');
    expect(html).not.toContain('rv-selbar');
  });

  it('chosen steps open the selection bar; removing asks first; proposed groups can be created at once', () => {
    const chosen = renderDashboard(base('flow', { review: review({ selected: ['s1', 's4'] }) }));
    expect(chosen).toContain('2 étape(s) choisie(s)');
    expect(chosen).toContain('data-action="review-create-group"');
    expect(chosen).toContain('<option value="g1">Création</option>');
    const confirming = renderDashboard(base('flow', { review: review({ confirmRemove: 's4' }) }));
    expect(confirming).toContain('Retirer cette étape et ses vérifications du flow ?');
    expect(confirming).toContain('data-action="review-remove-yes" data-step="s4"');
    const proposed = renderDashboard(
      base('flow', {
        review: review({
          groupProposals: [
            {
              name: 'Création — item',
              stepIds: ['s1', 's2'],
              from: 1,
              to: 2,
              action: 'create',
              confidence: 0.9,
            },
            { name: 'Recherche — item', stepIds: ['s4'], from: 3, to: 3, action: 'search', confidence: 0.7 },
          ],
        }),
      }),
    );
    expect(proposed).toContain('Découpage proposé');
    expect(proposed).toContain('Créer les 2 groupes');
    expect(proposed).toContain('étapes 1 à 2');
  });

  it('assertions are sorted like the recorder: recommended, to decide, weak (folded), decided', () => {
    const buckets = assertionBuckets(assertions);
    expect(buckets.recommended.map((entry) => entry.id)).toEqual(['p1']);
    expect(buckets.toDecide.map((entry) => entry.id)).toEqual(['p2']);
    expect(buckets.weak.map((entry) => entry.id)).toEqual(['p3']);
    expect(buckets.decided.map((entry) => entry.id)).toEqual(['p4']);
    const html = renderDashboard(base('assertions'));
    expect(html).toContain('Recommandées · 1');
    expect(html).toContain('Accepter les 1');
    expect(html).toContain('<details><summary><b>Faibles ou non exécutables</b> · 1</summary>');
    expect(html).toContain('data-action="review-decide-all" data-decision="REJECT" data-bucket="weak"');
    expect(html).toContain('>Conforme au rejeu<');
    expect(html).toContain('data-action="review-decide" data-decision="RESET" data-assertion="p4"');
    expect(html).not.toContain('data-decision="RESET" data-assertion="p1"');
    const editing = renderDashboard(
      base('assertions', { review: review({ editing: { id: 'p2', description: 'x' } }) }),
    );
    expect(editing).toContain('data-action="review-modify" data-assertion="p2"');
  });

  it('data: the source of each input, never a secret; earlier data only for reuse', () => {
    const html = renderDashboard(base('data'));
    expect(html).toContain('>Générée à chaque rejeu<');
    expect(html).toContain('data-action="review-bind" data-step="s4"');
    expect(html).toContain('value="demo"');
    expect(html).toContain('>Secret (jamais affiché)<');
    expect(html).not.toContain('data-action="review-bind" data-step="s5"');
    // Aucune donnée produite avant la première saisie : « reprise » n'y est pas proposée.
    expect(html).toMatch(/name="rv-src-s2"[^>]*value="REFERENCE"[^>]*disabled/);
    const reuse = renderDashboard(
      base('data', {
        review: review({
          binds: {
            s4: { source: 'REFERENCE', variable: '', generator: 'words', reference: 'item.title', value: '' },
          },
        }),
      }),
    );
    expect(reuse).toContain('<option value="item.title" selected>item.title — 2. Titre</option>');
    expect(html).toContain('Lignée des données');
  });

  it('tests: formats, groups, and the files produced with what they are (never "passed")', () => {
    const html = renderDashboard(
      base('tests', {
        review: review({
          generation: {
            warnings: [],
            files: [
              {
                format: 'playwright',
                path: 'playwright/creer.spec.ts',
                status: 'STATICALLY_VALIDATED',
                validation: { method: 'tsc --noEmit', ok: true, messages: [] },
                assertions: [{ id: 'p4', description: 'vérifier p4', support: 'NATIVE', status: 'APPROVED' }],
                limits: ['réseau non vérifié'],
                content: "test('<x>', () => {});",
              },
            ],
          },
        }),
      }),
    );
    expect(html).toContain('data-review-format="yaml" checked');
    expect(html).toContain('data-review-format="java" ');
    expect(html).toContain('data-review-gen-group="g1"');
    expect(html).toContain('Générer n’exécute rien');
    expect(html).toContain('>Validé (analyse statique)<');
    expect(html).toContain('test(&#39;&lt;x&gt;&#39;, () =&gt; {});');
    expect(html).toContain('réseau non vérifié');
  });

  it('a reader sees the whole review, never an action', () => {
    for (const tab of ['flow', 'assertions', 'data', 'tests'] as const) {
      const html = renderDashboard(base(tab, reader));
      expect(html).not.toMatch(
        /data-action="review-(remove|move|detach|decide|decide-all|bind|add-check|accept-groups|replay|generate|rename-open|delete-group)"/,
      );
      expect(html).not.toContain('data-review-pick');
    }
    expect(renderDashboard(base('tests', reader))).not.toContain('rv-gen');
  });
});
