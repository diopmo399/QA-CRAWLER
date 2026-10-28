import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { isSensitiveKey, parseTestDataSet, testDataSetDocument } from '../data/test-data-set.js';
import {
  planGeneration,
  planSummary,
  validateArtifacts,
  writeArtifacts,
  type GeneratedArtifact,
  type GenerationFormat,
} from '../platform/generation-plan.js';
import {
  applyHumanReview,
  emptyLedger,
  HUMAN_REVIEW_FILE,
  recordIntentDecision,
  REVIEWABLE_INTENTS,
  type HumanDecisionType,
  type HumanReviewLedger,
} from './application/human-review.js';
import type { ApplicationInteractionModel } from './application/model.js';
import { describeFlowStep } from './panel-state.js';
import {
  correctFlowTarget,
  describeTarget,
  editFlowRow,
  hasTarget,
  proposeCorrection,
  recordedRowCells,
  restoreFlowTarget,
  useOfStep,
  type CorrectionProposal,
  type KnownValue,
  type PickedElement,
  type RowBinding,
  type RowColumnChoice,
} from './target-correction.js';
import {
  addDataCheck,
  decideProposal,
  proposalSummary,
  type ProposalDecision,
} from './assertion-proposals.js';
import type { RawRecordedEvent, RecordedFlow } from './model.js';
import { TEST_DATA_FILE } from './process-recording.js';
import { generateFlowFiles, type GeneratedFiles } from './recorded-flow.js';
import {
  BINDING_GENERATORS,
  addRowVariables,
  applyTestDataBinding,
  availableVariables,
  dataLineage,
  stepDataBinding,
  type BindingContext,
  type DataLineageEntry,
  type StepDataBinding,
  type TestDataBindingDecision,
  type TestDataBindingInput,
} from './test-data-binding.js';
import {
  acceptGroupProposals,
  applyGroupCommand,
  groupCheckSuggestions,
  groupViews,
  proposeGroups,
  stepDependencies,
  type BusinessStepRef,
  type GroupCheckSuggestion,
  type GroupProposal,
  type GroupCommand,
  type GroupOutcome,
  type GroupView,
} from './step-groups.js';

/**
 * L'ATELIER D'UN ENREGISTREMENT : ce que la revue du recorder fait au flow (décider une proposition
 * d'assertion, éditer les groupes métier, générer les tests) et la réécriture des fichiers qui suit.
 * La fenêtre du recorder l'utilise pendant la revue ; le SDK l'utilise sur un enregistrement déjà
 * écrit sur disque. Une seule implémentation pour les deux.
 */

export { TEST_DATA_FILE };
export const FLOW_FILES = {
  yaml: 'generated.flow.yaml',
  feature: 'generated.feature',
  flow: 'recorded-flow.json',
  proposals: 'assertion-proposals.json',
  generation: 'generation.json',
} as const;

export type FlowFileFormat = 'yaml' | 'gherkin' | 'both';
export type WriteFile = (name: string, content: string) => Promise<void>;

const json = (value: unknown): string => `${JSON.stringify(value, null, 2)}\n`;

export function proposalsFile(flow: RecordedFlow): Record<string, unknown> {
  const proposals = flow.proposals ?? [];
  return {
    summary: proposalSummary(proposals),
    proposals,
    businessAssertions: flow.businessAssertions ?? [],
  };
}

/** Le flow (YAML et/ou .feature), le flow enregistré et les propositions : réécrits après chaque décision. */
export async function writeFlowFiles(
  write: WriteFile,
  flow: RecordedFlow,
  files: GeneratedFiles,
  format: FlowFileFormat,
): Promise<void> {
  if (format !== 'gherkin') await write(FLOW_FILES.yaml, files.yaml);
  if (format !== 'yaml') await write(FLOW_FILES.feature, files.feature);
  const { intent: _intent, ...recordedFlow } = flow;
  await write(FLOW_FILES.flow, json(recordedFlow));
  await write(FLOW_FILES.proposals, json(proposalsFile(flow)));
}

export interface TestGenerationRequest {
  formats: readonly string[];
  groupIds?: readonly string[];
  force?: boolean;
}

