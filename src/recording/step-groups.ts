import type { FlowStep } from '../config/flow-schema.js';
import type { BusinessStepGroup, RecordedFlow, RecordedFlowStep } from './model.js';

/**
 * LES GROUPES MÉTIER DU RECORDING : des objets fonctionnels (« Création de la demande », « Recherche »)
 * qui portent des étapes existantes, dans l'ordre du flow. Créer, renommer, décrire, regrouper,
 * déplacer, réordonner, replier, détacher, supprimer (en gardant les étapes), exécuter un groupe seul.
 *
 * Invariants :
 *   - les identifiants des étapes ne changent jamais ; une étape appartient à un groupe au plus ;
 *   - une vérification (`expect`) suit toujours l'action qu'elle vérifie : elle se déplace avec elle ;
 *   - un déplacement ou un réordonnancement qui placerait une étape AVANT l'étape qui produit la
 *     donnée qu'elle cite est BLOQUÉ (sauf `force`), et toujours signalé ;
 *   - un ancien enregistrement sans groupe reste valide : toutes ses étapes sont hors groupe.
 */
export interface StepDependency {
  stepId: string;
  /** Les données citées par l'étape (clés de testData), et celles qu'elle produit (première saisie de la clé). */
  consumes: string[];
  produces: string[];
}

export interface DependencyViolation {
  stepId: string;
  key: string;
  producerStepId: string;
  message: string;
}

export interface GroupDataFlow {
  /** Les clés citées par le groupe et produites ailleurs (ses entrées). */
  inputs: { key: string; producerStepId?: string; producerGroupId?: string }[];
  /** Les clés produites par le groupe et citées ailleurs (ses sorties). */
  outputs: { key: string; consumerStepIds: string[] }[];
}

export interface GroupView extends BusinessStepGroup {
  /** Les positions (1…n) des étapes dans le flow tel qu'écrit. */
  positions: number[];
  data: GroupDataFlow;
  /** Le point de départ si le groupe est joué seul (le dernier `goto` avant lui, sinon le départ du flow). */
  startAt: string;
  /** Les vérifications d'écran et les assertions métier ancrées dans le groupe. */
  checks: string[];
  assertionIds: string[];
  /** Jouable seul : aucune entrée produite hors du groupe ; sinon ce qui manque. */
  runnableAlone: { ok: boolean; missing: string[] };
}

export type GroupCommand =
  | { op: 'create'; name: string; description?: string; stepIds?: string[] }
  | { op: 'rename'; groupId: string; name: string }
  | { op: 'describe'; groupId: string; description: string }
  | { op: 'assign'; groupId: string; stepIds: string[] }
  | { op: 'detach'; stepIds: string[] }
  | { op: 'move-step'; stepId: string; direction: 'up' | 'down' }
  | { op: 'reorder-steps'; groupId: string; stepIds: string[] }
  | { op: 'move-group'; groupId: string; direction: 'up' | 'down' }
  | { op: 'collapse'; groupId: string; collapsed: boolean }
  | { op: 'delete'; groupId: string; keepSteps?: boolean };

export type GroupOutcome =
  { ok: true; warnings: string[] } | { error: string; violations?: DependencyViolation[] };

const CITATION = /\$\{testData:([^}]+)\}/g;

function citations(value: unknown, into: Set<string>): void {
  if (typeof value === 'string') {
    for (const match of value.matchAll(CITATION)) if (match[1]) into.add(match[1]);
    return;
  }
  if (Array.isArray(value)) {
    for (const item of value) citations(item, into);
    return;
  }
  if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (key === 'testData' && typeof item === 'string') into.add(item);
      else citations(item, into);
    }
  }
}

function keysOf(step: FlowStep): Set<string> {
  const keys = new Set<string>();
  citations(step, keys);
  return keys;
}

