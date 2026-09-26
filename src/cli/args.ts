import { parseArgs } from 'node:util';

export interface CliArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  baseUrl?: string;
  maxPages?: number;
  headless?: boolean;
  reportsDir?: string;
  screenshotsDir?: string;
  quiet: boolean;
}

export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

export const HELP_TEXT = `qa-crawler — deterministic QA crawler for web applications

Usage:
  npm run qa -- <scenario.yaml> [options]
  npm run qa -- --config <scenario.yaml> [options]
  node dist/main.js --config <scenario.yaml> [options]

Options:
  -c, --config <file>        Scenario YAML file (or pass it as the first argument)
      --base-url <url>       Override target.baseUrl (also: QA_BASE_URL env variable)
      --max-pages <n>        Override exploration.maxPages
      --headed               Show the browser window (debugging; needs a display)
      --reports-dir <dir>    Override output.reportsDir (default: reports)
      --screenshots-dir <dir> Override output.screenshotsDir (default: screenshots)
  -q, --quiet                Only print the summary
  -h, --help                 Show this help
  -v, --version              Show the version

Exit codes:
  0  crawl finished, no issue at or above report.failOnSeverity
  1  crawl finished with failing issues
  2  invalid usage or invalid scenario
  3  runtime failure (browser could not start, authentication failed...)

Environment:
  QA_BASE_URL                Overrides target.baseUrl
  QA_USERNAME / QA_PASSWORD  Default credential variables for auth.type: form
  PLAYWRIGHT_BROWSERS_PATH   Where Playwright finds Chromium
`;

export function parseCliArgs(argv: string[]): CliArgs {
  let parsed;
  try {
    parsed = parseArgs({
      args: argv,
      allowPositionals: true,
      strict: true,
      options: {
        config: { type: 'string', short: 'c' },
        'base-url': { type: 'string' },
        'max-pages': { type: 'string' },
        headed: { type: 'boolean', default: false },
        'reports-dir': { type: 'string' },
        'screenshots-dir': { type: 'string' },
        quiet: { type: 'boolean', short: 'q', default: false },
        help: { type: 'boolean', short: 'h', default: false },
        version: { type: 'boolean', short: 'v', default: false },
      },
    });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;

  if (positionals.length > 1 || (positionals.length === 1 && values.config !== undefined)) {
    throw new UsageError('Provide a single scenario file (positional argument or --config).');
  }

  let maxPages: number | undefined;
  if (values['max-pages'] !== undefined) {
    maxPages = Number(values['max-pages']);
    if (!Number.isInteger(maxPages) || maxPages <= 0) {
      throw new UsageError('--max-pages must be a positive integer.');
    }
  }

  const configPath = values.config ?? positionals[0];
  return {
    ...(configPath !== undefined ? { configPath } : {}),
    help: values.help,
    version: values.version,
    quiet: values.quiet,
    ...(values['base-url'] !== undefined ? { baseUrl: values['base-url'] } : {}),
    ...(maxPages !== undefined ? { maxPages } : {}),
    ...(values.headed ? { headless: false } : {}),
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    ...(values['screenshots-dir'] !== undefined ? { screenshotsDir: values['screenshots-dir'] } : {}),
  };
}
