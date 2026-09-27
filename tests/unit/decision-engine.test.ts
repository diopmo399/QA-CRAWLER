import { describe, expect, it } from 'vitest';
import { RuleBasedDecisionEngine } from '../../src/decision/rule-based-decision-engine.js';
import { FlowGraph, summaryOf } from '../../src/graph/flow-graph.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';
import type { PageContext } from '../../src/model/page-context.js';
import { SafetyPolicy } from '../../src/policies/safety-policy.js';
import { testConfig } from '../helpers.js';

const config = testConfig();
const safety = new SafetyPolicy(config.safety);
const engine = new RuleBasedDecisionEngine(safety, {
  goals: config.goals,
  maxDepth: 3,
  maxStatesPerRoute: 2,
  queryParamMode: 'pattern',
});

let counter = 0;
const action = (text: string, overrides: Partial<DiscoveredAction> = {}): DiscoveredAction => ({
  id: `a-${(counter += 1)}`,
  stateId: 'home',
  type: 'click',
  category: 'other',
  elementType: 'button',
  text,
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: '',
  risks: [],
  locator: { strategy: 'role', role: 'button', name: text },
  ...overrides,
});

const context = (actions: DiscoveredAction[], depth = 0, stateId = 'home'): PageContext => ({
  url: 'http://localhost:4200/',
  title: 'Home',
  stateId,
  stateLabel: stateId,
  route: '/',
  headings: [],
  dialogs: [],
  actions,
  forms: [],
  errors: [],
  metadata: { depth, timestamp: '', flow: [stateId] },
});

const graphWith = (stateId: string, actions: DiscoveredAction[]): FlowGraph => {
  const graph = new FlowGraph();
  graph.addNode({
    id: stateId,
    label: stateId,
    url: 'http://localhost:4200/',
    route: '/',
    headings: [],
    depth: 0,
    actions,
  });
  return graph;
};

