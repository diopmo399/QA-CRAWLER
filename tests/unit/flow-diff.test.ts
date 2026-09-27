import { describe, expect, it } from 'vitest';
import { FlowDiffEngine, isEmptyDiff, renderFlowDiffText } from '../../src/diff/flow-diff.js';
import type { FlowEdge, FlowGraphData, FlowNode } from '../../src/model/flow.js';

const node = (id: string, label: string, route: string): FlowNode => ({
  id,
  label,
  url: `http://app.test${route}`,
  route,
  headings: [],
  depth: 0,
  discoveredActions: [],
  actions: {},
  firstSeenAt: '',
  lastSeenAt: '',
  visits: 1,
  issueIds: [],
});
const edge = (
  from: string,
  actionId: string,
  text: string,
  to: string,
  extra: Partial<FlowEdge> = {},
): FlowEdge => ({
  from,
  to,
  actionId,
  action: { type: 'click', category: 'other', classification: 'SAFE', text },
  result: 'SUCCESS',
  timestamp: '',
  issueIds: [],
  ...extra,
});
const graph = (nodes: FlowNode[], edges: FlowEdge[]): FlowGraphData => ({
  version: 1,
  rootId: nodes[0]?.id,
  nodes,
  edges,
});

const dashboard = node('dash', 'Dashboard', '/');
const users = node('users', 'Users', '/users');
const create = node('create', 'Create user', '/users/new');
const settings = node('settings', 'Settings', '/settings');
const permissions = node('perm', 'Permissions', '/settings/permissions');

describe('FlowDiffEngine', () => {
  const previous = graph(
    [dashboard, users, create, settings, permissions],
    [
      edge('dash', 'a-users', 'Users', 'users'),
      edge('users', 'a-new', 'Create user', 'create', {
        network: [{ method: 'GET', url: 'http://app.test/api/roles', status: 200, resourceType: 'fetch' }],
      }),
      edge('dash', 'a-settings', 'Settings', 'settings'),
      edge('settings', 'a-perm', 'Permissions', 'perm'),
      edge('dash', 'a-logout', 'Logout', 'dash', { result: 'BLOCKED' }),
    ],
  );
  const importPage = node('import', 'Import users', '/users/import');
  const error = node('error', 'Error', '/error');
  const current = graph(
    [dashboard, users, create, settings, importPage, error],
    [
      edge('dash', 'a-users', 'Users', 'users'),
      edge('users', 'a-new', 'Create user', 'error', {
        network: [{ method: 'GET', url: 'http://app.test/api/roles', status: 500, resourceType: 'fetch' }],
      }),
      edge('dash', 'a-settings', 'Settings', 'settings'),
      edge('users', 'a-import', 'Import', 'import'),
    ],
  );

  it('finds added, removed and changed states and transitions', () => {
    const diff = new FlowDiffEngine().compare(previous, current);
    expect(diff.addedStates.map((state) => state.route)).toEqual(['/users/import', '/error']);
    expect(diff.removedStates.map((state) => state.label)).toEqual(['Permissions']);
    expect(diff.addedTransitions.map((t) => t.action.text)).toEqual(['Import']);
    expect(diff.removedTransitions.map((t) => `${t.fromLabel} → ${t.toLabel}`)).toEqual([
      'Settings → Permissions',
    ]);
    expect(diff.changedTransitions).toHaveLength(1);
    expect(diff.changedTransitions[0]?.changes).toEqual([
      'target: Create user → Error',
      'network: + GET /api/roles 5xx, - GET /api/roles 2xx',
    ]);
    // Les actions bloquées décrivent les réglages de sécurité de la mission, pas l'application.
    expect(diff.removedTransitions.some((t) => t.action.text === 'Logout')).toBe(false);
    expect(diff.summary).toEqual({
      addedStates: 2,
      removedStates: 1,
      addedTransitions: 1,
      removedTransitions: 1,
      changedTransitions: 1,
    });
  });

  it('renders a readable FLOW DIFF', () => {
    const text = renderFlowDiffText(new FlowDiffEngine().compare(previous, current));
    expect(text).toBe(
      [
        'FLOW DIFF',
        '',
        '+ Import users (/users/import)',
        '+ Error (/error)',
        '+ Users → "Import" → Import users',
        '- Permissions (/settings/permissions)',
        '- Settings → "Permissions" → Permissions',
        '',
        'Changed:',
        '  Users → "Create user"',
        '    target: Create user → Error',
        '    network: + GET /api/roles 5xx, - GET /api/roles 2xx',
      ].join('\n'),
    );
  });

  it('sees no difference between a graph and itself, whatever the ids in API calls', () => {
    const withIds = (id: number): FlowGraphData =>
      graph(
        [dashboard, users],
        [
          edge('dash', 'a-users', 'Users', 'users', {
            network: [
              {
                method: 'GET',
                url: `http://app.test/api/users/${id}?page=${id}`,
                status: 200,
                resourceType: 'fetch',
              },
            ],
          }),
        ],
      );
    const diff = new FlowDiffEngine().compare(withIds(1), withIds(2));
    expect(isEmptyDiff(diff)).toBe(true);
    expect(renderFlowDiffText(diff)).toContain('(no difference)');
  });
});
