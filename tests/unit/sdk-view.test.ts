import { describe, expect, it } from 'vitest';
import { strings } from '../../src/sdk/ui/i18n.js';
import { engineDefaults } from '../../src/sdk/server/project.js';
import {
  draftWith,
  esc,
  formatClock,
  layoutMap,
  render,
  stepErrors,
  type WizardState,
} from '../../src/sdk/ui/view.js';

function state(overrides: Partial<WizardState> = {}): WizardState {
  return {
    t: strings('fr'),
    locale: 'fr',
    mode: 'standalone',
    phase: 'ready',
    step: 1,
    visited: 1,
    draft: {
      ...engineDefaults(),
      project: { name: 'Demo', targetUrl: 'https://app.example.test', framework: 'angular' },
    },
    showErrors: {},
    urlChecking: false,
    env: {},
    validating: false,
    busy: false,
    pending: { host: '', path: '' },
    ...overrides,
  };
}

describe('SDK wizard rendering', () => {
  it('escapes every server and user text', () => {
    expect(esc('<img src=x onerror=alert(1)>"\'&')).toBe(
      '&lt;img src=x onerror=alert(1)&gt;&quot;&#39;&amp;',
    );
    const html = render(
      state({
        draft: {
          ...state().draft,
          project: { name: '<script>x</script>', targetUrl: '', framework: 'other' },
        },
        visited: 3,
      }),
    );
    expect(html).not.toContain('<script>x</script>');
    expect(html).toContain('&lt;script&gt;x&lt;/script&gt;');
  });

  it('never renders a password input: credentials are variable names', () => {
    for (const step of [1, 2, 3, 4] as const) {
      const html = render(
        state({
          step,
          visited: 4,
          draft: {
            ...state().draft,
            environment: {
              ...state().draft.environment,
              auth: {
                type: 'form',
                loginUrl: '/login',
                usernameSelector: '#u',
                passwordSelector: '#p',
                submitSelector: '#s',
                usernameEnv: 'QA_USERNAME',
                passwordEnv: 'QA_PASSWORD',
              },
            },
          },
        }),
      );
      expect(html).not.toMatch(/type="password"/);
    }
  });

  it('shows Chromium as the only engine browser and the data-changes switch locked off', () => {
    expect(render(state({ step: 2, visited: 2 }))).toContain('seul disponible');
    const exploration = render(state({ step: 3, visited: 3 }));
    expect(exploration).toMatch(/<input type="checkbox" role="switch" disabled\s*>/);
    expect(exploration).toContain('maxStates');
  });

  it('marks the step with a blocking problem in the journey after validation', () => {
    const html = render(
      state({
        step: 4,
        visited: 4,
        validation: {
          ok: false,
          blocking: [{ step: 'environment', field: 'auth', message: 'QA_PASSWORD missing' }],
          warnings: [],
          environment: { QA_PASSWORD: false },
        },
      }),
    );
    expect(html).toMatch(/class="step err"/);
    expect(html).toContain('QA_PASSWORD missing');
    expect(html).toMatch(/data-act="launch"\s+disabled/);
  });

  it('shows the run counters against their own budgets, never a global percentage', () => {
    const html = render(
      state({
        step: 5,
        visited: 5,
        run: {
          snapshot: {
            id: 'exp_1',
            projectId: 'prj_1',
            status: 'RUNNING',
            queuedAt: '2026-01-01T00:00:00Z',
            startedAt: '2026-01-01T00:00:00Z',
            serverTime: '2026-01-01T00:00:42Z',
            budget: { maxStates: 100, maxActions: 500, maxDurationMinutes: 15, maxDepth: 10 },
            counters: {
              states: 6,
              transitions: 4,
              actions: 31,
              blocked: 1,
              issues: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
            },
            lastSeq: 9,
          },
          counters: {
            states: 6,
            transitions: 4,
            actions: 31,
            blocked: 1,
            issues: { INFO: 0, WARNING: 1, ERROR: 0, CRITICAL: 0 },
          },
          events: [],
          nodes: [{ id: 'a', label: 'home', route: '/' }],
          edges: [],
          startedAtMs: 0,
          now: 42_000,
        },
      }),
    );
    expect(html).toContain('<b>6</b><em>/ 100</em>');
    expect(html).toContain('<b>31</b><em>/ 500</em>');
    expect(html).toContain('<b>0:42</b><em>/ 15:00</em>');
    // Le texte visible : ni pourcentage global, ni durée restante, ni annulation (le moteur ne l'offre pas).
    const visible = html.replace(/<[^>]+>/g, ' ');
    expect(visible).not.toMatch(/\d+\s?%/);
    expect(visible).not.toMatch(/restant|remaining|annuler|cancel/i);
  });

  it('offers the Salesforce Lightning type next to the web frameworks', () => {
    const html = render(state());
    expect(html).toContain('data-value="salesforce"');
    expect(html).toContain('Salesforce Lightning');
  });

  it('uses a compact step bar in embedded mode (CSS hides the dark panel)', () => {
    const html = render(state({ mode: 'embedded' }));
    expect(html).toContain('class="hsteps"');
  });

  it('checks formats locally (the server validation is the one that counts)', () => {
    const t = strings('fr');
    expect(
      stepErrors(
        { ...state().draft, project: { name: ' ', targetUrl: 'app.example.test', framework: 'other' } },
        1,
        t,
      ),
    ).toEqual({
      'project.name': t.required,
      'project.targetUrl': t.s1.formatBad,
    });
    const auth = {
      type: 'form' as const,
      loginUrl: '',
      usernameSelector: '#u',
      passwordSelector: '#p',
      submitSelector: '#s',
      usernameEnv: 'qa user',
      passwordEnv: 'QA_PASSWORD',
    };
    expect(
      Object.keys(
        stepErrors({ ...state().draft, environment: { ...state().draft.environment, auth } }, 2, t),
      ).sort(),
    ).toEqual(['environment.auth.loginUrl', 'environment.auth.usernameEnv']);
  });

  it('lays out the discovered screens by depth from the first one', () => {
    const layout = layoutMap(
      [
        { id: 'a', label: 'home', route: '/' },
        { id: 'b', label: 'users', route: '/users' },
        { id: 'c', label: 'user', route: '/users/:id' },
      ],
      [
        { from: 'a', to: 'b' },
        { from: 'b', to: 'c' },
        { from: 'b', to: 'c' },
      ],
    );
    expect(layout.nodes.map((node) => node.depth)).toEqual([0, 1, 2]);
    expect(layout.edges).toHaveLength(2);
    expect(layout.hidden).toBe(0);
  });

  it('formats the elapsed time and merges the host initial values over the engine defaults', () => {
    expect(formatClock(42_000)).toBe('0:42');
    expect(formatClock(3_725_000)).toBe('1:02:05');
    const merged = draftWith(engineDefaults(), {
      project: { name: 'Portal' },
      exploration: { maxStates: 20 },
    });
    expect(merged.project.name).toBe('Portal');
    expect(merged.exploration.maxStates).toBe(20);
    expect(merged.exploration.maxActions).toBe(500);
  });
});
