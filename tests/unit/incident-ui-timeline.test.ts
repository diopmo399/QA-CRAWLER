import { describe, expect, it } from 'vitest';
import type { Incident, ReproductionRun } from '../../src/incident/model.js';
import { buildTimeline } from '../../src/incident/timeline.js';
import { workspaceLinks, type WorkspaceSelection } from '../../src/sdk/ui/incident-links.js';
import { workspaceContext, type Lang, type WorkspaceContext } from '../../src/sdk/ui/incident-parts.js';
import {
  emptyTimelineUi,
  INCIDENT_TIMELINE_CSS,
  prettyBody,
  reduceTimeline,
  renderLogs,
  renderRequestDetail,
  renderRequests,
  renderScreenshot,
  renderTimeline,
  visibleEvents,
  type TimelineUi,
} from '../../src/sdk/ui/incident-timeline.js';

/**
 * LA CHRONOLOGIE, LES REQUÊTES HTTP ET LES JOURNAUX dans l'espace d'investigation, sur l'incident fictif
 * du catalogue (POST /api/books → 500) : critères d'affichage (couche, étape, statut, période,
 * reproduction, relié à la sélection), détail d'une requête (corps masqués, JSON mis en forme, en-têtes
 * de la liste blanche, corrélation, nœuds du graphe), journaux, captures, échappement.
 */

const T = (time: string): string => `2026-10-30T${time}Z`;

function reference(): ReproductionRun {
  return {
    id: 'rep_1',
    startedAt: T('08:59:59.000'),
    finishedAt: T('09:00:05.000'),
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre',
    reproduced: true,
    actions: [
      {
        index: 1,
        kind: 'goto',
        description: 'goto /books/new',
        status: 'PASSED',
        startedAt: T('09:00:00.000'),
        durationMs: 1000,
        requestIds: ['rep_1:req-1-1'],
      },
      {
        index: 2,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        startedAt: T('09:00:01.000'),
        durationMs: 1000,
        requestIds: ['rep_1:req-2-1'],
      },
    ],
    requests: [
      {
        id: 'rep_1:req-1-1',
        method: 'GET',
        url: '/api/publishers',
        path: '/api/publishers',
        status: 200,
        resourceType: 'fetch',
        step: 1,
        correlation: 'OBSERVED',
      },
      {
        id: 'rep_1:req-2-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books',
        status: 500,
        durationMs: 85,
        resourceType: 'fetch',
        startedAt: T('09:00:01.100'),
        step: 2,
        correlation: 'OBSERVED',
        requestBody: '{"title":"Le Petit Atlas","token":"raw-token-value","publisher":null}',
        responseBody: '{"status":500,"error":"Internal Server Error","path":"/api/books"}',
        requestHeaders: {
          'content-type': 'application/json',
          'x-request-id': 'req-<7>',
          // Jamais gardé par le moteur ; l'interface l'écarte quand même.
          authorization: 'Bearer abcdefghijklmnop',
        },
        responseHeaders: { 'content-type': 'application/problem+json', 'x-request-id': 'req-<7>' },
      },
      {
        id: 'rep_1:req-x-1',
        method: 'GET',
        url: '/api/stats',
        path: '/api/stats/<script>',
        status: 404,
        resourceType: 'xhr',
        startedAt: T('09:00:01.500'),
        step: 2,
        correlation: 'INFERRED',
        responseBody: 'Not found …[truncated]',
      },
    ],
    evidence: [
      {
        id: 'rep_1:ev-action-1',
        kind: 'ACTION',
        at: T('09:00:00.000'),
        summary: 'étape 1',
        source: { reproduction: 'rep_1', step: 1 },
      },
      {
        id: 'rep_1:ev-action-2',
        kind: 'ACTION',
        at: T('09:00:01.000'),
        summary: 'étape 2',
        source: { reproduction: 'rep_1', step: 2 },
      },
      {
        id: 'rep_1:ev-issue-ISSUE-0001',
        kind: 'CONSOLE',
        at: T('09:00:01.300'),
        summary: 'CONSOLE : <img src=x onerror=alert(1)>',
        source: { reproduction: 'rep_1', step: 2 },
        data: { issueId: 'ISSUE-0001', severity: 'ERROR' },
      },
      {
        id: 'rep_1:ev-trace',
        kind: 'TRACE',
        summary: 'Trace Playwright',
        source: { reproduction: 'rep_1', file: 'trace.zip' },
      },
    ],
    screenshots: [],
  };
}

