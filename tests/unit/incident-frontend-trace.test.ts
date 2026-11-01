import { describe, expect, it } from 'vitest';
import { buildFrontendTrace, parseStepTarget, parseTrigger } from '../../src/incident/frontend-trace.js';
import type { CodeIndex, CodeSymbol, Evidence, ReproductionRun } from '../../src/incident/model.js';

/**
 * LA TRAÇABILITÉ FRONTEND d'une reproduction : étape → élément → composant → handler → services →
 * clients HTTP → requêtes → erreur affichée. Index de code construit à la main comme celui de la fixture
 * (`tests/fixtures/incident-app/frontend`) : BookForm.onSave « Enregistrer » → validateBook →
 * toCreateBookPayload → createBook (POST /api/books), catch qui appelle setMessage.
 */

const R = 'rep_1';
const APP = 'web';
const FORM = 'frontend/src/books/BookForm.tsx';
const API = 'frontend/src/books/books-api.ts';
const id = (file: string, name: string): string => `${APP}:${file}#${name}`;

const ON_SAVE = id(FORM, 'BookForm.onSave');
const BOOK_FORM = id(FORM, 'BookForm');
const VALIDATE = id('frontend/src/books/validation.ts', 'validateBook');
const IS_VALID = id('frontend/src/books/validation.ts', 'isValidBook');
const PAYLOAD = id('frontend/src/books/payload.ts', 'toCreateBookPayload');
const CREATE = id(API, 'createBook');
const GET = id(API, 'getBook');
const CATCH = id(FORM, 'BookForm.onSave.catch');

function symbol(
  kind: CodeSymbol['kind'],
  file: string,
  name: string,
  line: number,
  detail: CodeSymbol['detail'] = {},
  parent?: string,
): CodeSymbol {
  return {
    id: id(file, name),
    applicationId: APP,
    layer: 'FRONTEND',
    kind,
    name,
    file,
    line,
    detail,
    ...(parent ? { parent } : {}),
  };
}

function fixtureCode(): CodeIndex {
  return {
    applications: [{ id: APP, layer: 'FRONTEND', files: 5, skipped: 0 }],
    symbols: [
      symbol('COMPONENT', FORM, 'BookForm', 14, { exported: true, framework: 'react' }),
      symbol(
        'EVENT_HANDLER',
        FORM,
        'BookForm.onSave',
        20,
        { async: true, triggers: ['<form onSubmit> « Enregistrer »'] },
        BOOK_FORM,
      ),
      symbol(
        'ERROR_HANDLER',
        FORM,
        'BookForm.onSave.catch',
        31,
        { calls: ['setMessage'], messages: ['Erreur inattendue.'], rethrows: false, style: 'try/catch' },
        ON_SAVE,
      ),
      symbol('HTTP_CLIENT_CALL', API, 'createBook', 15, { http: ['POST /api/books'], throws: ['ApiError'] }),
      symbol('HTTP_CLIENT_CALL', API, 'getBook', 27, { http: ['GET /api/books/{id}'], throws: ['ApiError'] }),
      symbol('PAYLOAD_TRANSFORM', 'frontend/src/books/payload.ts', 'toCreateBookPayload', 3, {
        fields: ['title', 'isbn', 'publisherId'],
        conditionalFields: ['publisherId'],
      }),
      symbol('VALIDATION', 'frontend/src/books/validation.ts', 'validateBook', 5, {
        checks: ['title', 'isbn'],
      }),
      symbol('VALIDATION', 'frontend/src/books/validation.ts', 'isValidBook', 12),
    ],
    endpoints: [],
    outgoing: [
      {
        applicationId: APP,
        layer: 'FRONTEND',
        symbolId: CREATE,
        status: 'STATICALLY_RESOLVED',
        file: API,
        line: 16,
        method: 'POST',
        path: '/api/books',
      },
      {
        applicationId: APP,
        layer: 'FRONTEND',
        symbolId: GET,
        status: 'INFERRED',
        file: API,
        line: 28,
        method: 'GET',
        path: '/api/books/{id}',
      },
    ],
    calls: [
      {
        from: ON_SAVE,
        to: VALIDATE,
        text: 'validateBook(values)',
        status: 'STATICALLY_RESOLVED',
        file: FORM,
        line: 22,
      },
      {
        from: ON_SAVE,
        to: IS_VALID,
        text: 'isValidBook(found)',
        status: 'STATICALLY_RESOLVED',
        file: FORM,
        line: 24,
      },
      {
        from: ON_SAVE,
        to: CREATE,
        text: 'createBook(toCreateBookPayload(values))',
        status: 'STATICALLY_RESOLVED',
        file: FORM,
        line: 27,
      },
      {
        from: ON_SAVE,
        to: PAYLOAD,
        text: 'toCreateBookPayload(values)',
        status: 'INFERRED',
        file: FORM,
        line: 27,
      },
    ],
    denied: [],
    truncated: [],
  };
}

