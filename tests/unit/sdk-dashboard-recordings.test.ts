import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { describe, expect, it } from 'vitest';
import type { ProjectDetail, RecordingSnapshot } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyRecordingsUi, newLiveRecording, studioLink } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * L'ÉCRAN ENREGISTREMENTS (fonctions pures) : démarrer un enregistrement (un seul à la fois), le
 * suivre en direct, l'arrêter ; la liste avec le statut, les étapes, les assertions à décider, le
 * rejeu de validation, le lien vers le Flow Studio et la promotion ; un rôle sans droit ne voit pas
 * ces actions. Le parcours complet dans Chromium : sdk-dashboard-recordings (intégration).
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
  counts: { environments: 0, scenarios: 1, recordings: 2, executions: 0 },
  draft: {},
  environments: [],
  scenarios: [{ name: 'search', file: 'search/search.flow.yaml', format: 'yaml', fromRecording: 'search' }],
} as unknown as ProjectDetail;

const summary = (steps: number, replay?: string) => ({
  name: 'x',
  steps,
  proposals: { total: 3, pending: 2, inFlow: 1 },
  groups: 1,
  files: [],
  warnings: [],
  ...(replay ? { replay } : {}),
});

const recordings = [
  {
    name: 'create-request',
    projectId: 'prj_a',
    status: 'COMPLETED',
    startedAt: at,
    serverTime: at,
    lastSeq: 9,
    summary: summary(6, 'REPLAY_CONFIRMED'),
  },
  { name: 'search', projectId: 'prj_a', status: 'STORED', serverTime: at, lastSeq: 0, summary: summary(4) },
  { name: 'a<b>', projectId: 'prj_a', status: 'FAILED', serverTime: at, lastSeq: 2, error: 'boom' },
] as RecordingSnapshot[];

const base = (
  extra: Partial<DashboardState> = {},
  recs: Partial<DashboardState['recs']> = {},
): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'recordings', projectId: 'prj_a' },
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
  recs: { ...emptyRecordingsUi(), ...recs },
  lib: emptyLibraryUi(),
  tst: emptyTestsUi(),
  studioUrl: '/studio',
  ...extra,
});

