import { chromium, type Browser, type Page } from 'playwright';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { captureScript } from '../../src/recording/capture-script.js';
import { selectorAnalyzerSource, type SelectorAnalysis } from '../../src/recording/selector-builder.js';

/**
 * DISCRIMINATING CSS SELECTOR BUILDER, sur un vrai DOM : chaque candidat est compté par
 * querySelectorAll ; le préféré est le minimum stable discriminant, le structurel reste en repli.
 */
let browser: Browser;
let page: Page;

beforeAll(async () => {
  browser = await chromium.launch();
});
afterAll(async () => {
  await browser.close();
});
beforeEach(async () => {
  page = await browser.newPage();
});

/** Un champ Material dans un composant hôte : même structure pour tous, ids générés. */
const material = (host: string, attributes: string, label: string, index: number): string =>
  `<${host} ${attributes}><mat-form-field class="mat-mdc-form-field"><div><div><span><mat-label>${label}</mat-label></span><div><input id="mat-input-${String(index)}" class="mat-mdc-input-element"></div></div></div></mat-form-field></${host}>`;

const analyse = async (html: string, selector = 'input'): Promise<SelectorAnalysis[]> => {
  await page.setContent(`<main>${html}</main>`);
  return await page.evaluate(
    `(() => { const analyse = ${selectorAnalyzerSource()}; return Array.from(document.querySelectorAll(${JSON.stringify(selector)})).map(analyse); })()`,
  );
};

describe('DiscriminatingCssSelectorBuilder (real DOM)', () => {
  it('TEST 1 / 2 / 3 / 7 four inputs with the same Material structure: the formControlName of each HOST makes a unique selector; the generic one matches all', async () => {
    const result = await analyse(
      [
        material('app-input-mask', 'formcontrolname="branchNumber"', 'Branch number', 0),
        material('app-input', 'formcontrolname="legalName"', 'Legal name', 1),
        material('app-input', 'formcontrolname="contactFirstName"', 'Contact first name', 2),
        material('app-input', 'formcontrolname="contactLastName"', 'Contact last name', 3),
        material('app-input', 'formcontrolname="phone"', 'Phone', 4),
        material('app-input', 'formcontrolname="email"', 'Email', 5),
      ].join(''),
    );
    expect(result.map((entry) => entry.preferred?.selector)).toEqual([
      'app-input-mask[formcontrolname="branchNumber"] input',
      'app-input[formcontrolname="legalName"] input',
      'app-input[formcontrolname="contactFirstName"] input',
      'app-input[formcontrolname="contactLastName"] input',
      'app-input[formcontrolname="phone"] input',
      'app-input[formcontrolname="email"] input',
    ]);
    for (const entry of result) {
      expect(entry.preferred).toMatchObject({ kind: 'HOST_BINDING', matchCount: 1, unique: true });
      expect(entry.host).toMatchObject({ attribute: 'formcontrolname' });
    }
    // Le CSS générique (les composants maison) désigne plusieurs champs : jamais préféré.
    const generic = result[1]?.candidates.find((candidate) => candidate.kind === 'COMPONENT');
    expect(generic?.matchCount).toBe(6);
    expect(generic?.unique).toBe(false);
  });

  it('TEST 5 a generated Material id is unique but DYNAMIC: never preferred over the host identity', async () => {
    const [entry] = await analyse(material('app-input', 'formcontrolname="legalName"', 'Legal name', 0));
    const id = entry?.candidates.find((candidate) => candidate.selector === '#mat-input-0');
    expect(id).toMatchObject({ unique: true, usesDynamicAttribute: true });
    expect(entry?.preferred?.selector).toBe('app-input[formcontrolname="legalName"] input');
    expect(entry?.ambiguity.reasons).toContain('DYNAMIC_ID');
  });

  it('TEST 6 a stable data-testid on the element is preferred', async () => {
    const [entry] = await analyse('<form><input data-testid="customer-email" class="field"></form>');
    expect(entry?.preferred).toMatchObject({ selector: '[data-testid="customer-email"]', kind: 'TEST_ID' });
    expect(entry?.ambiguity.level).toBe('NONE');
  });

  it('TEST 4 / 8 the same label in two sections: a contextual selector (section anchor) is unique — and as short as possible', async () => {
    const result = await analyse(
      `<section data-section="company"><label>Name <input></label></section><section data-section="contact"><label>Name <input></label></section>`,
    );
    expect(result.map((entry) => entry.preferred?.selector)).toEqual([
      '[data-section="company"] input',
      '[data-section="contact"] input',
    ]);
    expect(result[0]?.preferred?.kind).toBe('CONTEXTUAL');
  });

  it('TEST 9 / 10 a field reachable only by positions keeps a unique nth-of-type chain, flagged STRUCTURAL_ONLY (MEDIUM); a stable candidate always wins over it', async () => {
    const result = await analyse('<div><div><input></div><div><input></div></div>');
    expect(result[1]?.preferred?.usesStructuralIndex).toBe(true);
    expect(result[1]?.ambiguity.level).toBe('MEDIUM');
    expect(result[1]?.ambiguity.reasons).toContain('STRUCTURAL_ONLY');
    const named = await analyse('<div><div><input></div><div><input name="city"></div></div>');
    expect(named[1]?.preferred).toMatchObject({ selector: 'input[name="city"]', usesStructuralIndex: false });
    expect(named[1]?.structural.usesStructuralIndex).toBe(true);
  });

  it('TEST 11 the structural selector is always kept as fallback, with its match count', async () => {
    const result = await analyse(
      material('app-input', 'formcontrolname="a"', 'A', 0) +
        material('app-input', 'formcontrolname="b"', 'B', 1),
    );
    expect(result[0]?.structural.selector).toMatch(/input$/);
    expect(result[0]?.structural.matchCount).toBeGreaterThan(0);
    expect(result[0]?.preferred?.selector).not.toBe(result[0]?.structural.selector);
  });
});

