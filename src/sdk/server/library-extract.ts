import { createHash } from 'node:crypto';
import { describeStep, flowSchema } from '../../config/flow-schema.js';
import {
  isSensitiveKey,
  parseTestDataSet,
  testDataSetDocument,
  type TestDataEntry,
  type TestDataSet,
} from '../../data/test-data-set.js';
import type { RecordedFlow } from '../../recording/model.js';
import { groupViews, type GroupView } from '../../recording/step-groups.js';
import type {
  ExtractionBlockPlan,
  ExtractionDependency,
  ExtractionGroupView,
  ExtractionInput,
  ExtractionPlan,
  ExtractionSelection,
  ExtractionStepView,
} from '../core/contracts.js';
import { contractOf, dataUse, isDynamic } from './library-contract.js';

/**
 * L'EXTRACTION DE GROUPES MÉTIER VERS LA BIBLIOTHÈQUE : des fonctions pures, sans fichier.
 *
 * Les groupes sont ceux du Recorder (`RecordedFlow.groups`, identifiants stables) ; leurs dépendances
 * sont celles que le Recorder calcule (une donnée est produite par sa première saisie, consommée par
 * une citation). Pour une sélection (des groupes, ou une partie d'un groupe) et un mode (un bloc par
 * groupe, ou un bloc composé qui garde ses groupes), le plan dit, pour chaque bloc prévu : ses étapes
 * (telles que dans le YAML de l'enregistrement), ses assertions métier, son jeu de données RESTREINT
 * (une donnée produite hors du bloc n'y est jamais recopiée : elle devient une entrée), son contrat,
 * ses dépendances, sa provenance et sa validation. Rien n'est écrit ici, rien n'est inventé : une
 * donnée manquante reste une entrée signalée, sauf valeur fournie explicitement.
 */

type Raw = Record<string, unknown>;
const isObject = (value: unknown): value is Raw =>
  value !== null && typeof value === 'object' && !Array.isArray(value);

const NAME_MAX = 80;

/** L'enregistrement tel que l'extraction le lit. */
export interface ExtractionSource {
  name: string;
  flow: RecordedFlow;
  /** Le flow YAML de l'enregistrement (`generated.flow.yaml`), une étape par étape du Recorder. */
  yaml: Raw;
  data?: TestDataSet;
  /** L'empreinte du flow de l'enregistrement (le texte du YAML). */
  revision: string;
}

/** Un bloc prêt à écrire : son flow (reusable) et son jeu de données restreint. */
export interface ExtractionDraft {
  plan: ExtractionBlockPlan;
  flow: Raw;
  data?: TestDataSet;
  stepIds: string[];
  groupIds: string[];
  selection: ExtractionSelection[];
}

export const revisionOfText = (text: string): string =>
  createHash('sha256').update(text).digest('hex').slice(0, 16);

const kindOf = (step: unknown): string =>
  isObject(step)
    ? (Object.keys(step).find((key) =>
        [
          'goto',
          'click',
          'fill',
          'select',
          'check',
          'uncheck',
          'expect',
          'screenshot',
          'manual',
          'auto',
          'intent',
          'dragAndDrop',
          'run',
        ].includes(key),
      ) ?? 'unknown')
    : 'unknown';

/**
 * LA VALIDATION D'UN FLOW DE BLOC, localisée : le schéma des flows (actions, stratégies de ciblage,
 * clés), le jeu de données, et chaque clé lue (définie, ou entrée du contrat). Une étape `run:` (un bloc
 * qui en rejoue un autre) est vérifiée par la bibliothèque, pas par le schéma.
 */
