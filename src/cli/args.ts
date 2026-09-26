import { parseArgs } from 'node:util';

export interface CliArgs {
  configPath?: string;
  help: boolean;
  version: boolean;
  baseUrl?: string;
  maxStates?: number;
  maxActions?: number;
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

export const HELP_TEXT = `qa-crawler — autonomous, deterministic QA flow explorer for web applications

Give it a URL and a mission: it observes each screen, discovers the possible
actions, decides what to try, checks it against the safety policy, executes
it with Playwright and builds the flow graph of the application.

Usage:
  npm run qa -- <mission.yaml> [options]
  npm run qa -- --config <mission.yaml> [options]
  node dist/main.js --config <mission.yaml> [options]

Options:
  -c, --config <file>         Mission YAML file (or pass it as the first argument)
      --base-url <url>        Override target.baseUrl (also: QA_BASE_URL env variable)
      --max-states <n>        Override exploration.maxStates
      --max-actions <n>       Override exploration.maxActions
      --headed                Show the browser window (debugging; needs a display)
      --reports-dir <dir>     Override output.reportsDir (default: reports)
      --screenshots-dir <dir> Override output.screenshotsDir (default: screenshots)
  -q, --quiet                 Only print the summary
  -h, --help                  Show this help
  -v, --version               Show the version

Exit codes:
  0  exploration finished, no issue at or above report.failOnSeverity
  1  exploration finished with failing issues
  2  invalid usage or invalid mission
  3  runtime failure (browser could not start, authentication failed...)

Environment:
  QA_BASE_URL                Overrides target.baseUrl
  QA_USERNAME / QA_PASSWORD  Default credential variables for auth.type: form | http
  PLAYWRIGHT_BROWSERS_PATH   Where Playwright finds Chromium
`;

function positiveInteger(name: string, value: string | undefined): number | undefined {
  if (value === undefined) return undefined;
  const parsed = Number(value);
  if (!Number.isInteger(parsed) || parsed <= 0) throw new UsageError(`--${name} must be a positive integer.`);
  return parsed;
}

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
        'max-states': { type: 'string' },
        'max-actions': { type: 'string' },
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
    throw new UsageError('Provide a single mission file (positional argument or --config).');
  }
  const maxStates = positiveInteger('max-states', values['max-states']);
  const maxActions = positiveInteger('max-actions', values['max-actions']);
  const configPath = values.config ?? positionals[0];
  return {
    ...(configPath !== undefined ? { configPath } : {}),
    help: values.help,
    version: values.version,
    quiet: values.quiet,
    ...(values['base-url'] !== undefined ? { baseUrl: values['base-url'] } : {}),
    ...(maxStates !== undefined ? { maxStates } : {}),
    ...(maxActions !== undefined ? { maxActions } : {}),
    ...(values.headed ? { headless: false } : {}),
    ...(values['reports-dir'] !== undefined ? { reportsDir: values['reports-dir'] } : {}),
    ...(values['screenshots-dir'] !== undefined ? { screenshotsDir: values['screenshots-dir'] } : {}),
  };
}