const ev = (suffix: string, kind: Evidence['kind'], step: number, summary = ''): Evidence => ({
  id: `${R}:ev-${suffix}`,
  kind,
  summary,
  source: { reproduction: R, step },
});

/** goto → fill Titre → click Enregistrer (POST /api/books → 500) → expect « Livre créé » (échoue). */
function failingRun(overrides: Partial<ReproductionRun> = {}): ReproductionRun {
  return {
    id: R,
    startedAt: '2026-10-30T09:00:00.000Z',
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
        durationMs: 300,
        requestIds: [`${R}:req-1-1`],
      },
      {
        index: 2,
        kind: 'fill',
        description: 'fill label="Titre" = "Le Petit Atlas"',
        status: 'PASSED',
        durationMs: 40,
        requestIds: [],
      },
      {
        index: 3,
        kind: 'click',
        description: 'click role=button[name="Enregistrer"]',
        status: 'PASSED',
        durationMs: 120,
        requestIds: [`${R}:req-3-1`],
      },
      {
        index: 4,
        kind: 'expect',
        description: 'expect text "Livre créé"',
        status: 'FAILED',
        durationMs: 5000,
        reason: 'texte introuvable',
        screenshot: 'screens/step-4.png',
        requestIds: [],
      },
    ],
    requests: [
      {
        id: `${R}:req-1-1`,
        method: 'GET',
        url: '/books/new',
        path: '/books/new',
        status: 200,
        resourceType: 'document',
        step: 1,
        correlation: 'OBSERVED',
      },
      {
        id: `${R}:req-3-1`,
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        resourceType: 'fetch',
        step: 3,
        correlation: 'OBSERVED',
        requestBody: '{"title":"Le Petit Atlas","isbn":"9782070000000"}',
        responseBody: '{"error":"Internal Server Error","path":"/api/books"}',
      },
    ],
    evidence: [
      ev('action-1', 'ACTION', 1),
      ev('page-1', 'PAGE', 1),
      ev('action-2', 'ACTION', 2),
      ev('action-3', 'ACTION', 3),
      ev('issue-ISSUE-0001', 'CONSOLE', 3, 'CONSOLE : Failed to load resource: 500'),
      ev('action-4', 'ACTION', 4),
      ev('assertion-4', 'ASSERTION', 4, 'attente non satisfaite à l’étape 4 : expect text "Livre créé"'),
      ev('screenshot-4', 'SCREENSHOT', 4),
    ],
    screenshots: ['screens/step-4.png'],
    ...overrides,
  };
}