export interface TestGenerationContext {
  flow: RecordedFlow;
  /** Le dossier de l'enregistrement : la génération va dans `generated/`. */
  directory: string;
  baseUrl: string;
  language: 'fr' | 'en';
  recordedAt: string;
  /** test-data.yaml de l'enregistrement : copié avec le flow YAML ; cité par les fichiers quand il a des valeurs. */
  testData?: { yaml: string; hasValues: boolean };
  javaPackage?: string;
  write: WriteFile;
}

export type TestGenerationOutcome =
  | {
      directory: string;
      warnings: string[];
      artifacts: GeneratedArtifact[];
      /** Le nom du flow généré et les formats retenus. */
      name: string;
      formats: GenerationFormat[];
    }
  | { error: string };

const FORMATS: readonly GenerationFormat[] = ['yaml', 'gherkin', 'playwright', 'java'];

/**
 * LA GÉNÉRATION : les formats choisis pour les groupes choisis, écrits sous generated/ et validés avec
 * les outils réels disponibles (schéma, dictionnaire, TypeScript, Maven) ; jamais exécutés ici.
 */
export async function generateRecordingTests(
  context: TestGenerationContext,
  request: TestGenerationRequest,
): Promise<TestGenerationOutcome> {
  const formats = request.formats.filter((entry): entry is GenerationFormat =>
    (FORMATS as readonly string[]).includes(entry),
  );
  if (formats.length === 0) return { error: 'no format selected' };
  const plan = planGeneration({
    flow: context.flow,
    formats,
    baseUrl: context.baseUrl,
    language: context.language,
    ...(request.groupIds ? { groupIds: request.groupIds } : {}),
    ...(request.force ? { force: true } : {}),
    recordedAt: context.recordedAt,
    ...(context.testData?.hasValues ? { testDataFile: TEST_DATA_FILE } : {}),
    ...(context.javaPackage ? { java: { packageName: context.javaPackage } } : {}),
  });
  if ('error' in plan) return plan;
  const generatedDir = path.join(context.directory, 'generated');
  await writeArtifacts(plan.artifacts, generatedDir);
  // Le flow YAML et le .feature citent tous deux test-data.yaml (`testData:` / `# testData:`).
  if (context.testData && (formats.includes('yaml') || formats.includes('gherkin')))
    await writeFile(path.join(generatedDir, TEST_DATA_FILE), context.testData.yaml);
  const validated = await validateArtifacts(plan.artifacts, { directory: generatedDir });
  await context.write(
    FLOW_FILES.generation,
    json({
      generatedAt: new Date().toISOString(),
      directory: generatedDir,
      flow: plan.name,
      summary: planSummary({ ...plan, artifacts: validated }),
      warnings: plan.warnings,
      artifacts: validated.map(({ content: _content, ...artifact }) => artifact),
    }),
  );
  return { directory: generatedDir, warnings: plan.warnings, artifacts: validated, name: plan.name, formats };
}

// ── Un enregistrement déjà écrit sur disque ───────────────────────────────────────────────────

export interface StoredRecording {
  directory: string;
  flow: RecordedFlow;
  /** Le début de la session (en-tête des fichiers générés), lu dans raw-recording.json. */
  startedAt: string;
  format: FlowFileFormat;
  testData?: { yaml: string; hasValues: boolean };
}

const exists = (file: string): Promise<boolean> =>
  access(file).then(
    () => true,
    () => false,
  );