function replay(): ReproductionRun {
  return {
    id: 'rep_2',
    startedAt: T('09:10:00.000'),
    finishedAt: T('09:10:02.000'),
    status: 'COMPLETED',
    target: 'LOCAL',
    scenario: 'creer-livre-avec-editeur',
    reproduced: false,
    actions: [
      {
        index: 1,
        kind: 'click',
        description: 'click "Enregistrer"',
        status: 'PASSED',
        startedAt: T('09:10:00.000'),
        durationMs: 800,
        requestIds: ['rep_2:req-1-1'],
      },
    ],
    requests: [
      {
        id: 'rep_2:req-1-1',
        method: 'POST',
        url: '/api/books',
        path: '/api/books/created-in-replay',
        status: 201,
        durationMs: 40,
        resourceType: 'fetch',
        startedAt: T('09:10:00.100'),
        step: 1,
        correlation: 'OBSERVED',
      },
    ],
    evidence: [],
    screenshots: [],
  };
}

function incident(options: { logs?: boolean; readLogs?: boolean } = {}): Incident {
  const base: Incident = {
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
      applications: [
        {
          id: 'bff',
          name: 'BFF du catalogue',
          layer: 'BFF',
          repository: { root: '/repos/bff', include: [] },
          logFiles: ['logs/bff.log'],
        },
      ],
      scenarios: ['creer-livre'],
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
        readLogs: options.readLogs ?? true,
        openshift: 'READ',
        sideEffects: false,
      },
      limits: {
        maxFiles: 2000,
        maxFileBytes: 524288,
        maxDurationMs: 600000,
        maxRequests: 50,
        maxExperiments: 10,
      },
      extensions: [],
    },
    state: 'INVESTIGATING',
    revision: 3,
    createdAt: T('08:58:00.000'),
    updatedAt: T('09:12:05.000'),
    createdBy: 'lecteur',
    history: [
      { at: T('08:58:00.000'), actor: 'lecteur', kind: 'CREATED', message: 'incident déclaré' },
      { at: T('09:00:06.000'), actor: 'lecteur', kind: 'STATE', message: 'REPRODUCING → REPRODUCED' },
    ],
    investigation: {
      reproductions: [reference(), replay()],
      graph: {
        nodes: [
          {
            id: 'request:POST /api/books',
            kind: 'REQUEST',
            label: 'POST /api/books → 500',
            layer: 'NETWORK',
            evidence: ['rep_1:req-2-1'],
          },
          {
            id: 'bff:BookController.create',
            kind: 'BFF_ENDPOINT',
            label: 'BookController.create',
            layer: 'BFF',
            evidence: ['rep_1:req-2-1'],
            source: {
              applicationId: 'bff',
              layer: 'BFF',
              file: 'src/main/java/org/example/bff/BookController.java',
              line: 42,
            },
          },
          { id: 'catalog:Other', kind: 'BACKEND_SERVICE', label: 'Autre', layer: 'BACKEND', evidence: [] },
        ],
        edges: [],
      },
      hypotheses: [],
      experiments: options.logs
        ? [
            {
              id: 'exp_1',
              kind: 'INSPECT_LOGS',
              description: 'Chercher NullPointerException',
              params: { patterns: ['NullPointerException'] },
              status: 'DONE',
              sideEffects: false,
              decisions: [],
              outcome: 'SUPPORTS',
              summary: 'NullPointerException trouvé(s) dans les journaux',
              startedAt: T('09:12:00.000'),
              finishedAt: T('09:12:05.000'),
              evidence: [
                {
                  id: 'exp_1:ev1',
                  kind: 'LOG_LINE',
                  at: T('09:12:04.000'),
                  summary: 'ERROR BookController - java.lang.NullPointerException <b>',
                  source: { experiment: 'exp_1', file: 'logs/bff.log' },
                  data: { source: 'logs/bff.log', pattern: 'NullPointerException', at: T('09:00:01.150') },
                },
                {
                  id: 'exp_1:ev2',
                  kind: 'LOG_LINE',
                  at: T('09:12:04.500'),
                  summary: '\tat org.example.catalog.CatalogService.create(CatalogService.java:42)',
                  source: { experiment: 'exp_1' },
                  data: { source: 'openshift catalogue app=catalog-api', pattern: 'CatalogService' },
                },
              ],
            },
          ]
        : [],
    },
  };
  base.investigation.timeline = buildTimeline(base);
  return base;
}