/** Les dépendances de données de chaque étape d'action : la première saisie d'une clé la produit, les citations la consomment. */
export function stepDependencies(flow: Pick<RecordedFlow, 'steps'>): StepDependency[] {
  const produced = new Set<string>();
  const result: StepDependency[] = [];
  for (const item of flow.steps) {
    const keys = keysOf(item.step);
    const produces: string[] = [];
    const consumes: string[] = [];
    const filled =
      item.step.kind === 'fill' && typeof item.step.value !== 'string' && 'testData' in item.step.value
        ? item.step.value.testData
        : undefined;
    for (const key of keys) {
      if (key === filled && !produced.has(key)) {
        produces.push(key);
        produced.add(key);
      } else consumes.push(key);
    }
    result.push({ stepId: item.id, consumes, produces });
  }
  return result;
}

/**
 * Les étapes qui citeraient une donnée avant l'étape qui la produit, dans l'ordre `steps`. Qui produit
 * quoi se lit dans l'ordre de RÉFÉRENCE (l'enregistrement) : la première saisie d'une clé la produit,
 * quel que soit l'ordre proposé.
 */
export function dependencyViolations(
  steps: readonly RecordedFlowStep[],
  reference: readonly RecordedFlowStep[] = steps,
): DependencyViolation[] {
  const roles = new Map(stepDependencies({ steps: [...reference] }).map((entry) => [entry.stepId, entry]));
  const dependencies = steps.map(
    (item) => roles.get(item.id) ?? { stepId: item.id, consumes: [...keysOf(item.step)], produces: [] },
  );
  const producerOf = new Map<string, string>();
  const violations: DependencyViolation[] = [];
  for (const dependency of dependencies) {
    for (const key of dependency.consumes) {
      const producer = producerOf.get(key);
      if (producer === undefined) {
        // Un producteur plus loin dans le flow : la donnée est citée avant d'exister.
        const later = dependencies.find((entry) => entry.produces.includes(key));
        if (later)
          violations.push({
            stepId: dependency.stepId,
            key,
            producerStepId: later.stepId,
            message: `step ${dependency.stepId} uses testData.${key} before step ${later.stepId} produces it`,
          });
      }
    }
    for (const key of dependency.produces) producerOf.set(key, dependency.stepId);
  }
  return violations;
}

/** Une action et les vérifications qui la suivent : le bloc qui se déplace d'un seul tenant. */
function blockOf(steps: readonly RecordedFlowStep[], index: number): RecordedFlowStep[] {
  const anchor = steps[index];
  if (!anchor || anchor.step.kind === 'expect') return anchor ? [anchor] : [];
  const block = [anchor];
  const ids = new Set(anchor.actionIds);
  for (let next = index + 1; next < steps.length; next += 1) {
    const candidate = steps[next];
    if (!candidate || candidate.step.kind !== 'expect' || !candidate.actionIds.some((id) => ids.has(id)))
      break;
    block.push(candidate);
  }
  return block;
}

/** Les blocs (action + ses vérifications) du flow, dans l'ordre. */
function blocks(steps: readonly RecordedFlowStep[]): RecordedFlowStep[][] {
  const result: RecordedFlowStep[][] = [];
  let index = 0;
  while (index < steps.length) {
    const block = blockOf(steps, index);
    if (block.length === 0) break;
    result.push(block);
    index += block.length;
  }
  return result;
}

function groupOf(flow: RecordedFlow, stepId: string): BusinessStepGroup | undefined {
  return flow.groups?.find((group) => group.stepIds.includes(stepId));
}

/** L'étape d'action d'un identifiant (une vérification renvoie à son action). */
function actionStepId(flow: RecordedFlow, stepId: string): string | undefined {
  const index = flow.steps.findIndex((item) => item.id === stepId);
  const item = flow.steps[index];
  if (!item) return undefined;
  if (item.step.kind !== 'expect') return item.id;
  for (let back = index - 1; back >= 0; back -= 1) {
    const previous = flow.steps[back];
    if (
      previous &&
      previous.step.kind !== 'expect' &&
      previous.actionIds.some((id) => item.actionIds.includes(id))
    )
      return previous.id;
  }
  return undefined;
}

