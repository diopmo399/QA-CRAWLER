import type { FlowStep } from '../config/flow-schema.js';
import { testDataReference } from '../data/test-data-references.js';
import {
  isSensitiveKey,
  testDataSetDocument,
  type TestDataEntry,
  type TestDataSet,
} from '../data/test-data-set.js';
import type { HumanReviewLedger } from './application/human-review.js';
import type { RecordedFlowStep } from './model.js';
import type { RecordingResult } from './process-recording.js';
import { camel, citeIn } from './recorded-test-data.js';

/**
 * LIAISON EXPLICITE DES DONNÉES ENTRE ÉTAPES. L'humain choisit d'où vient la valeur d'une saisie :
 *
 *   FIXED      la valeur enregistrée (ou celle qu'il donne), gardée telle quelle
 *   GENERATED  une variable (company.companyName) générée UNE fois par run
 *   REFERENCE  une variable déjà produite par une étape ANTÉRIEURE (causalité du scénario)
 *
 * Aucun second système : la liaison EST la valeur de l'étape (`{ testData: clé }`) et l'entrée du jeu
 * de données (test-data.yaml) ; au rejeu, le TestDataRunContext résout la clé — la même valeur pour
 * toutes les étapes qui la citent. La variable porte le sens ; l'étape d'origine n'est qu'une
 * provenance (`producedBy`). Le choix humain est une DÉCISION du registre human-review.json : il
 * passe après la détection automatique, qui ne fait plus que proposer.
 */
export type TestDataSource = 'FIXED' | 'GENERATED' | 'REFERENCE';

export interface TestDataBindingInput {
  stepId: string;
  source: TestDataSource;
  /** GENERATED : le nom de la variable (par défaut, celui de l'étape) ; REFERENCE : la variable citée. */
  variable?: string;
  generator?: string;
  /** FIXED : la valeur (par défaut, la valeur enregistrée). */
  value?: string;
  at?: string;
}

export interface TestDataBindingDecision {
  id: string;
  stepId: string;
  actionIds: string[];
  source: TestDataSource;
  variable: string;
  generator?: string;
  /** La clé citée par l'étape avant la décision. */
  previousKey?: string;
  at: string;
}

/** Une variable qu'une étape peut réutiliser : produite par une étape antérieure. */
export interface BindableVariable {
  key: string;
  stepId: string;
  /** Position de l'étape productrice (1…n, actions seulement). */
  stepIndex: number;
  label: string;
  strategy: string;
}

export interface StepDataBinding {
  key?: string;
  source: TestDataSource | 'SENSITIVE';
  generator?: string;
  /** REFERENCE : la variable citée (la racine d'une référence automatique). */
  reference?: string;
  /** La valeur enregistrée, si elle est gardée en clair (jamais un secret). */
  recordedValue?: string;
  /** Les variables produites AVANT cette étape. */
  options: BindableVariable[];
  /** Ce que la détection automatique avait décidé (une proposition, jamais imposée à l'humain). */
  suggestion?: string;
  manual: boolean;
}

export interface DataLineageEntry {
  key: string;
  strategy: string;
  generator?: string;
  producedBy?: { stepId: string; stepIndex: number; label: string };
  usedBy: { stepId: string; stepIndex: number; label: string; how: 'INPUT' | 'CITATION' }[];
}

const KEY = /^[A-Za-z][A-Za-z0-9_]*(\.[A-Za-z][A-Za-z0-9_]*)*$/;

export const BINDING_GENERATORS = [
  'company',
  'email',
  'firstName',
  'lastName',
  'phone',
  'address',
  'city',
  'postalCode',
  'text',
  'unique',
] as const;

type Result = RecordingResult & { humanReview?: HumanReviewLedger };

/** Les étapes d'action, dans l'ordre (les vérifications n'ont pas de position). */
function actionSteps(result: Result): RecordedFlowStep[] {
  return result.flow.steps.filter((item) => item.step.kind !== 'expect');
}