/** Charge l'enregistrement d'un dossier `recordings/<nom>/` ; undefined s'il n'en contient pas. */
export async function loadStoredRecording(directory: string): Promise<StoredRecording | undefined> {
  const flowFile = path.join(directory, FLOW_FILES.flow);
  if (!(await exists(flowFile))) return undefined;
  const flow = JSON.parse(await readFile(flowFile, 'utf8')) as RecordedFlow;
  const raw = await readFile(path.join(directory, 'raw-recording.json'), 'utf8').catch(() => undefined);
  const startedAt = raw ? ((JSON.parse(raw) as { startedAt?: string }).startedAt ?? '') : '';
  const hasYaml = await exists(path.join(directory, FLOW_FILES.yaml));
  const hasFeature = await exists(path.join(directory, FLOW_FILES.feature));
  const format: FlowFileFormat = hasYaml && hasFeature ? 'both' : hasFeature ? 'gherkin' : 'yaml';
  const testDataYaml = await readFile(path.join(directory, TEST_DATA_FILE), 'utf8').catch(() => undefined);
  const values = testDataYaml ? (parseYaml(testDataYaml) as { values?: unknown } | null)?.values : undefined;
  return {
    directory,
    flow,
    startedAt,
    format,
    ...(testDataYaml !== undefined
      ? {
          testData: {
            yaml: testDataYaml,
            hasValues: typeof values === 'object' && values !== null && Object.keys(values).length > 0,
          },
        }
      : {}),
  };
}

function writerOf(directory: string): WriteFile {
  return async (name, content) => {
    await mkdir(directory, { recursive: true });
    await writeFile(path.join(directory, name), content, 'utf8');
  };
}

async function rewrite(recording: StoredRecording, language: 'fr' | 'en'): Promise<void> {
  const files = generateFlowFiles(recording.flow, {
    language,
    recordedAt: recording.startedAt,
    ...(recording.testData?.hasValues ? { testDataFile: TEST_DATA_FILE } : {}),
  });
  await writeFlowFiles(writerOf(recording.directory), recording.flow, files, recording.format);
}

/** Décide une proposition d'assertion et réécrit le flow : la même règle que la revue du recorder. */
export async function decideStoredProposal(
  recording: StoredRecording,
  decision: ProposalDecision,
  language: 'fr' | 'en',
): Promise<{ ok: true } | { error: string }> {
  const outcome = decideProposal(recording.flow, decision);
  if ('error' in outcome) return outcome;
  await rewrite(recording, language);
  return outcome;
}

/** Édite les groupes métier (dépendances de données vérifiées) et réécrit le flow. */
export async function editStoredGroups(
  recording: StoredRecording,
  command: GroupCommand,
  options: { force?: boolean },
  language: 'fr' | 'en',
): Promise<GroupOutcome> {
  const outcome = applyGroupCommand(recording.flow, command, options);
  if ('error' in outcome) return outcome;
  await rewrite(recording, language);
  return outcome;
}

export function storedGroups(recording: StoredRecording): GroupView[] {
  return groupViews(recording.flow);
}

/** Génère les tests d'un enregistrement écrit sur disque. */
export function generateStoredTests(
  recording: StoredRecording,
  request: TestGenerationRequest,
  options: { baseUrl: string; language: 'fr' | 'en'; javaPackage?: string },
): Promise<TestGenerationOutcome> {
  return generateRecordingTests(
    {
      flow: recording.flow,
      directory: recording.directory,
      baseUrl: options.baseUrl,
      language: options.language,
      recordedAt: recording.startedAt,
      ...(recording.testData ? { testData: recording.testData } : {}),
      ...(options.javaPackage ? { javaPackage: options.javaPackage } : {}),
      write: writerOf(recording.directory),
    },
    request,
  );
}

// ── Les données de test d'un enregistrement écrit ─────────────────────────────────────────────

/** Le contexte de liaison : le flow, le jeu relu dans test-data.yaml, le registre human-review.json. */
async function bindingContextOf(recording: StoredRecording): Promise<BindingContext> {
  const raw = recording.testData ? (parseYaml(recording.testData.yaml) as unknown) : undefined;
  const set = raw ? parseTestDataSet(raw, path.basename(recording.directory)) : undefined;
  const review = await readFile(path.join(recording.directory, HUMAN_REVIEW_FILE), 'utf8')
    .then((text) => JSON.parse(text) as HumanReviewLedger)
    .catch(() => undefined);
  return {
    flow: recording.flow,
    session: { id: recording.flow.recordingSessionId },
    ...(set ? { testData: { set, items: [], document: testDataSetDocument(set) } } : {}),
    ...(review ? { humanReview: review } : {}),
  };
}