const ctxOf = (
  value: Incident,
  options: { lang?: Lang; selection?: WorkspaceSelection } = {},
): WorkspaceContext =>
  workspaceContext({
    incident: value,
    lang: options.lang ?? 'fr',
    links: workspaceLinks(value),
    demo: false,
    can: () => true,
    ...(options.selection ? { selection: options.selection } : {}),
  });

const ui = (over: Partial<TimelineUi> = {}): TimelineUi => ({ ...emptyTimelineUi(), ...over });
const ids = (ctx: WorkspaceContext, state: TimelineUi): string[] =>
  visibleEvents(ctx, state).map((event) => event.id);

describe('reduceTimeline', () => {
  it('toggles layers, statuses and steps, and resets the steps with « all »', () => {
    const start = emptyTimelineUi();
    const frozen = JSON.stringify(start);
    const layered = reduceTimeline(start, 'ws-timeline-layer', { layer: 'NETWORK' });
    expect(layered?.layers).toEqual(['NETWORK']);
    expect(reduceTimeline(layered ?? start, 'ws-timeline-layer', { layer: 'NETWORK' })?.layers).toEqual([]);
    expect(reduceTimeline(start, 'ws-timeline-layer', { layer: 'NOPE' })).toEqual(start);
    expect(reduceTimeline(start, 'ws-timeline-status', { status: 'ERROR' })?.statuses).toEqual(['ERROR']);
    expect(reduceTimeline(start, 'ws-timeline-status', { status: 'BAD' })).toEqual(start);
    const two = reduceTimeline(ui({ steps: [3] }), 'ws-timeline-step', { step: '2' });
    expect(two?.steps).toEqual([2, 3]);
    expect(reduceTimeline(two ?? start, 'ws-timeline-step', { step: 'all' })?.steps).toEqual([]);
    expect(reduceTimeline(start, 'ws-timeline-step', { step: '0' })).toEqual(start);
    expect(JSON.stringify(start)).toBe(frozen);
  });

  it('sets the origin and the period; a custom bound switches to CUSTOM and can be cleared', () => {
    const start = emptyTimelineUi();
    expect(reduceTimeline(start, 'ws-timeline-origin', { value: 'VERIFICATION' })?.origin).toBe(
      'VERIFICATION',
    );
    expect(reduceTimeline(start, 'ws-timeline-origin', { value: 'OTHER' })?.origin).toBe('ALL');
    expect(reduceTimeline(start, 'ws-timeline-period', { value: 'ERROR' })?.period).toBe('ERROR');
    const from = reduceTimeline(start, 'ws-timeline-from', { value: '1,5' });
    expect(from).toMatchObject({ period: 'CUSTOM', fromSeconds: 1.5 });
    const to = reduceTimeline(from ?? start, 'ws-timeline-to', { value: '3' });
    expect(to).toMatchObject({ fromSeconds: 1.5, toSeconds: 3 });
    const cleared = reduceTimeline(to ?? start, 'ws-timeline-from', { value: '' });
    expect(cleared?.fromSeconds).toBeUndefined();
    expect(cleared?.toSeconds).toBe(3);
    expect(reduceTimeline(start, 'ws-timeline-to', { value: '-4' })?.toSeconds).toBeUndefined();
  });

  it('toggles the related and failing-only switches, resets, and ignores foreign actions', () => {
    const start = emptyTimelineUi();
    expect(reduceTimeline(start, 'ws-timeline-related', {})?.onlyRelated).toBe(true);
    expect(reduceTimeline(start, 'ws-timeline-req-errors', {})?.requestErrorsOnly).toBe(true);
    const busy = ui({ layers: ['NETWORK'], statuses: ['ERROR'], period: 'ERROR', requestErrorsOnly: true });
    expect(reduceTimeline(busy, 'ws-timeline-reset', {})).toEqual({ ...start, requestErrorsOnly: true });
    expect(reduceTimeline(start, 'ws-graph-zoom', {})).toBeUndefined();
    expect(reduceTimeline(start, 'ws-select', { kind: 'event' })).toBeUndefined();
  });
});

