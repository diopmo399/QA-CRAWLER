import { describe, expect, it } from 'vitest';
import { parseConfig } from '../../src/config/config-loader.js';
import { generatePlaywrightTests } from '../../src/platform/playwright-test-generator.js';
import { flow, result, step } from '../fixtures/qa-platform-results.js';

/**
 * NON-RÉGRESSION du générateur Playwright : il lit les flows et le résultat d'un run, produit du
 * texte, et c'est tout. Les flows source ne changent pas, aucune action n'est jouée sur
 * l'application, et un flow issu d'un enregistrement (cibles CSS de repli, ligne de tableau,
 * citation d'une donnée du run) se génère comme un flow écrit à la main.
 */
const RECORDED = `
mission: { name: recorded }
target: { baseUrl: http://app.test }
flows:
  - name: open the created request
    startAt: /requests
    testData: { values: { request.title: { strategy: generated, generator: text } } }
    steps:
      - click: { role: link, name: New request }
      - fill: { css: 'form > div > div > input', value: { testData: request.title } }
      - click: { role: button, name: Save }
        allow: MUTATION
        effects: { route: /requests/, appears: ['button:Edit'] }
      - fill: { label: Search, value: { testData: request.title } }
      - click: { role: button, name: Search, exact: true }
      - click: { text: '\${testData:request.title}', row: { Title: '\${testData:request.title}' } }
      - expect: { text: '\${testData:request.title}', url: /requests/ }
`;

describe('Playwright generator — non-regression', () => {
  it('does not modify the source flows and performs no action: the same input gives the same output', () => {
    const { config } = parseConfig(RECORDED, {}, {});
    const before = JSON.stringify(config.flows);
    const run = result([flow('open the created request', [step(1, 'New request'), step(2, 'Fill title')])]);
    const first = generatePlaywrightTests(config.flows, run.flows, { baseUrl: 'http://app.test' });
    const second = generatePlaywrightTests(config.flows, run.flows, { baseUrl: 'http://app.test' });
    expect(JSON.stringify(config.flows)).toBe(before);
    expect(second).toEqual(first);
    expect(first).toHaveLength(1);
    expect(first[0]).toMatchObject({
      flow: 'open the created request',
      fileName: 'open-the-created-request.spec.ts',
      steps: 7,
    });
  });

  it('generates a recorded flow: CSS fallback, table row, run value cited by the search and the expectation', () => {
    const { config } = parseConfig(RECORDED, {}, {});
    const [test] = generatePlaywrightTests(config.flows, [], { baseUrl: 'http://app.test' });
    const content = test?.content ?? '';
    expect(content).toContain(`await page.goto("http://app.test/requests");`);
    expect(content).toContain(`page.locator("form > div > div > input").fill(testData["request.title"])`);
    expect(content).toContain(`page.getByLabel("Search").fill(testData["request.title"])`);
    // Une citation ${testData:clé} devient la donnée du run (jamais le texte littéral de la citation).
    expect(content).toContain('getByRole(\'row\').filter({ hasText: `${testData["request.title"]}` })');
    expect(content).toContain(
      'await expect(page.getByText(`${testData["request.title"]}`).first()).toBeVisible();',
    );
    expect(content).not.toContain('${testData:');
    expect(content).toContain(`toHaveURL(new RegExp("/requests/"))`);
    expect(content).toContain(`getByRole("button", { name: "Edit" }).first()).toBeVisible()`);
    expect(content).toContain(`"request.title": \`title-\${runTag}\``);
    // Jamais une valeur enregistrée ni un secret : seule la clé de la donnée apparaît.
    expect(content).not.toMatch(/QA-CRAWLER-/);
    expect(test?.assertions).toBe(4);
  });
});
