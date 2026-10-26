import {
  expectStepOf,
  nativeComment,
  replayOnlyComment,
  translateAssertions,
} from './assertion-translation.js';
import type { FlowStep, FlowTarget } from '../config/flow-schema.js';
import type { FlowRunReport } from '../model/flow-run.js';
import {
  literalEnvName,
  playwrightLocator,
  playsFirstMatch,
  routeTemplatePattern,
  playwrightValue,
  testDataKeysOf,
  playwrightText,
  type FlowDefinition,
} from './flow-steps.js';

/**
 * PLAYWRIGHT TEST GENERATOR : d'un flow (et de ce que son exécution a appris) à un test Playwright
 * autonome, lisible, avec des localisateurs sémantiques (getByRole, getByLabel, getByText) et des
 * assertions tirées des effets attendus (effects: route, appears, request), des étapes `expect`
 * et des checkpoints sémantiques. Les données de test citées deviennent des valeurs générées,
 * marquées du run (jamais une valeur enregistrée, jamais un secret : `{ env }` devient
 * process.env). Les flows d'origine ne sont jamais modifiés.
 *
 * Ce qui existait : la génération de flows YAML / Gherkin depuis l'exploration (flow-generator) ;
 * aucun générateur Playwright.
 */

export interface GeneratedTest {
  /** Les assertions métier que seul le rejeu QA-CRAWLER vérifie (dites en commentaire dans le test). */
  replayOnly?: string[];
  flow: string;
  fileName: string;
  content: string;
  steps: number;
  assertions: number;
}

export interface TestGenerationOptions {
  baseUrl: string;
  /** Les checkpoints sémantiques du run (id → statut) ajoutés en commentaire d'intention. */
  checkpoints?: readonly { id: string; status: string }[];
}

const quote = (text: string): string => JSON.stringify(text);
const slug = (text: string): string =>
  text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'flow';

/**
 * L'URL attendue, lue comme le moteur la lit : `expect.url` est un texte que l'URL contient ;
 * `effects.route` est un gabarit de route (routeTemplatePattern).
 */
function routeAssertion(route: string, template = false): string {
  const pattern = template ? routeTemplatePattern(route) : route.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return `await expect(page).toHaveURL(new RegExp(${quote(pattern)}));`;
}

/** Le localisateur d'une action, joué comme le moteur le joue (playsFirstMatch). */
function actionLocator(target: FlowTarget): string {
  return `${playwrightLocator(target)}${playsFirstMatch(target) ? '.first()' : ''}`;
}

function stepLines(
  step: FlowStep,
  index: number,
  report: FlowRunReport | undefined,
  flowName: string,
): { lines: string[]; assertions: number } {
  const observed = report?.steps.find((entry) => entry.index === index);
  const lines: string[] = [
    `// step ${String(index)}${observed ? ` — ${observed.description} (${observed.status} at run time)` : ''}`,
  ];
  let assertions = 0;
  switch (step.kind) {
    case 'goto':
      lines.push(`await page.goto(${quote(step.url)});`);
      break;
    case 'click':
      lines.push(`await ${actionLocator(step.target)}.click();`);
      break;
    case 'check':
    case 'uncheck':
      lines.push(`await ${actionLocator(step.target)}.${step.kind}();`);
      break;
    case 'fill':
      lines.push(
        `await ${actionLocator(step.target)}.fill(${playwrightValue(step.value, literalEnvName(flowName, index))});`,
      );
      break;
    case 'select':
      lines.push(`await ${actionLocator(step.target)}.selectOption(${quote(step.option)});`);
      break;
    case 'expect': {
      const expectation = step.expect;
      if (expectation.url) {
        lines.push(routeAssertion(expectation.url));
        assertions += 1;
      }
      if (expectation.text) {
        lines.push(
          `await expect(page.getByText(${playwrightText(expectation.text)}).first()).toBeVisible();`,
        );
        assertions += 1;
      }
      if (expectation.visible) {
        lines.push(`await expect(${playwrightLocator(expectation.visible)}).toBeVisible();`);
        assertions += 1;
      }
      if (expectation.hidden) {
        lines.push(`await expect(${playwrightLocator(expectation.hidden)}).toBeHidden();`);
        assertions += 1;
      }
      if (expectation.noError) {
        lines.push(
          `await expect(page.locator('[role="alert"], .mat-error, .invalid-feedback')).toHaveCount(0);`,
        );
        assertions += 1;
      }
      if (expectation.response) {
        const { method, url, status } = expectation.response;
        lines.push(
          `await page.waitForResponse((response) => response.url().includes(${quote(url)})${method ? ` && response.request().method() === ${quote(method)}` : ''} && ${
            typeof status === 'number'
              ? `response.status() === ${String(status)}`
              : `String(response.status()).startsWith(${quote(status[0] ?? '2')})`
          });`,
        );
        assertions += 1;
      }
      break;
    }
    case 'screenshot':
      lines.push(`await page.screenshot({ path: ${quote(`${slug(step.label)}.png`)} });`);
      break;
    case 'manual':
      lines.push(`// MANUAL: ${step.text}`);
      break;
    case 'auto':
      lines.push(`// TODO (interpreted at run time by QA-CRAWLER): ${step.sentence}`);
      break;
    case 'intent':
      lines.push(
        `// TODO (semantic intent resolved at run time by QA-CRAWLER): ${JSON.stringify(step.intent)}`,
      );
      break;
    case 'dragAndDrop':
      lines.push(
        `await page.getByText(${quote(step.item)}).first().dragTo(page.getByText(${quote(step.to.label ?? step.to.section ?? '')}).first());`,
      );
      break;
  }
  // Les effets attendus appris à l'enregistrement deviennent des assertions.
  if (step.effects?.route) {
    lines.push(routeAssertion(step.effects.route, true));
    assertions += 1;
  }
  for (const control of step.effects?.appears ?? []) {
    const [role, name] = control.includes(':') ? control.split(':', 2) : ['text', control];
    lines.push(
      role === 'text' || !name
        ? `await expect(page.getByText(${playwrightText(name ?? role ?? '')}).first()).toBeVisible();`
        : `await expect(page.getByRole(${quote(role ?? 'button')}, { name: ${playwrightText(name)} }).first()).toBeVisible();`,
    );
    assertions += 1;
  }
  return { lines, assertions };
}

