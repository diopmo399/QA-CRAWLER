import { emptyLibraryUi } from '../../src/sdk/ui/dashboard-library.js';
import { describe, expect, it } from 'vitest';
import type {
  ImportSummary,
  MatrixRow,
  ProjectDetail,
  RequirementConnectorView,
  RequirementsIndicators,
  RequirementsView,
  TrendsView,
} from '../../src/sdk/core/contracts.js';
import type { ImportBatch } from '../../src/requirements/model.js';
import { dashboardStrings } from '../../src/sdk/ui/dashboard-i18n.js';
import { emptyRecordingsUi } from '../../src/sdk/ui/dashboard-recordings.js';
import { emptyAccessUi } from '../../src/sdk/ui/dashboard-access.js';
import { connectorOfFile, emptyImportForm, emptyLinkForm } from '../../src/sdk/ui/dashboard-requirements.js';
import { activeNav, renderDashboard, type DashboardState } from '../../src/sdk/ui/dashboard-view.js';

/**
 * LES ÉCRANS DES EXIGENCES (fonctions pures) : sources et imports (secrets par leur nom), validation
 * d'un import (raisons, confiance en classe, conflit à fusionner, lecture partielle à accepter
 * explicitement), référentiel, matrice, indicateurs (formules, indisponible sans corrélation),
 * tendances (rien avant la première publication). L'élément dans Chromium : sdk-dashboard-requirements.
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
  counts: { environments: 0, scenarios: 0, recordings: 0, executions: 0 },
  draft: {},
  environments: [],
  scenarios: [],
} as unknown as ProjectDetail;

const base = (
  extra: Partial<DashboardState> = {},
  req: Partial<DashboardState['req']> = {},
): DashboardState => ({
  t,
  phase: 'ready',
  route: { view: 'overview' },
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
  req: { form: emptyImportForm(), kind: 'ALL', source: 'ALL', weeks: 8, ...req },
  signIn: false,
  access: emptyAccessUi(),
  recs: emptyRecordingsUi(),
  lib: emptyLibraryUi(),
  ...extra,
});

const source = {
  kind: 'WORD',
  sourceId: 'word:spec.docx',
  title: 'Spécification',
  location: { block: 3, section: ['Exigences'] },
  importedAt: at,
  fingerprint: 'f',
};

const batch: ImportBatch = {
  id: 'imp_abcdef12',
  connector: 'WORD',
  status: 'PARTIAL',
  createdAt: at,
  updatedAt: at,
  source: { sourceId: 'word:spec.docx', title: 'Spécification <b>v2</b>' },
  completeness: 'PARTIAL',
  items: [
    {
      id: 'itm_0001',
      kind: 'REQUIREMENT',
      confidence: 'HIGH',
      reasons: ['explicit identifier REQ-501'],
      externalId: 'REQ-501',
      title: 'Enregistrer une demande',
      description: 'Le système doit enregistrer une demande.',
      attributes: {},
      source,
      duplicate: { status: 'NEW' },
      decision: { action: 'ACCEPT', at },
    },
    {
      id: 'itm_0002',
      kind: 'REQUIREMENT',
      confidence: 'HIGH',
      reasons: ['explicit identifier REQ-77'],
      externalId: 'REQ-77',
      title: 'Archiver',
      description: 'Archiver',
      attributes: {},
      source,
      duplicate: { status: 'SAME_ID_OTHER_SOURCE', entityId: 'req_x' },
    },
    {
      id: 'itm_0003',
      kind: 'UNCLASSIFIED',
      confidence: 'LOW',
      reasons: ['normative verb'],
      title: 'Le délai doit être court',
      description: 'Le délai doit être court',
      attributes: {},
      source,
      duplicate: { status: 'NEW' },
    },
  ],
  issues: [{ severity: 'WARNING', code: 'IMAGE', message: 'Image non lue', location: { block: 9, page: 4 } }],
  missingFromSource: ['req_old'],
};

describe('dashboard — requirements screens', () => {
  it('menu: the requirements and measure sections, with the count of candidates waiting for a decision', () => {
    const repository: RequirementsView = { entities: [], links: [], pending: 6 };
    const html = renderDashboard(base({}, { repository }));
    expect(html).toContain('>Exigences<');
    expect(html).toContain('>Mesurer<');
    expect(html).toContain('data-view="traceability"');
    expect(html).toContain('<span class="badge"');
    expect(html).toMatch(/class="badge"[^>]*>6</);
    expect(activeNav({ view: 'import', projectId: 'prj_a', batchId: batch.id })).toBe('sources');
    expect(activeNav({ view: 'trends' })).toBe('trends');
  });

  it('sources: connectors with their limits, Confluence secrets by name only, the import history', () => {
    const connectors: RequirementConnectorView[] = [
      {
        kind: 'CONFLUENCE',
        label: 'Confluence',
        formats: ['storage'],
        maxBytes: 5 * 1024 * 1024,
        capabilities: {
          headings: true,
          lists: true,
          tables: true,
          pages: false,
          versions: true,
          refresh: true,
          ocr: false,
        },
        limits: ['include macros are not read'],
        transport: 'CONFLUENCE',
      },
    ];
    const imports: ImportSummary[] = [
      {
        id: batch.id,
        connector: 'WORD',
        status: 'VALIDATION_REQUIRED',
        createdAt: at,
        updatedAt: at,
        source: { title: 'Spécification <b>v2</b>' },
        completeness: 'COMPLETE',
        candidates: 3,
        toDecide: 2,
        decided: 1,
        published: 0,
        byDuplicate: { NEW: 2 },
        issues: { errors: 0, warnings: 1, first: 'Image non lue' },
        missingFromSource: 0,
      },
    ];
    const route = { view: 'sources', projectId: 'prj_a' } as const;
    const html = renderDashboard(
      base(
        { route },
        {
          connectors,
          imports,
          form: { ...emptyImportForm(), source: 'CONFLUENCE', tokenEnv: 'QA_WIKI_TOKEN' },
        },
      ),
    );
    expect(html).toContain('5 Mo au plus');
    expect(html).toContain('include macros are not read');
    expect(html).toContain('data-req="tokenEnv" value="QA_WIKI_TOKEN"');
    expect(html).toContain('le serveur le lit dans la variable nommée');
    expect(html).not.toContain('type="password"');
    expect(html).toContain('Word · Spécification &lt;b&gt;v2&lt;/b&gt;');
    expect(html).toContain('3 candidat(s) · 2 à décider · 0 publié(s)');
    expect(html).toContain('>À valider<');
    const file = renderDashboard(base({ route }, { connectors, imports }));
    expect(file).toContain('type="file" data-req="file" accept=".docx,.xlsx,.pdf"');
    const archived = renderDashboard(
      base({ route, project: { ...project, state: 'ARCHIVED' } }, { connectors, imports }),
    );
    expect(archived).not.toContain('data-action="import"');
  });

  it('a file is matched to its connector by extension only', () => {
    expect(connectorOfFile('Spec.DOCX')).toBe('WORD');
    expect(connectorOfFile('liste.xlsx')).toBe('EXCEL');
    expect(connectorOfFile('annexe.pdf')).toBe('PDF');
    expect(connectorOfFile('ancien.doc')).toBeUndefined();
  });

  it('validation: reasons and confidence class, a conflict only merges, a partial read needs explicit agreement', () => {
    const route = { view: 'import', projectId: 'prj_a', batchId: batch.id } as const;
    const html = renderDashboard(base({ route }, { batch }));
    expect(html).toContain('Pourquoi : explicit identifier REQ-501');
    expect(html).toContain('Confiance élevée');
    expect(html).toContain('Décision : acceptée (modifiable jusqu’à la publication)');
    // Le conflit d'identifiant ne s'accepte pas : il se fusionne ou se refuse.
    const conflict = html.slice(html.indexOf('REQ-77'), html.indexOf('itm_0003'));
    expect(conflict).toContain('Fusionner dans req_x');
    expect(conflict).not.toContain('data-decision="ACCEPT"');
    // Non classé : le type est choisi avant d'accepter.
    expect(html).toContain('<select data-kind-for="itm_0003">');
    expect(html).toContain('Spécification &lt;b&gt;v2&lt;/b&gt;');
    expect(html).toContain('lecture partielle');
    expect(html).toContain('Publier 1 décision(s)');
    expect(html).not.toContain('data-action="publish-confirm"');
    expect(renderDashboard(base({ route, confirm: 'publish-partial' }, { batch }))).toContain(
      'Publier malgré la lecture partielle',
    );
    expect(html).toContain('Image non lue');
    expect(html).toContain('page 4');
    expect(html).toContain('<code>req_old</code>');
    expect(html).toContain('Mode à jeton unique : l’auteur des décisions n’est pas enregistré');
    // En mode nominatif, la décision est signée : la note disparaît.
    expect(
      renderDashboard(
        base(
          { route, me: { id: 'm', name: 'N', kind: 'MEMBER', role: 'ADMIN', rights: [], mode: 'named' } },
          { batch },
        ),
      ),
    ).not.toContain('Mode à jeton unique');
  });

  const entity = {
    id: 'req_1',
    kind: 'REQUIREMENT',
    externalId: 'REQ-501',
    title: 'Enregistrer une demande',
    description: 'Le système doit enregistrer une demande.',
    sources: [source],
    version: 2,
    history: [
      { version: 1, at, change: 'CREATED', batchId: batch.id, fingerprint: 'a' },
      {
        version: 2,
        at,
        change: 'UPDATED',
        batchId: batch.id,
        fingerprint: 'b',
        previous: { title: 'Ancien titre', description: '' },
      },
    ],
    createdAt: at,
    updatedAt: at,
    validation: 'VALIDATED',
    type: 'FUNCTIONAL',
    dependsOn: [],
  } as unknown as RequirementsView['entities'][number];
  const link = {
    id: 'lnk_abcdef',
    type: 'TESTED_BY',
    from: { kind: 'REQUIREMENT', id: 'req_1' },
    to: { kind: 'TEST', id: 'create-request' },
    origin: 'ANALYSIS',
    justification: ['the scenario saves a request'],
    confidence: 'MEDIUM',
    validation: 'PROPOSED',
    freshness: 'POSSIBLY_STALE',
    decisions: [{ action: 'PROPOSE', at }],
    createdAt: at,
    updatedAt: at,
  } as RequirementsView['links'][number];
  const repository: RequirementsView = { entities: [entity], links: [link], pending: 0 };

  it('repository: an item with its provenance, history, links to confirm, and a link form', () => {
    const route = { view: 'requirements', projectId: 'prj_a', entityId: 'req_1' } as const;
    const html = renderDashboard(base({ route }, { repository }));
    expect(html).toContain('1 élément(s) publié(s) · 0 candidat(s) en attente de décision');
    expect(html).toContain('<li><b>Word</b> · Spécification<small class="mu block">Exigences</small></li>');
    expect(html).toContain('Mise à jour');
    expect(html).toContain('Ancien titre');
    expect(html).toContain('testé par <code>TEST:create-request</code>');
    expect(html).toContain('possiblement périmé');
    expect(html).toContain('data-action="link-decide" data-link="lnk_abcdef" data-decision="CONFIRM"');
    expect(html).toContain('Justification : the scenario saves a request · Confiance moyenne');
    expect(html).toContain('data-action="link-open"');
    expect(renderDashboard(base({ route }, { repository, linkForm: emptyLinkForm() }))).toContain(
      'data-action="link-add"',
    );
    const none = renderDashboard(base({ route }, { repository, kind: 'BUSINESS_RULE' }));
    expect(none).toContain('Aucun élément de ce type et de cette source.');
    expect(
      renderDashboard(
        base(
          { route: { view: 'requirements', projectId: 'prj_a' } },
          { repository: { entities: [], links: [], pending: 2 } },
        ),
      ),
    ).toContain('Rien de publié');
  });

  it('matrix: one row per item, links by role, the correlation said unavailable, CSV export offered', () => {
    const matrix: MatrixRow[] = [
      {
        id: 'req_1',
        externalId: 'REQ-501',
        kind: 'REQUIREMENT',
        title: 'Enregistrer une demande',
        version: 2,
        sources: ['WORD'],
        children: [],
        implementedBy: [],
        verifiedBy: [
          {
            linkId: 'lnk_abcdef',
            type: 'TESTED_BY',
            target: { kind: 'TEST', id: 'create-request' },
            validation: 'PROPOSED',
            freshness: 'CURRENT',
            confidence: 'MEDIUM',
          },
        ],
        other: [],
      },
    ];
    const html = renderDashboard(
      base({ route: { view: 'traceability', projectId: 'prj_a' } }, { repository, matrix }),
    );
    expect(html).toContain('<span class="mx prop" title="proposé"><code>create-request</code></span>');
    expect(html).toContain(
      'La corrélation automatique avec le code, les tests et les preuves n’est pas encore disponible',
    );
    expect(html).toContain('data-action="export-csv"');
    expect(
      renderDashboard(
        base({ route: { view: 'traceability', projectId: 'prj_a' } }, { repository, matrix, source: 'PDF' }),
      ),
    ).toContain('Aucun élément de ce type et de cette source.');
  });

  it('indicators: each figure with its formula and denominator; no value without a denominator; evidence unavailable', () => {
    const indicators: RequirementsIndicators = {
      generatedAt: at,
      period: { days: 7, from: at, to: at },
      published: { total: 4, requirements: 2, rules: 1, criteria: 1 },
      coverage: { numerator: 1, denominator: 4, value: 0.25, proposedOnly: 1 },
      recentEvidence: { available: false, reason: 'CORRELATION_NOT_AVAILABLE' },
      replays: { numerator: 0, denominator: 0, cancelled: 2, withoutVerdict: 0 },
      links: {
        numerator: 2,
        denominator: 3,
        value: 2 / 3,
        confirmed: 2,
        proposed: 1,
        possiblyStale: 1,
        rejected: 1,
      },
      gaps: { withoutImplementation: 4, withoutTest: 2, staleLinks: 1, pendingCandidates: 3 },
    };
    const html = renderDashboard(base({ route: { view: 'indicators', projectId: 'prj_a' } }, { indicators }));
    expect(html).toContain('<b class="big">25 %</b><small>1 / 4</small>');
    expect(html).toContain(
      'éléments avec au moins un lien TESTED_BY ou VERIFIED_BY confirmé ÷ éléments publiés',
    );
    expect(html).toContain('liens seulement proposés (1 élément(s))');
    expect(html).toContain('<b class="big">—</b><small>0 / 0</small>');
    expect(html).toContain('0 rejeu(x) terminé(s) sur 7 jour(s) (aucun élément au dénominateur)');
    expect(html).toContain('rejeux annulés (2)');
    expect(html).toContain('Non disponible : cet indicateur demande la corrélation');
    expect(html).toContain('<b class="big">67 %</b><small>2 / 3</small>');
    expect(html).toContain('<b>3</b><span>candidats d’import en attente de décision</span>');
  });

  it('trends: weeks with their values; a week without replay or before the first publication has none', () => {
    const empty = { CRITICAL: 0, ERROR: 0, WARNING: 0, INFO: 0 };
    const trends: TrendsView = {
      generatedAt: at,
      weeks: [
        { week: '2026-W43', from: at, to: at, replays: { numerator: 0, denominator: 0 }, issues: empty },
        {
          week: '2026-W44',
          from: at,
          to: at,
          replays: { numerator: 3, denominator: 4, value: 0.75 },
          issues: { ...empty, CRITICAL: 2 },
          medianReplayMs: 3400,
          coverage: { numerator: 1, denominator: 2, value: 0.5 },
        },
      ],
      unstable: [{ projectId: 'prj_a', projectName: 'Demandes', name: 'search', flips: 3, runs: 10 }],
    };
    const html = renderDashboard(base({ route: { view: 'trends', projectId: 'prj_a' } }, { trends }));
    expect(html).toContain('aria-label="S43 : aucun rejeu"');
    expect(html).toContain('aria-label="S44 : 75 % (3 / 4)"');
    // Un taux se dessine sur 0 à 100 %, pas par rapport à la meilleure semaine.
    expect(html).toContain('<span class="p" style="height:75%"></span><b class="v">75 %</b>');
    expect(html).toContain('aria-label="S44 : 2 Critique, 0 Erreur, 0 Avertissement, 0 Info"');
    expect(html).toContain('aria-label="S44 : 3.4 s"');
    expect(html).toContain('aria-label="S43 : —"');
    expect(html).toContain('aria-label="S44 : 50 % (1 / 2)"');
    expect(html).toContain(
      '<code>search</code> <span class="mu">· Demandes · 3 bascule(s) sur 10 run(s)</span>',
    );
    expect(html).toContain('Demandes · 8 dernières semaines');
    expect(
      renderDashboard(
        base(
          { route: { view: 'trends' }, projectId: '' },
          { trends: { ...trends, weeks: trends.weeks.slice(0, 1), unstable: [] } },
        ),
      ),
    ).toContain('Aucune exigence publiée sur la période.');
  });
});
