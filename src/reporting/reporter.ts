import { mkdir } from 'node:fs/promises';
import type { ScenarioConfig } from '../config/config.js';
import type { CrawlResult } from '../model/crawl-result.js';
import { HtmlReporter } from './html-reporter.js';
import { JsonReporter } from './json-reporter.js';

/** Writes a crawl result somewhere; returns the path of the produced file. */
export interface Reporter {
  readonly format: string;
  write(result: CrawlResult): Promise<string>;
}

/** Runs every enabled reporter and records the produced files in `result.artifacts`. */
export async function writeReports(
  result: CrawlResult,
  output: ScenarioConfig['output'],
): Promise<CrawlResult> {
  await mkdir(output.reportsDir, { recursive: true });
  result.artifacts.screenshotsDir = output.screenshotsDir;
  // The HTML report is written first so the JSON can reference it.
  if (output.html) {
    result.artifacts.html = await new HtmlReporter(output.reportsDir, output.screenshotsDir).write(result);
  }
  if (output.json) {
    result.artifacts.json = await new JsonReporter(output.reportsDir).write(result);
  }
  return result;
}
