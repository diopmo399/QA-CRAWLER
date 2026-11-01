import { describe, expect, it } from 'vitest';
import type { Incident, ReproductionLive, ReproductionRun } from '../../src/sdk/core/incident-contracts.js';
import { workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';
import {
  baseOrigin,
  curlOf,
  emptyReproductionUi,
  evidenceCounts,
  evidenceReproduction,
  formatElapsed,
  INCIDENT_REPRODUCTION_CSS,
  liveStamp,
  neededShots,
  reduceReproduction,
  renderEvidence,
  renderReproductionRun,
  reproductionRunning,
  reproductionState,
  reproductionTabFocus,
  runReproduction,
  type ReproductionMedia,
  type ReproductionUi,
} from '../../src/sdk/ui/incident-reproduction.js';

/**
 * LA REPRODUCTION ET LES PREUVES COLLECTÉES, sur l'incident fictif du catalogue (POST /api/books → 500) :
 * réducteur, état de la reproduction, compteur, ce qui est montré pendant le run (seulement ce que
 * l'exécution du moteur contient), aperçu et erreur de l'étape, onglets du bas, preuves par nature,
 * détail d'une requête et commande cURL reconstruite (valeurs masquées), droits, démonstration,
 * échappement, styles.
 */

const T = (time: string): string => `2026-10-30T${time}Z`;
const PNG = 'data:image/png;base64,iVBORw0KGgo=';

function reference(): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: T('09:00:00.000'),
    finishedAt: T('09:00:05.400'),
    status: 'COMPLETED',
    target: 'LOCAL',
    baseUrl: 'http://localhost:4200/',
    scenario: 'creer-livre',
    run: 'run-2026-10-30T09-00-00-000Z',
    reproduced: true,
    symptomMatch: 'observé : HTTP 500 : POST /api/books → 500 (étape 3)',
    actions: [
      {
        index: 1,
        kind: 'goto',
        description: 'Ouvrir la page de création',
        status: 'PASSED',
        startedAt: T('09:00:00.100'),
        durationMs: 2100,
        requestIds: ['rep_1:req-1-1'],
      },
      {
        index: 2,
        kind: 'fill',
        description: 'Remplir les informations <b>',
        status: 'PASSED',
        startedAt: T('09:00:02.200'),
        durationMs: 640,
        requestIds: [],
      },
      {
        index: 3,
        kind: 'click',
        description: 'Cliquer sur Enregistrer',
        status: 'FAILED',
        startedAt: T('09:00:02.900'),
        durationMs: 1200,
        reason: 'observed request POST /api/books 500 <script>',
        screenshot: 'screenshots/step-3-failed.png',
        requestIds: ['rep_1:req-3-1'],
      },
      {
        index: 4,
        kind: 'expect',
        description: 'Vérifier le résultat',
        status: 'SKIPPED',
        durationMs: 0,
        reason: 'step 3 failed',
        requestIds: [],
      },
    ],
    requests: [
      {
        id: 'rep_1:req-1-1',
        method: 'GET',
        url: '/api/books',
        path: '/api/books',
        status: 200,
        durationMs: 124,
        resourceType: 'fetch',
        step: 1,
        correlation: 'OBSERVED',
      },
      {
        id: 'rep_1:req-3-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        durationMs: 76,
        resourceType: 'fetch',
        startedAt: T('09:00:03.000'),
        step: 3,
        correlation: 'OBSERVED',
        requestBody: '{"title":"Clean Code","password":"hunter2","publisherId":null}',
        responseBody: '{"status":500,"error":"Internal Server Error"}',
        requestHeaders: {
          'content-type': 'application/json',
          'x-request-id': 'req-7',
          'content-length': '58',
          authorization: 'Bearer abcdefghijklmnop',
          cookie: 'SESSION=abc',
        },
        responseHeaders: { 'content-type': 'application/json' },
      },
    ],
    evidence: [
      {
        id: 'rep_1:ev-screenshot-3',
        kind: 'SCREENSHOT',
        at: T('09:00:02.900'),
        summary: "capture d'écran après l'étape 3",
        source: { reproduction: 'rep_1', step: 3, file: 'screenshots/step-3-failed.png' },
      },
      {
        id: 'rep_1:ev-assertion-3',
        kind: 'ASSERTION',
        at: T('09:00:02.900'),
        summary: "attente non satisfaite à l'étape 3",
        source: { reproduction: 'rep_1', step: 3 },
      },
      {
        id: 'rep_1:ev-issue-1',
        kind: 'CONSOLE',
        at: T('09:00:03.100'),
        summary: 'CONSOLE : <img src=x onerror=alert(1)>',
        source: { reproduction: 'rep_1', step: 3 },
        data: { severity: 'ERROR' },
      },
      {
        id: 'rep_1:ev-issue-2',
        kind: 'JS_ERROR',
        at: T('09:00:03.200'),
        summary: 'PAGE_ERROR : TypeError: book is undefined',
        source: { reproduction: 'rep_1', step: 3, file: 'screenshots/issue-2.png' },
        data: { severity: 'CRITICAL', stack: ['at save (BookForm.tsx:42)', 'at onClick'] },
      },
      {
        id: 'rep_1:ev-trace',
        kind: 'TRACE',
        summary: 'Trace Playwright',
        source: { reproduction: 'rep_1', file: 'trace.zip' },
      },
    ],
    screenshots: ['screenshots/step-3-failed.png', 'screenshots/issue-2.png'],
    trace: 'trace.zip',
  };
}