function keyOf(step: FlowStep): string | undefined {
  return step.kind === 'fill' && typeof step.value !== 'string' && 'testData' in step.value
    ? step.value.testData
    : undefined;
}

function rootOf(key: string, set: TestDataSet): string {
  const seen = new Set<string>();
  let current = key;
  while (!seen.has(current)) {
    seen.add(current);
    const entry = set.values[current];
    if (entry?.strategy !== 'REFERENCE' || !entry.reference) return current;
    current = entry.reference;
  }
  return current;
}

/** Les variables produites par les étapes AVANT `stepId` : jamais une donnée produite plus tard. */
export function availableVariables(result: Result, stepId: string): BindableVariable[] {
  const set = result.testData?.set;
  if (!set) return [];
  const steps = actionSteps(result);
  const position = steps.findIndex((item) => item.id === stepId);
  const found = new Map<string, BindableVariable>();
  for (const [index, item] of steps.entries()) {
    if (position >= 0 && index >= position) break;
    const key = keyOf(item.step);
    if (!key) continue;
    const root = rootOf(key, set);
    const entry = set.values[root];
    if (!entry || entry.sensitive || isSensitiveKey(root) || found.has(root)) continue;
    found.set(root, {
      key: root,
      stepId: item.id,
      stepIndex: index + 1,
      label: item.label,
      strategy: entry.strategy,
    });
  }
  return [...found.values()];
}

/** Ce que la fenêtre montre pour une saisie : sa source, sa variable, les variables réutilisables. */
export function stepDataBinding(result: Result, stepId: string): StepDataBinding | undefined {
  const set = result.testData?.set;
  const item = result.flow.steps.find((candidate) => candidate.id === stepId);
  if (!set || item?.step.kind !== 'fill') return undefined;
  const options = availableVariables(result, stepId);
  const manual = (result.humanReview?.bindings ?? []).some((decision) => decision.stepId === stepId);
  const value = item.step.value;
  if (typeof value !== 'string' && 'env' in value) return { source: 'SENSITIVE', options: [], manual };
  if (typeof value === 'string') return { source: 'FIXED', recordedValue: value, options, manual };
  const key = value.testData;
  const entry = set.values[key];
  const literal = entry && !entry.sensitive && entry.value !== undefined ? entry.value : undefined;
  const root = rootOf(key, set);
  const producer = options.find((option) => option.key === root);
  // La même variable qu'une étape antérieure (citée directement, ou par une référence) : une réutilisation.
  if (producer || entry?.strategy === 'REFERENCE') {
    const automatic = !manual && entry?.strategy === 'REFERENCE';
    return {
      key,
      source: 'REFERENCE',
      reference: root,
      ...(literal !== undefined ? { recordedValue: literal } : {}),
      options,
      ...(automatic ? { suggestion: root } : {}),
      manual,
    };
  }
  if (entry?.strategy === 'GENERATE_AT_REPLAY' || entry?.strategy === 'TEMPLATE')
    return {
      key,
      source: 'GENERATED',
      ...(entry.generator ? { generator: entry.generator } : {}),
      options,
      manual,
    };
  return {
    key,
    source: 'FIXED',
    ...(literal !== undefined ? { recordedValue: literal } : {}),
    options,
    manual,
  };
}

/**
 * Applique le choix de l'humain : la valeur de l'étape, l'entrée du jeu, les citations des étapes
 * suivantes (le résultat ouvert qui porte la valeur), puis régénère test-data.yaml, le flow et le
 * .feature. Refusé sans effet si l'étape n'est pas une saisie, si la variable n'existe pas AVANT
 * l'étape (REFERENCE), ou si le nom est invalide.
 */