export interface StoredTestData {
  lineage: DataLineageEntry[];
  inputs: { stepId: string; position: number; label: string; binding: StepDataBinding }[];
  /** Citées par une étape, ni produites avant elle ni présentes dans le jeu : le rejeu en inventerait une. */
  missing: { key: string; stepIds: string[] }[];
  generators: readonly string[];
}

/** Les données d'un enregistrement : lignée, source de chaque saisie, citations sans origine. */
export async function storedTestData(recording: StoredRecording): Promise<StoredTestData> {
  const context = await bindingContextOf(recording);
  const actions = recording.flow.steps.filter((item) => item.step.kind !== 'expect');
  const inputs = actions.flatMap((item, index) => {
    const binding = stepDataBinding(context, item.id);
    return binding ? [{ stepId: item.id, position: index + 1, label: item.label, binding }] : [];
  });
  const known = new Set(Object.keys(context.testData?.set.values ?? {}));
  const produced = new Set<string>();
  const missing = new Map<string, string[]>();
  for (const role of stepDependencies(recording.flow)) {
    for (const key of role.consumes)
      if (!produced.has(key) && !known.has(key)) missing.set(key, [...(missing.get(key) ?? []), role.stepId]);
    for (const key of role.produces) produced.add(key);
  }
  return {
    lineage: dataLineage(context),
    inputs,
    missing: [...missing].map(([key, stepIds]) => ({ key, stepIds })),
    generators: BINDING_GENERATORS,
  };
}

/**
 * Lie la valeur d'une saisie (fixe, générée, reprise d'une étape antérieure) avec la règle de la
 * fenêtre du recorder, puis réécrit test-data.yaml, le flow et le registre des décisions humaines.
 */
export async function bindStoredTestData(
  recording: StoredRecording,
  input: TestDataBindingInput,
  language: 'fr' | 'en',
): Promise<{ decision: TestDataBindingDecision } | { error: string }> {
  const context = await bindingContextOf(recording);
  const outcome = applyTestDataBinding(context, input, () => undefined);
  if ('error' in outcome) return outcome;
  await persistContext(recording, context, language);
  return outcome;
}

/** Le jeu de test, le flow et le registre des décisions, réécrits après une décision. */
async function persistContext(
  recording: StoredRecording,
  context: BindingContext,
  language: 'fr' | 'en',
): Promise<void> {
  const write = writerOf(recording.directory);
  if (context.testData) {
    const yaml = stringifyYaml(context.testData.document, { lineWidth: 0 });
    await write(TEST_DATA_FILE, yaml);
    recording.testData = { yaml, hasValues: Object.keys(context.testData.set.values).length > 0 };
  }
  await rewrite(recording, language);
  if (context.humanReview) await write(HUMAN_REVIEW_FILE, json(context.humanReview));
}

// ── Retirer une étape, groupes proposés, vérification de groupe ───────────────────────────────

/**
 * RETIRER UNE ÉTAPE d'action du flow, avec les vérifications qui la suivent (celles de la même
 * action). Une vérification ne se retire pas ainsi : elle se refuse ou se désactive (propositions).
 */
export function dropFlowStep(flow: RecordedFlow, stepId: string): boolean {
  const target = flow.steps.find((item) => item.id === stepId);
  if (!target || target.step.kind === 'expect') return false;
  const actionIds = new Set(target.actionIds);
  flow.steps = flow.steps.filter(
    (item) =>
      item !== target && !(item.step.kind === 'expect' && item.actionIds.some((id) => actionIds.has(id))),
  );
  return true;
}

/** Retire une étape d'un enregistrement écrit et réécrit le flow. */
export async function removeStoredStep(
  recording: StoredRecording,
  stepId: string,
  language: 'fr' | 'en',
): Promise<{ ok: true } | { error: string }> {
  if (!dropFlowStep(recording.flow, stepId)) return { error: `no action step ${stepId}` };
  await rewrite(recording, language);
  return { ok: true };
}

