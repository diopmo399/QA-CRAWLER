import type { FlowConfig, FlowStep, FlowTarget, FlowValue } from '../config/flow-schema.js';

/**
 * Les étapes d'un flow, dans les deux sens : du modèle exécutable (FlowStep) vers la forme YAML
 * d'une mission, et vers un localisateur Playwright. Partagé par le planificateur de reproduction
 * (un flow YAML minimal) et le générateur de tests Playwright. Les flows d'origine ne sont jamais
 * modifiés : on en produit de nouveaux.
 */

function targetYaml(target: FlowTarget): Record<string, unknown> {
  return {
    ...(target.strategy === 'role'
      ? { role: target.role, ...(target.name !== undefined ? { name: target.name } : {}) }
      : {}),
    ...(target.strategy === 'label' ? { label: target.value } : {}),
    ...(target.strategy === 'text' ? { text: target.value } : {}),
    ...(target.strategy === 'testId' ? { testId: target.value } : {}),
    ...(target.strategy === 'css' ? { css: target.value } : {}),
    ...(target.exact !== undefined ? { exact: target.exact } : {}),
    ...(target.nth !== undefined ? { nth: target.nth } : {}),
    ...(target.section !== undefined ? { section: target.section } : {}),
    ...(target.row !== undefined ? { row: target.row } : {}),
    ...(target.rowPick !== undefined ? { rowPick: target.rowPick } : {}),
  };
}

/**
 * Une valeur de saisie LITTÉRALE (écrite dans la mission) n'est jamais recopiée dans un artefact :
 * elle devient une variable d'environnement nommée d'après le flow et l'étape, à fournir au rejeu.
 */
export function literalEnvName(flow: string, index: number): string {
  return `QA_REPRO_${flow.toUpperCase().replace(/[^A-Z0-9]+/g, '_')}_STEP_${String(index)}`;
}

function safeValue(value: FlowValue, placeholder: string | undefined): FlowValue {
  return typeof value === 'string' && placeholder !== undefined ? { env: placeholder } : value;
}

/** Une étape exécutable rendue dans la forme YAML d'une mission (`literalEnv` : la variable qui remplace une valeur littérale). */
export function stepYaml(step: FlowStep, literalEnv?: string): Record<string, unknown> {
  const common = {
    ...(step.name !== undefined ? { name: step.name } : {}),
    ...(step.allow.length > 0 ? { allow: step.allow.length === 1 ? step.allow[0] : step.allow } : {}),
    ...(step.optional ? { optional: true } : {}),
    ...(step.timeoutMs !== undefined ? { timeoutMs: step.timeoutMs } : {}),
  };
  switch (step.kind) {
    case 'goto':
      return { goto: step.url, ...common };
    case 'click':
    case 'check':
    case 'uncheck':
      return { [step.kind]: targetYaml(step.target), ...common };
    case 'fill':
      return { fill: { ...targetYaml(step.target), value: safeValue(step.value, literalEnv) }, ...common };
    case 'select':
      return { select: { ...targetYaml(step.target), option: step.option }, ...common };
    case 'expect': {
      const { visible, hidden, ...rest } = step.expect;
      return {
        expect: {
          ...rest,
          ...(visible ? { visible: targetYaml(visible) } : {}),
          ...(hidden ? { hidden: targetYaml(hidden) } : {}),
        },
        ...common,
      };
    }
    case 'screenshot':
      return { screenshot: step.label, ...common };
    case 'manual':
      return { manual: step.text, ...common };
    case 'auto':
      return { auto: { sentence: step.sentence, type: step.type }, ...common };
    case 'intent':
      return { intent: step.intent, ...common };
    case 'dragAndDrop':
      return {
        dragAndDrop: { item: step.item, ...(step.from ? { from: step.from } : {}), to: step.to },
        ...common,
      };
  }
}

const quote = (text: string): string => JSON.stringify(text);

/** Le localisateur Playwright d'une cible (getByRole / getByLabel / getByText / getByTestId / locator). */
export function playwrightLocator(target: FlowTarget, scope = 'page'): string {
  let locator: string;
  switch (target.strategy) {
    case 'role':
      locator = `${scope}.getByRole(${quote(target.role ?? 'button')}${target.name !== undefined ? `, { name: ${quote(target.name)}${target.exact ? ', exact: true' : ''} }` : ''})`;
      break;
    case 'label':
      locator = `${scope}.getByLabel(${quote(target.value ?? '')}${target.exact ? ', { exact: true }' : ''})`;
      break;
    case 'text':
      locator = `${scope}.getByText(${quote(target.value ?? '')}${target.exact ? ', { exact: true }' : ''})`;
      break;
    case 'testId':
      locator = `${scope}.getByTestId(${quote(target.value ?? '')})`;
      break;
    case 'css':
      locator = `${scope}.locator(${quote(target.value ?? '')})`;
      break;
  }
  if (target.row) {
    const cells = Object.values(target.row)
      .map((value) => `.filter({ hasText: ${quote(value)} })`)
      .join('');
    locator = locator.replace(scope, `${scope}.getByRole('row')${cells}`);
  }
  return target.nth !== undefined ? `${locator}.nth(${String(target.nth)})` : locator;
}

/** L'expression Playwright d'une valeur : variable d'environnement (une valeur littérale n'est jamais recopiée), donnée de test. */
export function playwrightValue(value: FlowValue, literalEnv?: string): string {
  if (typeof value === 'string') return `process.env[${quote(literalEnv ?? 'QA_VALUE')}] ?? ''`;
  if ('env' in value) return `process.env[${quote(value.env)}] ?? ''`;
  return `testData[${quote(value.testData)}]`;
}

/** Les clés de données de test que les étapes citent (saisie ou citation ${testData:clé}). */
export function testDataKeysOf(steps: readonly FlowStep[]): string[] {
  const keys = new Set<string>();
  for (const step of steps) {
    if (step.kind === 'fill' && typeof step.value === 'object' && 'testData' in step.value)
      keys.add(step.value.testData);
    const text = JSON.stringify(step);
    for (const match of text.matchAll(/\$\{testData:([^}]+)\}/g)) if (match[1]) keys.add(match[1]);
  }
  return [...keys];
}

export type FlowDefinition = Pick<FlowConfig, 'name' | 'steps'> & { description?: string; startAt?: string };