export function applyTestDataBinding(
  result: Result,
  input: TestDataBindingInput,
  regenerate: () => void,
): { decision: TestDataBindingDecision } | { error: string } {
  const data = result.testData;
  if (!data) return { error: 'recording.testData is disabled: no data set to bind' };
  const set = data.set;
  const steps = actionSteps(result);
  const position = steps.findIndex((item) => item.id === input.stepId);
  const item = steps[position];
  if (item?.step.kind !== 'fill') return { error: `step ${input.stepId} is not an input` };
  const step = item.step;
  if (typeof step.value !== 'string' && 'env' in step.value)
    return { error: 'a secret is never bound to test data: it comes from its environment variable' };
  const previousKey = keyOf(step);
  const previous = previousKey ? set.values[previousKey] : undefined;
  const recorded =
    typeof step.value === 'string'
      ? step.value
      : previous && !previous.sensitive && previous.value !== undefined
        ? previous.value
        : undefined;
  const producerOf = (key: string): number =>
    steps.findIndex((candidate) => {
      const cited = keyOf(candidate.step);
      return cited !== undefined && rootOf(cited, set) === key;
    });
  const cite = (literal: string | undefined, key: string): void => {
    if (!literal || literal.trim().length < 3) return;
    const reference = testDataReference(key);
    for (const candidate of result.flow.steps.slice(result.flow.steps.indexOf(item) + 1)) {
      if (candidate.step.kind === 'fill') continue;
      if (candidate.step.kind === 'click' || candidate.step.kind === 'expect') {
        const cited = citeIn(candidate.step, literal, reference);
        if (cited.changed) candidate.step = cited.value;
      } else if (candidate.step.effects) {
        const cited = citeIn(candidate.step.effects, literal, reference);
        if (cited.changed) candidate.step = { ...candidate.step, effects: cited.value };
      }
    }
  };
  const provenance = (key: string, reason: string): TestDataEntry['provenance'] => ({
    ...(previous?.provenance ?? {}),
    recordingSessionId: result.session.id,
    semanticField: key.split('.').at(-1) ?? key,
    classification: 'HUMAN_BINDING',
    reasons: [reason],
  });
  const freshKey = (base: string): string => {
    let key = base;
    for (let suffix = 2; set.values[key] !== undefined && key !== previousKey; suffix += 1)
      key = `${base}${String(suffix)}`;
    return key;
  };
  const isProducer = previousKey !== undefined && producerOf(rootOf(previousKey, set)) === position;
  // La variable n'appartient qu'à cette étape : aucune autre saisie ni référence ne la cite.
  const exclusive =
    previousKey !== undefined &&
    steps.filter((candidate) => keyOf(candidate.step) === previousKey).length === 1 &&
    !Object.values(set.values).some(
      (entry) => entry.strategy === 'REFERENCE' && entry.reference === previousKey,
    );
  const ownKey = (): string =>
    previousKey && (isProducer || exclusive) ? previousKey : freshKey(camel(item.label) || 'value');
  let variable: string;

  switch (input.source) {
    case 'REFERENCE': {
      const wanted = input.variable ?? '';
      const option = availableVariables(result, input.stepId).find((candidate) => candidate.key === wanted);
      if (!option)
        return {
          error: `"${wanted}" is not produced by a step before this one: only an earlier data can be reused`,
        };
      variable = option.key;
      step.value = { testData: variable };
      if (set.values[variable]?.strategy !== 'RECORDED_LITERAL') cite(recorded, variable);
      break;
    }
    case 'GENERATED': {
      const wanted = input.variable?.trim() || ownKey();
      if (!KEY.test(wanted)) return { error: `"${wanted}" is not a valid variable name (object.attribute)` };
      if (isSensitiveKey(wanted)) return { error: `"${wanted}" names a secret: never generated` };
      const taken = wanted !== previousKey && set.values[wanted] !== undefined;
      if (taken) return { error: `"${wanted}" already exists: choose “reuse” to cite it, or another name` };
      variable = wanted;
      const generator = input.generator ?? previous?.generator ?? previous?.semanticType ?? 'text';
      set.values[variable] = {
        key: variable,
        strategy: 'GENERATE_AT_REPLAY',
        generator,
        ...(previous?.semanticType ? { semanticType: previous.semanticType } : {}),
        sensitive: false,
        provenance: provenance(variable, `explicit choice: generated (${generator}) at step ${item.id}`),
      };
      // Le producteur renomme sa variable : toutes ses citations suivent (le sens reste le même).
      if (previousKey && previousKey !== variable && isProducer) renameKey(result, previousKey, variable);
      step.value = { testData: variable };
      cite(recorded, variable);
      break;
    }
    case 'FIXED': {
      const value = input.value ?? recorded;
      if (value === undefined) return { error: 'no recorded value for this input: give the fixed value' };
      variable = ownKey();
      if (isSensitiveKey(variable)) return { error: `"${variable}" names a secret: never kept in clear` };
      set.values[variable] = {
        key: variable,
        strategy: value === recorded ? 'RECORDED_LITERAL' : 'BUSINESS_LITERAL',
        value,
        sensitive: false,
        provenance: provenance(variable, `explicit choice: fixed value at step ${item.id}`),
      };
      step.value = { testData: variable };
      break;
    }
  }
  // Une variable que plus personne ne cite (l'ancienne clé de l'étape) quitte le jeu.
  if (previousKey && previousKey !== variable) dropIfUnused(result, previousKey);
  for (const entry of data.items)
    if (entry.actionIds.some((id) => item.actionIds.includes(id))) {
      entry.key = variable;
      entry.reasons = [`explicit choice: ${input.source.toLowerCase()} (${variable})`];
    }
  data.document = testDataSetDocument(set);
  const ledger = (result.humanReview ??= { version: 1, decisions: [] });
  const decision: TestDataBindingDecision = {
    id: `tb${String((ledger.bindings?.length ?? 0) + 1)}`,
    stepId: item.id,
    actionIds: [...item.actionIds],
    source: input.source,
    variable,
    ...(input.source === 'GENERATED' ? { generator: set.values[variable]?.generator ?? 'text' } : {}),
    ...(previousKey ? { previousKey } : {}),
    at: input.at ?? new Date().toISOString(),
  };
  (ledger.bindings ??= []).push(decision);
  refreshHttpTestData(result);
  regenerate();
  return { decision };
}

