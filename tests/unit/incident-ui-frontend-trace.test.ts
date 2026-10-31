import { describe, expect, it } from 'vitest';
import type {
  CodeIndex,
  FrontendTrace,
  Incident,
  InvestigationScope,
  ReproductionRun,
} from '../../src/sdk/core/incident-contracts.js';
import {
  defaultFrontendStep,
  emptyFrontendTraceUi,
  INCIDENT_FRONTEND_TRACE_CSS,
  isFailingStep,
  reduceFrontendTrace,
  renderFrontendStepDetail,
  renderFrontendTrace,
} from '../../src/sdk/ui/incident-frontend-trace.js';
import { stepId, workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type Lang, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';

/**
 * L'ONGLET « FRONTEND » : la chaîne détaillée d'une étape (étape Playwright → … → erreur affichée), le
 * sélecteur d'étapes (l'étape en échec au premier plan), la restriction aux étapes en échec, les cartes
 * sélectionnables (étape, symbole, requête, preuve), les maillons déduits marqués comme tels, l'échappement.
 */

const at = '2026-10-30T09:00:00.000Z';
const R = 'rep_1';
const FORM = 'frontend/src/books/BookForm.tsx';
const API = 'frontend/src/books/books-api.ts';
const ON_SAVE = `web:${FORM}#BookForm.onSave`;
const BOOK_FORM = `web:${FORM}#BookForm`;
const VALIDATE = 'web:frontend/src/books/validation.ts#validateBook';
const PAYLOAD = 'web:frontend/src/books/payload.ts#toCreateBookPayload';
const CREATE = `web:${API}#createBook`;
const CATCH = `web:${FORM}#BookForm.onSave.catch`;
const REQ = `${R}:req-3-1`;

const scope: InvestigationScope = {
  mode: 'GUIDED',
  applications: [],
  scenarios: ['Créer un livre'],
  steps: [],
  endpoints: [],
  depth: 3,
  allowedHosts: [],
  logRoots: [],
  allowedCommands: [],
  permissions: {
    readSources: true,
    navigate: true,
    httpRequests: 'NONE',
    runTests: 'NONE',
    localCommands: false,
    readLogs: false,
    openshift: 'NONE',
    sideEffects: false,
  },
  limits: { maxFiles: 100, maxFileBytes: 100000, maxDurationMs: 60000, maxRequests: 10, maxExperiments: 5 },
  extensions: [],
};

const run: ReproductionRun = {
  id: R,
  startedAt: at,
  status: 'COMPLETED',
  target: 'LOCAL',
  scenario: 'Créer un livre',
  reproduced: true,
  actions: [
    {
      index: 1,
      kind: 'goto',
      description: 'goto /books/new',
      status: 'PASSED',
      durationMs: 200,
      requestIds: [],
    },
    {
      index: 2,
      kind: 'fill',
      description: 'fill label="Titre" = "<b>Atlas</b>"',
      status: 'PASSED',
      durationMs: 30,
      requestIds: [],
    },
    {
      index: 3,
      kind: 'click',
      description: 'click role=button[name="Enregistrer"]',
      status: 'PASSED',
      durationMs: 90,
      requestIds: [REQ],
    },
    {
      index: 4,
      kind: 'expect',
      description: 'expect text "Livre créé"',
      status: 'FAILED',
      durationMs: 5000,
      screenshot: 'screens/step-4.png',
      requestIds: [],
    },
  ],
  requests: [
    {
      id: REQ,
      method: 'POST',
      url: '/api/books',
      path: '/api/books',
      status: 500,
      durationMs: 42,
      resourceType: 'fetch',
      step: 3,
      correlation: 'OBSERVED',
      requestBody: '{"title":"Atlas","isbn":"***"}',
      responseBody: `{"error":"<NullPointerException>","detail":"${'x'.repeat(500)}"}`,
    },
  ],
  evidence: [
    { id: `${R}:ev-action-3`, kind: 'ACTION', summary: 'étape 3', source: { reproduction: R, step: 3 } },
    { id: `${R}:ev-action-4`, kind: 'ACTION', summary: 'étape 4', source: { reproduction: R, step: 4 } },
    {
      id: `${R}:ev-assertion-4`,
      kind: 'ASSERTION',
      summary: 'attente',
      source: { reproduction: R, step: 4 },
    },
    {
      id: `${R}:ev-screenshot-4`,
      kind: 'SCREENSHOT',
      summary: 'capture',
      source: { reproduction: R, step: 4 },
    },
    {
      id: `${R}:ev-issue-ISSUE-0001`,
      kind: 'CONSOLE',
      summary: 'console',
      source: { reproduction: R, step: 3 },
    },
  ],
  screenshots: ['screens/step-4.png'],
};

const code: CodeIndex = {
  applications: [{ id: 'web', layer: 'FRONTEND', files: 5, skipped: 0 }],
  symbols: [
    {
      id: BOOK_FORM,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'COMPONENT',
      name: 'BookForm',
      file: FORM,
      line: 14,
    },
    {
      id: ON_SAVE,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'EVENT_HANDLER',
      name: 'BookForm.onSave',
      file: FORM,
      line: 20,
      parent: BOOK_FORM,
    },
    {
      id: VALIDATE,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'VALIDATION',
      name: 'validateBook',
      file: 'frontend/src/books/validation.ts',
      line: 5,
    },
    {
      id: PAYLOAD,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'PAYLOAD_TRANSFORM',
      name: 'toCreateBookPayload',
      file: 'frontend/src/books/payload.ts',
      line: 3,
    },
    {
      id: CREATE,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'HTTP_CLIENT_CALL',
      name: 'createBook',
      file: API,
      line: 15,
    },
    {
      id: CATCH,
      applicationId: 'web',
      layer: 'FRONTEND',
      kind: 'ERROR_HANDLER',
      name: 'BookForm.onSave.catch',
      file: FORM,
      line: 31,
      parent: ON_SAVE,
    },
  ],
  endpoints: [],
  outgoing: [],
  calls: [],
  denied: [],
  truncated: [],
};

const loc = (file: string, line: number, symbolId: string) => ({
  applicationId: 'web',
  layer: 'FRONTEND' as const,
  file,
  line,
  symbolId,
});

const trace: FrontendTrace = {
  reproduction: R,
  steps: [
    {
      index: 1,
      action: { kind: 'goto', description: 'goto /books/new', status: 'PASSED', evidence: [] },
      services: [],
      httpClients: [],
      requests: [],
      console: [],
      jsErrors: [],
    },
    {
      index: 2,
      action: {
        kind: 'fill',
        description: 'fill label="Titre" = "<b>Atlas</b>"',
        status: 'PASSED',
        evidence: [],
      },
      element: { label: 'champ « Titre »', status: 'OBSERVED', reason: 'cible <de> l’étape', evidence: [] },
      component: { label: '?', status: 'UNKNOWN', reason: 'aucun déclencheur « Titre »', evidence: [] },
      services: [],
      httpClients: [],
      requests: [],
      console: [],
      jsErrors: [],
    },
    {
      index: 3,
      action: {
        kind: 'click',
        description: 'click role=button[name="Enregistrer"]',
        status: 'PASSED',
        evidence: [`${R}:ev-action-3`],
      },
      element: {
        label: 'button « Enregistrer »',
        status: 'OBSERVED',
        reason: 'cible de l’étape 3',
        evidence: [`${R}:ev-action-3`],
      },
      component: {
        label: 'BookForm',
        status: 'INFERRED',
        reason: 'libellé <form onSubmit> « Enregistrer »',
        evidence: [],
        symbolId: BOOK_FORM,
        source: loc(FORM, 14, BOOK_FORM),
      },
      handler: {
        label: 'BookForm.onSave',
        status: 'INFERRED',
        reason: 'déclencheur « Enregistrer »',
        evidence: [],
        symbolId: ON_SAVE,
        source: loc(FORM, 20, ON_SAVE),
      },
      services: [
        {
          label: 'validateBook',
          status: 'STATICALLY_RESOLVED',
          reason: 'appel validateBook(values)',
          evidence: [],
          symbolId: VALIDATE,
          source: loc('frontend/src/books/validation.ts', 5, VALIDATE),
        },
        {
          label: 'toCreateBookPayload',
          status: 'INFERRED',
          reason: 'appel toCreateBookPayload(values)',
          evidence: [],
          symbolId: PAYLOAD,
          source: loc('frontend/src/books/payload.ts', 3, PAYLOAD),
        },
        {
          label: 'createBook',
          status: 'STATICALLY_RESOLVED',
          reason: 'appel createBook(…)',
          evidence: [],
          symbolId: CREATE,
          source: loc(API, 15, CREATE),
        },
      ],
      httpClients: [
        {
          label: 'POST /api/books (createBook)',
          status: 'STATICALLY_RESOLVED',
          reason: 'books-api.ts:16 envoie POST /api/books',
          evidence: [REQ],
          symbolId: CREATE,
          source: loc(API, 16, CREATE),
        },
      ],
      requests: [
        { requestId: REQ, method: 'POST', path: '/api/books', status: 500, correlation: 'OBSERVED' },
      ],
      displayedError: {
        label: '« Erreur inattendue. »',
        status: 'INFERRED',
        reason: 'déduit du code : setMessage',
        evidence: [`${R}:ev-assertion-4`, `${R}:ev-screenshot-4`],
        symbolId: CATCH,
        source: loc(FORM, 31, CATCH),
      },
      console: [`${R}:ev-issue-ISSUE-0001`],
      jsErrors: [],
    },
    {
      index: 4,
      action: {
        kind: 'expect',
        description: 'expect text "Livre créé"',
        status: 'FAILED',
        screenshot: 'screens/step-4.png',
        evidence: [`${R}:ev-action-4`, `${R}:ev-assertion-4`, `${R}:ev-screenshot-4`],
      },
      services: [],
      httpClients: [],
      requests: [],
      console: [],
      jsErrors: [],
    },
  ],
  limitations: ['étape(s) 2 : aucune requête observée — <aucun> client HTTP'],
};

function incident(withTrace = true): Incident {
  return {
    id: 'inc_1',
    projectId: 'prj_books',
    title: 'Erreur 500 à l’enregistrement',
    description: 'Après Enregistrer, erreur HTTP 500',
    observed: 'erreur HTTP 500',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'Créer un livre',
    execution: { target: 'LOCAL' },
    scope,
    state: 'INVESTIGATING',
    revision: 3,
    createdAt: at,
    updatedAt: at,
    createdBy: 'qa',
    history: [],
    investigation: {
      reproductions: [run],
      code,
      hypotheses: [],
      experiments: [],
      ...(withTrace ? { frontendTrace: trace } : {}),
    },
  };
}

function context(
  options: { selection?: WorkspaceSelection; lang?: Lang; withTrace?: boolean; demo?: boolean } = {},
): WorkspaceContext {
  const value = incident(options.withTrace ?? true);
  return workspaceContext({
    incident: value,
    lang: options.lang ?? 'fr',
    ...(options.selection ? { selection: options.selection } : {}),
    links: workspaceLinks(value),
    demo: options.demo ?? false,
    can: () => true,
  });
}

// Les mots proscrits (écrits avec un groupe vide pour ne pas figurer en clair dans ce fichier).
const FORBIDDEN =
  /\bt[âa](?:)ches?\b|appli(?:)qu|fil(?:)tr|entre(?:)prise|rensei(?:)gnements|proc(?:)essus|bes(?:)oin|respons(?:)able|partic(?:)ulier|consei(?:)ller|coordo(?:)nn[ée]e|ver(?:)rou|cai(?:)sse|tran(?:)sit(?!ion)|\bo(?:)ui\b|raison so(?:)ciale|sembl(?:)able|cl[ée] m[ée](?:)tier/i;

describe('renderFrontendTrace', () => {
  it('sans traçabilité : panneau vide qui invite à lancer l’analyse', () => {
    const html = renderFrontendTrace(context({ withTrace: false }), emptyFrontendTraceUi());
    expect(html).toContain('class="ws-state"');
    expect(html).toContain('La traçabilité frontend n’est pas encore construite.');
    expect(html).toContain('Lancez l’analyse du code');
    expect(html).not.toContain('ws-frontend-trace-chain');
  });

  it('l’étape qui porte l’erreur affichée est au premier plan par défaut, avec les dix maillons dans l’ordre', () => {
    const html = renderFrontendTrace(context(), emptyFrontendTraceUi());
    expect(html).toContain('Traçabilité de l’étape 3');
    expect(html).toMatch(/data-step="3" aria-current="step"/);
    const stages = [...html.matchAll(/<h4 class="ws-frontend-trace-stage-t">([^<]+)<\/h4>/g)].map(
      (m) => m[1],
    );
    expect(stages).toEqual([
      'Étape Playwright',
      'Action utilisateur',
      'Élément DOM',
      'Composant',
      'Handler',
      'Services TypeScript',
      'Client HTTP',
      'Requête',
      'Réponse',
      'Erreur affichée',
    ]);
  });

  it('cartes sélectionnables avec les bonnes sortes : étape, symbole, requête, preuve', () => {
    const html = renderFrontendTrace(context(), emptyFrontendTraceUi());
    expect(html).toContain(`data-kind="step" data-ref="${stepId(R, 3)}"`);
    expect(html).toContain(`data-kind="symbol" data-ref="${ON_SAVE}"`);
    expect(html).toContain(`data-kind="symbol" data-ref="${BOOK_FORM}"`);
    expect(html).toContain(`data-kind="symbol" data-ref="${CATCH}"`);
    expect(html).toContain(`data-kind="request" data-ref="${REQ}"`);
    expect(html).toContain(`data-kind="evidence" data-ref="${R}:ev-action-3"`);
    expect(html).toContain('data-action="ws-select"');
    // Liens vers l'explorateur de code.
    expect(html).toContain(`data-action="ws-code" data-app="web" data-file="${FORM}" data-line="20"`);
    expect(html).toContain(`data-file="${API}" data-line="16"`);
    // Preuves : la requête du client HTTP, l'assertion de l'erreur affichée, la console.
    expect(html).toContain(`data-kind="evidence" data-ref="${R}:ev-assertion-4"`);
    expect(html).toContain(`data-kind="evidence" data-ref="${R}:ev-issue-ISSUE-0001"`);
  });

  it('statuts : badges, mention « déduit, non observable sans instrumentation », légende', () => {
    const html = renderFrontendTrace(context(), emptyFrontendTraceUi());
    expect(html).toContain('ws-rel ws-rel-inferred');
    expect(html).toContain('ws-rel ws-rel-statically_resolved');
    expect(html).toContain('ws-rel ws-rel-observed');
    expect(html).toContain('déduit, non observable sans instrumentation');
    expect(html).toContain('ws-frontend-trace-s-inferred');
    expect(html).toContain('class="ws-legend"');
    expect(html).toContain('ce n’est pas une trace d’exécution');
    // Les sortes des services viennent de l'index de code.
    expect(html).toContain('Validation');
    expect(html).toContain('Transformation du payload');
  });

  it('requête et réponse : méthode, chemin, statut, extrait du corps (échappé), durée', () => {
    const html = renderFrontendTrace(context(), emptyFrontendTraceUi());
    expect(html).toContain('<span class="pill ko">500</span>');
    expect(html).toContain('42 ms');
    expect(html).toContain('&lt;NullPointerException&gt;');
    expect(html).not.toContain('<NullPointerException>');
    expect(html).toContain('Extrait du corps de la réponse (masqué)');
    expect(html).toContain('Corps complet (masqué)');
    expect(html).toContain('{&quot;title&quot;:&quot;Atlas&quot;,&quot;isbn&quot;:&quot;***&quot;}');
  });

  it('étape choisie dans l’état local ; maillons sans objet pour un goto', () => {
    const html = renderFrontendTrace(context(), { failingOnly: false, step: 1 });
    expect(html).toContain('Traçabilité de l’étape 1');
    expect(html).toContain('Sans objet pour une étape « goto ».');
    expect(html).toContain('Aucune requête observée pendant cette étape.');
    expect(html).toContain('Aucun échec à cette étape ni dans les attentes qui la suivent.');
  });

  it('restriction aux étapes en échec : seules 3 (requête 500, erreur affichée) et 4 (attente échouée)', () => {
    const html = renderFrontendTrace(context(), { failingOnly: true, step: 1 });
    const listed = [...html.matchAll(/data-action="ws-frontend-trace-step" data-step="(\d+)"/g)].map(
      (m) => m[1],
    );
    expect(listed).toEqual(['3', '4']);
    expect(html).toContain('2 étape(s) sur 4');
    expect(html).toContain('data-action="ws-frontend-trace-failing" aria-pressed="true"');
    // L'étape 1 n'est plus visible : retour à l'étape en échec par défaut.
    expect(html).toContain('Traçabilité de l’étape 3');
  });

  it('sélection synchronisée : la requête sélectionnée, l’étape qui la porte reliée', () => {
    const html = renderFrontendTrace(
      context({ selection: { kind: 'request', id: REQ } }),
      emptyFrontendTraceUi(),
    );
    expect(html).toMatch(/ws-frontend-trace-card[^"]* ws-selected"/);
    expect(html).toMatch(/data-step="3" aria-current="step"/);
    expect(html).toMatch(/class="ws-frontend-trace-step current failing ws-related"/);
    expect(html).toMatch(/class="ws-frontend-trace-step ws-dimmed"/);
  });

  it('échappement : descriptions, maillons et limites', () => {
    const html = renderFrontendTrace(context(), { failingOnly: false, step: 2 });
    expect(html).toContain('&lt;b&gt;Atlas&lt;/b&gt;');
    expect(html).not.toContain('<b>Atlas</b>');
    expect(html).toContain('cible &lt;de&gt; l’étape');
    expect(html).toContain('&lt;aucun&gt; client HTTP');
    expect(html).toContain('ws-frontend-trace-s-unknown');
    expect(html).toContain('lien non établi');
  });

  it('données de démonstration : bandeau ; anglais', () => {
    expect(renderFrontendTrace(context({ demo: true }), emptyFrontendTraceUi())).toContain('ws-demo');
    const html = renderFrontendTrace(context({ lang: 'en' }), emptyFrontendTraceUi());
    expect(html).toContain('Frontend traceability');
    expect(html).toContain('Displayed error');
    expect(html).toContain('inferred, not observable without instrumentation');
  });

  it('textes français sans mots proscrits, boutons nommés', () => {
    for (const step of [1, 2, 3, 4]) {
      const html = renderFrontendTrace(context(), { failingOnly: false, step });
      const visible = html.replace(/<[^>]+>/g, ' ');
      expect(visible).not.toMatch(FORBIDDEN);
      for (const button of html.matchAll(/<button[^>]*>([\s\S]*?)<\/button>/g))
        expect((button[1] ?? '').replace(/<[^>]+>/g, '').trim().length).toBeGreaterThan(0);
    }
    expect(renderFrontendTrace(context({ withTrace: false }), emptyFrontendTraceUi())).not.toMatch(FORBIDDEN);
  });
});

describe('renderFrontendStepDetail (panneau latéral)', () => {
  it('la chaîne compacte de l’étape', () => {
    const html = renderFrontendStepDetail(context(), 3);
    expect(html).toContain('ws-frontend-trace-compact');
    expect(html).toContain('Traçabilité de l’étape 3');
    expect(html).toContain(`data-ref="${ON_SAVE}"`);
    expect(html).not.toContain('Corps complet (masqué)');
  });

  it('étape absente, traçabilité absente', () => {
    expect(renderFrontendStepDetail(context(), 9)).toContain('Cette étape n’existe pas dans la traçabilité.');
    expect(renderFrontendStepDetail(context({ withTrace: false }), 3)).toContain('ws-state');
  });
});

describe('reduceFrontendTrace, étapes en échec', () => {
  it('réducteur pur : étape, restriction, retour à toutes les étapes, actions étrangères', () => {
    const ui = emptyFrontendTraceUi();
    expect(ui).toEqual({ failingOnly: false });
    expect(reduceFrontendTrace(ui, 'ws-frontend-trace-step', { step: '4' })).toEqual({
      failingOnly: false,
      step: 4,
    });
    expect(reduceFrontendTrace(ui, 'ws-frontend-trace-step', { step: 'abc' })).toBe(ui);
    const restricted = reduceFrontendTrace(ui, 'ws-frontend-trace-failing', {});
    expect(restricted).toEqual({ failingOnly: true });
    expect(reduceFrontendTrace(restricted ?? ui, 'ws-frontend-trace-failing', {})).toEqual({
      failingOnly: false,
    });
    expect(reduceFrontendTrace({ failingOnly: true, step: 2 }, 'ws-frontend-trace-all', {})).toEqual({
      failingOnly: false,
      step: 2,
    });
    expect(reduceFrontendTrace(ui, 'ws-select', { kind: 'step' })).toBeUndefined();
    expect(ui).toEqual({ failingOnly: false });
  });

  it('isFailingStep / defaultFrontendStep', () => {
    expect(trace.steps.map((step) => isFailingStep(step))).toEqual([false, false, true, true]);
    expect(defaultFrontendStep(trace)).toBe(3);
    const quiet: FrontendTrace = {
      ...trace,
      steps: trace.steps.map(({ displayedError: _, ...step }) => step),
    };
    expect(defaultFrontendStep(quiet)).toBe(4);
    expect(defaultFrontendStep({ ...trace, steps: [] })).toBeUndefined();
  });

  it('CSS : préfixe de la zone, jetons de couleur seulement', () => {
    expect(INCIDENT_FRONTEND_TRACE_CSS).toContain('.ws-frontend-trace-card');
    expect(INCIDENT_FRONTEND_TRACE_CSS).not.toMatch(/#[0-9a-fA-F]{3,8}\b|rgba?\(|hsla?\(/);
    for (const rule of INCIDENT_FRONTEND_TRACE_CSS.split('\n').filter((line) => line.startsWith('.')))
      expect(rule.startsWith('.ws-frontend-trace')).toBe(true);
  });

  it('CSS : les réserves colorées atteignent AA (jeton de statut mêlé à la couleur du texte)', () => {
    expect(INCIDENT_FRONTEND_TRACE_CSS).toContain(
      '.ws-frontend-trace-caveat{margin:0;font-size:12px;font-style:italic;color:color-mix(in srgb,var(--qa-color-warning) 70%,var(--qa-color-text))}',
    );
    expect(INCIDENT_FRONTEND_TRACE_CSS).toContain(
      '.ws-frontend-trace-s-unknown .ws-frontend-trace-caveat{color:color-mix(in srgb,var(--qa-color-danger) 70%,var(--qa-color-text))}',
    );
    expect(INCIDENT_FRONTEND_TRACE_CSS).not.toMatch(
      /[;{]color:var\(--qa-color-(danger|success|warning|faint)\)/,
    );
  });
});