function running(live?: ReproductionLive): ReproductionRun {
  return {
    ...(live ? { live } : {}),
    id: 'rep_2',
    startedAt: T('09:10:00.000'),
    status: 'RUNNING',
    target: 'LOCAL',
    scenario: 'creer-livre',
    run: 'run-2026-10-30T09-10-00-000Z',
    reproduced: null,
    actions: [],
    requests: [],
    evidence: [],
    screenshots: [],
  };
}

function incident(
  options: { running?: boolean; live?: ReproductionLive; state?: Incident['state'] } = {},
): Incident {
  return {
    id: 'inc_1',
    projectId: 'prj_books',
    title: 'Erreur 500 à l’enregistrement d’un livre',
    description: 'Après Enregistrer, une erreur s’affiche.',
    observed: 'erreur HTTP 500 après Enregistrer',
    expected: 'le livre est créé',
    severity: 'HIGH',
    scenario: 'creer-livre',
    execution: { target: 'LOCAL' },
    scope: {
      mode: 'GUIDED',
      applications: [],
      scenarios: ['creer-livre'],
      steps: [],
      endpoints: [],
      allowedHosts: [],
      permissions: {
        readSources: true,
        navigate: true,
        httpRequests: 'READ_ONLY',
        runTests: 'NONE',
        localCommands: false,
        readLogs: false,
        openshift: 'NONE',
        sideEffects: false,
      },
      limits: {
        maxFiles: 100,
        maxFileBytes: 100_000,
        maxDurationMs: 600_000,
        maxRequests: 10,
        maxExperiments: 5,
      },
      extensions: [],
    },
    state: options.state ?? (options.running ? 'REPRODUCING' : 'REPRODUCED'),
    revision: 2,
    createdAt: T('08:00:00.000'),
    updatedAt: T('09:10:00.000'),
    createdBy: 'qa',
    history: [],
    investigation: {
      reproductions: options.running ? [reference(), running(options.live)] : [reference()],
      hypotheses: [],
      experiments: [],
    },
  } as unknown as Incident;
}

function context(
  value: Incident = incident(),
  options: { selection?: WorkspaceSelection; lang?: 'fr' | 'en'; can?: boolean; demo?: boolean } = {},
): WorkspaceContext {
  return workspaceContext({
    incident: value,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(value),
    demo: options.demo ?? false,
    demoInShell: true,
    can: () => options.can ?? true,
    ...(options.selection ? { selection: options.selection } : {}),
  });
}

/** Ce que le moteur a annoncé : deux étapes finies, la troisième en cours, cinq au total. */
function liveProgress(overrides: Partial<ReproductionLive> = {}): ReproductionLive {
  return {
    flow: 'creer-livre',
    total: 5,
    steps: [
      {
        index: 1,
        kind: 'goto',
        description: 'Ouvrir la page de création',
        status: 'PASSED',
        startedAt: T('09:10:01.000'),
        durationMs: 2100,
      },
      {
        index: 2,
        kind: 'fill',
        description: 'Remplir les informations',
        status: 'PASSED',
        startedAt: T('09:10:03.100'),
        durationMs: 5800,
        screenshot: 'screenshots/live-step-2.png',
      },
      {
        index: 3,
        kind: 'click',
        description: 'Cliquer sur Enregistrer <i>',
        status: 'RUNNING',
        startedAt: T('09:10:08.900'),
      },
    ],
    current: 3,
    updatedAt: T('09:10:09.000'),
    latestScreenshot: 'screenshots/live-step-2.png',
    ...overrides,
  };
}

const ui = (patch: Partial<ReproductionUi> = {}): ReproductionUi => ({ ...emptyReproductionUi(), ...patch });
const shots: ReproductionMedia = { shot: () => ({ dataUrl: PNG }) };