/** Les étapes métier reconnues à l'enregistrement (business-flow.json), base des groupes proposés. */
async function businessStepsOf(recording: StoredRecording): Promise<BusinessStepRef[]> {
  const text = await readFile(path.join(recording.directory, 'business-flow.json'), 'utf8').catch(
    () => undefined,
  );
  if (!text) return [];
  const steps = (JSON.parse(text) as { steps?: unknown }).steps;
  return Array.isArray(steps) ? (steps as BusinessStepRef[]) : [];
}

/** Les groupes proposés d'après les étapes métier (aucun quand le flow a déjà des groupes). */
export async function storedGroupProposals(
  recording: StoredRecording,
  language: 'fr' | 'en',
): Promise<GroupProposal[]> {
  return proposeGroups(recording.flow, await businessStepsOf(recording), language);
}

/** Crée d'un coup les groupes proposés, sur décision humaine, et réécrit le flow. */
export async function acceptStoredGroupProposals(
  recording: StoredRecording,
  language: 'fr' | 'en',
): Promise<GroupOutcome> {
  const outcome = acceptGroupProposals(recording.flow, await storedGroupProposals(recording, language));
  if ('error' in outcome) return outcome;
  await rewrite(recording, language);
  return outcome;
}

export function storedGroupChecks(recording: StoredRecording): GroupCheckSuggestion[] {
  return groupCheckSuggestions(recording.flow);
}

/**
 * LA VÉRIFICATION D'UN GROUPE : la donnée de test reçue est visible après la dernière action du
 * groupe ; une proposition EXPLICIT acceptée, retirable comme les autres.
 */
export function addGroupCheck(
  flow: RecordedFlow,
  input: { groupId: string; key: string },
): { ok: true; proposalId: string; groupName: string } | { error: string } {
  const view = groupViews(flow).find((entry) => entry.id === input.groupId);
  if (!view) return { error: `unknown group ${input.groupId}` };
  const last = [...flow.steps]
    .reverse()
    .find((item) => view.stepIds.includes(item.id) && item.step.kind !== 'expect');
  if (!last) return { error: `group ${input.groupId} has no action` };
  const outcome = addDataCheck(flow, { afterStepId: last.id, key: input.key, groupName: view.name });
  if ('error' in outcome) return outcome;
  return { ...outcome, groupName: view.name };
}

export async function addStoredGroupCheck(
  recording: StoredRecording,
  input: { groupId: string; key: string },
  language: 'fr' | 'en',
): Promise<{ ok: true; proposalId: string; groupName: string } | { error: string }> {
  const outcome = addGroupCheck(recording.flow, input);
  if ('error' in outcome) return outcome;
  await rewrite(recording, language);
  return outcome;
}

// ── La cible d'une étape : corriger, restaurer, redéfinir la ligne ────────────────────────────

/** Les événements bruts de l'enregistrement (raw-recording.json) : aucune saisie en clair. */
async function rawEventsOf(recording: StoredRecording): Promise<RawRecordedEvent[]> {
  const text = await readFile(path.join(recording.directory, 'raw-recording.json'), 'utf8').catch(
    () => undefined,
  );
  if (!text) return [];
  const events = (JSON.parse(text) as { rawEvents?: unknown }).rawEvents;
  return Array.isArray(events) ? (events as RawRecordedEvent[]) : [];
}

/** Les données du jeu de test citables avant cette étape (jamais une donnée sensible), avec leur valeur. */
function rowVariablesOf(context: BindingContext, stepId: string): { key: string; value: string }[] {
  const set = context.testData?.set;
  if (!set) return [];
  return availableVariables(context, stepId)
    .filter((variable) => !isSensitiveKey(variable.key))
    .map((variable) => ({ key: variable.key, value: set.values[variable.key]?.value ?? '' }));
}

export interface StoredRowSource {
  /** La cible actuelle de l'étape, dite en mots. */
  target: string;
  cells: { column: string; value: string }[];
  variables: { key: string; value: string }[];
}

