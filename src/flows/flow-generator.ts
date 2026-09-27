import { stringify } from 'yaml';
import { flowSchema } from '../config/flow-schema.js';
import type { TestDataProvider } from '../data/test-data-provider.js';
import type { FormReport } from '../forms/form-report.js';
import type { FlowGraph } from '../graph/flow-graph.js';
import type { DiscoveredAction } from '../model/discovered-action.js';
import type { FlowEdge, FlowNode } from '../model/flow.js';
import type { LocatorDescriptor } from '../model/locator.js';
import { normalizeText } from '../policies/keywords.js';

export interface FlowGenerationInput {
  graph: FlowGraph;
  /** Latest observation of each state: its actions, with their locators. */
  details: ReadonlyMap<string, { actions: DiscoveredAction[] }>;
  /** Forms filled during the exploration (values used, never a sensitive one). */
  forms: readonly FormReport[];
  /** Values of single fields filled outside a form. */
  testData: TestDataProvider;
}

export interface FlowGenerationOptions {
  maxFlows: number;
}

/** A flow as written in the YAML (the flow schema's input shape). */
export type GeneratedFlow = Record<string, unknown> & { name: string; steps: Record<string, unknown>[] };

/** Whatever the page shows is copied as-is, never interpreted: at most this long. */
const MAX_TEXT = 80;

/**
 * FLOW GENERATION: turns what the exploration learned into imposed flows
 * (YAML), one per screen at the end of a path — the screens on the way are
 * covered by the flows going through them. Each flow replays the recorded
 * path (clicks, forms filled with the values used) and ends by checking the
 * screen reached. Sensitive fields are never given a value: they read an
 * environment variable to set. Every flow is checked against the flow
 * schema; one that does not fit is left out.
 */
export function generateFlows(input: FlowGenerationInput, options: FlowGenerationOptions): GeneratedFlow[] {
  const { graph } = input;
  const root = graph.rootId ? graph.getNode(graph.rootId) : undefined;
  if (!root) return [];
  const paths = new Map<string, FlowEdge[]>();
  for (const node of graph.allNodes()) {
    if (node.id === root.id) continue;
    const path = graph.pathTo(node.id);
    if (path.length > 0) paths.set(node.id, path);
  }
  // A screen passed through by another path is already covered.
  const onTheWay = new Set<string>();
  for (const path of paths.values()) for (const edge of path.slice(1)) onTheWay.add(edge.from);
  const flows: GeneratedFlow[] = [];
  const names = new Set<string>();
  for (const [stateId, path] of paths) {
    if (onTheWay.has(stateId)) continue;
    const target = graph.getNode(stateId);
    if (!target) continue;
    const flow = flowTo(input, root, target, path, names);
    if (flow) flows.push(flow);
    if (flows.length >= options.maxFlows) break;
  }
  return flows;
}

function flowTo(
  input: FlowGenerationInput,
  root: FlowNode,
  target: FlowNode,
  path: readonly FlowEdge[],
  names: Set<string>,
): GeneratedFlow | undefined {
  const steps: Record<string, unknown>[] = [];
  // Filling a form leaves the screen as it is: its fields are filled on that screen, before leaving it.
  const formsOn = (stateId: string): FormReport[] => {
    const seen = new Set<string>();
    return input.forms.filter((report) => {
      if (report.stateId !== stateId || seen.has(report.group)) return false;
      seen.add(report.group);
      return true;
    });
  };
  const fillForms = (stateId: string): void => {
    const actions = input.details.get(stateId)?.actions ?? [];
    for (const form of formsOn(stateId)) steps.push(...formSteps(form, actions));
  };
  for (const edge of path) {
    const actions = input.details.get(edge.from)?.actions ?? [];
    fillForms(edge.from);
    if (input.forms.some((report) => report.actionId === edge.actionId)) continue; // the fill itself
    const action = actions.find((candidate) => candidate.id === edge.actionId);
    if (!action) return undefined; // not replayable as a written step
    const step = actionStep(action, input.testData);
    if (!step) return undefined;
    steps.push(step);
  }
  fillForms(target.id);
  const check = expectation(target);
  if (check) steps.push({ name: `on ${target.label}`, expect: check });
  if (steps.length === 0) return undefined;

  const base = `to-${slug(target.label)}`;
  let name = base;
  for (let index = 2; names.has(name); index++) name = `${base}-${index}`;
  const flow: GeneratedFlow = {
    name,
    description: `Recorded path: ${[root.label, ...path.map((edge) => labelOf(edge))].join(' → ')}`,
    startAt: relative(root.url),
    steps,
  };
  if (!flowSchema.safeParse(flow).success) return undefined;
  names.add(name);
  return flow;
}

