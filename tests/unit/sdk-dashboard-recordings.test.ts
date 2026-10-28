import { describe, expect, it } from 'vitest';
import type { ProjectDetail, RecordingSnapshot } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyRecordingsUi, studioLink } from '../../src/sdk/ui/dashboard-recordings.js';
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
    expect(html).not.toContain('data-recording="search"');
    expect(html).toContain('Promu en scénario');
    expect(html).toContain('a&lt;b&gt;');
    expect(html).toContain('>Échoué<');
    expect(studioLink(base({ studioUrl: 'https://qa.example/studio' }), 'x y')).toBe(
      'https://qa.example/studio?project=prj_a&recording=x%20y',
    );
  });

  it('a session in progress: its gestures, the stop button; one recording at a time', () => {
    const live = {
      name: 'create-request',
      status: 'RECORDING',
      events: [{ at, text: 'HUMAN_INTERACTION_CAPTURED i1 click "Save"' }],
    };
    const html = renderDashboard(
      base({ recordings: [{ ...recordings[0], status: 'RECORDING' } as RecordingSnapshot] }, { live }),
    );
    expect(html).toContain('click &quot;Save&quot;');
    expect(html).toContain('data-action="stop-recording"');
    expect(html).toMatch(/data-action="start-recording"[^>]*disabled/);
    expect(html).toContain('Un seul enregistrement à la fois sur ce serveur.');
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
    expect(reader).not.toContain('data-action="promote"');
    expect(reader).toContain('Ouvrir dans le Flow Studio');
  });
});