/** La ligne de tableau visée par une étape : ses cellules enregistrées et les données citables. */
export async function storedRowSource(
  recording: StoredRecording,
  stepId: string,
): Promise<StoredRowSource | { error: string }> {
  const item = recording.flow.steps.find((entry) => entry.id === stepId);
  if (!item) return { error: `step ${stepId} not found` };
  if (!hasTarget(item.step)) return { error: `step ${stepId} has no target` };
  const context = await bindingContextOf(recording);
  return {
    target: describeTarget(item.step.target),
    cells: recordedRowCells(await rawEventsOf(recording), item.rawEventIds),
    variables: rowVariablesOf(context, stepId),
  };
}

/** REVUE, SANS NAVIGATEUR : la ligne visée est redéfinie colonne par colonne (une nouvelle donnée rejoint le jeu). */
export async function editStoredRow(
  recording: StoredRecording,
  input: { stepId: string; columns: readonly RowColumnChoice[] },
  language: 'fr' | 'en',
): Promise<{ ok: true; added: string[] } | { error: string }> {
  const item = recording.flow.steps.find((entry) => entry.id === input.stepId);
  if (!item) return { error: `step ${input.stepId} not found` };
  const context = await bindingContextOf(recording);
  const set = context.testData?.set;
  const outcome = editFlowRow(
    recording.flow,
    input.stepId,
    recordedRowCells(await rawEventsOf(recording), item.rawEventIds),
    rowVariablesOf(context, input.stepId),
    input.columns,
    Date.now(),
    set ? { taken: Object.keys(set.values) } : undefined,
  );
  if ('error' in outcome) return outcome;
  const added = addRowVariables(context, outcome.created, input.stepId);
  if ('error' in added) return added;
  await persistContext(recording, context, language);
  return { ok: true, added: added.added };
}

/** « Restaurer l'original » : la cible redevient celle de l'enregistrement ; l'historique reste. */
export async function restoreStoredTarget(
  recording: StoredRecording,
  stepId: string,
  language: 'fr' | 'en',
): Promise<{ ok: true } | { error: string }> {
  const outcome = restoreFlowTarget(recording.flow, stepId, Date.now());
  if ('error' in outcome) return outcome;
  await rewrite(recording, language);
  return { ok: true };
}

/** Ce que deviendrait la cible de l'étape avec l'élément désigné (sans rien écrire). */
export function storedCorrectionProposal(
  recording: StoredRecording,
  stepId: string,
  picked: PickedElement,
  known: readonly KnownValue[],
  language: 'fr' | 'en',
): CorrectionProposal | { error: string } {
  const item = recording.flow.steps.find((entry) => entry.id === stepId);
  if (!item) return { error: `step ${stepId} not found` };
  if (!hasTarget(item.step)) return { error: `step ${stepId} has no target to correct` };
  return proposeCorrection(
    picked.element,
    useOfStep(item.step.kind),
    language,
    { known, previous: item.step.target },
    picked.rowCells ?? [],
  );
}

/** La cible de l'étape remplacée par l'élément désigné (option de ligne, liaison d'une colonne). */
export async function correctStoredTarget(
  recording: StoredRecording,
  input: {
    stepId: string;
    picked: PickedElement;
    known: readonly KnownValue[];
    option?: string;
    binding?: RowBinding;
  },
  language: 'fr' | 'en',
): Promise<{ ok: true; previous: string; next: string } | { error: string }> {
  const context = await bindingContextOf(recording);
  const set = context.testData?.set;
  const outcome = correctFlowTarget(
    recording.flow,
    input.stepId,
    input.picked,
    Date.now(),
    language,
    { known: input.known, ...(set ? { newVariables: { taken: Object.keys(set.values) } } : {}) },
    input.option,
    input.binding,
  );
  if ('error' in outcome) return outcome;
  const added = addRowVariables(context, outcome.created, input.stepId);
  if ('error' in added) return added;
  await persistContext(recording, context, language);
  return {
    ok: true,
    previous: describeTarget(outcome.correction.previous),
    next: describeTarget(outcome.correction.next),
  };
}

// ── La revue des intentions (application-model.json, human-review.json) ────────────────────────

export interface StoredIntentRow {
  actionId: string;
  kind: string;
  label: string;
  /** L'intention finale (décision humaine, sinon l'interprétation automatique). */
  intent: string;
  status: string;
  source: 'HUMAN' | 'SYSTEM';
  confidence?: number;
  original?: string;
  reason?: string;
}