export function validateBlockFlow(flow: Raw, data?: TestDataSet): string[] {
  const errors: string[] = [];
  const steps: unknown[] = Array.isArray(flow.steps) ? (flow.steps as unknown[]) : [];
  const { reusable: _reusable, testData: _testData, ...rest } = flow;
  const checked = flowSchema.safeParse({
    ...rest,
    steps: steps.map((step): unknown =>
      isObject(step) && typeof step.run === 'string' ? { manual: `run ${step.run}` } : step,
    ),
  });
  if (!checked.success)
    for (const issue of checked.error.issues) {
      const [head, index] = issue.path;
      if (head === 'steps' && typeof index === 'number') {
        const where = issue.path.slice(2).join('.');
        errors.push(
          `step ${String(index + 1)} (${kindOf(steps[index])})${where ? ` ${where}` : ''}: ${issue.message}`,
        );
      } else errors.push(`${issue.path.join('.') || 'flow'}: ${issue.message}`);
    }
  if (data)
    try {
      parseTestDataSet(testDataSetDocument(data), typeof flow.name === 'string' ? flow.name : 'block');
    } catch (error) {
      errors.push(`test data: ${error instanceof Error ? error.message : String(error)}`);
    }
  return errors;
}

/** Les groupes de l'enregistrement, tels que la sélection les montre. */
export function extractionGroups(source: ExtractionSource): ExtractionGroupView[] {
  const views = groupViews(source.flow);
  const names = new Map(views.map((view) => [view.id, view.name]));
  const steps = new Map(source.flow.steps.map((item) => [item.id, item]));
  return views.map((view) => {
    const members = view.stepIds.map((id) => steps.get(id)).filter((item) => item !== undefined);
    const actions = members.filter((item) => item.step.kind !== 'expect');
    return {
      id: view.id,
      name: view.name,
      ...(view.description ? { description: view.description } : {}),
      steps: members.length,
      checks: members.length - actions.length,
      assertions: view.assertionIds.length,
      startAt: view.startAt,
      actions: actions.slice(0, 3).map((item) => item.label),
      produces: [...new Set(view.data.outputs.map((output) => output.key))],
      consumes: view.data.inputs.map((input) => ({
        key: input.key,
        ...(input.producerGroupId
          ? { groupId: input.producerGroupId, groupName: names.get(input.producerGroupId) ?? '' }
          : {}),
      })),
      runnableAlone: view.runnableAlone.ok,
    };
  });
}

interface Part {
  view: GroupView;
  /** Les étapes choisies (identifiants, dans l'ordre du flow) ; toutes, ou une partie. */
  stepIds: string[];
  partial: boolean;
}

/** Les clés qu'une étape produit (première saisie) : la position (1…n) de leur producteur dans l'enregistrement. */
function producers(yamlSteps: readonly unknown[]): Map<string, number> {
  const first = new Map<string, number>();
  yamlSteps.forEach((step, index) => {
    for (const key of dataUse([step]).fills) if (!first.has(key)) first.set(key, index + 1);
  });
  return first;
}