/** Normalise les groupes : étapes existantes seulement, dans l'ordre du flow, une seule fois, avec leurs vérifications. */
export function normalizeGroups(flow: RecordedFlow): void {
  if (!flow.groups) return;
  const order = new Map(flow.steps.map((item, index) => [item.id, index]));
  const seen = new Set<string>();
  for (const group of flow.groups) {
    const wanted = new Set<string>();
    for (const stepId of group.stepIds) {
      const action = actionStepId(flow, stepId);
      if (action !== undefined) wanted.add(action);
    }
    const ids: string[] = [];
    for (const block of blocks(flow.steps)) {
      const anchor = block[0];
      if (!anchor || !wanted.has(anchor.id) || seen.has(anchor.id)) continue;
      for (const item of block) {
        ids.push(item.id);
        seen.add(item.id);
      }
    }
    group.stepIds = ids.sort((a, b) => (order.get(a) ?? 0) - (order.get(b) ?? 0));
  }
  flow.groups = flow.groups.filter((group) => group.stepIds.length > 0 || group.name.trim() !== '');
  if (flow.groups.length === 0) delete flow.groups;
}

function nextGroupId(groups: readonly BusinessStepGroup[]): string {
  const max = groups.reduce((best, group) => {
    const match = /^g(\d+)$/.exec(group.id);
    return match ? Math.max(best, Number(match[1])) : best;
  }, 0);
  return `g${String(max + 1)}`;
}

/** Réordonne les blocs du flow pour qu'ils suivent l'ordre des groupes (les étapes hors groupe gardent leur place relative). */
function reorderByGroups(flow: RecordedFlow): void {
  if (!flow.groups || flow.groups.length === 0) return;
  const all = blocks(flow.steps);
  const groupIndex = new Map<string, number>();
  flow.groups.forEach((group, index) => {
    for (const stepId of group.stepIds) groupIndex.set(stepId, index);
  });
  // Chaque bloc prend le rang de son groupe ; un bloc hors groupe prend le rang du groupe précédent (ou -1).
  let current = -1;
  const ranked = all.map((block, position) => {
    const anchor = block[0];
    const rank = anchor ? groupIndex.get(anchor.id) : undefined;
    if (rank !== undefined) current = rank;
    return { block, rank: rank ?? current, position };
  });
  ranked.sort((a, b) => a.rank - b.rank || a.position - b.position);
  flow.steps = ranked.flatMap((entry) => entry.block);
}

function applyOrder(
  flow: RecordedFlow,
  proposed: RecordedFlowStep[],
  force: boolean | undefined,
): GroupOutcome | undefined {
  const violations = dependencyViolations(proposed, flow.steps);
  if (violations.length > 0 && !force)
    return {
      error: `this change would use a value before it exists: ${violations.map((entry) => entry.message).join('; ')}`,
      violations,
    };
  flow.steps = proposed;
  return violations.length > 0 ? { ok: true, warnings: violations.map((entry) => entry.message) } : undefined;
}

/**
 * Applique une commande de groupe au flow (en place). Les dépendances de données sont vérifiées avant
 * tout déplacement : une violation bloque (sauf `force`, où elle devient un avertissement).
 */
