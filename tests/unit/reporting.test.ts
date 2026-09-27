import { describe, expect, it } from 'vitest';
import { screenshotFileName, stateScreenshotFileName } from '../../src/browser/screenshot-service.js';
import { parseCliArgs, UsageError } from '../../src/cli/args.js';
import type { FlowEdge, FlowNode } from '../../src/model/flow.js';
import { buildFlowTree, renderTextTree } from '../../src/reporting/flow-tree.js';
import { esc } from '../../src/reporting/html-common.js';

const node = (id: string, heading: string, actions: FlowNode['actions'] = {}): FlowNode => ({
  id,
  label: id,
  url: `http://x.test/${id}`,
  route: `/${id}`,
  headings: [heading],
  depth: 0,
  discoveredActions: Object.keys(actions),
  actions,
  firstSeenAt: '',
  lastSeenAt: '',
  visits: 1,
  issueIds: [],
});
const edge = (
  from: string,
  to: string,
  text: string,
  category: FlowEdge['action']['category'] = 'navigation',
  href?: string,
): FlowEdge => ({
  from,
  to,
  actionId: `${from}-${to}`,
  action: { type: 'navigate', category, text, classification: 'SAFE', ...(href ? { href } : {}) },
  result: 'SUCCESS',
  timestamp: '',
  issueIds: [],
});

describe('flow tree', () => {
  it('renders the discovered structure, hanging global menu entries under the start state', () => {
    const settingsHref = 'http://x.test/settings';
    const nodes = [
      node('home', 'Dashboard', {
        m: {
          type: 'navigate',
          category: 'menu',
          text: 'Settings',
          href: settingsHref,
          classification: 'SAFE',
        },
      }),
      node('users', 'Users'),
      node('detail', 'User detail'),
      node('settings', 'Settings'),
    ];
    const edges = [
      edge('home', 'users', 'Users'),
      edge('users', 'detail', 'View'),
      edge('detail', 'settings', 'Settings', 'menu', settingsHref),
    ];
    expect(renderTextTree(buildFlowTree(nodes, edges, 'home'))).toBe(
      [
        'Dashboard',
        '├── Users  ⟵ navigate "Users"',
        '│   └── User detail  ⟵ navigate "View"',
        '└── Settings  ⟵ navigate "Settings"',
      ].join('\n'),
    );
  });
});

describe('file names and escaping', () => {
  it('builds safe, sortable screenshot names', () => {
    expect(stateScreenshotFileName(1, 'Tableau de bord')).toBe('001-tableau-de-bord.png');
    expect(stateScreenshotFileName(12, 'users/<script>', 'error ISSUE-0001')).toBe(
      '012-users-script-error-issue-0001.png',
    );
    expect(screenshotFileName(3, 'http://x.test/admin/Users/', 'error')).toBe('003-admin-users-error.png');
  });

  it('escapes markup', () => {
    expect(esc(`<img src=x onerror="alert('x')">`)).toBe(
      '&lt;img src=x onerror=&quot;alert(&#39;x&#39;)&quot;&gt;',
    );
  });
});

describe('parseCliArgs', () => {
  it('accepts a positional mission or --config, and limit overrides', () => {
    expect(parseCliArgs(['scenarios/demo.yaml']).configPath).toBe('scenarios/demo.yaml');
    expect(
      parseCliArgs(['-c', 'm.yaml', '--max-states', '5', '--max-actions', '20', '--headed']),
    ).toMatchObject({
      configPath: 'm.yaml',
      maxStates: 5,
      maxActions: 20,
      headless: false,
    });
  });

  it('accepts the learn / verify / explore commands and a baseline directory', () => {
    expect(parseCliArgs(['learn', 'm.yaml'])).toMatchObject({ mode: 'learn', configPath: 'm.yaml' });
    expect(parseCliArgs(['verify', '-c', 'm.yaml', '--baseline-dir', 'b'])).toMatchObject({
      mode: 'verify',
      configPath: 'm.yaml',
      baselineDir: 'b',
    });
    expect(parseCliArgs(['explore', 'm.yaml']).mode).toBe('explore');
    expect(parseCliArgs(['m.yaml']).mode).toBeUndefined();
    expect(parseCliArgs(['learn']).configPath).toBeUndefined();
    expect(() => parseCliArgs(['learn', 'a.yaml', 'b.yaml'])).toThrowError(UsageError);
  });

  it('rejects invalid usage', () => {
    expect(() => parseCliArgs(['a.yaml', 'b.yaml'])).toThrowError(UsageError);
    expect(() => parseCliArgs(['--max-states', 'zero'])).toThrowError(UsageError);
    expect(() => parseCliArgs(['--max-pages', '3'])).toThrowError(UsageError);
  });
});