describe('RuleBasedDecisionEngine', () => {
  it('tries only a few of many similar controls (days of a date picker)', () => {
    const limited = new RuleBasedDecisionEngine(safety, {
      goals: config.goals,
      maxDepth: 3,
      maxStatesPerRoute: 2,
      queryParamMode: 'pattern',
      maxSimilarActions: 2,
    });
    const days = Array.from({ length: 30 }, (_, i) => action(String(i + 1)));
    const other = action('Fermer le calendrier');
    const actions = [...days, other];
    const graph = graphWith('home', actions);
    for (const day of days.slice(0, 2)) {
      graph.addEdge({
        from: 'home',
        to: 'home',
        actionId: day.id,
        action: summaryOf(day),
        result: 'SUCCESS',
      });
    }
    expect(limited.rank(context(actions), graph).map((entry) => entry.action.text)).toEqual([
      'Fermer le calendrier',
    ]);
    // Seulement deux contrôles semblables : rien à regrouper.
    const two = [action('1'), action('2')];
    expect(limited.rank(context(two), graphWith('home', two))).toHaveLength(2);
  });

  it('explores what is in front of the screen first and skips what a modal layer covers', () => {
    const actions = [
      action('Onglet', { category: 'tab' }),
      action('Derrière', { obscured: true }),
      action('Compte courant', { foreground: true }),
    ];
    const ranked = engine.rank(context(actions), graphWith('home', actions));
    expect(ranked.map((entry) => entry.action.text)).toEqual(['Compte courant', 'Onglet']);
    expect(ranked[0]?.why).toContain('in front of the screen');
  });

  it('never proposes disabled, hidden, dangerous, blocked or unknown actions', async () => {
    const actions = [
      action('Disabled', { disabled: true }),
      action('Hidden', { visible: false }),
      action('Supprimer', { classification: 'DANGEROUS', risks: ['delete'] }),
      action('Enregistrer', { classification: 'MUTATION', risks: ['mutation'] }),
      action('⚙', { classification: 'UNKNOWN' }),
      action('Logout link', {
        type: 'navigate',
        category: 'navigation',
        href: 'http://localhost:4200/logout',
      }),
      action('External', {
        type: 'navigate',
        href: 'https://other.test/',
        external: true,
        risks: ['external-navigation'],
      }),
    ];
    const decision = await engine.decide(context(actions), graphWith('home', actions));
    expect(decision).toMatchObject({ decision: 'BACKTRACK' });
  });

  it('prefers new states (content link, then tab, then global menu), then other controls', () => {
    const menu = action('Settings', {
      type: 'navigate',
      category: 'menu',
      href: 'http://localhost:4200/settings',
    });
    const other = action('Refresh view');
    const content = action('Users', {
      type: 'navigate',
      category: 'navigation',
      href: 'http://localhost:4200/users',
    });
    const tab = action('History', { category: 'tab', selected: false });
    const actions = [menu, other, content, tab];
    const ranked = engine
      .rank(context(actions), graphWith('home', actions))
      .map((scored) => scored.action.text);
    expect(ranked).toEqual(['Users', 'History', 'Settings', 'Refresh view']);
  });

  it('skips actions already tried from this state, then backtracks', async () => {
    const only = action('Users', {
      type: 'navigate',
      category: 'navigation',
      href: 'http://localhost:4200/users',
    });
    const graph = graphWith('home', [only]);
    expect(await engine.decide(context([only]), graph)).toMatchObject({
      decision: 'EXECUTE',
      actionId: only.id,
    });
    graph.addEdge({
      from: 'home',
      to: 'users',
      actionId: only.id,
      action: summaryOf(only),
      result: 'SUCCESS',
    });
    expect(await engine.decide(context([only]), graph)).toMatchObject({ decision: 'BACKTRACK' });
  });

  it('limits exploration per route pattern (/users/:id)', async () => {
    const graph = graphWith('home', []);
    for (const id of [1, 2]) {
      graph.addNode({
        id: `user-${id}`,
        label: 'user',
        url: `http://localhost:4200/users/${id}`,
        route: '/users/:id',
        headings: [],
        depth: 1,
        actions: [],
      });
    }
    const third = action('User 3', {
      type: 'navigate',
      category: 'details',
      href: 'http://localhost:4200/users/3',
    });
    expect(await engine.decide(context([third]), graph)).toMatchObject({ decision: 'BACKTRACK' });
  });

  it('skips selected tabs, unchecking and free-text fills', async () => {
    const actions = [
      action('Profile', { category: 'tab', selected: true }),
      action('Newsletter', { type: 'uncheck', category: 'form-input' }),
      action('Name', { type: 'fill', category: 'form-input' }),
    ];
    expect(await engine.decide(context(actions), graphWith('home', actions))).toMatchObject({
      decision: 'BACKTRACK',
    });
  });

  it('backtracks at max depth and respects the mission goals', async () => {
    const tab = action('Tab', { category: 'tab' });
    expect(await engine.decide(context([tab], 3), graphWith('home', [tab]))).toMatchObject({
      decision: 'BACKTRACK',
    });

    const noFlows = new RuleBasedDecisionEngine(safety, {
      goals: { ...config.goals, discoverFlows: false },
      maxDepth: 3,
      maxStatesPerRoute: 2,
      queryParamMode: 'pattern',
    });
    expect(await noFlows.decide(context([tab]), graphWith('home', [tab]))).toMatchObject({
      decision: 'BACKTRACK',
    });
  });

  it('does not follow a link already followed from another state', async () => {
    const link = action('Users', { type: 'navigate', category: 'menu', href: 'http://localhost:4200/users' });
    const graph = graphWith('home', [link]);
    graph.addNode({
      id: 'other',
      label: 'other',
      url: 'http://localhost:4200/other',
      route: '/other',
      headings: [],
      depth: 1,
      actions: [],
    });
    graph.addEdge({
      from: 'other',
      to: 'users',
      actionId: 'a-elsewhere',
      action: summaryOf(link),
      result: 'SUCCESS',
    });
    expect(await engine.decide(context([link]), graph)).toMatchObject({ decision: 'BACKTRACK' });
  });
});
