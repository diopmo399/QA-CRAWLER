import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioConfig } from '../config/config.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { FlowGraphHtmlReporter } from './flow-graph-html-reporter.js';
import { HtmlReporter } from './html-reporter.js';
import type { ReportLanguage } from './i18n.js';
import { JsonReporter } from './json-reporter.js';

/** Écrit un résultat d'exploration quelque part ; renvoie le chemin du fichier produit. */
export interface Reporter {
  readonly format: string;
  write(result: ExplorationResult): Promise<string>;
}

/**
 * Exécute chaque reporter activé et enregistre les fichiers produits dans `result.artifacts`.
 * flow-graph.json lui-même est écrit par la FlowMemory.
 */
export async function writeReports(
  result: ExplorationResult,
  output: ScenarioConfig['output'],
  flowGraphFile?: string,
  language: ReportLanguage = 'en',
): Promise<ExplorationResult> {
  await mkdir(output.reportsDir, { recursive: true });
  result.artifacts.screenshotsDir = output.screenshotsDir;
  if (flowGraphFile) result.artifacts.flowGraph = flowGraphFile;
  if (output.flowGraphHtml) {
    result.artifacts.flowGraphHtml = path.join(output.reportsDir, 'flow-graph.html');
  }
  if (output.json) result.artifacts.json = path.join(output.reportsDir, 'result.json');
  if (result.flowDiff) {
    result.artifacts.flowDiff = path.join(output.reportsDir, 'flow-diff.json');
    await writeFile(result.artifacts.flowDiff, `${JSON.stringify(result.flowDiff, null, 2)}\n`, 'utf8');
  }
  if (result.runAnalysis) {
    result.artifacts.runAnalysis = path.join(output.reportsDir, 'run-analysis.json');
    await writeFile(result.artifacts.runAnalysis, `${JSON.stringify(result.runAnalysis, null, 2)}\n`, 'utf8');
  }
  if (result.workflowAnalysis) {
    const report = result.workflowAnalysis;
    const files: Record<string, { name: string; data: unknown }> = {
      run: {
        name: 'run.json',
        data: { ...report, workflowGraph: undefined, functionalCoverage: undefined, anomalies: undefined },
      },
      anomalies: {
        name: 'anomalies.json',
        data: { summary: report.anomalySummary, anomalies: report.anomalies },
      },
      workflowGraph: { name: 'workflow-graph.json', data: report.workflowGraph },
      functionalCoverage: { name: 'functional-coverage.json', data: report.functionalCoverage },
      ...Object.fromEntries(
        Object.entries(report.extensionFiles ?? {}).map(([key, entry]) => [
          key,
          { name: entry.name, data: entry.data },
        ]),
      ),
    };
    const written: Record<string, string> = {};
    for (const [key, file] of Object.entries(files)) {
      const target = path.join(output.reportsDir, file.name);
      await writeFile(target, `${JSON.stringify(file.data, null, 2)}\n`, 'utf8');
      written[key] = target;
    }
    report.artifacts = { ...report.artifacts, ...written };
    result.artifacts.workflowAnalysis = written;
  }
  if (output.html)
    result.artifacts.html = await new HtmlReporter(output.reportsDir, 'index.html', language).write(result);
  if (output.flowGraphHtml)
    await new FlowGraphHtmlReporter(output.reportsDir, 'flow-graph.html', language).write(result);
  if (output.json) await new JsonReporter(output.reportsDir).write(result);
  return result;
}