describe('buildFrontendTrace : la fixture « Nouveau livre » (Enregistrer → HTTP 500)', () => {
  const trace = buildFrontendTrace({ reproduction: failingRun(), code: fixtureCode() });
  const click = trace.steps.find((step) => step.index === 3);
  if (!click) throw new Error('étape 3 absente');

  it('une étape par action, dans l’ordre, avec la reproduction', () => {
    expect(trace.reproduction).toBe(R);
    expect(trace.steps.map((step) => step.index)).toEqual([1, 2, 3, 4]);
    expect(click.action).toEqual({
      kind: 'click',
      description: 'click role=button[name="Enregistrer"]',
      status: 'PASSED',
      evidence: [`${R}:ev-action-3`],
    });
  });

  it('élément : la cible décrite par l’étape, OBSERVED, sans détail DOM inventé', () => {
    expect(click.element).toMatchObject({
      label: 'button « Enregistrer »',
      status: 'OBSERVED',
      evidence: [`${R}:ev-action-3`],
    });
    expect(click.element?.reason).toContain('nom accessible « Enregistrer »');
    expect(click.element?.reason).toContain('Aucun détail DOM');
    expect(click.element?.source).toBeUndefined();
  });

  it('composant et handler : INFERRED par le libellé du déclencheur, avec leur localisation', () => {
    expect(click.component).toMatchObject({
      label: 'BookForm',
      status: 'INFERRED',
      symbolId: BOOK_FORM,
      source: { applicationId: APP, layer: 'FRONTEND', file: FORM, line: 14, symbolId: BOOK_FORM },
    });
    expect(click.component?.reason).toContain('<form onSubmit> « Enregistrer »');
    expect(click.handler).toMatchObject({
      label: 'BookForm.onSave',
      status: 'INFERRED',
      symbolId: ON_SAVE,
      source: { applicationId: APP, layer: 'FRONTEND', file: FORM, line: 20, symbolId: ON_SAVE },
    });
    expect(click.handler?.reason).toContain('non observable sans instrumentation');
  });

  it('services : les appels du handler dans l’ordre, chacun avec son propre statut, jamais OBSERVED', () => {
    expect(click.services.map((link) => [link.label, link.status])).toEqual([
      ['validateBook', 'STATICALLY_RESOLVED'],
      ['isValidBook', 'STATICALLY_RESOLVED'],
      ['createBook', 'STATICALLY_RESOLVED'],
      ['toCreateBookPayload', 'INFERRED'],
    ]);
    for (const link of click.services) {
      expect(link.source).toMatchObject({ applicationId: APP, layer: 'FRONTEND', symbolId: link.symbolId });
      expect(link.evidence).toEqual([]);
    }
    expect(click.services[0]?.source).toMatchObject({ file: 'frontend/src/books/validation.ts', line: 5 });
    expect(click.services[0]?.reason).toContain('validation');
    expect(click.services[3]?.reason).toContain('transformation du payload');
    const observed = [click.component, click.handler, ...click.services].filter(
      (link) => link?.status === 'OBSERVED',
    );
    expect(observed).toEqual([]);
  });

  it('client HTTP : createBook POST /api/books, littéral → STATICALLY_RESOLVED, preuve la requête observée', () => {
    expect(click.httpClients).toHaveLength(1);
    expect(click.httpClients[0]).toMatchObject({
      label: 'POST /api/books (createBook)',
      status: 'STATICALLY_RESOLVED',
      evidence: [`${R}:req-3-1`],
      symbolId: CREATE,
      source: { applicationId: APP, layer: 'FRONTEND', file: API, line: 16, symbolId: CREATE },
    });
    expect(click.httpClients[0]?.reason).toContain('POST /api/books → 500');
  });

  it('requêtes : celles de l’étape, avec la corrélation du run', () => {
    expect(click.requests).toEqual([
      { requestId: `${R}:req-3-1`, method: 'POST', path: '/api/books', status: 500, correlation: 'OBSERVED' },
    ]);
    expect(click.console).toEqual([`${R}:ev-issue-ISSUE-0001`]);
    expect(click.jsErrors).toEqual([]);
  });

  it('erreur affichée : le catch du handler, INFERRED (texte lu dans le code) + preuves de l’assertion échouée', () => {
    expect(click.displayedError).toMatchObject({
      label: '« Erreur inattendue. »',
      status: 'INFERRED',
      symbolId: CATCH,
      source: { applicationId: APP, layer: 'FRONTEND', file: FORM, line: 31, symbolId: CATCH },
      evidence: [`${R}:ev-assertion-4`, `${R}:ev-screenshot-4`],
    });
    expect(click.displayedError?.reason).toContain('setMessage');
    expect(click.displayedError?.reason).toContain('createBook lève ApiError');
    expect(click.displayedError?.reason).toContain("n'a pas été capturé");
    // L'attente elle-même ne répète pas l'erreur affichée, mais garde ses preuves.
    const expectStep = trace.steps.find((step) => step.index === 4);
    expect(expectStep?.displayedError).toBeUndefined();
    expect(expectStep?.action.evidence).toEqual([
      `${R}:ev-action-4`,
      `${R}:ev-assertion-4`,
      `${R}:ev-screenshot-4`,
    ]);
    expect(expectStep?.action.screenshot).toBe('screens/step-4.png');
  });

  it('étapes sans cible ou sans handler : rien d’inventé', () => {
    const goto = trace.steps[0];
    expect(goto?.element).toBeUndefined();
    expect(goto?.component).toBeUndefined();
    expect(goto?.handler).toBeUndefined();
    expect(goto?.httpClients).toEqual([]);
    const fill = trace.steps[1];
    expect(fill?.element).toMatchObject({ label: 'champ « Titre »', status: 'OBSERVED' });
    expect(fill?.component).toMatchObject({ status: 'UNKNOWN' });
    expect(fill?.component?.reason).toContain('« Titre »');
    expect(fill?.handler).toBeUndefined();
  });

  it('limites : code déduit, étape sans requête, cible sans handler', () => {
    expect(trace.limitations).toContain(
      'composants, handlers et services sont déduits du code (libellés des déclencheurs, appels lus) : ils ne sont pas observables sans instrumentation et ne constituent pas une trace d’exécution',
    );
    expect(trace.limitations.some((entry) => entry.startsWith('étape(s) 2 : aucune requête observée'))).toBe(
      true,
    );
    expect(trace.limitations.some((entry) => entry.includes('étape 2 : aucun composant ni handler'))).toBe(
      true,
    );
  });

  it('pur et déterministe : même entrée, même sortie ; l’entrée n’est pas modifiée', () => {
    const run = failingRun();
    const code = fixtureCode();
    const before = JSON.stringify({ run, code });
    const first = buildFrontendTrace({ reproduction: run, code });
    const second = buildFrontendTrace({ reproduction: run, code });
    expect(JSON.stringify(first)).toBe(JSON.stringify(second));
    expect(JSON.stringify({ run, code })).toBe(before);
  });
});

