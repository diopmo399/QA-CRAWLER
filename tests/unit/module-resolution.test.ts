import { describe, expect, it } from 'vitest';
import { ClassIdentity } from '../../src/static-analysis/class-identity.js';
import { ModuleResolver, parseJsonc } from '../../src/static-analysis/module-resolution.js';

/**
 * La résolution des modules d'une source : alias de chemin des `tsconfig` (extends, baseUrl, motifs), fichiers
 * barils, et ce qu'elle refuse de résoudre (bibliothèque, alias non déclaré, cycle de réexports).
 */
const file = (path: string, text = ''): { path: string; text: string } => ({ path, text });

describe('parseJsonc', () => {
  it('reads a tsconfig with comments and trailing commas, and keeps `//` inside strings', () => {
    const parsed = parseJsonc(`{
      // commentaire
      "a": "http://host/x", /* bloc */
      "b": [1, 2,],
    }`);
    expect(parsed).toEqual({ a: 'http://host/x', b: [1, 2] });
  });

  it('gives undefined for a text that is not JSON', () => {
    expect(parseJsonc('{ not json')).toBeUndefined();
  });
});

describe('ModuleResolver', () => {
  const files = [
    file('tsconfig.base.json', '{ "compilerOptions": { "paths": { "@lib/*": ["libs/*/src/index.ts"] } } }'),
    file(
      'apps/shop/tsconfig.json',
      '{ "extends": "../../tsconfig.base", "compilerOptions": { "baseUrl": "src" } }',
    ),
    file(
      'apps/admin/tsconfig.json',
      '{ "compilerOptions": { "baseUrl": ".", "paths": { "@app/*": ["src/*"], "@lib/ui": ["src/local-ui.ts"] } } }',
    ),
    file('libs/ui/src/index.ts', "export * from './button';\nexport { Card as Tile } from './card';"),
    file('libs/ui/src/button.ts', 'export class Button {}'),
    file('libs/ui/src/card.ts', 'export class Card {}'),
    file('libs/loop/src/index.ts', "export * from './again';"),
    file('libs/loop/src/again.ts', "export * from './index';"),
    file('apps/shop/src/main.ts'),
    file('apps/shop/src/core/api.ts', 'export const URL = "/x";'),
    file('apps/admin/src/main.ts'),
    file('apps/admin/src/local-ui.ts', 'export class Button {}'),
    file('apps/admin/src/pages/home.ts'),
  ];
  const resolver = new ModuleResolver(files);

  it('follows `extends` up to the file that declares the aliases, and resolves a wildcard pattern', () => {
    expect(resolver.resolve('apps/shop/src/main.ts', '@lib/ui')).toBe('libs/ui/src/index.ts');
  });

  it('resolves a non-relative import against baseUrl, and a relative one against the file', () => {
    expect(resolver.resolve('apps/shop/src/main.ts', 'core/api')).toBe('apps/shop/src/core/api.ts');
    expect(resolver.resolve('apps/admin/src/pages/home.ts', '../main')).toBe('apps/admin/src/main.ts');
  });

  it('the nearest tsconfig wins: an exact alias beats the inherited pattern of another project', () => {
    expect(resolver.resolve('apps/admin/src/pages/home.ts', '@lib/ui')).toBe('apps/admin/src/local-ui.ts');
    expect(resolver.resolve('apps/admin/src/pages/home.ts', '@app/main')).toBe('apps/admin/src/main.ts');
  });

  it('never resolves a library or an alias that nothing declares', () => {
    expect(resolver.resolve('apps/shop/src/main.ts', '@angular/core')).toBeUndefined();
    expect(resolver.resolve('apps/shop/src/main.ts', '@app/main')).toBeUndefined();
  });

  it('follows a barrel to the declaring file, through `export *` and a renamed export', () => {
    expect(resolver.origin('libs/ui/src/index.ts', 'Button')).toEqual({
      file: 'libs/ui/src/button.ts',
      name: 'Button',
    });
    expect(resolver.origin('libs/ui/src/index.ts', 'Tile')).toEqual({
      file: 'libs/ui/src/card.ts',
      name: 'Card',
    });
    expect(resolver.origin('libs/ui/src/index.ts', 'Missing')).toBeUndefined();
  });

  it('a cycle of re-exports ends without an answer', () => {
    expect(resolver.origin('libs/loop/src/index.ts', 'Anything')).toBeUndefined();
  });

  it('the class identity uses it: the homonym imported through the alias is the declared one', () => {
    const identity = new ClassIdentity([
      ...files,
      file('apps/shop/src/page.ts', "import { Button } from '@lib/ui';\nexport class Page { b!: Button; }"),
      file(
        'apps/admin/src/page2.ts',
        "import { Button } from '@lib/ui';\nexport class Page2 { b!: Button; }",
      ),
      file('apps/admin/src/page3.ts', "import { Button } from 'unknown-lib';\nexport class Page3 {}"),
    ]);
    expect(identity.resolve('apps/shop/src/page.ts', 'Button')).toBe('Button(ui/src)');
    expect(identity.resolve('apps/admin/src/page2.ts', 'Button')).toBe('Button(admin/src)');
    expect(identity.resolve('apps/admin/src/page3.ts', 'Button')).toBeUndefined();
  });
});
