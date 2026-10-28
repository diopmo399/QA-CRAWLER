import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { FLOW_MAP_SCRIPT, renderFlowMap, renderFlowSteps } from '../../src/reporting/flow-diagram.js';
import { renderFlowGraphHtml } from '../../src/reporting/flow-graph-html-reporter.js';
import { renderHtml } from '../../src/reporting/html-reporter.js';
import { branching } from '../fixtures/flow-map.js';

const node = (id: string, heading: string) => ({
  id,
  label: id,
  url: `http://app.test/${id}`,
  route: `/${id}`,
  headings: [heading],
  depth: 0,
  discoveredActions: [],
  actions: {},
  firstSeenAt: '',
  lastSeenAt: '',
  visits: 1,
  issueIds: [],
});
const edge = (from: string, to: string, text: string, status?: 'PASS' | 'FAIL') => ({
  from,
  to,
  actionId: `${from}-${to}`,
  action: { type: 'click', category: 'navigation', text, classification: 'SAFE' },
  result: 'SUCCESS',
  timestamp: '',
  issueIds: [],
  ...(status ? { oracle: { status, confidence: 1, reasons: [], results: [], assertions: [] } } : {}),
});

const result = {
  states: [node('home', 'Accueil'), node('users', 'Users <b>'), node('detail', 'Détail')],
  transitions: [edge('home', 'users', 'Users', 'PASS'), edge('users', 'detail', 'Open', 'FAIL')],
  issues: [{ id: 'i1', type: 'HTTP_ERROR', severity: 'ERROR', states: ['detail'], message: '' }],
} as unknown as ExplorationResult;

describe('flow diagrams (SVG)', () => {
  it('flow map: one box per screen, arrows coloured by verdict, labels escaped, French legend', () => {
    const svg = renderFlowMap(result, 'fr');
    expect(svg).toContain('<svg');
    expect(svg.match(/<rect[^>]*rx=/g)?.length ?? 0).toBeGreaterThanOrEqual(3);
    expect(svg).toContain('stroke="#2e7d32"'); // Users → PASS
    expect(svg).toContain('stroke="#c62828"'); // Open → FAIL, et l'écran en erreur
    expect(svg).toContain('Users &lt;b&gt;');
    expect(svg).not.toContain('Users <b>');
    expect(svg).not.toMatch(/<script/i);
  });

  it('flow map: every screen has its details (actions, checks, issues, screenshot); the fragment holds no script', () => {
    const html = renderFlowMap(branching(), 'fr', { href: (file) => `../${file}` });
    expect(html).not.toMatch(/<script/i);
    // Une carte par écran, un panneau de détails par écran, reliés par une ancre (lisible sans JavaScript).
    expect(html.match(/class="fm-node[ "]/g)).toHaveLength(11);
    expect(html.match(/class="fm-detail"/g)).toHaveLength(11);
    expect(html).toContain('href="#fm-d-0"');
    expect(html).toContain('id="fm-d-0"');
    // La fiche : actions depuis l'écran (avec leur verdict), arrivées, vérifications, anomalies, capture.
    const index = /href="#fm-d-(\d+)"[^>]*aria-label="Fiche de l’élément/.exec(html)?.[1] ?? '';
    const from = html.indexOf(`id="fm-d-${index}"`);
    const item = html.slice(from, html.indexOf('</section>', from));
    expect(item).toContain('Fiche de l’élément');
    expect(item).toContain('clic « Modifier » → <b>Modifier l’élément</b>');
    expect(item).toContain('vérification en échec');
    expect(item).toContain('✓ no HTTP 5xx');
    expect(item).toContain('href="../screenshots/item.png"');
    expect(html).toContain('PUT /api/items/42 → 500');
    // Les statuts proposés : seulement ceux qui existent, avec leur nombre.
    expect(html).toContain('data-fm-filter="FAIL"');
    expect(html).toMatch(/Échec \(1\)/);
    expect(html).toMatch(/data-status="FAIL"[^>]*aria-label="Modifier l’élément — Échec"/);
    // Les retours en tirets, avec une pointe ; l'étiquette de l'action reste à l'écart des cartes.
    expect(html).toMatch(/class="fm-edge fm-link"[^]*?marker-end="url\(#fm-a-/);
    expect(html).toContain('class="fm-label"');
  });

  it('both report pages carry the map behaviour once', () => {
    const page = renderFlowGraphHtml(branching(), 'fr');
    expect(page.split(FLOW_MAP_SCRIPT).length - 1).toBe(1);
    expect(page).toContain('class="fm"');
    const journey = branching();
    const report = renderHtml(
      {
        ...journey,
        // Le rapport complet lit aussi le détail des actions de chaque écran.
        states: journey.states.map((state) => ({ ...state, actionsDetail: [], forms: [] })),
        mode: 'explore',
        runId: 'run1',
        target: { baseUrl: 'http://app.test', startUrl: 'http://app.test/' },
        startedAt: '2026-10-28T10:00:00.000Z',
        finishedAt: '2026-10-28T10:01:00.000Z',
        durationMs: 60_000,
        flows: [],
        browserInteractions: [],
        stopReason: 'budget',
        decisionEngine: 'rules',
        settings: {},
        artifacts: {},
        stats: {
          states: journey.states.length,
          actionsExecuted: journey.transitions.length,
          actionsSucceeded: journey.transitions.length,
          actionsFailed: 0,
          actionsBlocked: 1,
          transitions: journey.transitions.length,
          backtracks: 0,
          maxDepth: 3,
          flowsPassed: 0,
          flowsFailed: 0,
          issuesBySeverity: { INFO: 0, WARNING: 1, ERROR: 1, CRITICAL: 0 },
          issuesByType: {},
          actionsByClassification: {},
          formsFound: 0,
          interactionsByType: {},
          interactionsByStatus: {},
        },
      } as unknown as ExplorationResult,
      (file) => file,
      'fr',
    );
    expect(report).toContain('class="fm"');
    expect(report.split(FLOW_MAP_SCRIPT).length - 1).toBe(1);
  });

  it('no screen, no map', () => {
    expect(renderFlowMap({ states: [], transitions: [], issues: [] } as unknown as ExplorationResult)).toBe(
      '',
    );
  });

  it('flow steps: a chain of boxes coloured by status', () => {
    const flow = {
      name: 'Créer <x>',
      steps: [
        { index: 1, description: 'Ouvrir', status: 'PASSED' },
        { index: 2, description: 'Soumettre', status: 'FAILED', reason: 'Timeout' },
        { index: 3, description: 'Vérifier', status: 'SKIPPED' },
      ],
    } as unknown as FlowRunReport;
    const svg = renderFlowSteps(flow);
    expect(svg).toContain('aria-label="Créer &lt;x&gt;"');
    expect(svg).toContain('2. FAILED');
    expect(svg).toContain('#c62828');
    expect(svg).toContain('(Timeout)');
    expect(renderFlowSteps({ ...flow, steps: [] })).toBe('');
  });
});