/** Fields of a filled form, in order, with the values used. */
function formSteps(form: FormReport, actions: readonly DiscoveredAction[]): Record<string, unknown>[] {
  const steps: Record<string, unknown>[] = [];
  for (const field of form.fields) {
    const action = actions.find((candidate) => candidate.id === field.id);
    if (!action || !field.operation || field.operation === 'skip') continue;
    const target = targetOf(action.locator);
    if (field.operation === 'check' || field.operation === 'uncheck') {
      steps.push({ [field.operation]: target });
    } else if (field.operation === 'select') {
      const option = field.value || firstRealOption(action);
      if (option) steps.push({ select: { ...target, option } });
    } else if (field.sensitive) {
      steps.push({ fill: { ...target, value: { env: envName(field.label) } } });
    } else if (field.value !== undefined) {
      steps.push({ fill: { ...target, value: field.value } });
    }
  }
  return steps;
}

function actionStep(
  action: DiscoveredAction,
  testData: TestDataProvider,
): Record<string, unknown> | undefined {
  const target = targetOf(action.locator);
  const allow =
    action.classification === 'SAFE'
      ? {}
      : { allow: action.classification === 'MUTATION' ? 'MUTATION' : action.classification };
  switch (action.type) {
    case 'click':
    case 'navigate':
      return { click: target, ...allow };
    case 'check':
    case 'uncheck':
      return { [action.type]: target };
    case 'fill': {
      if (action.risks.includes('payment')) return undefined; // never written, never filled
      if (action.risks.includes('sensitive-data'))
        return { fill: { ...target, value: { env: envName(action.label ?? action.text ?? action.id) } } };
      const instruction = testData.instructionFor(action);
      return instruction.kind === 'fill' ? { fill: { ...target, value: instruction.value } } : undefined;
    }
    case 'select': {
      const instruction = testData.instructionFor(action);
      const option =
        instruction.kind === 'select' && instruction.label ? instruction.label : firstRealOption(action);
      return option ? { select: { ...target, option } } : undefined;
    }
  }
}

/** The flow target of a recorded locator (same strategies, same names). */
function targetOf(locator: LocatorDescriptor): Record<string, unknown> {
  const target: Record<string, unknown> =
    locator.strategy === 'role'
      ? { role: locator.role, ...(locator.name ? { name: locator.name } : {}) }
      : { [locator.strategy]: locator.value };
  if (locator.exact) target.exact = true;
  if (locator.nth !== undefined) target.nth = locator.nth;
  return target;
}

/** The screen reached: its main heading, else its URL. */
function expectation(node: FlowNode): Record<string, unknown> | undefined {
  const heading = node.subtitle ?? node.headings[0];
  if (heading) return { text: heading.slice(0, MAX_TEXT) };
  const url = relative(node.url);
  return url !== '/' && !url.includes(':') ? { url } : undefined;
}

function firstRealOption(action: DiscoveredAction): string | undefined {
  const disabled = new Set(action.field?.disabledOptions ?? []);
  return action.field?.options?.find(
    (option) =>
      option.trim() !== '' &&
      !disabled.has(option) &&
      !/^(-+|(choisir|choose|select|sélectionner|selectionner|aucun|none)\b)/i.test(option.trim()),
  );
}

function labelOf(edge: FlowEdge): string {
  return (edge.action.text ?? edge.action.label ?? edge.action.type).slice(0, MAX_TEXT);
}

function relative(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.pathname}${parsed.search}`;
  } catch {
    return '/';
  }
}

function slug(text: string): string {
  return (
    normalizeText(text)
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || 'screen'
  );
}

/** QA_FIELD_CURRENT_PASSWORD: the variable to set for a sensitive field. */
function envName(label: string): string {
  return `QA_FIELD_${slug(label).replace(/-/g, '_').toUpperCase()}`;
}

/** The YAML file: a header saying where it comes from, then `flows:`. */
export function flowsYaml(
  flows: readonly GeneratedFlow[],
  source: { mission: string; date: string },
): string {
  const header = [
    `# Flows generated by QA-CRAWLER from the exploration "${source.mission}" (${source.date}).`,
    '# One flow per screen at the end of a path; the screens on the way are covered by the flows going through them.',
    '# Review before use: values are test data; sensitive fields read an environment variable (value: { env: … }).',
    '# Copy the flows you want under `flows:` in a mission.',
  ].join('\n');
  return `${header}\n${stringify({ flows }, { lineWidth: 0 })}`;
}