describe('reduceReproduction', () => {
  it('switches tabs of the three groups, ignores unknown tabs and keeps the object when nothing changes', () => {
    const start = ui();
    expect(reduceReproduction(start, 'ws-repro-tab', { tab: 'console' })?.runTab).toBe('console');
    expect(reduceReproduction(start, 'ws-repro-ev-tab', { tab: 'actions' })?.evidenceTab).toBe('actions');
    expect(reduceReproduction(start, 'ws-repro-req-tab', { tab: 'curl' })?.requestTab).toBe('curl');
    expect(reduceReproduction(start, 'ws-repro-tab', { tab: 'nope' })).toBe(start);
    expect(reduceReproduction(start, 'ws-repro-tab', { tab: 'shots' })).toBe(start);
    expect(reduceReproduction(start, 'ws-other', {})).toBeUndefined();
  });

  it('moves through a tab list with the keyboard (wrapping, Home, End) and names the element to focus', () => {
    let state = ui();
    state = reduceReproduction(state, 'ws-repro-key', { group: 'run', key: 'ArrowLeft' }) ?? state;
    expect(state.runTab).toBe('http');
    state = reduceReproduction(state, 'ws-repro-key', { group: 'run', key: 'ArrowRight' }) ?? state;
    expect(state.runTab).toBe('shots');
    state = reduceReproduction(state, 'ws-repro-key', { group: 'ev', key: 'End' }) ?? state;
    expect(state.evidenceTab).toBe('actions');
    state = reduceReproduction(state, 'ws-repro-key', { group: 'req', key: 'End' }) ?? state;
    state = reduceReproduction(state, 'ws-repro-key', { group: 'req', key: 'Home' }) ?? state;
    expect(state.requestTab).toBe('details');
    expect(reproductionTabFocus(state, 'ev')).toBe('#ws-repro-ev-tab-actions');
    expect(reduceReproduction(state, 'ws-repro-key', { group: 'zz', key: 'End' })).toBe(state);
    expect(reduceReproduction(state, 'ws-repro-key', { group: 'run', key: 'Enter' })).toBe(state);
  });

  it('picks a reproduction (resetting the focused request and screenshot), a screenshot, the error toggle', () => {
    const state = ui({ request: 'r', shot: 's', confirmStop: true });
    const picked = reduceReproduction(state, 'ws-repro-pick', { value: 'rep_1' });
    expect(picked).toMatchObject({ reproduction: 'rep_1', confirmStop: false });
    expect(picked?.request).toBeUndefined();
    expect(picked?.shot).toBeUndefined();
    expect(reduceReproduction(picked ?? state, 'ws-repro-pick', { value: '' })?.reproduction).toBeUndefined();
    expect(reduceReproduction(state, 'ws-repro-shot', { file: 'a.png' })?.shot).toBe('a.png');
    expect(reduceReproduction(state, 'ws-repro-shot', {})).toBe(state);
    expect(reduceReproduction(state, 'ws-repro-ev-errors', {})?.errorsOnly).toBe(true);
  });

  it('« Voir les preuves associées » opens the tab of the evidence', () => {
    const state = ui({ requestTab: 'curl' });
    expect(reduceReproduction(state, 'ws-repro-ev-show', { kind: 'request', ref: 'r1' })).toMatchObject({
      evidenceTab: 'http',
      request: 'r1',
      requestTab: 'details',
    });
    expect(
      reduceReproduction(state, 'ws-repro-ev-show', { kind: 'evidence', ref: 'e', evkind: 'JS_ERROR' })
        ?.evidenceTab,
    ).toBe('console');
    expect(
      reduceReproduction(state, 'ws-repro-ev-show', {
        kind: 'evidence',
        ref: 'e',
        evkind: 'SCREENSHOT',
        file: 'x.png',
      }),
    ).toMatchObject({ evidenceTab: 'shots', shot: 'x.png' });
    expect(
      reduceReproduction(state, 'ws-repro-ev-show', { kind: 'evidence', ref: 'e', evkind: 'TRACE' })
        ?.evidenceTab,
    ).toBe('traces');
    expect(
      reduceReproduction(state, 'ws-repro-ev-show', { kind: 'evidence', ref: 'e', evkind: 'ASSERTION' })
        ?.evidenceTab,
    ).toBe('actions');
    expect(reduceReproduction(state, 'ws-repro-ev-show', { kind: 'request' })).toBe(state);
  });

  it('asks for a confirmation before stopping; « Continuer », the confirmation and a new run close it', () => {
    const asked = reduceReproduction(ui(), 'ws-repro-stop', {}) ?? ui();
    expect(asked.confirmStop).toBe(true);
    for (const action of ['ws-repro-stop-no', 'ws-repro-stop-yes', 'ws-repro-start'])
      expect(reduceReproduction(asked, action, {})?.confirmStop).toBe(false);
    const idle = ui();
    expect(reduceReproduction(idle, 'ws-repro-start', {})).toBe(idle);
  });
});

