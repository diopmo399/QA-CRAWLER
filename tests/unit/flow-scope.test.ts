import { describe, expect, it } from 'vitest';
import { actionsInScope, isInScope, scopeOf } from '../../src/flows/flow-scope.js';
import type { DiscoveredAction } from '../../src/model/discovered-action.js';

const action = (overrides: Partial<DiscoveredAction>): DiscoveredAction => ({
  id: overrides.id ?? 'a',
  stateId: 's',
  type: 'click',
  category: 'other',
  elementType: 'button',
  disabled: false,
  visible: true,
  classification: 'SAFE',
  reason: 'test',
  risks: [],
  locator: { strategy: 'role', role: 'button', name: 'x' },
  ...overrides,
});

describe('thenExplore scope', () => {
  const scope = scopeOf('http://localhost:4200/app/admin/fideles/');

  it('covers the flow screen and the pages below it', () => {
    expect(scope.path).toBe('/app/admin/fideles');
    expect(isInScope(scope, 'http://localhost:4200/app/admin/fideles')).toBe(true);
    expect(isInScope(scope, 'http://localhost:4200/app/admin/fideles?page=2')).toBe(true);
    expect(isInScope(scope, 'http://localhost:4200/app/admin/fideles/12/edit')).toBe(true);
    expect(isInScope(scope, 'http://localhost:4200/app/admin/fidelesX')).toBe(false);
    expect(isInScope(scope, 'http://localhost:4200/app/admin/dashboard')).toBe(false);
  });

  it('follows hash routes', () => {
    const hash = scopeOf('http://localhost:4200/#/users/3');
    expect(isInScope(hash, 'http://localhost:4200/#/users/3/historique')).toBe(true);
    expect(isInScope(hash, 'http://localhost:4200/#/settings')).toBe(false);
  });

  it('keeps in-page controls and links below the screen, never the global menu', () => {
    const kept = actionsInScope(scope, [
      action({ id: 'tab', category: 'tab' }),
      action({
        id: 'details',
        type: 'navigate',
        category: 'details',
        href: 'http://localhost:4200/app/admin/fideles/12',
      }),
      action({
        id: 'menu',
        type: 'navigate',
        category: 'menu',
        href: 'http://localhost:4200/app/admin/fideles/new',
      }),
      action({
        id: 'elsewhere',
        type: 'navigate',
        category: 'navigation',
        href: 'http://localhost:4200/app/admin/devoirs',
      }),
      action({ id: 'no-href', type: 'navigate', category: 'navigation' }),
    ]);
    expect(kept.map((candidate) => candidate.id)).toEqual(['tab', 'details']);
  });
});
