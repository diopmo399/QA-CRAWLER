import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import type { ScenarioConfig } from '../config/config.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import { FlowGraphHtmlReporter } from './flow-graph-html-reporter.js';
import { HtmlReporter } from './html-reporter.js';
import type { ReportLanguage } from './i18n.js';
import { JsonReporter } from './json-reporter.js';

/** Writes an exploration result somewhere; returns the path of the produced file. */
export interface Reporter {
  readonly format: string;
  write(result: ExplorationResult): Promise<string>;
}

/**
 * Runs every enabled reporter and records the produced files in `result.artifacts`.
 * flow-graph.json itself is written by the FlowMemory.
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
  if (output.html)
    result.artifacts.html = await new HtmlReporter(output.reportsDir, 'index.html', language).write(result);
  if (output.flowGraphHtml)
    await new FlowGraphHtmlReporter(output.reportsDir, 'flow-graph.html', language).write(result);
  if (output.json) await new JsonReporter(output.reportsDir).write(result);
  return result;
}