/** Le test Playwright d'un flow. */
export function generatePlaywrightTest(
  definition: FlowDefinition,
  report: FlowRunReport | undefined,
  options: TestGenerationOptions,
): GeneratedTest {
  const keys = testDataKeysOf(definition.steps);
  const body: string[] = [];
  let assertions = 0;
  // LES ASSERTIONS MÉTIER (modèle commun) : natives → une attente après leur étape ; sinon un commentaire.
  const business = translateAssertions(definition.assertions, definition.steps.length);
  const groupAt = new Map((definition.groups ?? []).map((group) => [group.steps[0] ?? 0, group]));
  const pushNative = (position: number): void => {
    for (const assertion of business.nativeAfter.get(position) ?? []) {
      const step = expectStepOf(assertion);
      if (!step) continue;
      const generated = stepLines(step, position, report, definition.name);
      body.push(`// ${nativeComment(assertion)}`, ...generated.lines.slice(1), '');
      assertions += generated.assertions;
    }
  };
  definition.steps.forEach((step, position) => {
    const group = groupAt.get(position + 1);
    if (group) body.push(`// ── group: ${group.name}${group.description ? ` — ${group.description}` : ''}`);
    const generated = stepLines(step, position + 1, report, definition.name);
    body.push(...generated.lines, '');
    assertions += generated.assertions;
    pushNative(position + 1);
  });
  pushNative(0);
  for (const assertion of business.replayOnly) body.push(`// ${replayOnlyComment(assertion)}`);
  if (business.replayOnly.length > 0) body.push('');
  const start = new URL(definition.startAt ?? '/', options.baseUrl).toString();
  const checkpoints = (options.checkpoints ?? []).map(
    (checkpoint) => ` *   - ${checkpoint.id}: ${checkpoint.status}`,
  );
  const content = [
    `import { test, expect } from '@playwright/test';`,
    '',
    '/**',
    ` * Generated by QA-CRAWLER from the flow "${definition.name}"${definition.description ? ` — ${definition.description}` : ''}.`,
    ` * Run status at generation time: ${report?.status ?? 'not executed'}.`,
    ' * Test data is generated per run (never a recorded value); literal values of the flow and secrets come from the environment (QA_REPRO_<FLOW>_STEP_<n>).',
    ...(checkpoints.length > 0 ? [' * Semantic checkpoints observed:', ...checkpoints] : []),
    ...(business.replayOnly.length > 0
      ? [
          ' * Business assertions this test cannot verify by itself (the QA-CRAWLER replay does, on the observed network):',
          ...business.replayOnly.map((assertion) => ` *   - ${assertion.id}: ${assertion.description}`),
        ]
      : []),
    ' */',
    `const runTag = \`QA-\${Date.now().toString(36)}\`;`,
    `const testData: Record<string, string> = {`,
    ...keys.map((key) => `  ${quote(key)}: \`${key.split('.').pop() ?? key}-\${runTag}\`,`),
    '};',
    '',
    `test.describe(${quote(definition.name)}, () => {`,
    `  test(${quote(definition.description ?? definition.name)}, async ({ page }) => {`,
    `    await page.goto(${quote(start)});`,
    '',
    ...body.map((line) => (line ? `    ${line}` : '')),
    '  });',
    '});',
    '',
  ].join('\n');
  return {
    flow: definition.name,
    fileName: `${slug(definition.name)}.spec.ts`,
    content,
    steps: definition.steps.length,
    assertions,
    ...(business.replayOnly.length > 0
      ? { replayOnly: business.replayOnly.map((assertion) => assertion.id) }
      : {}),
  };
}

/** Un test par flow de la mission. */
export function generatePlaywrightTests(
  definitions: readonly FlowDefinition[],
  reports: readonly FlowRunReport[],
  options: TestGenerationOptions,
): GeneratedTest[] {
  return definitions.map((definition) =>
    generatePlaywrightTest(
      definition,
      reports.find((report) => report.name === definition.name),
      options,
    ),
  );
}
