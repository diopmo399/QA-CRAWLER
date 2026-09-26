import { writeFile } from 'node:fs/promises';
import path from 'node:path';
import type { CrawlResult } from '../model/crawl-result.js';
import type { Reporter } from './reporter.js';

/** reports/result.json — the machine-readable result (CI gates, dashboards, future AI engines). */
export class JsonReporter implements Reporter {
  readonly format = 'json';

  constructor(
    private readonly directory: string,
    private readonly fileName = 'result.json',
  ) {}

  async write(result: CrawlResult): Promise<string> {
    const target = path.join(this.directory, this.fileName);
    const withSelf: CrawlResult = { ...result, artifacts: { ...result.artifacts, json: target } };
    await writeFile(target, `${JSON.stringify(withSelf, null, 2)}\n`, 'utf8');
    return target;
  }
}