/**
 * Les critères de recherche de l'analyse HTTP citent la donnée de test par la clé de la saisie qui
 * l'a produite : après une liaison (clé renommée, étape passée en référence), ils suivent la clé
 * courante de chaque saisie — jamais une clé qui n'existe plus.
 */
export function refreshHttpTestData(result: Result): void {
  const data = result.testData;
  const http = result.http;
  if (!data || !http) return;
  const keys = new Map<string, string>();
  for (const item of data.items)
    if (item.key && !item.sensitive) for (const id of item.rawEventIds) keys.set(id, item.key);
  for (const analysis of [http.consolidated, http.live])
    for (const business of analysis?.business ?? [])
      for (const criterion of business.searchCriteria) {
        const key = criterion.ui ? keys.get(criterion.ui.actionId) : undefined;
        criterion.evidence = criterion.evidence.filter(
          (line) => !line.startsWith('the value is the test datum testData.'),
        );
        if (key) {
          criterion.testData = { key, reference: `\${testData.${key}}` };
          criterion.evidence.push(
            `the value is the test datum testData.${key}: dynamic, not a frozen literal`,
          );
        } else delete criterion.testData;
      }
}

/** La LIGNÉE de chaque variable : l'étape qui la produit, les étapes qui la saisissent ou la citent. */
export function dataLineage(result: Result): DataLineageEntry[] {
  const set = result.testData?.set;
  if (!set) return [];
  const steps = actionSteps(result);
  const lineage = new Map<string, DataLineageEntry>();
  const entryOf = (key: string): DataLineageEntry => {
    const found = lineage.get(key);
    if (found) return found;
    const data = set.values[key];
    const created: DataLineageEntry = {
      key,
      strategy: data?.strategy ?? 'UNKNOWN',
      ...(data?.generator ? { generator: data.generator } : {}),
      usedBy: [],
    };
    lineage.set(key, created);
    return created;
  };
  for (const [index, item] of steps.entries()) {
    const at = { stepId: item.id, stepIndex: index + 1, label: item.label };
    const key = keyOf(item.step);
    if (key) {
      const entry = entryOf(rootOf(key, set));
      // L'étape productrice n'est pas un usage : seules les étapes suivantes « utilisent » la donnée.
      if (entry.producedBy) entry.usedBy.push({ ...at, how: 'INPUT' });
      else entry.producedBy = at;
    }
    for (const cited of new Set(JSON.stringify(item.step).match(/\$\{testData:([A-Za-z0-9_.-]+)\}/g) ?? [])) {
      const name = cited.slice('${testData:'.length, -1);
      entryOf(rootOf(name, set)).usedBy.push({ ...at, how: 'CITATION' });
    }
  }
  return [...lineage.values()].filter((entry) => !set.values[entry.key]?.sensitive);
}