/** Une sélection lue : ses groupes, dans l'ordre de l'enregistrement, ou ce qui ne va pas. */
function readSelection(
  source: ExtractionSource,
  selection: readonly ExtractionSelection[],
): { parts: Part[]; errors: string[] } {
  const errors: string[] = [];
  const views = groupViews(source.flow);
  const seen = new Set<string>();
  const parts: Part[] = [];
  if (selection.length === 0) errors.push('choose at least one group');
  for (const item of selection) {
    const view = views.find((entry) => entry.id === item.groupId);
    if (!view) {
      errors.push(`no group ${item.groupId} in the recording ${source.name}`);
      continue;
    }
    if (seen.has(view.id)) {
      errors.push(`the group "${view.name}" is chosen twice`);
      continue;
    }
    seen.add(view.id);
    const wanted = item.stepIds && item.stepIds.length > 0 ? new Set(item.stepIds) : undefined;
    if (wanted) {
      const foreign = [...wanted].filter((id) => !view.stepIds.includes(id));
      if (foreign.length > 0)
        errors.push(`"${view.name}": the step(s) ${foreign.join(', ')} are not in this group`);
    }
    const stepIds = wanted ? view.stepIds.filter((id) => wanted.has(id)) : [...view.stepIds];
    if (stepIds.length === 0) errors.push(`"${view.name}": choose at least one of its steps`);
    parts.push({ view, stepIds, partial: stepIds.length < view.stepIds.length });
  }
  // Une vérification suit toujours l'action qu'elle vérifie : une partie la garde avec elle.
  const order = source.flow.steps;
  for (const part of parts.filter((entry) => entry.partial)) {
    const chosen = new Set(part.stepIds);
    for (const id of part.stepIds) {
      const index = order.findIndex((item) => item.id === id);
      if (order[index]?.step.kind !== 'expect') continue;
      let back = index - 1;
      while (back >= 0 && order[back]?.step.kind === 'expect') back -= 1;
      const action = order[back];
      if (action && part.view.stepIds.includes(action.id) && !chosen.has(action.id))
        errors.push(
          `"${part.view.name}": the check "${order[index].label}" follows the action "${action.label}", which is not chosen`,
        );
    }
  }
  const position = new Map(order.map((item, index) => [item.id, index]));
  parts.sort((a, b) => (position.get(a.stepIds[0] ?? '') ?? 0) - (position.get(b.stepIds[0] ?? '') ?? 0));
  return { parts, errors };
}

const cleanName = (raw: string | undefined): string => (raw ?? '').replace(/\s+/g, ' ').trim();

/**
 * LE PLAN D'UNE PUBLICATION. `taken` : les noms déjà pris dans le projet (scénarios et blocs). Les
 * brouillons rendus sont ce que la publication écrira, si le plan est valide.
 */