describe('dashboard — recordings', () => {
  it('lists the recordings: status, steps, assertions to decide, validation replay, studio, promotion', () => {
    const html = renderDashboard(base());
    expect(activeNav({ view: 'recordings', projectId: 'prj_a' })).toBe('recordings');
    expect(html).toContain('data-view="recordings"');
    expect(html).toContain('Demandes · 3 enregistrement(s)');
    expect(html).toContain('>Confirmé<');
    expect(html).toContain(
      'href="/studio?project=prj_a&amp;recording=create-request" target="_blank" rel="noopener"',
    );
    expect(html).toContain('data-action="promote" data-recording="create-request"');
    expect(html).not.toContain('data-action="promote" data-recording="search"');
    expect(html).toContain('data-action="open-review" data-recording="search"');
    expect(html).not.toContain('data-action="open-review" data-recording="a&lt;b&gt;"');
    expect(html).toContain('Promu en scénario');
    expect(html).toContain('a&lt;b&gt;');
    expect(html).toContain('>Échoué<');
    expect(studioLink(base({ studioUrl: 'https://qa.example/studio' }), 'x y')).toBe(
      'https://qa.example/studio?project=prj_a&recording=x%20y',
    );
  });

  it('a session in progress: readable gestures, the recording bar, checks; one recording at a time', () => {
    const live = {
      ...newLiveRecording('create-request', 'RECORDING'),
      timeline: {
        paused: false,
        steps: [
          {
            id: 'a1',
            index: 1,
            kind: 'click',
            description: 'Cliquer sur "Nouvelle demande"',
            page: '/',
            status: 'CONFIRMED',
            statusText: 'Cible unique, effet observé',
          },
          {
            id: 'a2',
            index: 2,
            kind: 'fill',
            description: 'Saisir dans "Titre"',
            detail: 'Champ du formulaire',
            page: '/new',
            status: 'PENDING',
            statusText: 'Validation en cours',
          },
        ],
        checkpoints: ['La demande <apparaît>'],
      },
      notes: [{ at, text: 'Enregistrement démarré' }],
      technical: [{ at, text: 'HUMAN_INTERACTION_CAPTURED i1 click "Save"' }],
    };
    const html = renderDashboard(
      base({ recordings: [{ ...recordings[0], status: 'RECORDING' } as RecordingSnapshot] }, { live }),
    );
    expect(html).toContain('Cliquer sur &quot;Nouvelle demande&quot;');
    expect(html).toContain('Gestes enregistrés · 2');
    expect(html).toContain('>En validation<');
    expect(html).toContain('data-action="rec-control" data-control="pause"');
    expect(html).toContain('data-action="rec-control" data-control="undo"');
    expect(html).toContain('<form class="rec-check" data-action="rec-checkpoint">');
    expect(html).toContain('La demande &lt;apparaît&gt;');
    expect(html).toContain('Enregistrement démarré');
    // Les messages bruts du recorder restent repliés dans le journal technique.
    expect(html).toMatch(
      /<details class="tech"><summary>Journal technique · 1<\/summary>[^]*click &quot;Save&quot;/,
    );
    expect(html).toContain('data-action="stop-recording"');
    expect(html).toMatch(/data-action="start-recording"[^>]*disabled/);
    expect(html).toContain('Un seul enregistrement à la fois sur ce serveur.');
  });

  it('paused, then an ambiguous target: resume, choose the element touched or leave it', () => {
    const ambiguous = {
      id: 'a3',
      index: 1,
      kind: 'click',
      description: 'Cliquer sur "Ouvrir"',
      page: '/list',
      status: 'AMBIGUOUS',
      statusText: '2 éléments correspondent',
      candidates: [
        { index: 0, label: 'Ouvrir — ligne 1', original: true },
        { index: 1, label: 'Ouvrir — ligne 2', original: false },
      ],
    };
    const live = {
      ...newLiveRecording('create-request', 'RECORDING'),
      timeline: { paused: true, steps: [ambiguous], checkpoints: [] },
    };
    const html = renderDashboard(base({}, { live }));
    expect(html).toContain('>En pause<');
    expect(html).toContain('data-control="resume"');
    expect(html).not.toContain('data-control="pause"');
    expect(html).toContain('Plusieurs éléments correspondent : lequel avez-vous touché ?');
    expect(html).toContain('data-action="rec-resolve" data-step="a3" data-candidate="0"');
    expect(html).toContain('(touché)');
    expect(html).toContain('data-action="rec-ignore" data-step="a3"');
    const resolved = renderDashboard(
      base(
        {},
        {
          live: {
            ...live,
            timeline: { ...live.timeline, steps: [{ ...ambiguous, resolution: 'RESOLVED' as const }] },
          },
        },
      ),
    );
    expect(resolved).not.toContain('data-action="rec-resolve"');
    expect(resolved).toContain('Élément confirmé');
  });

  it('after the stop: the processing phases in words, with their progress; no recording bar', () => {
    const live = {
      ...newLiveRecording('create-request', 'PROCESSING'),
      phases: [
        { label: 'Finishing the capture', step: 1, total: 7 },
        { label: 'Building the flow', step: 3, total: 7 },
        { label: 'Validating by replay', step: 6, total: 7, detail: 'step 2/4' },
      ],
    };
    const html = renderDashboard(base({}, { live }));
    expect(html).toContain('Traitement après l’arrêt · Étape 6 sur 7');
    expect(html).toContain('Fin de la capture');
    expect(html).toContain('Rejeu de validation <small class="mu">step 2/4</small>');
    expect(html).toContain('style="width:86%"');
    expect(html).not.toContain('data-action="rec-control"');
    expect(html).not.toContain('data-action="stop-recording"');
  });

  it('a reader sees the list, never the actions', () => {
    const reader = renderDashboard(
      base({
        me: {
          id: 'm',
          name: 'N',
          kind: 'MEMBER',
          role: 'READER',
          rights: [...ROLE_RIGHTS.READER],
          mode: 'named',
        },
      }),
    );
    expect(reader).not.toContain('data-action="start-recording"');
    const watching = renderDashboard(
      base(
        {
          me: {
            id: 'm',
            name: 'N',
            kind: 'MEMBER',
            role: 'READER',
            rights: [...ROLE_RIGHTS.READER],
            mode: 'named',
          },
        },
        { live: newLiveRecording('create-request', 'RECORDING') },
      ),
    );
    expect(watching).toContain('En attente des premiers gestes…');
    expect(watching).not.toContain('data-action="rec-control"');
    expect(watching).not.toContain('data-action="stop-recording"');
    expect(reader).not.toContain('data-action="promote"');
    expect(reader).toContain('Ouvrir dans le Flow Studio');
  });
});