describe('reproduction data', () => {
  it('maps the run to its state, only « Reproduit » when the symptom was observed', () => {
    expect(reproductionState({ status: 'RUNNING', reproduced: null })).toBe('RUNNING');
    expect(reproductionState({ status: 'COMPLETED', reproduced: true })).toBe('REPRODUCED');
    expect(reproductionState({ status: 'COMPLETED', reproduced: false })).toBe('NOT_REPRODUCED');
    expect(reproductionState({ status: 'COMPLETED', reproduced: null })).toBe('FAILED');
    expect(reproductionState({ status: 'FAILED', reproduced: null })).toBe('FAILED');
    expect(reproductionState({ status: 'CANCELLED', reproduced: null })).toBe('CANCELLED');
  });

  it('follows the latest run of the scenario (even running), the evidence screen the reference', () => {
    const ctx = context(incident({ running: true }));
    expect(runReproduction(ctx, ui())?.id).toBe('rep_2');
    expect(evidenceReproduction(ctx, ui())?.id).toBe('rep_1');
    expect(runReproduction(ctx, ui({ reproduction: 'rep_1' }))?.id).toBe('rep_1');
    expect(reproductionRunning(ctx, ui())).toBe(true);
    expect(reproductionRunning(ctx, ui({ reproduction: 'rep_1' }))).toBe(false);
    expect(reproductionRunning(context(), ui())).toBe(false);
  });

  it('liveStamp changes with each signal of the engine (the revision does not), empty when nothing runs', () => {
    expect(liveStamp(incident())).toBe('');
    expect(liveStamp(incident({ running: true }))).toBe('rep_2@#0');
    const first = liveStamp(incident({ running: true, live: liveProgress() }));
    expect(first).toBe(`rep_2@${T('09:10:09.000')}#3`);
    expect(
      liveStamp(incident({ running: true, live: liveProgress({ updatedAt: T('09:10:10.000') }) })),
    ).not.toBe(first);
  });

  it('formats an elapsed time as hh:mm:ss (never negative)', () => {
    expect(formatElapsed(83_400)).toBe('00:01:23');
    expect(formatElapsed(3_723_000)).toBe('01:02:03');
    expect(formatElapsed(-5)).toBe('00:00:00');
    expect(formatElapsed(Number.NaN)).toBe('00:00:00');
  });

  it('counts evidence from the reproduction only', () => {
    expect(evidenceCounts(reference())).toEqual({ http: 2, console: 2, shots: 2, traces: 1, actions: 4 });
  });

  it('asks for the screenshots of the shown view: the preview first; during the run, the announced ones', () => {
    const ctx = context();
    expect(neededShots(ctx, ui(), 'run')).toEqual([
      { reproduction: 'rep_1', file: 'screenshots/step-3-failed.png' },
      { reproduction: 'rep_1', file: 'screenshots/issue-2.png' },
    ]);
    expect(neededShots(ctx, ui({ runTab: 'console' }), 'run')).toHaveLength(1);
    expect(neededShots(ctx, ui(), 'evidence')).toEqual([]);
    expect(neededShots(ctx, ui({ evidenceTab: 'shots' }), 'evidence')).toHaveLength(2);
    expect(neededShots(context(incident({ running: true })), ui(), 'run')).toEqual([]);
    const live = liveProgress({ latestScreenshot: 'screenshots/live-latest.png' });
    expect(neededShots(context(incident({ running: true, live })), ui(), 'run')).toEqual([
      { reproduction: 'rep_2', file: 'screenshots/live-latest.png' },
      { reproduction: 'rep_2', file: 'screenshots/live-step-2.png' },
    ]);
  });
});

describe('curlOf', () => {
  const post = reference().requests[1];
  if (!post) throw new Error('fixture');

  it('rebuilds the command: method, origin + path, allowlisted headers, masked body', () => {
    const command = curlOf(post, 'http://user:secret@localhost:4200/app/');
    expect(command.split(' \\\n  ')).toEqual([
      "curl -X POST 'http://localhost:4200/api/books'",
      "-H 'content-type: application/json'",
      "-H 'x-request-id: req-7'",
      `--data-raw '{"title":"Clean Code","password":"[REDACTED]","publisherId":null}'`,
    ]);
    expect(command).not.toMatch(/hunter2|abcdefghijklmnop|SESSION|content-length|secret/);
  });

  it('omits -X for GET, uses $BASE_URL without a usable base, quotes apostrophes', () => {
    const get = curlOf({ method: 'get', path: "/api/books/l'atlas" });
    expect(get).toBe(`curl "$BASE_URL"'/api/books/l'\\''atlas'`);
    expect(curlOf({ method: 'GET', path: '/x' }, 'javascript:alert(1)')).toBe(`curl "$BASE_URL"'/x'`);
    expect(baseOrigin('not a url')).toBeUndefined();
    expect(
      curlOf({ method: 'DELETE', path: 'api/x', requestBody: 'token=abc123456' }, 'https://h.test'),
    ).toBe("curl -X DELETE 'https://h.test/api/x' \\\n  --data-raw 'token=[REDACTED]'");
  });
});

