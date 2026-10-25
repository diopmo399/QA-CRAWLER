import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parseTestDataSet, type TestDataSet } from '../data/test-data-set.js';
import type { RememberedFieldMapping } from '../knowledge/functional-knowledge-store.js';
import { HUMAN_REVIEW_FILE, type HumanReviewLedger } from '../recording/application/human-review.js';
import type { RecordedFlow } from '../recording/model.js';
import { TEST_DATA_FILE } from '../recording/process-recording.js';
import { dataLineage, type DataLineageEntry } from '../recording/test-data-binding.js';
import type { FlowSummary, VariableDto, VariableIssue, VariablesDto } from './model.js';
import type { ReaderWarning } from './sources.js';

/**
 * LES ENREGISTREMENTS (`<reports>/recordings/<nom>/`) : le flow enregistré, son jeu de données et les
 * liaisons décidées par l'humain, lus tels quels. La lignée (qui produit, qui consomme) est celle que
 * la fenêtre du recorder calcule déjà (`dataLineage`) : aucun second calcul.
 */

export interface LoadedRecording {
  name: string;
  directory: string;
  flow: RecordedFlow;
  set?: TestDataSet;
  humanReview?: HumanReviewLedger;
  lineage: DataLineageEntry[];
}

export async function readRecordings(
  directory: string,
): Promise<{ recordings: LoadedRecording[]; warnings: ReaderWarning[] }> {
  const warnings: ReaderWarning[] = [];
  let entries: string[];
  try {
    entries = (await readdir(directory, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name)
      .sort();
  } catch {
    return { recordings: [], warnings };
  }
  const recordings: LoadedRecording[] = [];
  for (const name of entries) {
    const folder = path.join(directory, name);
    const flowFile = path.join(folder, 'recorded-flow.json');
    let flow: RecordedFlow;
    try {
      flow = JSON.parse(await readFile(flowFile, 'utf8')) as RecordedFlow;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push({
          location: flowFile,
          message: error instanceof Error ? error.message : String(error),
        });
      continue;
    }
    if (!Array.isArray(flow.steps)) {
      warnings.push({ location: flowFile, message: 'not a recorded flow (no steps)' });
      continue;
    }
    let set: TestDataSet | undefined;
    const dataFile = path.join(folder, TEST_DATA_FILE);
    try {
      set = parseTestDataSet(parseYaml(await readFile(dataFile, 'utf8')), dataFile);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push({
          location: dataFile,
          message: error instanceof Error ? error.message : String(error),
        });
    }
    let humanReview: HumanReviewLedger | undefined;
    const reviewFile = path.join(folder, HUMAN_REVIEW_FILE);
    try {
      humanReview = JSON.parse(await readFile(reviewFile, 'utf8')) as HumanReviewLedger;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT')
        warnings.push({
          location: reviewFile,
          message: error instanceof Error ? error.message : String(error),
        });
    }
    // dataLineage ne lit que flow.steps et testData.set : le reste du résultat d'enregistrement n'est pas nécessaire.
    const lineage = set
      ? dataLineage({ flow, testData: { set }, humanReview } as unknown as Parameters<typeof dataLineage>[0])
      : [];
    recordings.push({
      name,
      directory: folder,
      flow,
      ...(set ? { set } : {}),
      ...(humanReview ? { humanReview } : {}),
      lineage,
    });
  }
  return { recordings, warnings };
}

export function recordingFlowSummary(recording: LoadedRecording): FlowSummary {
  const produces = recording.lineage.filter((entry) => entry.producedBy).map((entry) => entry.key);
  const consumes = recording.lineage.filter((entry) => entry.usedBy.length > 0).map((entry) => entry.key);
  return {
    name: recording.flow.name || recording.name,
    source: 'RECORDING',
    steps: recording.flow.steps.length,
    location: recording.directory,
    produces,
    consumes,
    ...(recording.flow.startAt ? { startAt: recording.flow.startAt } : {}),
  };
}

/** Le libellé du champ d'une étape de saisie (cible label / placeholder / name), pour relier aux correspondances. */
function fieldLabelOf(recording: LoadedRecording, stepId: string | undefined): string | undefined {
  if (!stepId) return undefined;
  const step = recording.flow.steps.find((candidate) => candidate.id === stepId)?.step;
  if (!step || step.kind !== 'fill') return undefined;
  const target = step.target as { strategy?: string; value?: string };
  return typeof target.value === 'string' && target.value ? target.value : undefined;
}

/**
 * Les variables de tous les enregistrements, avec leurs anomalies :
 * - NEVER_CONSUMED : une variable générée (ou citée par référence) qu'aucune étape ne réutilise ;
 * - NO_PRODUCER : une variable consommée qu'aucune étape ne produit et que le jeu ne génère pas ;
 * - AMBIGUOUS_MAPPING : plusieurs correspondances différentes pour le même libellé de champ ;
 * - STATIC_REUSED : une valeur enregistrée telle quelle, réutilisée par d'autres étapes (à vérifier : une
 *   valeur fixe partagée est souvent une identité qui devrait être générée) ;
 * - BROKEN_DEPENDENCY : consommée avant d'être produite, ou citée sans entrée dans le jeu de données.
 * Rien n'est corrigé automatiquement : ce sont des signaux à juger.
 */
export function variablesOf(recordings: LoadedRecording[], mappings: RememberedFieldMapping[]): VariablesDto {
  const variables: VariableDto[] = [];
  const issues: Record<string, number> = {};
  const count = (issue: VariableIssue): VariableIssue => {
    issues[issue.kind] = (issues[issue.kind] ?? 0) + 1;
    return issue;
  };
  const mappingsByLabel = new Map<string, RememberedFieldMapping[]>();
  for (const mapping of mappings) {
    const label = mapping.uiLabel.trim().toLowerCase();
    mappingsByLabel.set(label, [...(mappingsByLabel.get(label) ?? []), mapping]);
  }
  for (const recording of recordings) {
    const flowName = recording.flow.name || recording.name;
    for (const entry of recording.lineage) {
      const data = recording.set?.values[entry.key];
      const found: VariableIssue[] = [];
      const generated = ['GENERATE_AT_REPLAY', 'TEMPLATE'].includes(entry.strategy);
      if (entry.usedBy.length === 0 && (generated || entry.strategy === 'REFERENCE'))
        found.push(
          count({ kind: 'NEVER_CONSUMED', message: `${entry.key} is produced but no step reuses it` }),
        );
      if (!entry.producedBy && entry.usedBy.length > 0 && !generated && entry.strategy !== 'BUSINESS_LITERAL')
        found.push(
          count({
            kind: entry.strategy === 'UNKNOWN' ? 'BROKEN_DEPENDENCY' : 'NO_PRODUCER',
            message:
              entry.strategy === 'UNKNOWN'
                ? `${entry.key} is cited but has no entry in the data set`
                : `${entry.key} is consumed but no step produces it`,
          }),
        );
      if (entry.producedBy)
        for (const use of entry.usedBy)
          if (use.stepIndex < entry.producedBy.stepIndex)
            found.push(
              count({
                kind: 'BROKEN_DEPENDENCY',
                message: `step ${String(use.stepIndex)} uses ${entry.key} before step ${String(entry.producedBy.stepIndex)} produces it`,
              }),
            );
      if (entry.strategy === 'RECORDED_LITERAL' && entry.usedBy.some((use) => use.how === 'INPUT'))
        found.push(
          count({
            kind: 'STATIC_REUSED',
            message: `${entry.key} is a recorded literal typed again by ${String(entry.usedBy.filter((use) => use.how === 'INPUT').length)} step(s): a shared identity should probably be generated`,
          }),
        );
      const label = fieldLabelOf(recording, entry.producedBy?.stepId);
      const related = label ? (mappingsByLabel.get(label.trim().toLowerCase()) ?? []) : [];
      const distinct = new Set(related.map((mapping) => `${mapping.property}|${mapping.jsonPath}`));
      if (distinct.size > 1)
        found.push(
          count({
            kind: 'AMBIGUOUS_MAPPING',
            message: `"${label ?? ''}" maps to ${String(distinct.size)} different properties (${[...distinct].join(', ')})`,
          }),
        );
      const binding = recording.humanReview?.bindings?.find(
        (decision) => decision.variable === entry.key || decision.previousKey === entry.key,
      );
      variables.push({
        key: entry.key,
        flow: flowName,
        strategy: entry.strategy,
        ...(entry.generator ? { generator: entry.generator } : {}),
        sensitive: data?.sensitive ?? false,
        ...(data && !data.sensitive && data.value !== undefined ? { value: data.value } : {}),
        ...(entry.producedBy ? { producedBy: entry.producedBy } : {}),
        usedBy: entry.usedBy,
        mappings: related.map((mapping) => ({
          uiLabel: mapping.uiLabel,
          property: mapping.property,
          jsonPath: mapping.jsonPath,
          api: mapping.api,
          operation: mapping.operation,
          transformation: mapping.transformation,
          confirmations: mapping.confirmations,
        })),
        ...(binding
          ? { humanBinding: { source: binding.source, variable: binding.variable, at: binding.at } }
          : {}),
        issues: found,
      });
    }
  }
  return {
    variables,
    flows: recordings.map((recording) => recording.flow.name || recording.name),
    issues,
    ...(recordings.length === 0 ? { unavailable: 'no recording found' } : {}),
  };
}