describe('buildFrontendTrace : sans code, code partiel, cas limites', () => {
  it('sans code : composant UNKNOWN, élément et requêtes gardés, erreur affichée UNKNOWN avec les preuves', () => {
    const trace = buildFrontendTrace({ reproduction: failingRun() });
    const click = trace.steps[2];
    expect(click?.element?.status).toBe('OBSERVED');
    expect(click?.component).toMatchObject({ status: 'UNKNOWN' });
    expect(click?.component?.reason).toContain("le code n'a pas été analysé");
    expect(click?.handler).toBeUndefined();
    expect(click?.services).toEqual([]);
    expect(click?.httpClients).toEqual([]);
    expect(click?.requests).toHaveLength(1);
    expect(click?.displayedError).toMatchObject({
      status: 'UNKNOWN',
      evidence: [`${R}:ev-assertion-4`, `${R}:ev-screenshot-4`],
    });
    expect(click?.displayedError?.symbolId).toBeUndefined();
    expect(trace.limitations[0]).toContain("le code n'a pas été analysé");
  });

  it('code sans application FRONTEND : le frontend est hors périmètre', () => {
    const code: CodeIndex = {
      ...fixtureCode(),
      applications: [{ id: 'bff', layer: 'BFF', files: 3, skipped: 0 }],
      symbols: [],
      outgoing: [],
      calls: [],
    };
    const trace = buildFrontendTrace({ reproduction: failingRun(), code });
    expect(trace.limitations[0]).toContain('aucune application FRONTEND');
    expect(trace.steps[2]?.component?.reason).toContain("n'est pas dans le périmètre");
  });

  it('analyse tronquée : dite dans les limites', () => {
    const trace = buildFrontendTrace({
      reproduction: failingRun(),
      code: { ...fixtureCode(), truncated: ['maxFiles atteint (200)'] },
    });
    expect(trace.limitations.some((entry) => entry.includes('maxFiles atteint (200)'))).toBe(true);
  });

  it('étape d’action échouée : élément UNKNOWN, erreur affichée portée par l’étape elle-même', () => {
    const run = failingRun();
    const actions = run.actions
      .slice(0, 3)
      .map((action) =>
        action.index === 3 ? { ...action, status: 'FAILED', reason: 'élément introuvable' } : action,
      );
    const trace = buildFrontendTrace({
      reproduction: { ...run, actions, evidence: run.evidence.filter((item) => item.source.step !== 4) },
      code: fixtureCode(),
    });
    const click = trace.steps[2];
    expect(click?.element?.status).toBe('UNKNOWN');
    expect(click?.element?.reason).toContain("n'a peut-être pas été atteint");
    expect(click?.displayedError?.status).toBe('INFERRED');
    expect(click?.displayedError?.reason).toContain('étape 3');
  });

  it('erreur affichée OBSERVED seulement quand une preuve contient le texte', () => {
    const run = failingRun();
    const trace = buildFrontendTrace({
      reproduction: {
        ...run,
        evidence: [...run.evidence, ev('issue-ISSUE-0002', 'PAGE', 4, 'UI_ERROR : Erreur inattendue.')],
      },
      code: fixtureCode(),
    });
    const shown = trace.steps[2]?.displayedError;
    expect(shown?.status).toBe('OBSERVED');
    expect(shown?.evidence[0]).toBe(`${R}:ev-issue-ISSUE-0002`);
    expect(shown?.reason).toContain('déduit du code');
  });

  it('chemin gabarit : GET /api/books/42 relié à getBook (INFERRED, base lue dans une constante)', () => {
    const code = fixtureCode();
    const OPEN = id(FORM, 'BookForm.onOpen');
    code.symbols.push(
      symbol(
        'EVENT_HANDLER',
        FORM,
        'BookForm.onOpen',
        40,
        { triggers: ['<button onClick> « Ouvrir »'] },
        BOOK_FORM,
      ),
    );
    code.calls.push({
      from: OPEN,
      to: GET,
      text: 'getBook(id)',
      status: 'STATICALLY_RESOLVED',
      file: FORM,
      line: 41,
    });
    const run = failingRun({
      actions: [
        {
          index: 1,
          kind: 'click',
          description: 'click "Ouvrir"',
          status: 'PASSED',
          durationMs: 50,
          requestIds: [`${R}:req-1-1`],
        },
      ],
      requests: [
        {
          id: `${R}:req-1-1`,
          method: 'GET',
          url: '/api/books/42',
          path: '/api/books/42',
          status: 404,
          resourceType: 'fetch',
          step: 1,
          correlation: 'OBSERVED',
        },
      ],
      evidence: [ev('action-1', 'ACTION', 1)],
    });
    const step = buildFrontendTrace({ reproduction: run, code }).steps[0];
    expect(step?.handler?.symbolId).toBe(OPEN);
    expect(step?.element).toMatchObject({ label: '« Ouvrir »', status: 'OBSERVED' });
    expect(step?.httpClients).toHaveLength(1);
    expect(step?.httpClients[0]).toMatchObject({
      status: 'INFERRED',
      symbolId: GET,
      evidence: [`${R}:req-1-1`],
    });
    expect(step?.displayedError).toBeUndefined();
  });

  it('ambiguïté : deux handlers « Enregistrer », celui qui émet la requête observée l’emporte, limite écrite', () => {
    const code = fixtureCode();
    const OTHER = id('frontend/src/authors/AuthorForm.tsx', 'AuthorForm.onSave');
    code.symbols.push(
      symbol('COMPONENT', 'frontend/src/authors/AuthorForm.tsx', 'AuthorForm', 8),
      symbol(
        'EVENT_HANDLER',
        'frontend/src/authors/AuthorForm.tsx',
        'AuthorForm.onSave',
        12,
        { triggers: ['<form onSubmit> « Enregistrer »'] },
        id('frontend/src/authors/AuthorForm.tsx', 'AuthorForm'),
      ),
    );
    const trace = buildFrontendTrace({ reproduction: failingRun(), code });
    expect(trace.steps[2]?.handler?.symbolId).toBe(ON_SAVE);
    // Sans requête pour départager : le premier par ordre de déclaration, et la limite le dit.
    const run = failingRun();
    const quiet = buildFrontendTrace({
      reproduction: {
        ...run,
        actions: run.actions.map((action) => ({ ...action, requestIds: [] })),
        requests: [],
      },
      code,
    });
    expect(quiet.steps[2]?.handler?.symbolId).toBe(OTHER);
    expect(quiet.limitations.some((entry) => entry.includes('plusieurs handlers correspondent'))).toBe(true);
    expect(quiet.limitations.some((entry) => entry.includes('peut envoyer'))).toBe(false);
  });

  it('handler qui peut envoyer une requête non observée : limite écrite', () => {
    const run = failingRun();
    const trace = buildFrontendTrace({
      reproduction: {
        ...run,
        actions: run.actions.map((action) => ({ ...action, requestIds: [] })),
        requests: [],
      },
      code: fixtureCode(),
    });
    expect(trace.steps[2]?.httpClients).toEqual([]);
    expect(
      trace.limitations.some((entry) => entry.includes('BookForm.onSave peut envoyer POST /api/books')),
    ).toBe(true);
  });

  it('profondeur des appels bornée à 4, appels non résolus en UNKNOWN', () => {
    const code = fixtureCode();
    const chainFile = 'frontend/src/books/chain.ts';
    const names = ['a1', 'a2', 'a3', 'a4', 'a5', 'a6'];
    for (const [rank, name] of names.entries())
      code.symbols.push(symbol('FUNCTION', chainFile, name, rank + 1));
    code.calls = [
      {
        from: ON_SAVE,
        to: id(chainFile, 'a1'),
        text: 'a1()',
        status: 'STATICALLY_RESOLVED',
        file: FORM,
        line: 21,
      },
      ...names.slice(1).map((name, rank) => ({
        from: id(chainFile, names[rank] ?? ''),
        to: id(chainFile, name),
        text: `${name}()`,
        status: 'INFERRED' as const,
        file: chainFile,
        line: rank + 1,
      })),
      { from: ON_SAVE, text: 'helpers.format(values)', status: 'UNKNOWN', file: FORM, line: 23 },
    ];
    const step = buildFrontendTrace({ reproduction: failingRun(), code }).steps[2];
    expect(step?.services.map((link) => link.label)).toEqual([
      'a1',
      'a2',
      'a3',
      'a4',
      'helpers.format(values)',
    ]);
    expect(step?.services.at(-1)).toMatchObject({
      status: 'UNKNOWN',
      source: { file: FORM, line: 23, symbolId: ON_SAVE },
    });
  });

  it('déclencheur non indexé (`… → save`) : composant INFERRED, handler UNKNOWN', () => {
    const code = fixtureCode();
    code.symbols = code.symbols.filter((entry) => entry.kind !== 'EVENT_HANDLER');
    code.symbols[0] = {
      ...code.symbols[0],
      detail: { handlers: ['<button onClick> « Enregistrer » → save'] },
    } as CodeSymbol;
    const step = buildFrontendTrace({ reproduction: failingRun(), code }).steps[2];
    expect(step?.component).toMatchObject({ label: 'BookForm', status: 'INFERRED' });
    expect(step?.handler).toMatchObject({ label: 'save', status: 'UNKNOWN' });
    expect(step?.services).toEqual([]);
    expect(step?.displayedError?.status).toBe('UNKNOWN');
  });

  it('description libre (« Cliquer sur Enregistrer ») : libellé cité, rapprochement plus faible', () => {
    const run = failingRun();
    const actions = run.actions.map((action) =>
      action.index === 3 ? { ...action, description: 'Cliquer sur Enregistrer' } : action,
    );
    const step = buildFrontendTrace({ reproduction: { ...run, actions }, code: fixtureCode() }).steps[2];
    expect(step?.element).toBeUndefined();
    expect(step?.handler?.symbolId).toBe(ON_SAVE);
    expect(step?.handler?.reason).toContain('cite « Enregistrer »');
  });
});