export function applyGroupCommand(
  flow: RecordedFlow,
  command: GroupCommand,
  options: { force?: boolean } = {},
): GroupOutcome {
  const groups = (flow.groups ??= []);
  const find = (groupId: string): BusinessStepGroup | undefined =>
    groups.find((group) => group.id === groupId);
  const known = (stepIds: readonly string[]): string[] =>
    stepIds.map((stepId) => actionStepId(flow, stepId)).filter((id): id is string => id !== undefined);
  let outcome: GroupOutcome | undefined;
  switch (command.op) {
    case 'create': {
      const name = command.name.trim();
      if (!name) return { error: 'a group needs a name' };
      if (groups.some((group) => group.name === name))
        return { error: `a group named "${name}" already exists` };
      const stepIds = known(command.stepIds ?? []);
      for (const other of groups) other.stepIds = other.stepIds.filter((id) => !stepIds.includes(id));
      groups.push({
        id: nextGroupId(groups),
        name,
        ...(command.description?.trim() ? { description: command.description.trim() } : {}),
        stepIds,
      });
      break;
    }
    case 'rename': {
      const group = find(command.groupId);
      if (!group) return { error: `unknown group ${command.groupId}` };
      const name = command.name.trim();
      if (!name) return { error: 'a group needs a name' };
      if (groups.some((other) => other !== group && other.name === name))
        return { error: `a group named "${name}" already exists` };
      group.name = name;
      break;
    }
    case 'describe': {
      const group = find(command.groupId);
      if (!group) return { error: `unknown group ${command.groupId}` };
      const description = command.description.trim();
      if (description) group.description = description;
      else delete group.description;
      break;
    }
    case 'assign': {
      const group = find(command.groupId);
      if (!group) return { error: `unknown group ${command.groupId}` };
      const stepIds = known(command.stepIds);
      if (stepIds.length === 0) return { error: 'no step to assign' };
      for (const other of groups)
        if (other !== group) other.stepIds = other.stepIds.filter((id) => !stepIds.includes(id));
      group.stepIds = [...new Set([...group.stepIds, ...stepIds])];
      normalizeGroups(flow);
      const before = flow.steps.map((item) => item.id).join(',');
      const snapshot = [...flow.steps];
      reorderByGroups(flow);
      if (flow.steps.map((item) => item.id).join(',') !== before) {
        const proposed = flow.steps;
        flow.steps = snapshot;
        outcome = applyOrder(flow, proposed, options.force);
        if (outcome && 'error' in outcome) {
          // L'affectation est annulée : le groupe ne garde pas des étapes qu'il ne peut pas ordonner.
          group.stepIds = group.stepIds.filter((id) => !stepIds.includes(id));
          normalizeGroups(flow);
          return outcome;
        }
      }
      break;
    }
    case 'detach': {
      const stepIds = new Set(known(command.stepIds));
      for (const group of groups) group.stepIds = group.stepIds.filter((id) => !stepIds.has(id));
      break;
    }
    case 'move-step': {
      const action = actionStepId(flow, command.stepId);
      if (action === undefined) return { error: `unknown step ${command.stepId}` };
      const all = blocks(flow.steps);
      const index = all.findIndex((block) => block[0]?.id === action);
      const target = command.direction === 'up' ? index - 1 : index + 1;
      if (index < 0 || target < 0 || target >= all.length) return { error: 'the step is already at the end' };
      const swapped = [...all];
      [swapped[index], swapped[target]] = [swapped[target] ?? [], swapped[index] ?? []];
      const result = applyOrder(flow, swapped.flat(), options.force);
      if (result && 'error' in result) return result;
      outcome = result;
      // Le bloc déplacé rejoint le groupe de son nouveau voisin quand il franchit une frontière de groupe.
      const neighbour = all[target]?.[0];
      const from = groupOf(flow, action);
      const to = neighbour ? groupOf(flow, neighbour.id) : undefined;
      if (from !== to) {
        if (from) from.stepIds = from.stepIds.filter((id) => id !== action);
        if (to) to.stepIds.push(action);
      }
      break;
    }
    case 'reorder-steps': {
      const group = find(command.groupId);
      if (!group) return { error: `unknown group ${command.groupId}` };
      const wanted = known(command.stepIds);
      const members = new Set(
        group.stepIds.map((id) => actionStepId(flow, id)).filter((id): id is string => id !== undefined),
      );
      if (wanted.length !== members.size || wanted.some((id) => !members.has(id)))
        return { error: 'the new order must list every step of the group once' };
      const all = blocks(flow.steps);
      const slots = all
        .map((block, position) => ({ block, position }))
        .filter((entry) => members.has(entry.block[0]?.id ?? ''));
      const byId = new Map(all.map((block) => [block[0]?.id ?? '', block]));
      const proposed = [...all];
      slots.forEach((slot, order) => {
        proposed[slot.position] = byId.get(wanted[order] ?? '') ?? slot.block;
      });
      const result = applyOrder(flow, proposed.flat(), options.force);
      if (result && 'error' in result) return result;
      outcome = result;
      break;
    }
    case 'move-group': {
      const index = groups.findIndex((group) => group.id === command.groupId);
      if (index < 0) return { error: `unknown group ${command.groupId}` };
      const target = command.direction === 'up' ? index - 1 : index + 1;
      if (target < 0 || target >= groups.length) return { error: 'the group is already at the end' };
      const moving = groups[index];
      const neighbour = groups[target];
      if (!moving || !neighbour) return { error: 'the group is already at the end' };
      const reordered = [...groups];
      reordered[index] = neighbour;
      reordered[target] = moving;
      const snapshot = [...flow.steps];
      const previous = flow.groups;
      flow.groups = reordered;
      reorderByGroups(flow);
      const proposed = flow.steps;
      flow.steps = snapshot;
      const result = applyOrder(flow, proposed, options.force);
      if (result && 'error' in result) {
        flow.groups = previous;
        return result;
      }
      outcome = result;
      break;
    }
    case 'collapse': {
      const group = find(command.groupId);
      if (!group) return { error: `unknown group ${command.groupId}` };
      if (command.collapsed) group.collapsed = true;
      else delete group.collapsed;
      break;
    }
    case 'delete': {
      const index = groups.findIndex((group) => group.id === command.groupId);
      if (index < 0) return { error: `unknown group ${command.groupId}` };
      const [removed] = groups.splice(index, 1);
      if (removed && command.keepSteps === false) {
        const ids = new Set(removed.stepIds);
        flow.steps = flow.steps.filter((item) => !ids.has(item.id));
      }
      break;
    }
  }
  normalizeGroups(flow);
  return outcome ?? { ok: true, warnings: [] };
}