export function planExtraction(
  source: ExtractionSource,
  input: ExtractionInput,
  context: { taken: readonly string[] },
): { plan: ExtractionPlan; drafts: ExtractionDraft[] } {
  const groups = extractionGroups(source);
  const yamlSteps = Array.isArray(source.yaml.steps) ? source.yaml.steps : [];
  const errors: string[] = [];
  if (yamlSteps.length !== source.flow.steps.length)
    errors.push(
      `the flow YAML of ${source.name} does not match its recorded steps (${String(yamlSteps.length)} for ${String(source.flow.steps.length)}): regenerate it first`,
    );
  const { parts, errors: selectionErrors } = readSelection(source, input.selection);
  errors.push(...selectionErrors);
  const mode = input.mode === 'composite' ? 'composite' : 'separate';
  const position = new Map(source.flow.steps.map((item, index) => [item.id, index + 1]));
  const producerOf = producers(yamlSteps);
  const groupOfStep = new Map<string, GroupView>();
  for (const view of groupViews(source.flow)) for (const id of view.stepIds) groupOfStep.set(id, view);
  const assertions = Array.isArray(source.yaml.assertions) ? source.yaml.assertions.filter(isObject) : [];
  const provided = input.provided ?? {};

  // Les blocs prévus : un par groupe, ou un seul pour tous.
  const units =
    mode === 'composite'
      ? parts.length > 0
        ? [{ key: 'composite', parts }]
        : []
      : parts.map((part) => ({ key: part.view.id, parts: [part] }));
  const blockOfPosition = new Map<number, string>();
  const unitNames = units.map((unit) => {
    const named = cleanName(input.names?.[unit.key]?.name);
    return named || unit.parts.map((part) => part.view.name).join(' + ');
  });
  units.forEach((unit, index) => {
    for (const part of unit.parts)
      for (const id of part.stepIds) blockOfPosition.set(position.get(id) ?? 0, unitNames[index] ?? '');
  });

  const drafts: ExtractionDraft[] = units.map((unit, unitIndex): ExtractionDraft => {
    const name = unitNames[unitIndex] ?? '';
    const description = cleanName(input.names?.[unit.key]?.description) || undefined;
    const stepIds = unit.parts.flatMap((part) => part.stepIds);
    const positions = stepIds.map((id) => position.get(id) ?? 0).filter((at) => at > 0);
    const startAt = unit.parts[0]?.view.startAt ?? source.flow.startAt;
    const transformations: string[] = [];
    const steps: unknown[] = positions.map((at): unknown => structuredClone(yamlSteps[at - 1] as unknown));
    const navigate = input.navigate === true && kindOf(steps[0]) !== 'goto' && Boolean(startAt);
    if (navigate) {
      steps.unshift({ goto: startAt });
      transformations.push(`starts with goto ${startAt} (its start page)`);
    }
    const offset = navigate ? 1 : 0;
    const newPosition = new Map(positions.map((at, index) => [at, index + 1 + offset]));
    const copiedAssertions = assertions
      .filter((assertion) => typeof assertion.after === 'number' && newPosition.has(assertion.after))
      .map((assertion) => ({ ...assertion, after: newPosition.get(assertion.after as number) }));
    const internalGroups =
      mode === 'composite'
        ? unit.parts.map((part) => ({
            id: part.view.id,
            name: part.view.name,
            ...(part.view.description ? { description: part.view.description } : {}),
            steps: part.stepIds.map((id) => newPosition.get(position.get(id) ?? 0) ?? 0),
          }))
        : [];

    // Les données : celles que le bloc utilise, restreintes à ce qu'il produit ou à ce qui ne vient de nulle part.
    const use = dataUse(steps);
    const used = new Set([...use.fills, ...use.cites]);
    const own = source.data?.values ?? {};
    for (const key of [...used]) {
      const reference = own[key]?.reference;
      if (own[key]?.strategy === 'REFERENCE' && reference) used.add(reference);
    }
    const values: Record<string, TestDataEntry> = {};
    const dependencies: ExtractionDependency[] = [];
    const data: ExtractionBlockPlan['data'] = [];
    const inside = new Set(positions);
    for (const key of [...used].sort()) {
      const producer = producerOf.get(key);
      const entry = own[key];
      const producedHere = producer !== undefined && inside.has(producer);
      if (producedHere || (producer === undefined && entry)) {
        if (entry) {
          values[key] = entry;
          data.push({ key, dynamic: isDynamic(entry) });
        } else
          errors.push(`"${name}": ${key} is typed but the test data of ${source.name} does not define it`);
        continue;
      }
      if (provided[key] !== undefined) {
        if (isSensitiveKey(key) || entry?.sensitive || entry?.strategy === 'CREDENTIAL_REFERENCE') {
          errors.push(
            `"${name}": ${key} is sensitive: no value can be provided, only an environment reference`,
          );
          continue;
        }
        values[key] = {
          key,
          strategy: 'BUSINESS_LITERAL',
          value: provided[key],
          sensitive: false,
        };
        data.push({ key, dynamic: false, provided: true });
        dependencies.push({ key, source: 'PROVIDED' });
        transformations.push(`value of ${key} provided at publication`);
        continue;
      }
      if (producer === undefined) {
        dependencies.push({ key, source: 'NOWHERE' });
        continue;
      }
      const block = blockOfPosition.get(producer);
      if (block && block !== name) {
        dependencies.push({ key, source: 'BLOCK', block });
        continue;
      }
      const producerStep = source.flow.steps[producer - 1];
      const group = producerStep ? groupOfStep.get(producerStep.id) : undefined;
      dependencies.push(
        group
          ? { key, source: 'UNSELECTED_GROUP', group: { id: group.id, name: group.name } }
          : { key, source: 'OUTSIDE_GROUPS' },
      );
    }
    const set: TestDataSet | undefined =
      Object.keys(values).length > 0
        ? {
            id: name || 'block',
            name: name || 'block',
            source: 'HUMAN_RECORDING',
            ...(source.data?.recordingSessionId
              ? { recordingSessionId: source.data.recordingSessionId }
              : {}),
            values,
          }
        : undefined;
    const flow: Raw = {
      name,
      ...(description ? { description } : {}),
      reusable: true,
      ...(startAt ? { startAt } : {}),
      steps,
      ...(copiedAssertions.length > 0 ? { assertions: copiedAssertions } : {}),
      ...(internalGroups.length > 0 ? { groups: internalGroups } : {}),
    };

    // La validation : nom, schéma, données, contrat.
    const blockErrors: string[] = [];
    const warnings: string[] = [];
    if (!name || name.length > NAME_MAX)
      blockErrors.push(`a name of 1 to ${String(NAME_MAX)} characters is required`);
    else if (context.taken.includes(name))
      blockErrors.push(`a scenario or a block is already named "${name}"`);
    else if (unitNames.filter((other) => other === name).length > 1)
      blockErrors.push(`two blocks of this publication are named "${name}"`);
    if (steps.length === 0) blockErrors.push('it has no step');
    blockErrors.push(...validateBlockFlow(flow, set));
    const { contract, problems } = contractOf({ name, steps, ...(set ? { data: set } : {}) });
    blockErrors.push(...problems);
    for (const dependency of dependencies) {
      if (dependency.source === 'UNSELECTED_GROUP')
        warnings.push(
          `consumes ${dependency.key}, produced by the group "${dependency.group?.name ?? ''}", which is not chosen: the block will need it as an input`,
        );
      if (dependency.source === 'OUTSIDE_GROUPS')
        warnings.push(
          `consumes ${dependency.key}, produced by a step outside any group: the block will need it as an input`,
        );
      if (dependency.source === 'NOWHERE')
        warnings.push(
          `consumes ${dependency.key}, which nothing produces nor defines: the block will need it as an input`,
        );
    }
    const firstIndex = positions[0] ?? 1;
    const midway = !navigate && firstIndex > 1 && kindOf(steps[0]) !== 'goto';
    if (midway)
      warnings.push(
        `it starts in the middle of the recording: composed after another block, it plays where that block left off (its start page ${startAt} is not visited)`,
      );
    const recorded = new Map(source.flow.steps.map((item) => [item.id, item]));
    const stepViews: ExtractionStepView[] = [
      ...(navigate ? [{ position: 1, kind: 'goto', label: `goto ${startAt}` }] : []),
      ...stepIds.map((id, index) => {
        const item = recorded.get(id);
        return {
          position: index + 1 + offset,
          source: position.get(id) ?? 0,
          stepId: id,
          kind: item?.step.kind ?? kindOf(yamlSteps[(position.get(id) ?? 1) - 1]),
          label: item?.label ?? '',
          ...(groupOfStep.get(id) ? { groupId: groupOfStep.get(id)?.id } : {}),
        };
      }),
    ];
    const plan: ExtractionBlockPlan = {
      key: unit.key,
      name,
      ...(description ? { description } : {}),
      composite: mode === 'composite',
      groups: unit.parts.map((part) => ({
        id: part.view.id,
        name: part.view.name,
        steps: part.stepIds.length,
        partial: part.partial,
      })),
      startAt,
      steps: stepViews,
      assertions: copiedAssertions.length,
      checks: stepViews.filter((step) => step.kind === 'expect').length,
      data,
      produces: [...new Set(use.fills.filter((key) => values[key] && !provided[key]))].sort(),
      consumes: dependencies.filter((entry) => entry.source !== 'PROVIDED').map((entry) => entry.key),
      contract,
      dependencies,
      transformations,
      midway,
      validation: { ok: blockErrors.length === 0, errors: blockErrors, warnings },
    };
    return {
      plan,
      flow,
      ...(set ? { data: set } : {}),
      stepIds,
      groupIds: unit.parts.map((part) => part.view.id),
      selection: unit.parts.map((part) => ({
        groupId: part.view.id,
        ...(part.partial ? { stepIds: part.stepIds } : {}),
      })),
    };
  });

  const blocks = drafts.map((draft) => draft.plan);
  const producedKeys = new Set(blocks.flatMap((block) => block.produces));
  const consumedKeys = new Set(blocks.flatMap((block) => block.consumes));
  const external = [
    ...new Set(
      blocks.flatMap((block) =>
        block.dependencies
          .filter((entry) => entry.source !== 'BLOCK' && entry.source !== 'PROVIDED')
          .map((entry) => entry.key),
      ),
    ),
  ].sort();
  const blockErrors = blocks.reduce((sum, block) => sum + block.validation.errors.length, 0);
  return {
    plan: {
      recording: source.name,
      mode,
      ok: errors.length === 0 && blocks.length > 0 && blocks.every((block) => block.validation.ok),
      groups,
      blocks,
      summary: {
        groups: parts.length,
        steps: blocks.reduce((sum, block) => sum + block.steps.length, 0),
        produced: producedKeys.size,
        consumed: consumedKeys.size,
        external,
        errors: errors.length + blockErrors,
        warnings: blocks.reduce((sum, block) => sum + block.validation.warnings.length, 0),
      },
      errors,
    },
    drafts,
  };
}

