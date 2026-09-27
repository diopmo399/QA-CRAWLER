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
  /** Dernière observation de chaque état : ses actions, avec leurs localisateurs. */
  details: ReadonlyMap<string, { actions: DiscoveredAction[] }>;
  /** Formulaires remplis pendant l'exploration (valeurs utilisées, jamais une valeur sensible). */
  forms: readonly FormReport[];
  /** Valeurs des champs isolés remplis hors d'un formulaire. */
  testData: TestDataProvider;
}

export interface FlowGenerationOptions {
  maxFlows: number;
}

/** Un flow tel qu'écrit dans le YAML (la forme d'entrée du schéma des flows). */
export type GeneratedFlow = Record<string, unknown> & { name: string; steps: Record<string, unknown>[] };

/** Ce que montre la page est recopié tel quel, jamais interprété : au plus cette longueur. */
const MAX_TEXT = 80;

/**
 * GÉNÉRATION DE FLOWS : transforme ce que l'exploration a appris en flows imposés
 * (YAML), un par écran en bout de chemin — les écrans intermédiaires sont couverts
 * par les flows qui y passent. Chaque flow rejoue le chemin enregistré (clics,
 * formulaires remplis avec les valeurs utilisées) et se termine par une vérification
 * de l'écran atteint. Les champs sensibles ne reçoivent jamais de valeur : ils lisent
 * une variable d'environnement à définir. Chaque flow est vérifié avec le schéma des
 * flows ; celui qui ne passe pas est laissé de côté.
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
  // Un écran traversé par un autre chemin est déjà couvert.
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
  // Remplir un formulaire laisse l'écran tel quel : ses champs sont remplis sur cet écran, avant de le quitter.
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
    if (input.forms.some((report) => report.actionId === edge.actionId)) continue; // le remplissage lui-même
    const action = actions.find((candidate) => candidate.id === edge.actionId);
    if (!action) return undefined; // impossible à rejouer sous forme d'étape écrite
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

/** Champs d'un formulaire rempli, dans l'ordre, avec les valeurs utilisées. */
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
      if (action.risks.includes('payment')) return undefined; // jamais écrit, jamais rempli
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

/** La cible de flow d'un localisateur enregistré (mêmes stratégies, mêmes noms). */
function targetOf(locator: LocatorDescriptor): Record<string, unknown> {
  const target: Record<string, unknown> =
    locator.strategy === 'role'
      ? { role: locator.role, ...(locator.name ? { name: locator.name } : {}) }
      : { [locator.strategy]: locator.value };
  if (locator.exact) target.exact = true;
  if (locator.nth !== undefined) target.nth = locator.nth;
  return target;
}

/** L'écran atteint : son titre principal, sinon son URL. */
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

/** QA_FIELD_CURRENT_PASSWORD : la variable à définir pour un champ sensible. */
function envName(label: string): string {
  return `QA_FIELD_${slug(label).replace(/-/g, '_').toUpperCase()}`;
}

/** Le fichier YAML : un en-tête qui dit d'où il vient, puis `flows:`. */
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