describe('Screen inventory in the capture script (real page)', () => {
  const install = async (
    html: string,
  ): Promise<{
    inventories: { reason: string; elements: number }[];
    elements: Record<string, unknown>[];
  }> => {
    const inventories: { reason: string; elements: number }[] = [];
    const elements: Record<string, unknown>[] = [];
    await page.exposeBinding('qaTest', (_source, payload: { element?: Record<string, unknown> }) => {
      if (payload.element) elements.push(payload.element);
    });
    await page.exposeBinding('qaTest_inventory', (_source, payload: { reason: string; elements: number }) => {
      inventories.push(payload);
    });
    await page.setContent(`<main><h1>Create request</h1><form>${html}</form></main>`);
    await page.evaluate(
      captureScript({ binding: 'qaTest', salt: 'salt', overlay: false, inputDebounceMs: 100 }),
    );
    await page.waitForTimeout(700);
    return { inventories, elements };
  };

  it('TEST 15 / 16 the screen is inventoried once; typing reuses it (no new inventory); a field added later is analysed locally, and a structural change refreshes the inventory', async () => {
    const { inventories, elements } = await install(
      material('app-input', 'formcontrolname="legalName"', 'Legal name', 0) +
        material('app-input', 'formcontrolname="contactLastName"', 'Contact last name', 1),
    );
    expect(inventories.map((entry) => [entry.reason, entry.elements])).toEqual([['SCREEN_ARRIVED', 2]]);
    // Une saisie : le descripteur vient de l'inventaire, et rien n'est ré-inventorié.
    await page
      .locator('app-input[formcontrolname="legalName"] input')
      .pressSequentially('ACME', { delay: 30 });
    await page.locator('app-input[formcontrolname="legalName"] input').blur();
    await page.waitForTimeout(700);
    expect(inventories).toHaveLength(1);
    const typed = elements.find((element) => element.formControlName === 'legalName');
    expect((typed?.selectors as { inventory?: string } | undefined)?.inventory).toBe('INVENTORY');
    // Un champ apparu APRÈS l'inventaire : analysé localement, puis l'inventaire est rafraîchi.
    await page.evaluate(() => {
      const host = document.createElement('app-input');
      host.setAttribute('formcontrolname', 'reference');
      host.innerHTML =
        '<mat-form-field><div><div><span><mat-label>Reference</mat-label></span><div><input id="mat-input-9"></div></div></div></mat-form-field>';
      for (let index = 0; index < 4; index += 1)
        document.querySelector('form')?.appendChild(host.cloneNode(true));
      document.querySelectorAll('app-input[formcontrolname="reference"]').forEach((node, index) => {
        node.setAttribute('formcontrolname', `reference${['A', 'B', 'C', 'D'][index] ?? ''}`);
      });
    });
    await page
      .locator('app-input[formcontrolname="referenceA"] input')
      .pressSequentially('R1', { delay: 30 });
    await page.locator('app-input[formcontrolname="referenceA"] input').blur();
    await page.waitForTimeout(800);
    const added = elements.find((element) => element.formControlName === 'referenceA');
    expect(added?.css).toBe('app-input[formcontrolname="referenceA"] input');
    expect(inventories.map((entry) => entry.reason)).toEqual(['SCREEN_ARRIVED', 'STRUCTURE_CHANGED']);
    expect(inventories[1]?.elements).toBe(6);
  });
});