describe('visibleEvents', () => {
  const ctx = ctxOf(incident({ logs: true }));
  const all = ids(ctx, ui());

  it('shows the whole timeline by default, in order', () => {
    expect(all).toEqual(ctx.incident.investigation.timeline?.map((event) => event.id));
  });

  it('restricts by layer, status and step', () => {
    const network = visibleEvents(ctx, ui({ layers: ['NETWORK'] }));
    expect(network.length).toBeGreaterThan(0);
    expect(network.every((event) => event.kind === 'REQUEST' || event.kind === 'RESPONSE')).toBe(true);
    const errors = visibleEvents(ctx, ui({ statuses: ['ERROR'] }));
    expect(errors.every((event) => event.status === 'ERROR')).toBe(true);
    expect(errors.map((event) => event.id)).toContain('rep_1:RESPONSE:rep_1:req-2-1');
    const step2 = visibleEvents(ctx, ui({ steps: [2] }));
    expect(step2.every((event) => event.step === 2)).toBe(true);
    // Le rejeu a une étape 1, pas d'étape 2 ; les événements sans étape sont écartés.
    expect(step2.some((event) => event.reproduction === 'rep_2')).toBe(false);
    expect(ids(ctx, ui({ layers: ['BFF'] }))).toEqual(['experiment:exp_1:LOG:exp_1:ev1']);
  });

  it('restricts by reproduction: reference, verification replays, investigation', () => {
    const refs = visibleEvents(ctx, ui({ origin: 'REFERENCE' }));
    expect(refs.length).toBeGreaterThan(0);
    expect(refs.every((event) => event.reproduction === 'rep_1')).toBe(true);
    const replays = visibleEvents(ctx, ui({ origin: 'VERIFICATION' }));
    expect(replays.map((event) => event.kind)).toEqual(['ACTION', 'REQUEST', 'RESPONSE']);
    expect(replays.every((event) => event.reproduction === 'rep_2')).toBe(true);
    const investigation = visibleEvents(ctx, ui({ origin: 'INVESTIGATION' }));
    expect(investigation.every((event) => event.reproduction === undefined)).toBe(true);
    expect(investigation.map((event) => event.kind)).toEqual(
      expect.arrayContaining(['STATE', 'LOG', 'EXPERIMENT']) as unknown,
    );
  });

  it('restricts by period: reference span, around the first error, custom seconds; undated events left out', () => {
    const span = ids(ctx, ui({ period: 'REFERENCE' }));
    expect(span).toContain('rep_1:ACTION:rep_1:ev-action-1');
    expect(span).toContain('experiment:exp_1:LOG:exp_1:ev1');
    expect(span).not.toContain('history:0');
    expect(span).not.toContain('rep_2:ACTION:rep_2:ev-action-1');
    expect(span).not.toContain('rep_1:TRACE:rep_1:ev-trace');
    const around = ids(ctx, ui({ period: 'ERROR' }));
    // Première erreur de la référence : le POST à 09:00:01.100 (±5 s) ; l'historique de 08:58 est hors fenêtre.
    expect(around).toContain('rep_1:REQUEST:rep_1:req-2-1');
    expect(around).toContain('history:1');
    expect(around).not.toContain('history:0');
    // Origine : 08:58:00 (premier événement daté) ; 0 à 119 s : jusqu'à 08:59:59.
    const custom = ids(ctx, ui({ period: 'CUSTOM', fromSeconds: 0, toSeconds: 119 }));
    expect(custom).toEqual(['history:0']);
    const later = ids(ctx, ui({ period: 'CUSTOM', fromSeconds: 600 }));
    expect(later).toContain('rep_2:ACTION:rep_2:ev-action-1');
    expect(later).not.toContain('rep_1:ACTION:rep_1:ev-action-1');
  });

  it('keeps only what is related to the selection, and nothing changes without a selection', () => {
    expect(ids(ctx, ui({ onlyRelated: true }))).toEqual(all);
    const selected = ctxOf(incident({ logs: true }), {
      selection: { kind: 'request', id: 'rep_1:req-2-1' },
    });
    const related = ids(selected, ui({ onlyRelated: true }));
    expect(related).toContain('rep_1:REQUEST:rep_1:req-2-1');
    expect(related).toContain('rep_1:RESPONSE:rep_1:req-2-1');
    expect(related).toContain('rep_1:ACTION:rep_1:ev-action-2');
    expect(related).not.toContain('rep_1:ACTION:rep_1:ev-action-1');
    expect(related).not.toContain('history:0');
    expect(related.length).toBeLessThan(all.length);
  });
});

