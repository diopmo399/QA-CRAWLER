import { describe, expect, it } from 'vitest';
import { DefaultTestDataProvider } from '../../src/data/test-data-provider.js';
import { generateFlows } from '../../src/flows/flow-generator.js';
import { FlowGraph } from '../../src/graph/flow-graph.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';

const link = (id: string, stateId: string, text: string): DiscoveredAction => ({
  id,
  stateId,
  type: 'click',
  category: 'navigation',
  elementType: 'a',
  text,
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: '',
  risks: [],
  locator: { strategy: 'role', role: 'link', name: text },
});

describe('generateFlows', () => {
  it('root that leads nowhere (error page before sign-in): starts from the screen reached after it', () => {
    const graph = new FlowGraph();
    const node = (id: string, route: string, heading: string, actions: DiscoveredAction[], at: string) =>
      graph.addNode({
        id,
        label: id,
        url: `http://app.test${route}`,
        route,
        headings: [heading],
        depth: 0,
        actions,
        timestamp: at,
      });
    const toForm = link('a-form', 'home', 'Questionnaire');
    node('error', '/', 'Erreur 401', [], '2026-09-27T10:00:00Z');
    // Atteint par la connexion (un flow imposé), pas par un clic depuis la racine.
    node('home', '/accueil', 'Accueil', [toForm], '2026-09-27T10:00:05Z');
    node('form', '/questionnaire', 'Questionnaire', [], '2026-09-27T10:00:06Z');
    graph.addEdge({
      from: 'home',
      to: 'form',
      actionId: 'a-form',
      action: { type: 'click', category: 'navigation', classification: 'SAFE', text: 'Questionnaire' },
      result: 'SUCCESS',
    });
    const flows = generateFlows(
      {
        graph,
        details: new Map([['home', { actions: [toForm] }]]),
        forms: [],
        testData: new DefaultTestDataProvider(),
      },
      { maxFlows: 10 },
    );
    expect(flows).toHaveLength(1);
    expect(flows[0]).toMatchObject({ name: 'to-form', startAt: '/accueil' });
    expect(flows[0]?.steps[0]).toMatchObject({ click: { role: 'link', name: 'Questionnaire' } });
  });
});
