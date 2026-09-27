import { describe, expect, it } from 'vitest';
import type { ExplorationResult } from '../../src/model/exploration-result.js';
import type { FlowRunReport } from '../../src/model/flow-run.js';
import { renderFlowMap, renderFlowSteps } from '../../src/reporting/flow-diagram.js';

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
