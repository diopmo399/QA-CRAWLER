import { mkdtemp, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { FlowGraph, summaryOf } from '../../src/graph/flow-graph.js';
import { JsonFlowMemory } from '../../src/memory/json-flow-memory.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';

const action = (id: string, text: string, overrides: Partial<DiscoveredAction> = {}): DiscoveredAction => ({
  id,
  stateId: 'x',
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

function sampleGraph(): FlowGraph {
  const graph = new FlowGraph();
  const openUsers = action('a-users', 'Users', { type: 'navigate', href: 'http://x.test/users' });
  const openSettings = action('a-settings', 'Settings', { type: 'navigate', href: 'http://x.test/settings' });
  const openDetail = action('a-detail', 'View');
  graph.addNode({
    id: 'home',
    label: 'home',
    url: 'http://x.test/',
    route: '/',
    headings: ['Home'],
    depth: 0,
    actions: [openUsers, openSettings],
  });
  graph.addNode({
    id: 'users',
    label: 'users',
    url: 'http://x.test/users',
    route: '/users',
    headings: ['Users'],
    depth: 1,
    actions: [openDetail],
  });
  graph.addNode({
    id: 'detail',
    label: 'detail',
    url: 'http://x.test/users/1',
    route: '/users/:id',
    headings: ['User'],
    depth: 2,
    actions: [],
  });
  graph.addEdge({
    from: 'home',
    to: 'users',
    actionId: 'a-users',
    action: summaryOf(openUsers),
    result: 'SUCCESS',
  });
  graph.addEdge({
    from: 'users',
    to: 'detail',
    actionId: 'a-detail',
    action: summaryOf(openDetail),
    result: 'SUCCESS',
  });
  return graph;
}

describe('FlowGraph', () => {
  it('adds nodes once and refreshes them on later visits', () => {
    const graph = sampleGraph();
    expect(graph.hasNode('users')).toBe(true);
    const added = graph.addNode({
      id: 'users',
      label: 'users',
      url: 'u',
      route: '/users',
      headings: [],
      depth: 5,
      actions: [action('a-new', 'New tab')],
    });
    expect(added).toBe(false);
    expect(graph.getNode('users')).toMatchObject({ visits: 2, depth: 1 });
    expect(graph.getNode('users')?.discoveredActions).toEqual(['a-detail', 'a-new']);
    expect(graph.rootId).toBe('home');
  });

  it('remembers tried transitions and lists unexplored actions', () => {
    const graph = sampleGraph();
    expect(graph.hasTransition('home', 'a-users')).toBe(true);
    expect(graph.hasTransition('home', 'a-settings')).toBe(false);
    expect(graph.getUnexploredActions('home')).toEqual(['a-settings']);
    expect(graph.getUnexploredActions('users')).toEqual([]);
  });

  it('records blocked actions so they are never proposed again', () => {
    const graph = sampleGraph();
    const edge = graph.recordBlocked('home', action('a-settings', 'Settings'), 'not allowed');
    expect(edge).toMatchObject({ from: 'home', to: 'home', result: 'BLOCKED', reason: 'not allowed' });
    expect(graph.getUnexploredActions('home')).toEqual([]);
    expect(graph.countEdges('BLOCKED')).toBe(1);
  });

  it('computes paths from the start state (backtracking by replay, issue flows)', () => {
    const graph = sampleGraph();
    expect(graph.pathTo('detail').map((edge) => edge.actionId)).toEqual(['a-users', 'a-detail']);
    expect(graph.flowTo('detail')).toEqual(['home', 'users', 'detail']);
    expect(graph.flowTo('home')).toEqual(['home']);
    expect(graph.statesForRoute('/users/:id').map((node) => node.id)).toEqual(['detail']);
  });

  it('reuses a link validated elsewhere when a state offers the same target (global menus)', () => {
    const graph = new FlowGraph();
    const homeMenu = action('a-home-admin', 'Admin', {
      type: 'navigate',
      category: 'menu',
      href: 'http://x.test/admin',
    });
    const usersMenu = action('a-users-admin', 'Admin', {
      type: 'navigate',
      category: 'menu',
      href: 'http://x.test/admin',
    });
    const openUsers = action('a-users', 'Users', { type: 'navigate', href: 'http://x.test/users' });
    graph.addNode({
      id: 'home',
      label: 'home',
      url: 'http://x.test/',
      route: '/',
      headings: [],
      depth: 0,
      actions: [openUsers, homeMenu],
    });
    graph.addNode({
      id: 'users',
      label: 'users',
      url: 'http://x.test/users',
      route: '/users',
      headings: [],
      depth: 1,
      actions: [usersMenu],
    });
    graph.addNode({
      id: 'admin',
      label: 'admin',
      url: 'http://x.test/admin',
      route: '/admin',
      headings: [],
      depth: 1,
      actions: [],
    });
    graph.addEdge({
      from: 'home',
      to: 'users',
      actionId: 'a-users',
      action: summaryOf(openUsers),
      result: 'SUCCESS',
    });
    graph.addEdge({
      from: 'users',
      to: 'admin',
      actionId: 'a-users-admin',
      action: summaryOf(usersMenu),
      result: 'SUCCESS',
    });
    const path = graph.pathTo('admin');
    expect(path.map((edge) => [edge.from, edge.actionId])).toEqual([['home', 'a-home-admin']]);
    expect(graph.flowTo('admin')).toEqual(['home', 'admin']);
  });

  it('round-trips through JSON', () => {
    const graph = sampleGraph();
    const copy = FlowGraph.fromJSON(
      JSON.parse(JSON.stringify(graph.toJSON())) as ReturnType<FlowGraph['toJSON']>,
    );
    expect(copy.toJSON()).toEqual(graph.toJSON());
    expect(copy.hasTransition('users', 'a-detail')).toBe(true);
  });
});

describe('JsonFlowMemory', () => {
  it('saves and loads the graph (reports/flow-graph.json)', async () => {
    const file = path.join(await mkdtemp(path.join(tmpdir(), 'flow-memory-')), 'nested', 'flow-graph.json');
    const memory = new JsonFlowMemory(file);
    expect((await memory.load()).nodeCount).toBe(0);
    await memory.save(sampleGraph());
    const loaded = await memory.load();
    expect(loaded.nodeCount).toBe(3);
    expect(loaded.getUnexploredActions('home')).toEqual(['a-settings']);
    expect(JSON.parse(await readFile(file, 'utf8'))).toMatchObject({ version: 1, rootId: 'home' });
  });
});
