import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { emptyEditorUi } from '../../src/sdk/ui/dashboard-editor.js';
import { emptyTestsUi } from '../../src/sdk/ui/dashboard-tests.js';
import { describe, expect, it } from 'vitest';
import { parseSdkServerArgs } from '../../src/cli/sdk-server-command.js';
import type { AccessMe, JournalEntry, MemberView, ProjectDetail } from '../../src/sdk/core/contracts.js';
import { ROLE_RIGHTS } from '../../src/sdk/core/contracts.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyImportForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * L'ÉCRAN ACCÈS ET JOURNAL et la connexion (fonctions pures) : matrice des droits, membres et rôles
 * par projet, jeton montré une fois, révocation confirmée dans la page, journal ; un rôle sans droit
 * ne voit pas l'action (le serveur la refuse de toute façon) ; la connexion ne montre jamais le jeton.
 */
const at = '2026-10-27T10:00:00.000Z';
const t = dashboardStrings('fr');

const project = {
  id: 'prj_a',
  name: 'Demandes',
  targetUrl: 'http://127.0.0.1:9/',
  framework: 'other',
  createdAt: at,
  status: 'PROJECT_CREATED',
  state: 'ACTIVE',
  counts: { environments: 1, scenarios: 1, recordings: 0, executions: 0 },
  draft: {},
  environments: [
    {
      id: 'env_1',
      name: 'Recette',
      kind: 'TEST',
      baseUrl: 'http://127.0.0.1:9',
      mutations: { enabled: true, maxPerRun: 3 },
      createdAt: at,
      updatedAt: at,
    },
  ],
  scenarios: [{ name: 'create-request', file: 'create-request.flow.yaml', format: 'yaml', steps: 3 }],
} as unknown as ProjectDetail;

const me = (role: AccessMe['role'], kind: AccessMe['kind'] = 'MEMBER'): AccessMe => ({
  id: kind === 'SERVICE' ? 'service' : 'mbr_abcdefgh',
  name: kind === 'SERVICE' ? 'service' : 'Camille R.',
  kind,
  role,
  rights: [...ROLE_RIGHTS[role]],
  mode: 'named',
});

const base = (
  extra: Partial<DashboardState> = {},
  access: Partial<DashboardState['access']> = {},
): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'access' },
  days: 7,
  showArchived: false,
  launch: { kind: 'REPLAY', environmentId: 'env_1', scenarios: [], busy: false },
  projectId: 'prj_a',
  catalog: [{ id: 'prj_a', name: 'Demandes' } as never],
  menuOpen: false,
  checks: {},
  cancellation: true,
  picked: [],
  severity: 'ALL',
  project,
  req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8 },
  signIn: true,
  access: { ...emptyAccessUi(), ...access },
  recs: emptyRecordingsUi(),
  lib: emptyLibraryUi(),
  tst: emptyTestsUi(),
  ed: emptyEditorUi(),
  ...extra,
});

const members: MemberView[] = [
  { id: 'mbr_abcdefgh', name: 'Camille R.', role: 'ADMIN', projects: {}, createdAt: at },
  { id: 'mbr_ijklmnop', name: 'Noa <b>P.</b>', role: 'ANALYST', projects: { prj_a: 'PILOT' }, createdAt: at },
  { id: 'mbr_qrstuvwx', name: 'Ancien', role: 'READER', projects: {}, createdAt: at, revokedAt: at },
];
const journal: JournalEntry[] = [
  {
    at,
    who: { id: 'mbr_ijklmnop', name: 'Noa P.' },
    role: 'ANALYST',
    method: 'POST',
    action: 'projects.executions',
    kind: 'RUN',
    path: '/api/projects/prj_a/executions',
    projectId: 'prj_a',
    status: 403,
    outcome: 'DENIED',
  },
];

