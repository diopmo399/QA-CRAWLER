import { describe, expect, it } from 'vitest';
import type {
  CodeIndex,
  Diagnosis,
  Experiment,
  Hypothesis,
  Incident,
  InvestigationReport,
  InvestigationScope,
  RegressionTestProposal,
  ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import {
  confidenceLabel,
  confirmationProgress,
  DIAGNOSIS_OPERATIONS,
  emptyDiagnosisUi,
  INCIDENT_DIAGNOSIS_CSS,
  planInputOf,
  reduceDiagnosis,
  regressionVerdict,
  renderDiagnosis,
  renderExperimentDetail,
  renderExperiments,
  renderHypotheses,
  renderHypothesisDetail,
  renderRegression,
  renderReport,
  sortHypotheses,
  type DiagnosisUi,
} from '../../src/sdk/ui/incident-diagnosis.js';
import { workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type Lang, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';

/**
 * LE DIAGNOSTIC DE L'ESPACE D'INVESTIGATION : jamais « Cause racine confirmée » sans diagnostic
 * CONFIRMED, une confiance lisible par un lecteur d'écran, les preuves favorables et contraires côte à
 * côte, les droits (lecteur sans action, approbation réservée à RUN_WRITES), les refus du périmètre avec
 * leur règle et leur raison, le verdict de non-régression jamais « Réussi » sans exécution réelle, les
 * exports du rapport, le réducteur pur et l'échappement.
 */
const at = '2026-10-30T09:00:00.000Z';
const BOOK_SERVICE = 'src/main/java/org/example/catalog/books/CatalogBookService.java';
const SYMBOL_ID = `backend:${BOOK_SERVICE}#CatalogBookService.register`;

const scope: InvestigationScope = {
  mode: 'GUIDED',
  applications: [
    {
      id: 'backend',
      name: 'Catalogue',
      layer: 'BACKEND',
      repository: { root: '/repos/catalog', include: ['src/main/java'] },
    },
  ],
  scenarios: ['Créer un livre'],
  steps: [],
  endpoints: ['POST /api/books'],
  depth: 3,
  allowedHosts: ['books.test'],
  logRoots: [],
  allowedCommands: [],
  permissions: {
    readSources: true,
    navigate: true,
    httpRequests: 'READ_ONLY',
    runTests: 'UNIT',
    localCommands: false,
    readLogs: false,
    openshift: 'NONE',
    sideEffects: false,
  },
  limits: {
    maxFiles: 2000,
    maxFileBytes: 524288,
    maxDurationMs: 600000,
    maxRequests: 200,
    maxExperiments: 20,
  },
  extensions: [],
};

const reproduction: ReproductionRun = {
  id: 'rep_1',
  startedAt: at,
  finishedAt: at,
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'Créer un livre',
  reproduced: true,
  actions: [
    {
      index: 1,
      kind: 'click',
      description: 'Cliquer sur Enregistrer',
      status: 'PASSED',
      durationMs: 120,
      requestIds: ['req_1'],
    },
  ],
  requests: [
    {
      id: 'req_1',
      method: 'POST',
      url: '/api/books',
      path: '/api/books',
      status: 500,
      resourceType: 'fetch',
      step: 1,
      correlation: 'OBSERVED',
      responseBody: '{"status":500}',
    },
  ],
  evidence: [{ id: 'rep_1:ev1', kind: 'JS_ERROR', summary: 'Erreur affichée', source: { step: 1 } }],
  screenshots: [],
};

const code: CodeIndex = {
  applications: [{ id: 'backend', layer: 'BACKEND', files: 1, skipped: 0 }],
  symbols: [
    {
      id: SYMBOL_ID,
      applicationId: 'backend',
      layer: 'BACKEND',
      kind: 'SERVICE',
      name: 'CatalogBookService.register',
      file: BOOK_SERVICE,
      line: 42,
    },
  ],
  endpoints: [],
  outgoing: [],
  calls: [],
  denied: [],
  truncated: [],
};

const hypothesis = (over: Partial<Hypothesis> = {}): Hypothesis => ({
  id: 'hyp-null-relation',
  title: 'Éditeur absent non validé',
  description: 'publisherId vide arrive jusqu’au backend',
  suspectedCause: 'book.getPublisher().getName() sur un éditeur absent',
  layer: 'BACKEND',
  files: [BOOK_SERVICE, 'web/src/app/book-form.component.ts'],
  supporting: [
    { ref: 'req_1', fact: 'Réponse 500 sur POST /api/books' },
    { ref: SYMBOL_ID, fact: 'Déréférencement sans contrôle' },
    { ref: 'experiment:REPLAY:exp_done', fact: 'REPLAY SUPPORTS : symptôme reproduit' },
  ],
  contradicting: [{ ref: 'note-libre', fact: 'Le champ est parfois rempli' }],
  confidence: 0.6,
  verifications: [
    {
      kind: 'COMPARE_WITH_PASSING',
      description: 'Comparer avec un éditeur choisi',
      params: { field: 'publisherId' },
    },
  ],
  status: 'SUPPORTED',
  ...over,
});

const experiment = (over: Partial<Experiment> = {}): Experiment => ({
  id: 'exp_1',
  kind: 'INTEGRATION_TEST',
  hypothesisId: 'hyp-null-relation',
  description: 'Créer un livre sans éditeur contre le backend',
  params: { command: 'mvn', args: ['test', '-Dtest=CatalogBookServiceTest'] },
  status: 'APPROVAL_REQUIRED',
  sideEffects: true,
  decisions: [],
  evidence: [],
  ...over,
});

const incidentOf = (
  over: Partial<Incident> = {},
  investigation: Partial<Incident['investigation']> = {},
): Incident => ({
  id: 'inc_abc123def456',
  projectId: 'prj_books',
  title: 'Erreur 500 à la création d’un livre',
  description: 'Après Enregistrer, une erreur HTTP 500 apparaît.',
  observed: 'erreur HTTP 500 après Enregistrer',
  expected: 'le livre est créé',
  severity: 'HIGH',
  scenario: 'Créer un livre',
  environmentId: 'env_test',
  execution: { target: 'LOCAL' },
  scope,
  state: 'REPRODUCED',
  revision: 4,
  createdAt: at,
  updatedAt: at,
  createdBy: 'analyste',
  history: [],
  investigation: {
    reproductions: [reproduction],
    code,
    hypotheses: [hypothesis()],
    experiments: [
      experiment({
        id: 'exp_done',
        kind: 'REPLAY',
        status: 'DONE',
        sideEffects: false,
        outcome: 'SUPPORTS',
        summary: 'Symptôme reproduit',
        evidence: [{ id: 'exp_done:ev1', kind: 'EXPERIMENT', summary: 'HTTP 500 de nouveau', source: {} }],
      }),
    ],
    ...investigation,
  },
  ...over,
});

type Right = 'RUN' | 'DECIDE' | 'PUBLISH' | 'RUN_WRITES';
const ALL: Right[] = ['RUN', 'DECIDE', 'PUBLISH', 'RUN_WRITES'];

const ctxOf = (
  incident: Incident,
  options: { rights?: Right[]; lang?: Lang; selection?: WorkspaceSelection; demo?: boolean } = {},
): WorkspaceContext => {
  const rights = options.rights ?? ALL;
  return workspaceContext({
    incident,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(incident),
    demo: options.demo ?? false,
    can: (right) => rights.includes(right),
    ...(options.selection ? { selection: options.selection } : {}),
  });
};

const ui = (over: Partial<DiagnosisUi> = {}): DiagnosisUi => ({ ...emptyDiagnosisUi(), ...over });

const diagnosis = (over: Partial<Diagnosis> = {}): Diagnosis => ({
  status: 'PROBABLE',
  rootCause: {
    hypothesisId: 'hyp-null-relation',
    statement: 'Déréférencement de l’éditeur absent',
    layer: 'BACKEND',
    files: [BOOK_SERVICE],
  },
  alternatives: [{ hypothesisId: 'hyp-other', statement: 'Validation absente côté BFF', confidence: 0.3 }],
  missing: ['Une seconde vérification d’une autre sorte est nécessaire.'],
  recommendations: ['Vérifier la relation avant de la déréférencer.'],
  generatedAt: at,
  ...over,
});

const regression = (over: Partial<RegressionTestProposal> = {}): RegressionTestProposal => ({
  name: 'Créer un livre sans éditeur',
  basedOn: 'Créer un livre',
  flowYaml: 'name: Créer un livre sans éditeur\nsteps:\n  - click: "<Enregistrer>"\n',
  expected: 'Un message clair, pas d’erreur 500',
  status: 'PROPOSED',
  ...over,
});

describe('incident-diagnosis : diagnostic', () => {
  it('never titles the cause « Cause racine confirmée » when the diagnosis is PROBABLE', () => {
    const html = renderDiagnosis(ctxOf(incidentOf({}, { diagnosis: diagnosis() })), ui());
    expect(html).not.toContain('Cause racine confirmée');
    expect(html).toContain('Cause probable, non confirmée');
    expect(html).toContain('>Cause probable</h3>');
    expect(html).toContain('data-status="PROBABLE"');
    expect(html).not.toContain('data-status="CONFIRMED"');
    expect(html).toContain('Déréférencement de l’éditeur absent');
    // Les fichiers de la cause mènent au code (fichier déclaré par l'index de code).
    expect(html).toContain('data-action="ws-code" data-app="backend"');
    expect(html).toContain('Ce qui manque pour conclure');
    expect(html).toContain('Une seconde vérification d’une autre sorte est nécessaire.');
    expect(html).toContain('Vérifier la relation avant de la déréférencer.');
    expect(html).toContain('aria-label="Confiance : 30 % (faible)"');
  });

  it('never titles the cause « Cause racine confirmée » when the diagnosis is INCONCLUSIVE', () => {
    const without = renderDiagnosis(
      ctxOf(incidentOf({}, { diagnosis: diagnosis({ status: 'INCONCLUSIVE', rootCause: undefined }) })),
      ui(),
    );
    expect(without).not.toContain('Cause racine confirmée');
    expect(without).toContain('>Aucune cause établie</h3>');
    expect(without).toContain('Diagnostic inconclusif');
    // Même si un diagnostic inconclusif portait une piste, elle n'est ni confirmée ni « probable ».
    const lead = renderDiagnosis(
      ctxOf(incidentOf({}, { diagnosis: diagnosis({ status: 'INCONCLUSIVE' }) })),
      ui(),
    );
    expect(lead).not.toContain('Cause racine confirmée');
    expect(lead).not.toContain('>Cause probable</h3>');
    expect(lead).toContain('>Aucune cause établie</h3>');
    expect(lead).toContain('Piste la plus avancée, non établie');
    const english = renderDiagnosis(ctxOf(incidentOf({}, { diagnosis: diagnosis() }), { lang: 'en' }), ui());
    expect(english).not.toContain('Confirmed root cause');
    expect(english).toContain('Probable cause, not confirmed');
  });

  it('shows « Cause racine confirmée » only for a CONFIRMED diagnosis with a root cause', () => {
    const html = renderDiagnosis(
      ctxOf(incidentOf({}, { diagnosis: diagnosis({ status: 'CONFIRMED', missing: [] }) })),
      ui(),
    );
    expect(html).toContain('>Cause racine confirmée</h3>');
    expect(html).toContain('data-status="CONFIRMED"');
    expect(html).toContain('>Confirmé</span>');
    const noRoot = renderDiagnosis(
      ctxOf(incidentOf({}, { diagnosis: diagnosis({ status: 'CONFIRMED', rootCause: undefined }) })),
      ui(),
    );
    expect(noRoot).not.toContain('>Cause racine confirmée</h3>');
  });

  it('offers « Rediagnostiquer » to RUN only, disabled with its reason when the incident cannot be investigated', () => {
    const incident = incidentOf({}, { diagnosis: diagnosis() });
    expect(renderDiagnosis(ctxOf(incident), ui())).toContain('data-action="ws-dx-diagnose"');
    expect(renderDiagnosis(ctxOf(incident), ui())).toContain('Rediagnostiquer');
    expect(renderDiagnosis(ctxOf(incident, { rights: [] }), ui())).not.toContain('ws-dx-diagnose');
    const draft = renderDiagnosis(ctxOf(incidentOf({ state: 'DRAFT' }, { diagnosis: diagnosis() })), ui());
    expect(draft).toMatch(/data-action="ws-dx-diagnose"[^>]* disabled aria-describedby="ws-dx-diag-why"/);
    expect(draft).toContain('id="ws-dx-diag-why"');
  });

  it('shows the demo banner on demonstration data', () => {
    const html = renderDiagnosis(ctxOf(incidentOf({}, { diagnosis: diagnosis() }), { demo: true }), ui());
    expect(html).toContain('Données de démonstration');
  });
});

describe('incident-diagnosis : hypothèses', () => {
  it('gives the confidence bar an accessible meter and label', () => {
    const html = renderHypotheses(ctxOf(incidentOf()), ui());
    expect(html).toContain('role="meter"');
    expect(html).toContain('aria-valuenow="60"');
    expect(html).toContain('aria-valuemin="0" aria-valuemax="100"');
    expect(html).toContain('aria-label="Confiance : 60 % (moyenne)"');
    expect(html).toContain('>60 %</b>');
    expect(confidenceLabel(0.6, 'fr')).toBe('Confiance : 60 % (moyenne)');
    expect(confidenceLabel(0.9, 'en')).toBe('Confidence: 90% (high)');
    expect(confidenceLabel(1.7, 'fr')).toBe('Confiance : 100 % (élevée)');
    expect(confidenceLabel(Number.NaN, 'fr')).toBe('Confiance : 0 % (faible)');
  });

  it('renders supporting and contradicting evidence side by side, with selectable references', () => {
    const html = renderHypotheses(ctxOf(incidentOf()), ui({ expanded: ['hyp-null-relation'] }));
    const pro = html.indexOf('ws-dx-side-pro');
    const con = html.indexOf('ws-dx-side-con');
    expect(pro).toBeGreaterThan(0);
    expect(con).toBeGreaterThan(pro);
    expect(html).toContain('Preuves favorables (3)');
    expect(html).toContain('Preuves contraires (1)');
    const supporting = html.slice(pro, con);
    expect(supporting).toContain('Réponse 500 sur POST /api/books');
    expect(supporting).toContain('data-kind="request" data-ref="req_1"');
    expect(supporting).toContain(`data-kind="symbol" data-ref="${SYMBOL_ID}"`);
    expect(supporting).toContain('data-line="42"');
    expect(supporting).toContain('data-kind="experiment" data-ref="exp_done"');
    const contradicting = html.slice(con);
    expect(contradicting).toContain('Le champ est parfois rempli');
    expect(contradicting).toContain('<code class="ws-dx-ref"');
    expect(contradicting).toContain('note-libre');
    // Fichiers : lien vers le code quand l'index le connaît, chemin seul sinon.
    expect(html).toContain(`data-file="${BOOK_SERVICE}"`);
    expect(html).toContain('<code class="ws-dx-file" title="Fichier absent de l’index de code');
    // Avancement vers la confirmation (une seule nature de vérification, une preuve contraire).
    expect(html).toContain('Deux vérifications favorables de natures différentes (1 sur 2)');
    expect(html).toContain('Aucune preuve contraire (1 à lever)');
    expect(html).toContain('aria-expanded="true"');
  });

  it('keeps a collapsed hypothesis body out of the page and explains the confirmation rule', () => {
    const html = renderHypotheses(ctxOf(incidentOf()), ui());
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('hidden');
    expect(html).not.toContain('ws-dx-side-pro');
    expect(html).toContain('Quand une hypothèse est-elle confirmée ?');
    expect(html).toContain('deux vérifications favorables de natures différentes, dont une dynamique');
    expect(html).toContain('aucune preuve contraire');
    expect(html).toContain('data-action="ws-select" data-kind="hypothesis" data-ref="hyp-null-relation"');
  });

  it('shows Plan only with RUN, disabled with its reason when the incident cannot be investigated', () => {
    const expanded = ui({ expanded: ['hyp-null-relation'] });
    const runner = renderHypotheses(ctxOf(incidentOf(), { rights: ['RUN'] }), expanded);
    expect(runner).toContain('data-action="ws-dx-plan" data-hypothesis="hyp-null-relation" data-index="0"');
    expect(runner).not.toMatch(/data-action="ws-dx-plan"[^>]* disabled/);
    const reader = renderHypotheses(ctxOf(incidentOf(), { rights: [] }), expanded);
    expect(reader).not.toContain('ws-dx-plan');
    expect(reader).not.toContain('ws-dx-analyze');
    const draft = renderHypotheses(ctxOf(incidentOf({ state: 'DRAFT' }), { rights: ['RUN'] }), expanded);
    expect(draft).toMatch(
      /data-action="ws-dx-plan"[^>]* disabled aria-describedby="ws-dx-h-why-hyp-null-relation"/,
    );
    expect(draft).toContain('Disponible une fois l’incident délimité');
    // Pendant une autre opération, le bouton attend.
    const busy = renderHypotheses(
      ctxOf(incidentOf(), { rights: ['RUN'] }),
      ui({ ...expanded, busy: 'ws-dx-diagnose' }),
    );
    expect(busy).toMatch(/data-action="ws-dx-plan"[^>]* disabled title="Une opération est en cours\."/);
  });

  it('sorts by confidence or by status', () => {
    const list = [
      hypothesis({ id: 'a', confidence: 0.2, status: 'CONFIRMED' }),
      hypothesis({ id: 'b', confidence: 0.9, status: 'PROPOSED' }),
      hypothesis({ id: 'c', confidence: 0.5, status: 'REFUTED' }),
    ];
    expect(sortHypotheses(list, 'confidence').map((entry) => entry.id)).toEqual(['b', 'c', 'a']);
    expect(sortHypotheses(list, 'status').map((entry) => entry.id)).toEqual(['a', 'b', 'c']);
    const html = renderHypotheses(ctxOf(incidentOf({}, { hypotheses: list })), ui({ sort: 'status' }));
    expect(html.indexOf('data-hypothesis="a"')).toBeLessThan(html.indexOf('data-hypothesis="b"'));
    expect(html).toContain('data-sort="status" aria-pressed="true"');
  });

  it('counts confirmation progress from experiment references only', () => {
    expect(confirmationProgress(hypothesis())).toEqual({
      kinds: 1,
      verifications: 1,
      dynamic: true,
      contrary: 1,
    });
    expect(
      confirmationProgress(
        hypothesis({
          supporting: [
            { ref: 'experiment:CHECK_VALIDATION:e1', fact: 'a' },
            { ref: 'experiment:COMPARE_REQUESTS:e2', fact: 'b' },
          ],
          contradicting: [],
        }),
      ),
    ).toEqual({ kinds: 2, verifications: 2, dynamic: true, contrary: 0 });
  });

  it('highlights the selected hypothesis and what is related to it', () => {
    const html = renderHypotheses(
      ctxOf(incidentOf(), { selection: { kind: 'hypothesis', id: 'hyp-null-relation' } }),
      ui({ expanded: ['hyp-null-relation'] }),
    );
    expect(html).toContain('ws-dx-hyp ws-selected');
    expect(html).toMatch(
      /class="ws-chip ws-related" data-action="ws-select" data-kind="request" data-ref="req_1"/,
    );
  });
});

describe('incident-diagnosis : expériences', () => {
  it('lists experiments with status, outcome, summary and evidence chips', () => {
    const html = renderExperiments(ctxOf(incidentOf()), ui());
    expect(html).toContain('Rejouer le scénario');
    expect(html).toContain('>Terminée</span>');
    expect(html).toContain('>Étaye l’hypothèse</span>');
    expect(html).toContain('Symptôme reproduit');
    expect(html).toContain('data-kind="evidence" data-ref="exp_done:ev1"');
    expect(html).toContain('data-kind="hypothesis" data-ref="hyp-null-relation"');
  });

  it('shows the rule and the reason of a refused operation, without a Run button', () => {
    const refused = experiment({
      id: 'exp_ref',
      kind: 'COMPARE_WITH_PASSING',
      status: 'REFUSED',
      sideEffects: false,
      decisions: [
        {
          allowed: false,
          rule: 'scope.hosts.allowed',
          reason: 'hôte <evil.test> hors des hôtes autorisés',
          operation: { kind: 'NAVIGATE', url: 'http://evil.test/' },
          extension: { kind: 'ADD_HOST', target: 'evil.test' },
        },
        {
          allowed: true,
          rule: 'scope.read',
          reason: 'lecture permise',
          operation: { kind: 'READ_LOG', path: '/x' },
        },
      ],
    });
    const html = renderExperiments(ctxOf(incidentOf({}, { experiments: [refused] })), ui());
    expect(html).toContain('>Refusée</span>');
    expect(html).toContain('1 opération(s) refusée(s) par le périmètre');
    expect(html).toContain('<code>scope.hosts.allowed</code>');
    expect(html).toContain('hôte &lt;evil.test&gt; hors des hôtes autorisés');
    expect(html).toContain('Extension qui la rendrait possible : ADD_HOST evil.test');
    expect(html).toContain('1 opération(s) autorisée(s)');
    expect(html).not.toContain('data-action="ws-dx-run"');
  });

  it('renders every experiment status', () => {
    const statuses = [
      'PROPOSED',
      'REFUSED',
      'APPROVAL_REQUIRED',
      'RUNNING',
      'DONE',
      'ERROR',
      'CANCELLED',
    ] as const;
    const html = renderExperiments(
      ctxOf(
        incidentOf(
          {},
          {
            experiments: statuses.map((status) =>
              experiment({ id: `e_${status}`, status, sideEffects: false }),
            ),
          },
        ),
      ),
      ui(),
    );
    for (const label of [
      'Planifiée',
      'Refusée',
      'Approbation requise',
      'En cours',
      'Terminée',
      'Erreur',
      'Annulée',
    ])
      expect(html).toContain(`>${label}</span>`);
    expect(html).toContain('aria-busy="true"');
  });

  it('asks for approval in the page, approvable only with RUN_WRITES, never with confirm()', () => {
    const incident = incidentOf({}, { experiments: [experiment()] });
    const closed = renderExperiments(ctxOf(incident, { rights: ['RUN'] }), ui());
    expect(closed).toContain('data-action="ws-dx-run" data-experiment="exp_1" data-approval="required"');
    expect(closed).toContain('Examiner avant d’exécuter');
    const runnerOnly = renderExperiments(ctxOf(incident, { rights: ['RUN'] }), ui({ approving: 'exp_1' }));
    expect(runnerOnly).toContain('role="group"');
    expect(runnerOnly).toContain('Approuver une vérification avec effets de bord');
    expect(runnerOnly).toContain('modifier des données');
    expect(runnerOnly).toContain('Approuver demande le droit de permettre les écritures');
    expect(runnerOnly).toContain('Le périmètre n’autorise pas encore les effets de bord');
    expect(runnerOnly).not.toContain('data-action="ws-dx-approve"');
    expect(runnerOnly).toContain('data-action="ws-dx-approve-cancel"');
    const writer = renderExperiments(
      ctxOf(incident, { rights: ['RUN', 'RUN_WRITES'] }),
      ui({ approving: 'exp_1' }),
    );
    expect(writer).toContain('data-action="ws-dx-approve" data-experiment="exp_1"');
    expect(writer).not.toContain('Approuver demande le droit');
    expect(writer).not.toContain('confirm(');
    const reader = renderExperiments(ctxOf(incident, { rights: [] }), ui({ approving: 'exp_1' }));
    expect(reader).not.toContain('ws-dx-run');
    expect(reader).not.toContain('ws-dx-approve');
    expect(reader).not.toContain('ws-dx-plan-submit');
  });

  it('runs an experiment without side effects directly', () => {
    const html = renderExperiments(
      ctxOf(
        incidentOf(
          {},
          { experiments: [experiment({ kind: 'REPLAY', status: 'PROPOSED', sideEffects: false })] },
        ),
      ),
      ui(),
    );
    expect(html).toMatch(
      /data-action="ws-dx-run" data-experiment="exp_1" aria-label="Exécuter la vérification/,
    );
    expect(html).not.toContain('data-approval');
  });

  it('offers a manual plan form with kind, hypothesis and key/value rows', () => {
    const html = renderExperiments(
      ctxOf(incidentOf()),
      ui({
        plan: {
          kind: 'INTEGRATION_TEST',
          hypothesisId: 'hyp-null-relation',
          params: [{ key: 'test', value: 'A<B' }],
        },
        planProblems: [{ code: 'duplicate', key: 'test', index: 0 }],
      }),
    );
    expect(html).toContain('data-action="ws-dx-plan-submit"');
    expect(html).toContain('data-ws-field="dx.kind"');
    expect(html).toContain('<option value="INTEGRATION_TEST" selected>');
    expect(html).toContain('<option value="CHECK_VALIDATION">');
    expect(html).toContain('data-ws-field="dx.hypothesisId"');
    expect(html).toContain('<option value="hyp-null-relation" selected>');
    expect(html).toContain('data-ws-field="dx.param.key" data-index="0" value="test"');
    expect(html).toContain('value="A&lt;B"');
    expect(html).toContain('data-action="ws-dx-plan-param-add"');
    expect(html).toContain('data-action="ws-dx-plan-param-remove" data-index="0"');
    expect(html).toContain('Le paramètre « test » est en double.');
    expect(html).toContain('aria-invalid="true"');
    expect(html).toContain('il attendra une approbation explicite');
    expect(html).toContain('environmentKind');
  });
});

describe('incident-diagnosis : rapport', () => {
  const report: InvestigationReport = {
    version: 1,
    generatedAt: at,
    incident: {
      id: 'inc_abc123def456',
      projectId: 'prj_books',
      title: 'Erreur <500>',
      description: 'd',
      observed: 'erreur HTTP 500',
      expected: 'le livre est créé',
      severity: 'HIGH',
      state: 'INVESTIGATING',
    },
    environment: { execution: { target: 'LOCAL' }, environmentId: 'env_test', baseUrl: 'http://books.test/' },
    scope,
    scenario: 'Créer un livre',
    timeline: [{ kind: 'ACTION', summary: 'Cliquer', ref: 'rep_1#1' }],
    requests: reproduction.requests,
    code: { files: [BOOK_SERVICE], symbols: code.symbols, denied: [], truncated: [] },
    hypotheses: [hypothesis()],
    experiments: [],
    diagnosis: diagnosis(),
    regression: regression(),
    limitations: ['Analyse du code partielle.'],
  };

  it('offers JSON and Markdown exports to everyone', () => {
    const html = renderReport(ctxOf(incidentOf(), { rights: [] }), report);
    expect(html).toContain('data-action="ws-dx-export" data-format="json"');
    expect(html).toContain('data-action="ws-dx-export" data-format="markdown"');
    expect(html).toContain('Exporter en JSON');
    expect(html).toContain('Exporter en Markdown');
  });

  it('summarises the report without inventing anything', () => {
    const html = renderReport(ctxOf(incidentOf()), report);
    expect(html).toContain('Erreur &lt;500&gt;');
    expect(html).toContain('<code>http://books.test/</code>');
    expect(html).toContain('Créer un livre');
    expect(html).toContain('Guidé');
    expect(html).toContain('<code>POST /api/books</code>');
    expect(html).toContain('requête(s) en erreur sur 1');
    expect(html).toContain('Analyse du code partielle.');
    expect(html).not.toContain('Cause racine confirmée');
    expect(html).toContain('Cause probable :');
    expect(html).toContain('>Pas encore exécuté</span>');
    expect(html).not.toContain('Réussi');
  });

  it('shows loading, error and empty states', () => {
    expect(renderReport(ctxOf(incidentOf()), undefined, { loading: true })).toContain('aria-busy="true"');
    const error = renderReport(ctxOf(incidentOf()), undefined, { error: 'Le serveur a refusé' });
    expect(error).toContain('role="alert"');
    expect(error).toContain('Le serveur a refusé');
    expect(error).toContain('data-action="ws-dx-report"');
    expect(renderReport(ctxOf(incidentOf()))).toContain('Le rapport n’est pas encore chargé.');
    expect(renderReport(ctxOf(incidentOf()), report, { exporting: 'json' })).toMatch(
      /data-format="json" disabled aria-busy="true"/,
    );
  });
});

describe('incident-diagnosis : non-régression', () => {
  it('derives the verdict from execution.passed only', () => {
    expect(regressionVerdict(regression({ execution: { run: 'r1', passed: true, at } }))).toBe('PASSED');
    expect(regressionVerdict(regression({ execution: { run: 'r1', passed: false, at } }))).toBe('FAILED');
    expect(regressionVerdict(regression())).toBe('NOT_RUN');
    expect(regressionVerdict(undefined)).toBe('NOT_RUN');
  });

  it('says « Réussi » only when execution.passed === true', () => {
    const passed = renderRegression(
      ctxOf(incidentOf({}, { regression: regression({ execution: { run: 'run-7', passed: true, at } }) })),
      ui(),
    );
    expect(passed).toContain('>Réussi</span>');
    expect(passed).toContain('Exécution run-7');
    const failed = renderRegression(
      ctxOf(incidentOf({}, { regression: regression({ execution: { run: 'run-8', passed: false, at } }) })),
      ui(),
    );
    expect(failed).toContain('>Échoué</span>');
    expect(failed).not.toContain('Réussi');
    const notRun = renderRegression(ctxOf(incidentOf({}, { regression: regression() })), ui());
    expect(notRun).toContain('>Pas encore exécuté</span>');
    expect(notRun).not.toContain('Réussi');
    expect(notRun).not.toContain('Échoué');
  });

  it('shows the proposal, a read-only YAML block and the buttons allowed by the rights', () => {
    const incident = incidentOf({}, { regression: regression() });
    const all = renderRegression(ctxOf(incident), ui());
    expect(all).toContain('Créer un livre sans éditeur');
    expect(all).toContain('Un message clair, pas d’erreur 500');
    expect(all).toContain('aria-readonly="true"');
    expect(all).toContain('click: &quot;&lt;Enregistrer&gt;&quot;');
    expect(all).toContain('data-action="ws-dx-regression" data-op="run"');
    expect(all).toContain('data-action="ws-dx-regression" data-op="accept"');
    expect(all).toContain('data-action="ws-dx-regression" data-op="reject"');
    expect(all).toContain('data-action="ws-dx-regression" data-op="propose"');
    expect(all).toContain('le place dans la bibliothèque de scénarios');
    const publisher = renderRegression(ctxOf(incident, { rights: ['PUBLISH'] }), ui());
    expect(publisher).toContain('data-op="accept"');
    expect(publisher).not.toContain('data-op="reject"');
    expect(publisher).not.toContain('data-op="run"');
    const decider = renderRegression(ctxOf(incident, { rights: ['DECIDE'] }), ui());
    expect(decider).toContain('data-op="reject"');
    expect(decider).not.toContain('data-op="accept"');
    const reader = renderRegression(ctxOf(incident, { rights: [] }), ui());
    expect(reader).not.toContain('ws-dx-regression');
    const accepted = renderRegression(
      ctxOf(
        incidentOf({}, { regression: regression({ status: 'ACCEPTED', file: 'incidents/x/x.flow.yaml' }) }),
      ),
      ui(),
    );
    expect(accepted).not.toContain('data-op="accept"');
    expect(accepted).toContain('Ajouté à la bibliothèque');
  });

  it('explains why a test cannot be proposed without a scenario', () => {
    const html = renderRegression(ctxOf(incidentOf({ scenario: undefined })), ui());
    expect(html).toMatch(/data-op="propose"[^>]* disabled aria-describedby="ws-dx-reg-why"/);
    expect(html).toContain('Un scénario de la bibliothèque est nécessaire');
  });
});

describe('incident-diagnosis : panneau latéral', () => {
  it('details a hypothesis with its linked experiments', () => {
    const html = renderHypothesisDetail(ctxOf(incidentOf()), 'hyp-null-relation');
    expect(html).toContain('Éditeur absent non validé');
    expect(html).toContain('Preuves favorables (3)');
    expect(html).toContain('Vérifications liées');
    expect(html).toContain('data-kind="experiment" data-ref="exp_done"');
    expect(renderHypothesisDetail(ctxOf(incidentOf()), 'nope')).toContain('n’existe plus');
  });

  it('details an experiment with its evidence', () => {
    const html = renderExperimentDetail(ctxOf(incidentOf()), 'exp_done');
    expect(html).toContain('Rejouer le scénario');
    expect(html).toContain('HTTP 500 de nouveau');
    expect(renderExperimentDetail(ctxOf(incidentOf()), 'nope')).toContain('n’existe plus');
  });
});

describe('incident-diagnosis : réducteur', () => {
  it('toggles, sorts and opens or closes the approval, without touching the previous state', () => {
    const start = emptyDiagnosisUi();
    const open = reduceDiagnosis(start, 'ws-dx-toggle', { hypothesis: 'h1' });
    expect(open?.expanded).toEqual(['h1']);
    expect(start.expanded).toEqual([]);
    expect(reduceDiagnosis(open ?? start, 'ws-dx-toggle', { hypothesis: 'h1' })?.expanded).toEqual([]);
    expect(reduceDiagnosis(start, 'ws-dx-sort', { sort: 'status' })?.sort).toBe('status');
    expect(reduceDiagnosis(start, 'ws-dx-sort', { sort: 'other' })).toBeUndefined();
    const approving = reduceDiagnosis(start, 'ws-dx-run', { experiment: 'e1', approval: 'required' });
    expect(approving?.approving).toBe('e1');
    expect(reduceDiagnosis(start, 'ws-dx-run', { experiment: 'e1' })).toBeUndefined();
    expect(reduceDiagnosis(approving ?? start, 'ws-dx-approve-cancel', {})?.approving).toBeUndefined();
  });

  it('edits the plan draft and validates it on submit', () => {
    let state: DiagnosisUi = emptyDiagnosisUi();
    state = reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.kind', value: 'INSPECT_LOGS' }) ?? state;
    expect(state.plan.kind).toBe('INSPECT_LOGS');
    expect(reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.kind', value: 'DROP' })).toBeUndefined();
    state = reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.hypothesisId', value: 'h1' }) ?? state;
    state =
      reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.param.key', index: '0', value: 'patterns' }) ??
      state;
    state =
      reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.param.value', index: '0', value: 'NPE|500' }) ??
      state;
    state = reduceDiagnosis(state, 'ws-dx-plan-param-add', {}) ?? state;
    state =
      reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.param.key', index: '1', value: 'tail' }) ?? state;
    state =
      reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.param.value', index: '1', value: '200' }) ?? state;
    expect(
      reduceDiagnosis(state, 'ws-dx-field', { field: 'dx.param.key', index: '9', value: 'x' }),
    ).toBeUndefined();
    expect(reduceDiagnosis(state, 'ws-dx-plan-submit', {})).toBeUndefined();
    expect(planInputOf(state.plan)).toEqual({
      ok: true,
      input: { kind: 'INSPECT_LOGS', hypothesisId: 'h1', params: { patterns: ['NPE', '500'], tail: 200 } },
    });
    const duplicated = reduceDiagnosis(state, 'ws-dx-field', {
      field: 'dx.param.key',
      index: '1',
      value: 'patterns',
    });
    const refused = reduceDiagnosis(duplicated ?? state, 'ws-dx-plan-submit', {});
    expect(refused?.planProblems).toEqual([{ code: 'duplicate', key: 'patterns', index: 1 }]);
    state = reduceDiagnosis(state, 'ws-dx-plan-param-remove', { index: '0' }) ?? state;
    expect(state.plan.params).toEqual([{ key: 'tail', value: '200' }]);
    state = reduceDiagnosis(state, 'ws-dx-plan-reset', {}) ?? state;
    expect(state.plan).toEqual(emptyDiagnosisUi().plan);
    expect(planInputOf({ kind: 'REPLAY', hypothesisId: '', params: [{ key: '', value: 'x' }] })).toEqual({
      ok: false,
      problems: [{ code: 'emptyKey', index: 0 }],
    });
    expect(
      planInputOf({ kind: 'REPLAY', hypothesisId: '', params: [{ key: 'sideEffects', value: 'true' }] }),
    ).toEqual({ ok: true, input: { kind: 'REPLAY', params: { sideEffects: true } } });
  });

  it('dismisses an error and leaves server operations to the integration', () => {
    const state = ui({ errors: { plan: 'refusé', diagnose: 'x' } });
    expect(reduceDiagnosis(state, 'ws-dx-dismiss', { key: 'plan' })?.errors).toEqual({ diagnose: 'x' });
    expect(reduceDiagnosis(state, 'ws-dx-dismiss', { key: 'none' })).toBeUndefined();
    for (const action of DIAGNOSIS_OPERATIONS.filter(
      (entry) => entry !== 'ws-dx-run' && entry !== 'ws-dx-plan-submit',
    ))
      expect(
        reduceDiagnosis(state, action, { experiment: 'e1', hypothesis: 'h', index: '0' }),
      ).toBeUndefined();
    expect(reduceDiagnosis(state, 'ws-other', {})).toBeUndefined();
  });

  it('renders errors as alerts with a dismiss button', () => {
    const html = renderDiagnosis(ctxOf(incidentOf()), ui({ errors: { diagnose: 'Diagnostic <refusé>' } }));
    expect(html).toContain('role="alert"');
    expect(html).toContain('Diagnostic &lt;refusé&gt;');
    expect(html).toContain('data-action="ws-dx-dismiss" data-key="diagnose"');
  });
});

describe('incident-diagnosis : échappement, styles et vocabulaire', () => {
  it('escapes every text coming from the investigation', () => {
    const evil = '<img src=x onerror=alert(1)>';
    const incident = incidentOf(
      {},
      {
        hypotheses: [
          hypothesis({ title: evil, suspectedCause: evil, supporting: [{ ref: evil, fact: evil }] }),
        ],
        experiments: [experiment({ summary: evil, description: evil, params: { [evil]: evil } })],
        diagnosis: diagnosis({ missing: [evil], recommendations: [evil], alternatives: [] }),
        regression: regression({ name: evil, flowYaml: evil }),
      },
    );
    const ctx = ctxOf(incident);
    const html = [
      renderHypotheses(ctx, ui({ expanded: ['hyp-null-relation'] })),
      renderExperiments(ctx, ui()),
      renderDiagnosis(ctx, ui()),
      renderRegression(ctx, ui()),
      renderHypothesisDetail(ctx, 'hyp-null-relation'),
      renderExperimentDetail(ctx, 'exp_1'),
    ].join('');
    expect(html).not.toContain('<img');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
  });

  it('uses only theme tokens and its own class prefix', () => {
    expect(INCIDENT_DIAGNOSIS_CSS).not.toMatch(/#[0-9a-f]{3,8}\b/i);
    expect(INCIDENT_DIAGNOSIS_CSS).not.toMatch(/rgba?\(|hsla?\(/);
    const selectors = INCIDENT_DIAGNOSIS_CSS.match(/(^|[\s,{>])\.[a-z][\w-]*/g) ?? [];
    expect(selectors.length).toBeGreaterThan(10);
    const own = selectors
      .map((entry) => entry.trim().replace(/^[,{>]/, ''))
      .filter((entry) => entry.startsWith('.'));
    expect(
      own.every((entry) => entry.startsWith('.ws-dx-') || ['.checks', '.row-acts'].includes(entry)),
    ).toBe(true);
  });
});