describe('renderReproductionRun', () => {
  it('a finished run: scenario, « Reproduit », measured duration, steps, preview with the error, tabs', () => {
    const html = renderReproductionRun(context(), ui(), shots);
    expect(html).toContain('Scénario :</span> creer-livre');
    expect(html).toContain('>Reproduit</span>');
    expect(html).toContain('data-ws-ticking="false">00:00:05</span>');
    expect(html).toContain('data-action="ws-repro-start"');
    expect(html).toContain('Reproduire de nouveau');
    expect(html).not.toContain('data-action="ws-repro-stop"');
    // Les étapes : statut, durée mesurée, « non jouée » pour l'étape sautée, raison de l'échec.
    expect(html.match(/class="ws-repro-step /g)).toHaveLength(4);
    expect(html).toContain('ws-repro-st-failed');
    expect(html).toContain('2,1 s');
    expect(html).toContain('640 ms');
    expect(html).toContain('non jouée');
    expect(html).toContain('data-kind="step" data-ref="rep_1#3"');
    expect(html).not.toContain('ws-repro-ico-running');
    // L'aperçu : la capture de l'étape 3, l'erreur de l'étape posée dessus.
    expect(html).toContain(`<img class="ws-repro-img" src="${PNG}" alt="capture après l’étape 3"`);
    expect(html).toContain('Étape 3 en échec');
    expect(html).toContain('<code>POST /api/books</code></button> <span class="pill ko">500</span>');
    // Les onglets du bas et leurs nombres.
    expect(html).toContain('role="tablist"');
    expect(html).toMatch(/Captures d’écran <span class="ws-repro-count">\(2\)<\/span>/);
    expect(html).toMatch(/Console <span class="ws-repro-count">\(2\)<\/span>/);
    expect(html).toMatch(/Requêtes HTTP <span class="ws-repro-count">\(2\)<\/span>/);
    expect(html).toContain('id="ws-repro-run-tab-shots" class="ws-repro-tab" aria-selected="true"');
    expect(html.match(/class="ws-repro-thumb /g)).toHaveLength(2);
    expect(html).toContain('ws-repro-thumb ws-repro-on');
    expect(html).toContain('capture de l’anomalie (Erreur JavaScript, étape 3)');
    expect(html).toContain('data-kind="evidence" data-ref="rep_1:ev-screenshot-3"');
  });

  it('bottom tabs: console, trace (path and command), HTTP with « Voir dans Preuves »', () => {
    const consoleHtml = renderReproductionRun(context(), ui({ runTab: 'console' }), shots);
    expect(consoleHtml).toContain('Erreur JavaScript');
    expect(consoleHtml).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const trace = renderReproductionRun(context(), ui({ runTab: 'traces' }), shots);
    expect(trace).toContain('qa-reports/run-2026-10-30T09-00-00-000Z/trace.zip');
    expect(trace).toContain('npx playwright show-trace qa-reports/run-2026-10-30T09-00-00-000Z/trace.zip');
    expect(trace).toContain('ne s’affiche pas dans le Dashboard');
    const http = renderReproductionRun(context(), ui({ runTab: 'http' }), shots);
    expect(http).toContain('data-action="ws-repro-ev-show" data-kind="request" data-ref="rep_1:req-3-1"');
    expect(http).toContain('class="ws-repro-ko ');
  });

  it('while running, before any signal of the engine: « en attente du moteur », a ticking timer, « Arrêter »', () => {
    const ctx = context(incident({ running: true }));
    const html = renderReproductionRun(ctx, ui(), { now: Date.parse(T('09:11:23.500')) });
    expect(html).toContain('data-state="RUNNING"');
    expect(html).toContain('>En cours</span>');
    expect(html).toContain('role="timer"');
    expect(html).toContain(`data-ws-elapsed-from="${T('09:10:00.000')}" data-ws-ticking="true">00:01:23`);
    expect(html).toContain('En attente du moteur : aucune étape annoncée pour l’instant.');
    expect(html).not.toContain('class="ws-repro-steps"');
    expect(html).not.toContain('ws-repro-ico-running');
    expect(html).toContain('Aucune capture pour l’instant');
    expect(html).not.toContain('<img');
    expect(html).toContain('data-action="ws-repro-stop"');
    expect(html).toMatch(
      /data-action="ws-repro-start" disabled title="Une reproduction est déjà en cours\."/,
    );
    // Sans heure courante : un compteur neutre jusqu'au premier tic du contrôleur.
    expect(renderReproductionRun(ctx, ui())).toContain('data-ws-ticking="true">--:--:--');
    const confirm = renderReproductionRun(ctx, ui({ confirmStop: true }));
    expect(confirm).toContain('data-action="ws-repro-stop-yes"');
    expect(confirm).toContain('data-action="ws-repro-stop-no"');
    expect(confirm).toContain('Arrêter annule l’investigation');
    expect(confirm).toContain('aria-labelledby="ws-repro-stop-hint"');
    // Le flow annoncé, sans étape commencée.
    const started = renderReproductionRun(
      context(incident({ running: true, live: liveProgress({ steps: [], latestScreenshot: undefined }) })),
      ui(),
    );
    expect(started).toContain('Flow « creer-livre » démarré : aucune étape commencée pour l’instant.');
    expect(started).toContain('5 étape(s) à venir');
  });

  it('while running: the steps the engine started (current one « en cours », no duration), n / total', () => {
    const ctx = context(incident({ running: true, live: liveProgress() }));
    const html = renderReproductionRun(ctx, ui(), { shot: () => ({ dataUrl: PNG }) });
    expect(html.match(/class="ws-repro-step /g)).toHaveLength(3);
    expect(html).toContain('<div class="ws-repro-stepb">');
    expect(html).not.toContain('data-ref="rep_2#1"');
    expect(html).toContain('2,1 s');
    expect(html).toContain('5,8 s');
    expect(html).toMatch(/ws-repro-st-running " title="En cours" aria-current="step"/);
    expect(html).toContain('<span class="ws-repro-now">en cours</span>');
    expect(html).toContain('Cliquer sur Enregistrer &lt;i&gt;');
    // n / total, sans libellé inventé pour les étapes à venir.
    expect(html).toContain('<span aria-hidden="true">3 / 5</span><progress max="5" value="3"');
    expect(html).toContain('3 étape(s) commencée(s) sur 5 annoncée(s) par le moteur');
    expect(html).toContain('2 étape(s) à venir : leur libellé apparaît quand le moteur les commence.');
    expect(html).toContain(`<time datetime="${T('09:10:09.000')}">Dernier signal du moteur :`);
    // L'aperçu : la dernière capture réellement écrite.
    expect(html).toContain(`<img class="ws-repro-img" src="${PNG}" alt="capture après l’étape 2"`);
    expect(html).toMatch(/Captures d’écran <span class="ws-repro-count">\(1\)<\/span>/);
    expect(html).not.toContain('ws-repro-toast');
  });

  it('while running: a failed step shows its reason on the preview; a capture of the running step', () => {
    const live = liveProgress({
      steps: [
        {
          index: 1,
          kind: 'click',
          description: 'Cliquer sur Enregistrer',
          status: 'FAILED',
          durationMs: 1200,
          reason: 'HTTP 500 <b>',
          screenshot: 'screenshots/live-1.png',
        },
        {
          index: 2,
          kind: 'expect',
          description: 'Vérifier',
          status: 'RUNNING',
          screenshot: 'screenshots/live-2.png',
        },
      ],
      latestScreenshot: 'screenshots/live-2.png',
    });
    const html = renderReproductionRun(context(incident({ running: true, live })), ui(), {
      shot: () => ({ dataUrl: PNG }),
    });
    expect(html).toContain('Étape 1 en échec');
    expect(html).toContain('HTTP 500 &lt;b&gt;');
    expect(html).toContain('Aperçu : dernière capture du run (étape 2)');
    expect(html).toMatch(/Captures d’écran <span class="ws-repro-count">\(2\)<\/span>/);
    // Pas de capture écrite : « aucune capture pour l'instant ».
    const none = renderReproductionRun(
      context(incident({ running: true, live: liveProgress({ latestScreenshot: undefined, steps: [] }) })),
      ui(),
    );
    expect(none).toContain('Aucune capture pour l’instant');
  });

  it('rights and demonstration: actions disabled with their reason; demo screenshots are said absent', () => {
    const denied = renderReproductionRun(context(incident(), { can: false }), ui(), shots);
    expect(denied).toMatch(/data-action="ws-repro-start" disabled title="Votre rôle ne permet pas/);
    const runningDenied = renderReproductionRun(
      context(incident({ running: true }), { can: false }),
      ui({ confirmStop: true }),
    );
    expect(runningDenied).toMatch(/data-action="ws-repro-stop" disabled title="Votre rôle/);
    expect(runningDenied).not.toContain('ws-repro-stop-yes');
    const demo = renderReproductionRun(context(incident(), { demo: true }), ui());
    expect(demo).toMatch(/data-action="ws-repro-start" disabled title="Indisponible dans la démonstration/);
    expect(demo).toContain('n’est pas incluse dans les données de démonstration');
    const cancelled = renderReproductionRun(context(incident({ state: 'CANCELLED' })), ui());
    expect(cancelled).toMatch(/disabled title="Indisponible dans l’état « Annulé »/);
    const drafted = { ...incident(), scenario: undefined } as Incident;
    expect(renderReproductionRun(context(drafted), ui())).toMatch(
      /data-action="ws-repro-start" disabled title="L’incident n’a pas de scénario à rejouer/,
    );
    const empty = {
      ...drafted,
      investigation: { reproductions: [], hypotheses: [], experiments: [] },
    } as Incident;
    expect(renderReproductionRun(context(empty), ui())).toContain('Aucune reproduction');
  });

  it('screenshot states: loading, refused, error with retry, invalid image never shown', () => {
    const run = (media: ReproductionMedia): string => renderReproductionRun(context(), ui(), media);
    expect(run({ shot: () => ({ state: 'loading' }) })).toContain('Chargement de la capture…');
    expect(run({ shot: () => ({ state: 'denied' }) })).toContain('ne permet pas de voir les captures');
    expect(run({ shot: () => ({ state: { error: 'introuvable' } }) })).toContain(
      'data-action="ws-shot-reload"',
    );
    const invalid = run({ shot: () => ({ dataUrl: 'javascript:alert(1)' }) });
    expect(invalid).not.toContain('javascript:alert');
    expect(invalid).toContain('Format de capture non pris en charge');
  });

  it('selecting a screenshot evidence shows it in the preview; a reproduction picker when several exist', () => {
    const ctx = context(incident({ running: true }), {
      selection: { kind: 'evidence', id: 'rep_1:ev-issue-2' },
    });
    const html = renderReproductionRun(ctx, ui({ reproduction: 'rep_1' }), shots);
    expect(html).toContain('alt="capture après l’étape 3"');
    expect(html).toContain('Aperçu : capture de l’anomalie (Erreur JavaScript, étape 3)');
    expect(renderReproductionRun(context(), ui({ shot: 'screenshots/issue-2.png' }), shots)).toContain(
      'Aperçu : capture de l’anomalie',
    );
    // Sans choix : la dernière capture prise après une étape.
    expect(renderReproductionRun(context(), ui(), shots)).toContain('Aperçu : capture après l’étape 3');
    expect(html).toContain('<select data-action="ws-repro-pick">');
    expect(html).toContain('<option value="rep_1" selected>');
  });

  it('escapes every value and speaks English', () => {
    const html = renderReproductionRun(context(), ui(), shots);
    expect(html).toContain('Remplir les informations &lt;b&gt;');
    expect(html).not.toContain('<script>');
    const en = renderReproductionRun(context(incident(), { lang: 'en' }), ui(), shots);
    expect(en).toContain('Scenario:');
    expect(en).toContain('Reproduce again');
    expect(en).toContain('Step 3 failed');
  });
});

describe('renderEvidence', () => {
  it('tabs with counts; the HTTP table (#, method, URL, status, duration, action), error rows marked', () => {
    const html = renderEvidence(context(), ui());
    for (const [label, count] of [
      ['Requêtes HTTP', 2],
      ['Console', 2],
      ['Captures d’écran', 2],
      ['Traces', 1],
      ['Actions', 4],
    ] as const)
      expect(html).toContain(`${label} <span class="ws-repro-count">(${String(count)})</span>`);
    expect(html).toContain('<th scope="col">URL</th>');
    expect(html.match(/<tr class="ws-repro-tr/g)).toHaveLength(2);
    expect(html).toMatch(/<tr class="ws-repro-tr ws-repro-tr-ko ws-repro-tr-on/);
    expect(html).toContain('Cliquer sur Enregistrer</button>');
    expect(html).toContain('124 ms');
    // Sans sélection : la première requête en erreur est détaillée, et l'écran le dit.
    expect(html).toContain('Première requête en erreur');
    expect(html).toContain('id="ws-repro-req-tab-details" class="ws-repro-tab" aria-selected="true"');
  });

  it('the selected request is detailed; its sub-tabs: headers filtered, payload and response masked', () => {
    const ctx = context(incident(), { selection: { kind: 'request', id: 'rep_1:req-1-1' } });
    expect(renderEvidence(ctx, ui())).not.toContain('Première requête en erreur');
    expect(renderEvidence(ctx, ui())).toContain(
      '<code>GET</code> <code class="ws-repro-msg">/api/books</code>',
    );
    const focused = ui({ request: 'rep_1:req-3-1' });
    const headers = renderEvidence(context(), { ...focused, requestTab: 'headers' });
    expect(headers).toContain('<code>x-request-id</code>');
    expect(headers).not.toMatch(/authorization|abcdefghijklmnop|SESSION=abc/);
    const payload = renderEvidence(context(), { ...focused, requestTab: 'payload' });
    expect(payload).toContain('&quot;password&quot;: &quot;[REDACTED]&quot;');
    expect(payload).not.toContain('hunter2');
    const response = renderEvidence(context(), { ...focused, requestTab: 'response' });
    expect(response).toContain('Internal Server Error');
    const details = renderEvidence(context(), focused);
    expect(details).toContain('Vue pendant la fenêtre réseau de l’action.');
    expect(details).toContain('Aucun nœud du graphe ne cite cette requête.');
  });

  it('cURL: the reconstructed command with its masked-values note and the base URL caveat', () => {
    const html = renderEvidence(context(), ui({ request: 'rep_1:req-3-1', requestTab: 'curl' }));
    expect(html).toContain('curl -X POST &#39;http://localhost:4200/api/books&#39;');
    expect(html).toContain('les valeurs sensibles sont masquées ([REDACTED])');
    expect(html).toContain('pas la requête exacte');
    expect(html).toContain(
      'L’hôte n’est pas capturé : l’URL de base est celle de l’application rejouée (http://localhost:4200)',
    );
    expect(html).not.toContain('hunter2');
  });

  it('only the failing exchanges on demand', () => {
    const html = renderEvidence(context(), ui({ errorsOnly: true }));
    expect(html.match(/<tr class="ws-repro-tr/g)).toHaveLength(1);
    expect(html).toContain('1 requête(s) sur 2');
    expect(html).toContain('data-action="ws-repro-ev-errors" checked');
  });

  it('console (with call stack), screenshots (large view), trace, actions', () => {
    const consoleTab = renderEvidence(context(), ui({ evidenceTab: 'console' }));
    expect(consoleTab).toContain('Pile d’appels');
    expect(consoleTab).toContain('at save (BookForm.tsx:42)');
    expect(consoleTab).toContain('<span class="pill mu">CRITICAL</span>');
    const shotsTab = renderEvidence(context(), ui({ evidenceTab: 'shots' }), shots);
    expect(shotsTab).toContain('class="ws-repro-large"');
    expect(shotsTab).toContain('<code>screenshots/step-3-failed.png</code>');
    const traces = renderEvidence(context(), ui({ evidenceTab: 'traces' }));
    expect(traces).toContain('npx playwright show-trace');
    const actions = renderEvidence(context(), ui({ evidenceTab: 'actions' }));
    expect(actions).toContain('<code>click</code>');
    expect(actions).toContain('non jouée');
    expect(actions).toContain('Assertions non satisfaites');
    expect(actions).toContain('observed request POST /api/books 500 &lt;script&gt;');
  });

  it('without a finished reproduction, or while it runs, says so', () => {
    const none = {
      ...incident(),
      investigation: { reproductions: [], hypotheses: [], experiments: [] },
    } as Incident;
    expect(renderEvidence(context(none), ui())).toContain('Aucune reproduction terminée');
    const runningOnly = incident({ running: true });
    runningOnly.investigation.reproductions = [running()];
    expect(renderEvidence(context(runningOnly), ui())).toContain(
      'Reproduction en cours : les preuves sont lues à la fin du run.',
    );
    const noTrace = { ...reference(), trace: undefined };
    const value = incident();
    value.investigation.reproductions = [noTrace];
    expect(renderEvidence(context(value), ui({ evidenceTab: 'traces' }))).toContain(
      'Aucune trace Playwright',
    );
  });

  it('English', () => {
    const html = renderEvidence(context(incident(), { lang: 'en' }), ui({ requestTab: 'curl' }));
    expect(html).toContain('Collected evidence');
    expect(html).toContain('Reconstructed cURL command');
  });
});

describe('INCIDENT_REPRODUCTION_CSS', () => {
  it('theme tokens only, readable status texts, visible focus, reduced motion, narrow layout', () => {
    expect(INCIDENT_REPRODUCTION_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    expect(INCIDENT_REPRODUCTION_CSS.replace(/[^}\n]*\.ico\{[^}]*\}/g, '')).not.toMatch(
      /[;{]color:var\(--qa-color-(danger|success|warning|primary)\)/,
    );
    const selectors = INCIDENT_REPRODUCTION_CSS.match(/(^|[},])\s*\.[a-z-]+/gm) ?? [];
    for (const selector of selectors) expect(selector).toMatch(/\.ws-repro(-|$)/);
    expect(INCIDENT_REPRODUCTION_CSS).toContain(':focus-visible');
    expect(INCIDENT_REPRODUCTION_CSS).toContain('prefers-reduced-motion');
    expect(INCIDENT_REPRODUCTION_CSS).toContain('@media (max-width:900px)');
  });
});
