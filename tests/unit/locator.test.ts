import { describe, expect, it } from 'vitest';
import { buildLocator, buildLocators } from '../../src/discovery/locator-builder.js';
import { toLocator, type LocatorFactory } from '../../src/execution/locator-resolver.js';
import { describeLocator, type LocatorDescriptor } from '../../src/model/locator.js';
import { button, element, field, link } from '../helpers.js';

describe('buildLocator (preference order)', () => {
  it('prefers testId, then role + name, then label, then text, then css', () => {
    expect(buildLocator(button('Save', { testId: 'save-btn' }))).toEqual({
      strategy: 'testId',
      value: 'save-btn',
    });
    expect(buildLocator(link('Users', 'http://x.test/users'))).toEqual({
      strategy: 'role',
      role: 'link',
      name: 'Users',
      exact: true,
    });
    expect(buildLocator(field('Email', { role: '', name: '' }))).toEqual({
      strategy: 'label',
      value: 'Email',
      exact: true,
    });
    expect(buildLocator(element({ tag: 'span', role: '', name: '', text: 'Open' }))).toEqual({
      strategy: 'text',
      value: 'Open',
      exact: true,
    });
    expect(buildLocator(element({ tag: 'div', role: '', name: '', text: '', css: '#root > div' }))).toEqual({
      strategy: 'css',
      value: '#root > div',
    });
  });

  it('adds nth only for ambiguous descriptors', () => {
    const locators = buildLocators([button('Voir'), button('Voir'), button('Autre')]);
    expect(locators.map((locator) => locator.nth)).toEqual([0, 1, undefined]);
  });

  it('describes locators for humans', () => {
    expect(describeLocator({ strategy: 'role', role: 'button', name: 'OK', nth: 2 })).toBe(
      'role=button[name="OK"] [2]',
    );
  });
});

describe('toLocator (descriptor → Playwright)', () => {
  const calls: string[] = [];
  const fake = new Proxy(
    {},
    {
      get:
        (_target, method: string) =>
        (...args: unknown[]) => {
          calls.push(`${method}(${JSON.stringify(args)})`);
          return {};
        },
    },
  ) as unknown as LocatorFactory;

  it('maps each strategy to the matching Playwright method', () => {
    const cases: [LocatorDescriptor, string][] = [
      [
        { strategy: 'role', role: 'button', name: 'Nouvel utilisateur', exact: true },
        'getByRole(["button",{"name":"Nouvel utilisateur","exact":true}])',
      ],
      [{ strategy: 'testId', value: 'save' }, 'getByTestId(["save"])'],
      [{ strategy: 'label', value: 'Email', exact: true }, 'getByLabel(["Email",{"exact":true}])'],
      [{ strategy: 'text', value: 'Open' }, 'getByText(["Open",{"exact":false}])'],
      [{ strategy: 'css', value: '#id' }, 'locator(["#id"])'],
    ];
    for (const [descriptor, expected] of cases) {
      calls.length = 0;
      toLocator(fake, descriptor);
      expect(calls).toEqual([expected]);
    }
  });
});
