import { copyFile, mkdir, stat } from 'node:fs/promises';
import path from 'node:path';
import type { ExplorationResult } from '../model/exploration-result.js';
import type { VisualComparator } from '../visual/visual-comparator.js';
import type { Finding, RunAnomaly } from './model.js';

/**
 * VISUAL ANALYSIS : SemanticCheckpoint (une étape de flow) → Screenshot → VisualBaseline → VisualDiff.
 *
 * Ce qui existait : l'interface VisualComparator (stub NoVisualComparator, verdict UNKNOWN), les
 * captures d'étapes (ScreenshotService, seulement sur erreur). Ce qui est nouveau : la capture de
 * chaque étape réussie quand `visual.enabled`, une baseline visuelle par flow et par étape
 * (<baselineDir>/visual/<flow>/<index>.png), la comparaison pixel (PixelVisualComparator) et le
 * verdict en quatre valeurs :
 *
 *   VISUAL_MATCH        rien n'a changé (hors masques) ;
 *   MINOR_CHANGE        une petite part de l'image a changé — une information, jamais un défaut ;
 *   VISUAL_REGRESSION   l'image a changé ET l'étape porte une anomalie fonctionnelle : la preuve visuelle d'un défaut ;
 *   MAJOR_CHANGE        une grande part de l'image a changé sans anomalie fonctionnelle : à revoir, pas une régression.
 *
 * Règle absolue : un screenshot différent n'est pas une régression. Seul le recoupement avec une
 * anomalie fonctionnelle de la même étape en fait une.
 */

export type VisualVerdict =
  'VISUAL_MATCH' | 'MINOR_CHANGE' | 'VISUAL_REGRESSION' | 'MAJOR_CHANGE' | 'NEW_BASELINE' | 'UNKNOWN';

export interface VisualCheckpointResult {
  flow: string;
  step: number;
  description: string;
  verdict: VisualVerdict;
  /** 0..1 : part de l'image qui a changé. */
  difference?: number;
  current: string;
  baseline?: string;
  diffImage?: string;
  /** Les anomalies de la même étape (ce qui fait d'un changement une régression). */
  anomalies: string[];
  reason?: string;
  /** La baseline a été (ré)écrite avec la capture courante. */
  baselineUpdated: boolean;
}

export interface VisualAnalysis {
  comparator: string;
  baselineDir: string;
  checkpoints: VisualCheckpointResult[];
  summary: Record<VisualVerdict, number> & { checkpoints: number };
  findings: Finding[];
}

export interface VisualAnalysisOptions {
  comparator: VisualComparator;
  baselineDir: string;
  minorChangeRatio: number;
  majorChangeRatio: number;
  /** on-pass : la baseline suit les étapes qui ont réussi sans anomalie ; always ; never. */
  updateBaseline: 'on-pass' | 'always' | 'never';
}

const VERDICTS: VisualVerdict[] = [
  'VISUAL_MATCH',
  'MINOR_CHANGE',
  'VISUAL_REGRESSION',
  'MAJOR_CHANGE',
  'NEW_BASELINE',
  'UNKNOWN',
];

const slug = (text: string): string =>
  text
    .replace(/[^A-Za-z0-9_-]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60) || 'flow';

async function exists(file: string): Promise<boolean> {
  return stat(file).then(
    () => true,
    () => false,
  );
}

/** La capture de chaque étape confrontée à sa baseline visuelle ; `anomalies` recoupe les étapes fautives. */
export async function analyzeVisual(
  result: ExplorationResult,
  anomalies: readonly RunAnomaly[],
  options: VisualAnalysisOptions,
): Promise<VisualAnalysis> {
  const checkpoints: VisualCheckpointResult[] = [];
  for (const flow of result.flows)
    for (const step of flow.steps) {
      if (!step.screenshot || step.status === 'SKIPPED') continue;
      const own = anomalies
        .filter(
          (anomaly) =>
            anomaly.location.flow === flow.name &&
            anomaly.location.step === step.index &&
            anomaly.severity !== 'INFO',
        )
        .map((anomaly) => anomaly.id);
      const directory = path.join(options.baselineDir, 'visual', slug(flow.name));
      const baseline = path.join(directory, `${String(step.index).padStart(3, '0')}.png`);
      const base = {
        flow: flow.name,
        step: step.index,
        description: step.description,
        current: step.screenshot,
        anomalies: own,
      };
      const refresh = async (): Promise<boolean> => {
        if (options.updateBaseline === 'never') return false;
        if (options.updateBaseline === 'on-pass' && (step.status !== 'PASSED' || own.length > 0))
          return false;
        await mkdir(directory, { recursive: true });
        await copyFile(step.screenshot ?? '', baseline);
        return true;
      };
      if (!(await exists(baseline))) {
        const updated = await refresh();
        checkpoints.push({
          ...base,
          verdict: 'NEW_BASELINE',
          baselineUpdated: updated,
          reason: updated
            ? 'first capture kept as baseline'
            : 'no baseline and the step did not pass cleanly',
        });
        continue;
      }
      const comparison = await options.comparator.compare(baseline, step.screenshot);
      if (comparison.status === 'UNKNOWN') {
        checkpoints.push({
          ...base,
          verdict: 'UNKNOWN',
          baseline,
          baselineUpdated: false,
          ...(comparison.reason ? { reason: comparison.reason } : {}),
        });
        continue;
      }
      const difference = comparison.difference ?? (comparison.status === 'SAME' ? 0 : 1);
      let verdict: VisualVerdict;
      if (comparison.status === 'SAME' || difference < options.minorChangeRatio / 10)
        verdict = 'VISUAL_MATCH';
      else if (own.length > 0) verdict = 'VISUAL_REGRESSION';
      else if (difference < options.minorChangeRatio) verdict = 'MINOR_CHANGE';
      else verdict = 'MAJOR_CHANGE';
      // La baseline suit la capture quand l'étape est saine (MATCH / MINOR / MAJOR sans anomalie), jamais une régression.
      const updated = verdict !== 'VISUAL_REGRESSION' && verdict !== 'VISUAL_MATCH' ? await refresh() : false;
      checkpoints.push({
        ...base,
        verdict,
        difference,
        baseline,
        ...(comparison.diffImage ? { diffImage: comparison.diffImage } : {}),
        ...(comparison.reason ? { reason: comparison.reason } : {}),
        baselineUpdated: updated,
      });
    }
  const summary = Object.fromEntries(
    VERDICTS.map((verdict) => [verdict, checkpoints.filter((entry) => entry.verdict === verdict).length]),
  ) as Record<VisualVerdict, number>;
  const findings: Finding[] = checkpoints
    .filter((entry) => entry.verdict === 'VISUAL_REGRESSION' || entry.verdict === 'MAJOR_CHANGE')
    .map((entry) => ({
      conclusion: `${entry.verdict} at ${entry.flow} step ${String(entry.step)} "${entry.description}"`,
      evidence: [
        `${String(Math.round((entry.difference ?? 0) * 10_000) / 100)} % of the image changed`,
        ...(entry.diffImage ? [`diff ${entry.diffImage}`] : []),
        ...entry.anomalies.map((id) => `anomaly ${id} on the same step`),
      ],
      confidence: entry.verdict === 'VISUAL_REGRESSION' ? 0.8 : 0.5,
      source: 'RUNTIME' as const,
    }));
  return {
    comparator: options.comparator.name,
    baselineDir: path.join(options.baselineDir, 'visual'),
    checkpoints,
    summary: { ...summary, checkpoints: checkpoints.length },
    findings,
  };
}