/** La vue d'un groupe : positions, données entrantes et sortantes, départ, vérifications, exécutabilité seule. */
export function groupViews(flow: RecordedFlow): GroupView[] {
  if (!flow.groups || flow.groups.length === 0) return [];
  const dependencies = new Map(stepDependencies(flow).map((entry) => [entry.stepId, entry]));
  const position = new Map(flow.steps.map((item, index) => [item.id, index + 1]));
  const producerOf = new Map<string, string>();
  for (const entry of dependencies.values())
    for (const key of entry.produces) producerOf.set(key, entry.stepId);
  const consumersOf = new Map<string, string[]>();
  for (const entry of dependencies.values())
    for (const key of entry.consumes)
      (consumersOf.get(key) ?? consumersOf.set(key, []).get(key))?.push(entry.stepId);
  return flow.groups.map((group) => {
    const members = new Set(group.stepIds);
    const inputs: GroupDataFlow['inputs'] = [];
    const outputs: GroupDataFlow['outputs'] = [];
    const seenIn = new Set<string>();
    for (const stepId of group.stepIds) {
      const entry = dependencies.get(stepId);
      if (!entry) continue;
      for (const key of entry.consumes) {
        const producer = producerOf.get(key);
        if ((producer === undefined || !members.has(producer)) && !seenIn.has(key)) {
          seenIn.add(key);
          inputs.push({
            key,
            ...(producer !== undefined ? { producerStepId: producer } : {}),
            ...(producer !== undefined && groupOf(flow, producer)
              ? { producerGroupId: groupOf(flow, producer)?.id }
              : {}),
          });
        }
      }
      for (const key of entry.produces) {
        const consumers = (consumersOf.get(key) ?? []).filter((consumer) => !members.has(consumer));
        if (consumers.length > 0) outputs.push({ key, consumerStepIds: consumers });
      }
    }
    const first = flow.steps.findIndex((item) => members.has(item.id));
    let startAt = flow.startAt;
    for (let back = first - 1; back >= 0; back -= 1) {
      const item = flow.steps[back];
      if (item?.step.kind === 'goto') {
        startAt = item.step.url;
        break;
      }
    }
    const checks = flow.steps
      .filter((item) => members.has(item.id) && item.step.kind === 'expect')
      .map((item) => item.label);
    const assertionIds = (flow.proposals ?? [])
      .filter(
        (proposal) =>
          proposal.assertion && proposal.afterStepId !== undefined && members.has(proposal.afterStepId),
      )
      .filter((proposal) =>
        (flow.businessAssertions ?? []).some((assertion) => assertion.id === proposal.assertion?.id),
      )
      .map((proposal) => proposal.assertion?.id ?? '');
    const missing = inputs.map(
      (input) =>
        `testData.${input.key}${input.producerStepId ? ` (produced by step ${input.producerStepId})` : ''}`,
    );
    return {
      ...group,
      positions: group.stepIds.map((stepId) => position.get(stepId) ?? 0),
      data: { inputs, outputs },
      startAt,
      checks,
      assertionIds,
      runnableAlone: { ok: missing.length === 0, missing },
    };
  });
}