describe('renderTimeline', () => {
  it('lists events grouped by step, with time, estimated marker, kind, status and selectable items', () => {
    const html = renderTimeline(ctxOf(incident()), ui());
    expect(html).toContain('Chronologie');
    expect(html).toContain('Afficher :');
    expect(html).toContain(
      'data-action="ws-select" data-kind="event" data-ref="rep_1:ACTION:rep_1:ev-action-2"',
    );
    expect(html).toContain('data-kind="step" data-ref="rep_1#2"');
    expect(html).toContain('Étape 2 : click &quot;Enregistrer&quot;');
    expect(html).toContain('rep_2 · rejeu de vérification (creer-livre-avec-editeur)');
    expect(html).toContain('rep_1 · référence');
    expect(html).toContain('ws-timeline-est');
    expect(html).toContain('heure estimée');
    expect(html).toContain('<time datetime="2026-10-30T09:00:01.100Z">');
    expect(html).toContain('+121,1 s');
    expect(html).toContain('ws-timeline-st-error');
    expect(html).toContain('Console');
    expect(html).toContain('Les heures marquées ≈ sont estimées');
    // La requête d'un événement : un bouton qui sélectionne la requête.
    expect(html).toContain('data-kind="request" data-ref="rep_1:req-2-1"');
    expect(html).toContain('Sélectionner la requête POST /api/books');
    expect(html).toContain('Investigation');
    // Une trace sans heure le dit.
    expect(html).toContain('heure inconnue');
    expect(html).toMatch(/\d+ événement\(s\) sur \d+/);
    // Le compte est un texte d'état simple : la zone live du Dashboard annonce les changements.
    expect(html).toContain('<p class="ws-timeline-count mu">');
    expect(html).not.toContain('aria-live');
  });

  it('renders the « Afficher : » criteria as pressed buttons; the related switch only with a selection', () => {
    const plain = renderTimeline(
      ctxOf(incident()),
      ui({ layers: ['NETWORK'], period: 'CUSTOM', fromSeconds: 2 }),
    );
    expect(plain).toContain('data-action="ws-timeline-layer" data-layer="NETWORK" aria-pressed="true"');
    expect(plain).toContain('data-action="ws-timeline-layer" data-layer="FRONTEND" aria-pressed="false"');
    expect(plain).toContain('data-action="ws-timeline-status" data-status="ERROR"');
    expect(plain).toContain('data-action="ws-timeline-origin" data-value="VERIFICATION"');
    expect(plain).toContain('data-action="ws-timeline-period" data-value="CUSTOM" aria-pressed="true"');
    expect(plain).toContain('data-action="ws-timeline-from" value="2"');
    expect(plain).toContain('data-action="ws-timeline-step" data-step="all"');
    expect(plain).toContain('data-action="ws-timeline-reset"');
    expect(plain).not.toContain('ws-timeline-related');
    const selected = renderTimeline(
      ctxOf(incident(), { selection: { kind: 'request', id: 'rep_1:req-2-1' } }),
      ui({ onlyRelated: true }),
    );
    expect(selected).toContain('data-action="ws-timeline-related" checked');
    expect(selected).toContain('Seulement ce qui est relié à la sélection');
    expect(selected).toContain('ws-selected');
    expect(selected).toContain('ws-related');
  });

  it('shows the empty states: no timeline, nothing visible', () => {
    const none = incident();
    delete none.investigation.timeline;
    expect(renderTimeline(ctxOf(none), ui())).toContain('La chronologie n’est pas encore calculée');
    const empty = renderTimeline(ctxOf(incident()), ui({ layers: ['DATABASE'] }));
    expect(empty).toContain('Aucun événement ne correspond à ces critères d’affichage.');
    expect(renderTimeline(ctxOf(incident()), ui({ period: 'REFERENCE' }))).toContain(
      'Les événements sans heure sont masqués',
    );
  });

  it('escapes every summary and speaks English too', () => {
    const html = renderTimeline(ctxOf(incident()), ui());
    expect(html).not.toContain('<img src=x');
    expect(html).toContain('&lt;img src=x onerror=alert(1)&gt;');
    const en = renderTimeline(ctxOf(incident(), { lang: 'en' }), ui());
    expect(en).toContain('Timeline');
    expect(en).toContain('Show:');
    expect(en).toContain('estimated time');
    expect(en).toContain('Response');
  });
});