function renameKey(result: Result, from: string, to: string): void {
  const set = result.testData?.set;
  if (!set) return;
  const reference = testDataReference(from);
  for (const item of result.flow.steps) {
    if (keyOf(item.step) === from && item.step.kind === 'fill') item.step.value = { testData: to };
    const text = JSON.stringify(item.step);
    if (text.includes(reference))
      item.step = JSON.parse(text.split(reference).join(testDataReference(to))) as FlowStep;
  }
  for (const entry of Object.values(set.values))
    if (entry.strategy === 'REFERENCE' && entry.reference === from) entry.reference = to;
}

function dropIfUnused(result: Result, key: string): void {
  const set = result.testData?.set;
  if (!set?.values[key]) return;
  const reference = testDataReference(key);
  const cited = result.flow.steps.some(
    (item) => keyOf(item.step) === key || JSON.stringify(item.step).includes(reference),
  );
  const referenced = Object.values(set.values).some(
    (entry) => entry.strategy === 'REFERENCE' && entry.reference === key,
  );
  if (!cited && !referenced)
    set.values = Object.fromEntries(Object.entries(set.values).filter(([name]) => name !== key));
}

/**
 * LES DONNÉES CRÉÉES PAR UNE LIGNE DE TABLEAU : une colonne liée à une nouvelle donnée (« Workflow » →
 * `row.workflow`) l'ajoute au jeu de test avec la valeur de la cellule. test-data.yaml la porte : on la
 * modifie là sans toucher au flow. Jamais une clé existante écrasée, jamais une clé sensible.
 */
export function addRowVariables(
  result: Result,
  created: readonly { key: string; value: string; column: string }[],
  stepId: string,
): { error: string } | { added: string[] } {
  if (created.length === 0) return { added: [] };
  const data = result.testData;
  if (!data) return { error: 'no test data set to add the variable to' };
  const set = data.set;
  for (const entry of created) {
    if (!KEY.test(entry.key))
      return { error: `"${entry.key}" is not a valid variable name (object.attribute)` };
    if (isSensitiveKey(entry.key)) return { error: `"${entry.key}" names a secret: never kept in clear` };
    if (set.values[entry.key] !== undefined) return { error: `the variable "${entry.key}" already exists` };
  }
  for (const entry of created)
    set.values[entry.key] = {
      key: entry.key,
      strategy: 'BUSINESS_LITERAL',
      value: entry.value,
      sensitive: false,
      provenance: {
        recordingSessionId: result.session.id,
        semanticField: entry.key.split('.').at(-1) ?? entry.key,
        classification: 'HUMAN_BINDING',
        reasons: [`explicit choice: table row column "${entry.column}" at step ${stepId}`],
      },
    };
  data.document = testDataSetDocument(set);
  return { added: created.map((entry) => entry.key) };
}