/** Les différences entre le contenu d'un bloc et celui que sa source donnerait aujourd'hui. */
export function contentChanges(
  current: { flow: Raw; data?: TestDataSet },
  next: { flow: Raw; data?: TestDataSet },
): string[] {
  const changes: string[] = [];
  const before: unknown[] = Array.isArray(current.flow.steps) ? (current.flow.steps as unknown[]) : [];
  const after: unknown[] = Array.isArray(next.flow.steps) ? (next.flow.steps as unknown[]) : [];
  const label = (step: unknown): string => {
    const parsed = flowSchema.shape.steps.element.safeParse(step);
    return parsed.success ? describeStep(parsed.data, true) : kindOf(step);
  };
  for (let index = 0; index < Math.max(before.length, after.length); index += 1) {
    const a = before[index];
    const b = after[index];
    if (a === undefined) changes.push(`step ${String(index + 1)} added: ${label(b)}`);
    else if (b === undefined) changes.push(`step ${String(index + 1)} removed: ${label(a)}`);
    else if (JSON.stringify(a) !== JSON.stringify(b))
      changes.push(`step ${String(index + 1)} changed: ${label(a)} → ${label(b)}`);
  }
  const pageOf = (flow: Raw): string => (typeof flow.startAt === 'string' ? flow.startAt : '—');
  if (pageOf(current.flow) !== pageOf(next.flow))
    changes.push(`start page: ${pageOf(current.flow)} → ${pageOf(next.flow)}`);
  const names = (flow: Raw): string =>
    JSON.stringify(
      (Array.isArray(flow.groups) ? flow.groups : []).filter(isObject).map((group) => group.name),
    );
  if (names(current.flow) !== names(next.flow)) changes.push('internal groups renamed or regrouped');
  const assertionsOf = (flow: Raw): string => JSON.stringify(flow.assertions ?? []);
  if (assertionsOf(current.flow) !== assertionsOf(next.flow)) changes.push('business assertions changed');
  const keys = new Set([...Object.keys(current.data?.values ?? {}), ...Object.keys(next.data?.values ?? {})]);
  for (const key of [...keys].sort()) {
    const a = current.data?.values[key];
    const b = next.data?.values[key];
    const shape = (entry: TestDataEntry | undefined): string =>
      entry ? JSON.stringify({ ...entry, provenance: undefined, key: undefined }) : '';
    if (!a) changes.push(`test data ${key} added`);
    else if (!b) changes.push(`test data ${key} no longer used`);
    else if (shape(a) !== shape(b)) changes.push(`test data ${key} defined differently`);
  }
  return changes;
}
