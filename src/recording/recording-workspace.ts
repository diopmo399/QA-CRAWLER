import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { parseTestDataSet, testDataSetDocument } from '../data/test-data-set.js';
import {
  planGeneration,
  planSummary,
  validateArtifacts,
  writeArtifacts,
  type GeneratedArtifact,
  type GenerationFormat,
} from '../platform/generation-plan.js';
import { HUMAN_REVIEW_FILE, type HumanReviewLedger } from './application/human-review.js';
import { decideProposal, proposalSummary, type ProposalDecision } from './assertion-proposals.js';
import type { RecordedFlow } from './model.js';
import { TEST_DATA_FILE } from './process-recording.js';
import { generateFlowFiles, type GeneratedFiles } from './recorded-flow.js';
import {
  BINDING_GENERATORS,
  applyTestDataBinding,
  dataLineage,
  stepDataBinding,
  type BindingContext,
  type DataLineageEntry,
  type StepDataBinding,
  type TestDataBindingDecision,
  type TestDataBindingInput,
} from './test-data-binding.js';
import {
  applyGroupCommand,
  groupViews,
  stepDependencies,
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
  const write = writerOf(recording.directory);
  if (context.testData) {
    const yaml = stringifyYaml(context.testData.document, { lineWidth: 0 });
    await write(TEST_DATA_FILE, yaml);
    recording.testData = { yaml, hasValues: Object.keys(context.testData.set.values).length > 0 };
  }
  await rewrite(recording, language);
  if (context.humanReview) await write(HUMAN_REVIEW_FILE, json(context.humanReview));
  return outcome;
}