async function applicationOf(recording: StoredRecording): Promise<ApplicationInteractionModel | undefined> {
  const text = await readFile(path.join(recording.directory, 'application-model.json'), 'utf8').catch(
    () => undefined,
  );
  return text ? (JSON.parse(text) as ApplicationInteractionModel) : undefined;
}

async function ledgerOf(recording: StoredRecording): Promise<HumanReviewLedger> {
  const text = await readFile(path.join(recording.directory, HUMAN_REVIEW_FILE), 'utf8').catch(
    () => undefined,
  );
  return text ? (JSON.parse(text) as HumanReviewLedger) : emptyLedger(recording.flow.recordingSessionId);
}

/** Chaque action du modèle : son intention finale et sa provenance (rien sans modèle d'application). */
export async function storedIntents(
  recording: StoredRecording,
  language: 'fr' | 'en',
): Promise<{ choices: string[]; rows: StoredIntentRow[] }> {
  const model = await applicationOf(recording);
  const labels = new Map(
    recording.flow.steps.map((item) => [item.id, describeFlowStep(item.step, language)]),
  );
  return {
    choices: [...REVIEWABLE_INTENTS],
    rows: (model?.actions ?? []).map((view) => {
      const review = view.review;
      const human = review?.source === 'HUMAN' ? review : undefined;
      return {
        actionId: view.actionId,
        kind: view.type,
        label:
          view.stepIds.map((id) => labels.get(id)).find((label) => label !== undefined) ??
          (view.label
            ? `${view.type} "${view.label}"`
            : view.type === 'NAVIGATE'
              ? language === 'fr'
                ? 'Ouvrir la page'
                : 'Open the page'
              : view.type),
        intent: human ? human.finalIntent : view.interpretation.join(' + '),
        status: review?.status ?? 'INFERRED',
        source: human ? 'HUMAN' : 'SYSTEM',
        ...(view.confidence !== undefined ? { confidence: view.confidence } : {}),
        ...(human ? { original: human.originalIntent.join(' + ') } : {}),
        ...(human?.correction?.reason ? { reason: human.correction.reason } : {}),
      };
    }),
  };
}

/**
 * LA REVUE D'UNE INTENTION : corriger, confirmer, réinitialiser. Une décision de plus au registre ;
 * ni l'action, ni le flow, ni le rejeu ne changent. Le modèle d'application est réécrit.
 */
export async function reviewStoredIntent(
  recording: StoredRecording,
  input: { actionId: string; type: HumanDecisionType; intent?: string; reason?: string },
): Promise<{ ok: true } | { error: string }> {
  const model = await applicationOf(recording);
  if (!model) return { error: 'no application model to review' };
  const ledger = await ledgerOf(recording);
  const view = model.actions.find((action) => action.actionId === input.actionId);
  const item = recording.flow.steps.find((entry) => view?.stepIds.includes(entry.id));
  const raw = (await rawEventsOf(recording)).find((event) => event.id === item?.rawEventIds.at(-1));
  const element = raw?.element;
  const business = (await businessStepsOf(recording)).find((step) =>
    step.recordedActions.some((id) => view?.stepIds.includes(id)),
  );
  let page: string | undefined;
  try {
    page = raw ? new URL(raw.url).pathname : undefined;
  } catch {
    page = undefined;
  }
  const outcome = recordIntentDecision(ledger, model, {
    ...input,
    context: {
      ...(page ? { page } : {}),
      ...(element
        ? {
            element: `${element.role || element.tag} "${element.name || element.label || element.text || ''}"`,
          }
        : {}),
      ...(element?.role ? { role: element.role } : {}),
      ...(element?.label ? { label: element.label } : {}),
      ...(business ? { businessStep: `${business.action} ${business.entity ?? ''}`.trim() } : {}),
    },
  });
  if ('error' in outcome) return outcome;
  applyHumanReview(model, ledger);
  const write = writerOf(recording.directory);
  await write('application-model.json', json(model));
  await write(HUMAN_REVIEW_FILE, json(ledger));
  return { ok: true };
}