describe('renderRequests', () => {
  it('lists the reference reproduction requests with status, duration, step and correlation', () => {
    const html = renderRequests(ctxOf(incident()), ui());
    expect(html).toContain('Requêtes HTTP');
    expect(html).toContain('<div class="tw"><table');
    expect(html).toContain('data-kind="request" data-ref="rep_1:req-2-1"');
    expect(html).toContain('<span class="pill ko">500</span>');
    expect(html).toContain('<span class="pill warn">404</span>');
    expect(html).toContain('85 ms');
    expect(html).toContain('ws-rel-inferred');
    expect(html).toContain('data-kind="step" data-ref="rep_1#2"');
    expect(html).toContain('Ni l’hôte ni la chaîne de requête');
    expect(html).toContain('/api/stats/&lt;script&gt;');
    expect(html).not.toContain('<script>');
    // Le rejeu de vérification n'est pas la reproduction de l'incident.
    expect(html).not.toContain('created-in-replay');
    expect(html).toContain('3 requête(s) sur 3');
    // La durée et l'étape ne se coupent jamais (« 135 ms », pas « 135 m » / « s »).
    expect(html).toContain('<th scope="col" class="ws-timeline-dur">Durée</th>');
    expect(html).toContain('<td class="ws-timeline-dur">85 ms</td>');
    expect(INCIDENT_TIMELINE_CSS).toMatch(/\.ws-timeline-tbl \.ws-timeline-dur\{white-space:nowrap;/);
  });

  it('keeps only failing exchanges on demand, and says when there is no reproduction', () => {
    const html = renderRequests(ctxOf(incident()), ui({ requestErrorsOnly: true }));
    expect(html).not.toContain('/api/publishers');
    expect(html).toContain('2 requête(s) sur 3');
    expect(html).toContain('data-action="ws-timeline-req-errors" checked');
    const none = incident();
    none.investigation.reproductions = [replay()];
    expect(renderRequests(ctxOf(none), ui())).toContain('Aucune reproduction terminée');
  });
});

describe('renderRequestDetail', () => {
  it('shows timing, step, correlation reason, allowlisted headers and pretty-printed masked bodies', () => {
    const html = renderRequestDetail(
      ctxOf(incident(), { selection: { kind: 'request', id: 'rep_1:req-2-1' } }),
      'rep_1:req-2-1',
    );
    expect(html).toContain('<code>POST</code> <code>/api/books</code>');
    expect(html).toContain('<time datetime="2026-10-30T09:00:01.100Z">');
    expect(html).toContain('<time datetime="2026-10-30T09:00:01.185Z">');
    expect(html).toContain('85 ms');
    expect(html).toContain('Étape 2 : click &quot;Enregistrer&quot;');
    expect(html).toContain('Vue pendant la fenêtre réseau de l’action de l’étape 2.');
    expect(html).toContain('ws-rel-observed');
    // En-têtes : la liste blanche seulement, valeurs échappées ; jamais l'authentification.
    expect(html).toContain('<code>x-request-id</code>');
    expect(html).toContain('req-&lt;7&gt;');
    expect(html).toContain('application/problem+json');
    expect(html).not.toContain('authorization');
    expect(html).not.toContain('abcdefghijklmnop');
    // Corps : JSON mis en forme, clés sensibles masquées, la réponse en erreur ouverte.
    expect(html).toContain('&quot;title&quot;: &quot;Le Petit Atlas&quot;');
    expect(html).toContain('&quot;token&quot;: &quot;[REDACTED]&quot;');
    expect(html).not.toContain('raw-token-value');
    expect(html).toMatch(/<details class="ws-timeline-pl" open><summary>Corps de la réponse \(masqué\)/);
    expect(html).toContain('JSON mis en forme');
    // Nœuds du graphe qui citent la requête, avec le lien vers le code.
    expect(html).toContain('data-kind="node" data-ref="bff:BookController.create"');
    expect(html).toContain('data-action="ws-code"');
    expect(html).not.toContain('catalog:Other');
    expect(html).toContain('Ni l’hôte ni la chaîne de requête');
  });

  it('says what was not captured, keeps truncated bodies as text, and handles unknown ids', () => {
    const ctx = ctxOf(incident());
    const list = renderRequestDetail(ctx, 'rep_1:req-1-1');
    expect(list).toContain('Heure de départ non capturée');
    expect(list).toContain('Aucun en-tête gardé');
    expect(list).toContain('Corps non capturé');
    expect(list).toContain('Aucun nœud du graphe ne cite cette requête.');
    const stats = renderRequestDetail(ctx, 'rep_1:req-x-1');
    expect(stats).toContain('Rattachée à l’étape 2 par son horodatage');
    expect(stats).toContain('Corps tronqué à 8 Kio.');
    expect(stats).toContain('/api/stats/&lt;script&gt;');
    expect(renderRequestDetail(ctx, 'rep_2:req-1-1')).toContain('rejeu de vérification');
    expect(renderRequestDetail(ctx, 'nope')).toContain('Cette requête n’existe pas');
  });

  it('pretty-prints valid JSON only and masks secrets in plain text', () => {
    expect(prettyBody('{"a":1,"password":"x"}')).toEqual({
      text: '{\n  "a": 1,\n  "password": "[REDACTED]"\n}',
      json: true,
      truncated: false,
    });
    expect(prettyBody('{"a":').json).toBe(false);
    expect(prettyBody('Authorization failed: Bearer abcdefghijkl').text).not.toContain('abcdefghijkl');
    expect(prettyBody('{"a":1}…[truncated]')).toMatchObject({ json: false, truncated: true });
  });
});

describe('renderLogs', () => {
  it('lists LOG_LINE evidence with its source, pattern, time and verification', () => {
    const html = renderLogs(ctxOf(incident({ logs: true })));
    expect(html).toContain('Journaux');
    expect(html).toContain('<span class="pill mu">Fichier</span> <code>logs/bff.log</code>');
    expect(html).toContain('<span class="pill mu">OpenShift</span> <code>catalogue app=catalog-api</code>');
    expect(html).toContain('<code>NullPointerException</code>');
    expect(html).toContain('<time datetime="2026-10-30T09:00:01.150Z">');
    expect(html).toContain('heure inconnue');
    expect(html).toContain('data-kind="evidence" data-ref="exp_1:ev1"');
    expect(html).toContain('data-kind="experiment" data-ref="exp_1"');
    expect(html).toContain('NullPointerException &lt;b&gt;');
    expect(html).toContain('Vérifications INSPECT_LOGS');
  });

  it('explains how to obtain logs when there are none', () => {
    const html = renderLogs(ctxOf(incident()));
    expect(html).toContain('Aucune ligne de journal');
    expect(html).toContain('INSPECT_LOGS');
    expect(html).not.toContain('readLogs');
    expect(renderLogs(ctxOf(incident({ readLogs: false })))).toContain('(readLogs)');
    expect(renderLogs(ctxOf(incident(), { lang: 'en' }))).toContain('No log line');
  });
});

describe('renderScreenshot and styles', () => {
  it('renders a data: image with its alt text, a loading state, and refuses other URLs', () => {
    const ctx = ctxOf(incident());
    const html = renderScreenshot(
      ctx,
      'data:image/png;base64,iVBORw0KGgo=',
      'Après « Enregistrer » <étape 2>',
    );
    expect(html).toContain('<img src="data:image/png;base64,iVBORw0KGgo="');
    expect(html).toContain('alt="Après « Enregistrer » &lt;étape 2&gt;"');
    expect(renderScreenshot(ctx, undefined, 'capture')).toContain('aria-busy="true"');
    const refused = renderScreenshot(ctx, 'javascript:alert(1)', 'capture');
    expect(refused).toContain('role="alert"');
    expect(refused).not.toContain('javascript:');
    expect(renderScreenshot(ctx, 'data:image/svg+xml;base64,PHN2Zz4=', 'svg')).not.toContain('<img');
  });

  it('uses theme tokens only, with the ws-timeline- prefix and visible focus', () => {
    expect(INCIDENT_TIMELINE_CSS).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
    const selectors = INCIDENT_TIMELINE_CSS.match(/(^|[},])\s*\.[a-z-]+/gm) ?? [];
    expect(selectors.length).toBeGreaterThan(10);
    for (const selector of selectors) expect(selector.replace(/^[},]?\s*/, '')).toMatch(/^\.ws-timeline/);
    expect(INCIDENT_TIMELINE_CSS).toContain(':focus-visible');
  });

  it('colours status texts like the Dashboard pills (status token mixed with the text colour, AA in both themes)', () => {
    const rule = (selector: string): string => {
      const start = INCIDENT_TIMELINE_CSS.indexOf(`\n${selector}{`);
      return INCIDENT_TIMELINE_CSS.slice(start + 1, INCIDENT_TIMELINE_CSS.indexOf('}', start) + 1);
    };
    const mixed = (token: string, percent: number): string =>
      `color:color-mix(in srgb,var(--qa-color-${token}) ${String(percent)}%,var(--qa-color-text))`;
    expect(rule('.ws-timeline-st-ok .ws-timeline-status')).toContain(mixed('success', 62));
    expect(rule('.ws-timeline-st-error .ws-timeline-status')).toContain(mixed('danger', 70));
    expect(rule('.ws-timeline-st-warning .ws-timeline-status')).toContain(mixed('warning', 70));
    expect(rule('.ws-timeline-est')).toContain(mixed('warning', 70));
    // Aucun texte coloré avec un jeton de statut brut (3,0 à 3,6:1 en thème clair).
    expect(INCIDENT_TIMELINE_CSS).not.toMatch(/[;{]color:var\(--qa-color-(danger|success|warning|faint)\)/);
  });
});