describe('lecture des descriptions et des déclencheurs', () => {
  it('parseStepTarget : rôle, libellé, texte, testId, css, citation, rien', () => {
    expect(parseStepTarget('click role=button[name="Enregistrer"]')).toMatchObject({
      strategy: 'role',
      role: 'button',
      name: 'Enregistrer',
    });
    expect(parseStepTarget('click role=link')).toMatchObject({ strategy: 'role', role: 'link' });
    expect(parseStepTarget('fill label="ISBN" = "978"')).toMatchObject({ strategy: 'label', name: 'ISBN' });
    expect(parseStepTarget('click text="Annuler"')).toMatchObject({ strategy: 'text', name: 'Annuler' });
    expect(parseStepTarget('click testId=save-book')).toMatchObject({ strategy: 'testId' });
    expect(parseStepTarget('click css=#save')).toMatchObject({ strategy: 'css', raw: 'css=#save' });
    expect(parseStepTarget('click "Enregistrer"')).toMatchObject({ strategy: 'quoted', name: 'Enregistrer' });
    expect(parseStepTarget('Cliquer sur Enregistrer')).toMatchObject({ strategy: 'none' });
  });

  it('parseTrigger : balise, prop, libellés', () => {
    expect(parseTrigger('<form onSubmit> « Enregistrer »')).toEqual({
      tag: 'form',
      prop: 'onSubmit',
      labels: ['Enregistrer'],
      raw: '<form onSubmit> « Enregistrer »',
    });
    expect(parseTrigger('<form onSubmit> « Enregistrer / Publier »')?.labels).toEqual([
      'Enregistrer',
      'Publier',
    ]);
    expect(parseTrigger('<input onChange>')?.labels).toEqual([]);
    expect(parseTrigger('n’importe quoi')).toBeUndefined();
  });
});