describe('dashboard — access and journal', () => {
  it('sign-in: a password field, the token never shown; the refusal said', () => {
    const html = renderDashboard(base({ phase: 'idle' }, { signInError: t.access.refused }));
    expect(html).toContain('<input type="password" data-bind="token" autocomplete="off"');
    expect(html).toContain('Jeton refusé (inconnu ou révoqué).');
    expect(renderDashboard(base({ phase: 'idle', signIn: false }))).toContain(
      'Le jeton de l’API n’est pas fourni',
    );
  });

  it('administrator: rights matrix, members with their project role, the token once, revocation confirmed', () => {
    const html = renderDashboard(
      base(
        { me: me('ADMIN', 'SERVICE') },
        { members, journal, created: { member: members[0] as MemberView, token: 'qa_once-shown-token' } },
      ),
    );
    expect(html).toContain('Les droits sont vérifiés par le service, pas par l’écran');
    expect(html).toContain('Lancer avec écritures permises</th><td class="no">');
    expect(html).toContain('Noa &lt;b&gt;P.&lt;/b&gt;');
    expect(html).toContain('<select data-member-project-role="mbr_ijklmnop" >');
    expect(html).toMatch(/data-member-project-role="mbr_ijklmnop"[^>]*>.*<option value="PILOT" selected>/s);
    expect(html).toContain('<code class="tok" data-token>qa_once-shown-token</code>');
    expect(html).toContain('n’est affiché qu’une fois');
    expect(html).toContain('révoqué le');
    expect(html).not.toContain('data-action="revoke-confirm"');
    expect(
      renderDashboard(base({ me: me('ADMIN', 'SERVICE'), confirm: 'revoke:mbr_ijklmnop' }, { members })),
    ).toContain('data-action="revoke-confirm" data-member="mbr_ijklmnop"');
    expect(html).toContain('projects.executions');
    expect(html).toContain('Refusé · 403');
    expect(html).toContain('Le journal ne contient ni valeur saisie, ni secret, ni jeton.');
  });

  it('a non administrator sees the rights, not the members nor the journal', () => {
    const html = renderDashboard(base({ me: me('PILOT') }, { members, journal }));
    expect(html).toContain('Camille R. · Pilote QA');
    expect(html).toContain('Les membres et le journal sont réservés à l’administration.');
    expect(html).not.toContain('data-member-role');
    expect(html).not.toContain('projects.executions');
  });

  it('the screens hide what the role does not allow; the footer says who is signed in', () => {
    const reader = renderDashboard(
      base({ me: me('READER'), route: { view: 'project', projectId: 'prj_a' } }),
    );
    expect(reader).toContain('Votre rôle permet de voir les résultats, pas de lancer une exécution.');
    expect(reader).not.toContain('form class="launch');
    expect(reader).not.toContain('data-action="archive"');
    expect(reader).toContain('Connecté : Camille R. · Lecteur');
    expect(reader).toContain('data-action="sign-out"');
    const analyst = renderDashboard(
      base({ me: me('ANALYST'), route: { view: 'project', projectId: 'prj_a' } }),
    );
    expect(analyst).toContain('form class="launch');
    expect(analyst).toContain('Votre rôle ne permet pas un lancement avec écritures');
    const environments = renderDashboard(
      base({ me: me('PILOT'), route: { view: 'environments', projectId: 'prj_a' } }),
    );
    expect(environments).not.toContain('data-action="edit-env"');
    const admin = renderDashboard(
      base({ me: me('ADMIN'), route: { view: 'environments', projectId: 'prj_a' } }),
    );
    expect(admin).toContain('data-action="edit-env" data-env="new"');
  });

  it('sdk-server --access named, anything else refused', () => {
    expect(parseSdkServerArgs(['--workspace', 'w', '--access', 'named']).access).toBe('named');
    expect(parseSdkServerArgs(['--workspace', 'w']).access).toBe('single');
    expect(() => parseSdkServerArgs(['--workspace', 'w', '--access', 'open'])).toThrow(
      '--access must be single or named',
    );
  });
});