/** Le flow réduit aux groupes choisis (pour générer ou exécuter) ; `null` quand des entrées manquent, sauf `force`. */
export function flowForGroups(
  flow: RecordedFlow,
  groupIds: readonly string[],
  options: { force?: boolean } = {},
): { flow: RecordedFlow } | { error: string; missing: string[] } {
  const views = groupViews(flow).filter((view) => groupIds.includes(view.id));
  if (views.length === 0) return { error: 'no group selected', missing: [] };
  const members = new Set(views.flatMap((view) => view.stepIds));
  const missing = views.flatMap((view) =>
    view.data.inputs
      .filter((input) => !(input.producerStepId !== undefined && members.has(input.producerStepId)))
      .map((input) => `testData.${input.key}`),
  );
  if (missing.length > 0 && !options.force)
    return {
      error: `the selection needs data produced outside it: ${[...new Set(missing)].join(', ')}`,
      missing: [...new Set(missing)],
    };
  const steps = flow.steps.filter((item) => members.has(item.id));
  const first = views[0];
  const assertionIds = new Set(views.flatMap((view) => view.assertionIds));
  const proposals = (flow.proposals ?? []).filter(
    (proposal) => proposal.afterStepId !== undefined && members.has(proposal.afterStepId),
  );
  return {
    flow: {
      ...flow,
      name: views.map((view) => view.name).join(' + '),
      startAt: first?.startAt ?? flow.startAt,
      steps,
      assertions: flow.assertions.filter((candidate) =>
        steps.some((item) => item.actionIds.includes(candidate.afterActionId)),
      ),
      proposals,
      ...(assertionIds.size > 0
        ? {
            businessAssertions: (flow.businessAssertions ?? []).filter((assertion) =>
              assertionIds.has(assertion.id),
            ),
          }
        : {}),
      groups: views.map((view) => ({
        id: view.id,
        name: view.name,
        ...(view.description ? { description: view.description } : {}),
        stepIds: view.stepIds,
      })),
    },
  };
}

/** Les groupes à écrire dans le YAML : nom, description, positions des étapes (1…n) dans le flow écrit. */
export function groupsForYaml(flow: RecordedFlow): Record<string, unknown>[] {
  if (!flow.groups || flow.groups.length === 0) return [];
  const position = new Map(flow.steps.map((item, index) => [item.id, index + 1]));
  return flow.groups.map((group) => ({
    id: group.id,
    name: group.name,
    ...(group.description ? { description: group.description } : {}),
    steps: group.stepIds
      .map((stepId) => position.get(stepId))
      .filter((entry): entry is number => entry !== undefined),
  }));
}
