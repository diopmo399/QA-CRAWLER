import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { parseArgs } from 'node:util';
import { parse as parseYaml } from 'yaml';
import { ConfigError } from '../config/config-loader.js';
import type { ExplorationResult } from '../model/exploration-result.js';
import {
  defaultPlaywrightJavaVersion,
  generateJavaJUnitPlaywrightProject,
  writeJavaProject,
} from '../platform/java-junit-playwright-generator.js';
import { generateGherkinFeatures } from '../platform/gherkin-feature-generator.js';
import { generatePlaywrightTests } from '../platform/playwright-test-generator.js';
import type { ScenarioConfig } from '../config/config.js';
import { assessReproduction, type ReproductionAnalysis } from '../platform/reproduction-planner.js';
import { initProject } from '../project/init.js';
import { missionOverridesOf, readPlaywrightConfig } from '../project/playwright-config.js';
import {
  findProjectConfigFile,
  loadProjectConfig,
  loadProjectMission,
  PROJECT_DIR,
  type MissionOptions,
  type ProjectConfigFile,
} from '../project/project-config.js';
import { setToolIdentity } from '../tool-identity.js';
import { UsageError } from './args.js';
import { logger } from './logger.js';

/**
 * LES COMMANDES DE PROJET : la façade du package installé dans un projet consommateur.
 *
 *   init            détecte le projet, écrit qa-crawler.config.yaml et les dossiers
 *   record          enregistre un parcours humain (le recorder existant, mission dérivée)
 *   replay          rejoue les flows du projet (rejeu, guérison, divergence, récupération…)
 *   explore         exploration autonome
 *   analyze         flows + analyse complète du run de workflow ; code de sortie selon le statut global
 *   test-api        flows + tests d'API tirés du contrat OpenAPI
 *   reproduce       rejoue le chemin de reproduction minimal d'une anomalie et juge le rejeu
 *   generate-tests  écrit les tests Playwright des flows
 *   knowledge-center (à part, src/cli/knowledge-center-command.ts) : le tableau de bord de la mémoire
 *
 * Chaque commande dérive une MISSION de la configuration du projet et la confie aux moteurs
 * existants par la CLI de mission : aucune logique métier n'est dupliquée ici.
 *
 * Codes de sortie : 0 succès · 1 échec QA · 2 usage ou configuration · 3 erreur d'infrastructure.
 */
export const PROJECT_COMMANDS = [
  'init',
  'replay',
  'explore',
  'analyze',
  'test-api',
  'reproduce',
  'generate-tests',
] as const;
export type ProjectCommand = (typeof PROJECT_COMMANDS)[number];

export const PROJECT_HELP = `qa-crawler — QA tool for web applications (installed in your project)

Usage:
  npx qa-crawler init [--base-url <url>] [--force] [--no-example]
  npx qa-crawler record --name <flow> [--url <route>] [record options]
  npx qa-crawler replay [--flow <name>]... [run options]
  npx qa-crawler explore [run options]
  npx qa-crawler analyze [--flow <name>]... [run options]
  npx qa-crawler test-api [run options]
  npx qa-crawler reproduce [<anomaly id>] [run options]
  npx qa-crawler generate-tests [--out <dir>]              Playwright specs (qa-crawler/generated-tests/)
  npx qa-crawler generate-tests --java [--package <name>]  Maven project, JUnit 5 + Playwright Java (qa-crawler/generated-tests-java/)
  npx qa-crawler generate-tests --gherkin                  Gherkin scenarios (qa-crawler/generated-features/)
  npx qa-crawler knowledge-center [--port 4190] [--read-only]  The Knowledge Center: what the tool learned, served locally

Run options (every command that runs the application):
      --base-url <url>        Override qaCrawler.application.baseUrl (also QA_BASE_URL)
      --headless / --headed   Browser visibility (default: qaCrawler.browser.headless)
      --playwright-config <f> Reuse baseURL / headless / viewport from this Playwright config
      --reports-dir <dir>     Override the reports directory (default: qa-reports)
      --config <file>         Project configuration (default: qa-crawler.config.yaml, searched upwards)
      --cwd <dir>             Project directory (default: current directory)
      --persistence <p>       off | memory | file | sqlite | postgres | sqlserver
      --junit                 Also write qa-reports/junit.xml for the CI (or reporting.format: [html, json, junit])
      --intelligence <m>      off | assist | hybrid (also QA_INTELLIGENCE_MODE)
      --max-states <n>, --max-actions <n>, --quiet, --dotenv <file>

Priority: command line > environment variables > qa-crawler.config.yaml > defaults.
Legacy usage (a mission file) still works: qa-crawler [learn|verify|explore] <mission.yaml>, dry-run, sources, k8s-manifest.

Exit codes: 0 success · 1 QA failure · 2 usage or configuration error · 3 infrastructure/tool error
`;

interface ProjectArgs {
  command: ProjectCommand;
  cwd: string;
  configFile?: string;
  baseUrl?: string;
  headless?: boolean;
  playwrightConfig?: string;
  reportsDir?: string;
  flows: string[];
  force: boolean;
  example: boolean;
  out?: string;
  /** generate-tests --java : un projet Maven JUnit 5 + Playwright Java au lieu des specs TypeScript. */
  java: boolean;
  /** generate-tests --gherkin : des scénarios .feature (exécutables par le moteur Gherkin de QA-CRAWLER). */
  gherkin: boolean;
  javaPackage?: string;
  positional?: string;
  /** Options passées telles quelles à la CLI de mission. */
  passthrough: string[];
  help: boolean;
}

const OPTIONS = {
  cwd: { type: 'string' },
  config: { type: 'string', short: 'c' },
  'base-url': { type: 'string' },
  headless: { type: 'boolean' },
  headed: { type: 'boolean' },
  'playwright-config': { type: 'string' },
  'reports-dir': { type: 'string' },
  flow: { type: 'string', multiple: true },
  force: { type: 'boolean', default: false },
  'no-example': { type: 'boolean', default: false },
  out: { type: 'string' },
  java: { type: 'boolean', default: false },
  gherkin: { type: 'boolean', default: false },
  package: { type: 'string' },
  persistence: { type: 'string' },
  'no-persistence': { type: 'boolean' },
  memory: { type: 'boolean' },
  'no-memory': { type: 'boolean' },
  intelligence: { type: 'string' },
  'ai-provider': { type: 'string' },
  'ai-model': { type: 'string' },
  'max-states': { type: 'string' },
  'max-actions': { type: 'string' },
  quiet: { type: 'boolean', short: 'q' },
  junit: { type: 'boolean' },
  help: { type: 'boolean', short: 'h', default: false },
} as const;

const PASSTHROUGH = [
  'persistence',
  'intelligence',
  'ai-provider',
  'ai-model',
  'max-states',
  'max-actions',
] as const;

export function parseProjectArgs(command: ProjectCommand, argv: readonly string[]): ProjectArgs {
  let parsed;
  try {
    parsed = parseArgs({ args: [...argv], allowPositionals: true, strict: true, options: OPTIONS });
  } catch (error) {
    throw new UsageError(error instanceof Error ? error.message : String(error));
  }
  const { values, positionals } = parsed;
  if (positionals.length > 1) throw new UsageError(`unexpected argument "${positionals[1] ?? ''}"`);
  if (values.headless && values.headed) throw new UsageError('--headless and --headed are exclusive');
  const passthrough: string[] = [];
  for (const option of PASSTHROUGH) {
    const value = values[option];
    if (typeof value === 'string') passthrough.push(`--${option}`, value);
  }
  if (values['no-persistence']) passthrough.push('--no-persistence');
  if (values.memory) passthrough.push('--memory');
  if (values['no-memory']) passthrough.push('--no-memory');
  if (values.quiet) passthrough.push('--quiet');
  if (values.junit) passthrough.push('--junit');
  return {
    command,
    cwd: values.cwd ?? process.cwd(),
    ...(values.config ? { configFile: values.config } : {}),
    ...(values['base-url'] ? { baseUrl: values['base-url'] } : {}),
    ...(values.headless ? { headless: true } : values.headed ? { headless: false } : {}),
    ...(values['playwright-config'] ? { playwrightConfig: values['playwright-config'] } : {}),
    ...(values['reports-dir'] ? { reportsDir: values['reports-dir'] } : {}),
    flows: values.flow ?? [],
    force: values.force,
    example: !values['no-example'],
    ...(values.out ? { out: values.out } : {}),
    java: values.java,
    gherkin: values.gherkin,
    ...(values.package ? { javaPackage: values.package } : {}),
    ...(positionals[0] !== undefined ? { positional: positionals[0] } : {}),
    passthrough,
    help: values.help,
  };
}

async function projectOf(args: ProjectArgs): Promise<ProjectConfigFile> {
  const file = args.configFile
    ? path.resolve(args.cwd, args.configFile)
    : await findProjectConfigFile(args.cwd);
  if (!file)
    throw new ConfigError(
      'No qa-crawler.config.yaml found: run `npx qa-crawler init` first (or pass --config <file>).',
    );
  return loadProjectConfig(file);
}

/** La version du projet analysé (son package.json), copiée dans les métadonnées de run. */
async function rememberProjectVersion(root: string): Promise<void> {
  const pkg = await readJson<{ version?: string }>(path.join(root, 'package.json'));
  if (pkg?.version) setToolIdentity({ projectVersion: pkg.version });
}

/** La mission dérivée écrite dans qa-crawler/.derived/ (le fichier que la CLI de mission lit). */
async function deriveMission(
  project: ProjectConfigFile,
  args: ProjectArgs,
  options: MissionOptions,
): Promise<{ file: string; reportsDir: string; flows: number }> {
  await rememberProjectVersion(project.root);
  const playwrightFile = args.playwrightConfig ?? project.config.playwright.config;
  const playwright = playwrightFile
    ? await readPlaywrightConfig(path.resolve(project.root, playwrightFile))
    : undefined;
  const fromPlaywright = playwright ? missionOverridesOf(playwright) : {};
  if (playwright && Object.keys(fromPlaywright).length > 0)
    logger.info(
      `  Playwright: ${path.relative(project.root, playwright.file)} (${Object.keys(fromPlaywright).join(', ')} reused)`,
    );
  // Ce que le playwright.config du projet fixe entre dans la mission dérivée elle-même (le fichier
  // que la CLI de mission relit) ; les options de la ligne de commande restent des surcharges.
  const missionOptions: MissionOptions = {
    ...options,
    missionOverlay: {
      ...(fromPlaywright.baseUrl ? { target: { baseUrl: fromPlaywright.baseUrl } } : {}),
      browser: {
        ...(fromPlaywright.headless !== undefined ? { headless: fromPlaywright.headless } : {}),
        ...(fromPlaywright.viewport ? { viewport: fromPlaywright.viewport } : {}),
      },
    },
  };
  const loaded = await loadProjectMission(project, missionOptions, {
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
    ...(args.headless !== undefined ? { headless: args.headless } : {}),
    ...(args.reportsDir ? { reportsDir: path.resolve(args.cwd, args.reportsDir) } : {}),
  });
  const directory = path.join(project.root, PROJECT_DIR, '.derived');
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `${options.command}.mission.yaml`);
  await writeFile(
    file,
    `# Derived by qa-crawler ${options.command} from ${path.relative(project.root, project.file)} — do not edit, regenerated at each run.\n${loaded.missionYaml}`,
    'utf8',
  );
  for (const warning of loaded.warnings) logger.warn(`  ! ${warning}`);
  return {
    file,
    reportsDir: args.reportsDir ? path.resolve(args.cwd, args.reportsDir) : loaded.config.output.reportsDir,
    flows: loaded.config.flows.length,
  };
}

const missionFlags = (args: ProjectArgs): string[] => [
  ...(args.baseUrl ? ['--base-url', args.baseUrl] : []),
  ...(args.headless === true ? ['--headless'] : []),
  ...(args.reportsDir ? ['--reports-dir', path.resolve(args.cwd, args.reportsDir)] : []),
  ...args.passthrough,
];

async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch {
    return undefined;
  }
}

/** Dépendances injectées : la CLI de mission et celle de l'enregistrement (les moteurs existants). */
export interface ProjectCliRuntime {
  runMissionCli: (argv: string[]) => Promise<number>;
  runRecordCli: (argv: string[]) => Promise<number>;
}

export async function runProjectCli(
  command: ProjectCommand | 'record',
  argv: readonly string[],
  runtime: ProjectCliRuntime,
): Promise<number> {
  let args: ProjectArgs;
  try {
    args = parseProjectArgs(command === 'record' ? 'replay' : command, command === 'record' ? [] : argv);
    if (command === 'record') args = { ...args, command: 'replay', cwd: cwdOf(argv), passthrough: [] };
  } catch (error) {
    if (error instanceof UsageError) {
      logger.error(`Error: ${error.message}\n`);
      logger.info(PROJECT_HELP);
      return 2;
    }
    throw error;
  }
  if (args.help) {
    logger.info(PROJECT_HELP);
    return 0;
  }
  try {
    switch (command) {
      case 'init':
        return await init(args);
      case 'record':
        return await record(argv, args, runtime);
      case 'replay':
      case 'explore':
      case 'test-api':
        return await run(args, command, runtime);
      case 'analyze':
        return await analyze(args, runtime);
      case 'reproduce':
        return await reproduce(args, runtime);
      case 'generate-tests':
        return await generateTests(args);
    }
  } catch (error) {
    if (error instanceof ConfigError) {
      logger.error(error.message);
      return 2;
    }
    throw error;
  }
}

function cwdOf(argv: readonly string[]): string {
  const index = argv.indexOf('--cwd');
  return index >= 0 && argv[index + 1] ? path.resolve(argv[index + 1] ?? '.') : process.cwd();
}

async function init(args: ProjectArgs): Promise<number> {
  const outcome = await initProject({
    root: args.cwd,
    force: args.force,
    example: args.example,
    ...(args.baseUrl ? { baseUrl: args.baseUrl } : {}),
  });
  const d = outcome.detection;
  logger.info('QA-Crawler init');
  logger.info(
    `  Project    : ${d.name ?? path.basename(d.root)}${d.version ? ` ${d.version}` : ''} (${d.framework}${d.typescript ? ', TypeScript' : ''})`,
  );
  logger.info(
    `  Playwright : ${d.playwright.installed ? `${d.playwright.version ?? 'installed'}${d.playwright.config ? ` · ${d.playwright.config}` : ''}` : 'not in this project (QA-Crawler brings its own)'}`,
  );
  logger.info(`  OpenAPI    : ${d.openapi ?? 'none found'}`);
  logger.info(
    `  Git/CI     : ${d.git ? 'git' : 'no git'}${d.github ? ', GitHub' : ''}${d.ci.length > 0 ? `, ${d.ci.join(', ')}` : ''}${d.docker ? ', Docker' : ''}${d.kubernetes ? ', Kubernetes' : ''}`,
  );
  for (const file of outcome.created) logger.info(`  + ${file}`);
  for (const file of outcome.kept) logger.info(`  = ${file} (kept)`);
  for (const note of outcome.notes) logger.info(`  · ${note}`);
  logger.info('');
  logger.info(
    `Next: edit ${path.relative(d.root, outcome.configFile)}, then \`npx qa-crawler record --name <flow>\` or \`npx qa-crawler analyze\`.`,
  );
  return 0;
}

async function record(
  argv: readonly string[],
  args: ProjectArgs,
  runtime: ProjectCliRuntime,
): Promise<number> {
  // Une mission explicite (-c), ou aucun projet configuré (usage historique --url) : la commande d'enregistrement existante telle quelle.
  if (argv.includes('-c') || argv.includes('--config') || !(await findProjectConfigFile(args.cwd)))
    return runtime.runRecordCli([...argv]);
  const project = await projectOf(args);
  const { file, reportsDir } = await deriveMission(project, args, { command: 'record' });
  const rest = [...argv].filter((_, index, all) => !(all[index - 1] === '--cwd') && argv[index] !== '--cwd');
  const flags = [
    '-c',
    file,
    ...(rest.includes('--url') ? [] : ['--url', project.config.application.startAt]),
    ...(rest.includes('--reports-dir') ? [] : ['--reports-dir', reportsDir]),
  ];
  return runtime.runRecordCli([...rest, ...flags]);
}

async function run(
  args: ProjectArgs,
  command: 'replay' | 'explore' | 'test-api',
  runtime: ProjectCliRuntime,
): Promise<number> {
  const project = await projectOf(args);
  const { file, flows } = await deriveMission(project, args, {
    command,
    ...(args.flows.length > 0 ? { flows: args.flows } : {}),
  });
  if (command === 'replay' && flows === 0) {
    logger.error(
      `No flow to replay: add YAML or .feature files under ${path.join(PROJECT_DIR, 'flows')} or record one (qa-crawler record --name <flow>).`,
    );
    return 2;
  }
  return runtime.runMissionCli(['explore', file, ...missionFlags(args)]);
}

async function analyze(args: ProjectArgs, runtime: ProjectCliRuntime): Promise<number> {
  const project = await projectOf(args);
  const { file, reportsDir } = await deriveMission(project, args, {
    command: 'analyze',
    ...(args.flows.length > 0 ? { flows: args.flows } : {}),
  });
  const code = await runtime.runMissionCli(['explore', file, ...missionFlags(args)]);
  if (code >= 2) return code;
  const run = await readJson<{ overallStatus?: string; statusReasons?: string[] }>(
    path.join(reportsDir, 'run.json'),
  );
  if (!run?.overallStatus) return code;
  logger.info(
    `Overall status: ${run.overallStatus}${run.statusReasons?.length ? ` — ${run.statusReasons.join('; ')}` : ''}`,
  );
  return run.overallStatus === 'FAIL' ? 1 : code;
}

async function reproduce(args: ProjectArgs, runtime: ProjectCliRuntime): Promise<number> {
  const project = await projectOf(args);
  const reportsDir = args.reportsDir
    ? path.resolve(args.cwd, args.reportsDir)
    : path.resolve(project.root, project.config.reporting.dir);
  const reproductions = await readJson<ReproductionAnalysis>(path.join(reportsDir, 'reproductions.json'));
  if (!reproductions)
    throw new ConfigError(`No reproductions.json in ${reportsDir}: run \`qa-crawler analyze\` first.`);
  const candidates = reproductions.artifacts.filter((artifact) => artifact.flowYaml);
  const artifact = args.positional
    ? candidates.find((entry) => entry.anomalyId === args.positional)
    : candidates[0];
  if (!artifact?.flowYaml) {
    if (args.positional) {
      logger.error(`Anomaly ${args.positional} has no replayable reproduction path.`);
      return 2;
    }
    logger.info('No anomaly with a reproduction path in the last analysis: nothing to reproduce.');
    return 0;
  }
  const parsed = parseYaml(artifact.flowYaml) as { flows: Record<string, unknown>[] };
  const flow = parsed.flows[0];
  if (!flow) return 1;
  const reproDir = path.join(reportsDir, 'reproductions', artifact.anomalyId.toLowerCase());
  const { file } = await deriveMission(
    project,
    { ...args, reportsDir: reproDir, flows: [] },
    {
      command: 'reproduce',
      flows: [],
      extraFlows: [flow],
      missionName: `reproduce-${artifact.anomalyId.toLowerCase()}`,
    },
  );
  logger.info(
    `Reproducing ${artifact.anomalyId} (${artifact.category}): ${String(artifact.path?.steps.length ?? 0)} step(s) → ${reproDir}`,
  );
  const code = await runtime.runMissionCli(['explore', file, '--reports-dir', reproDir, ...args.passthrough]);
  if (code >= 2) return code;
  const result = await readJson<ExplorationResult>(path.join(reproDir, 'result.json'));
  const replayed = result?.flows[0];
  const status = replayed ? assessReproduction(artifact, replayed) : 'INSUFFICIENT_EVIDENCE';
  logger.info(`Reproduction: ${status}`);
  return status === 'REPRODUCED' ? 0 : 1;
}

async function generateTests(args: ProjectArgs): Promise<number> {
  const project = await projectOf(args);
  const loaded = await loadProjectMission(project, {
    command: 'generate-tests',
    ...(args.flows.length > 0 ? { flows: args.flows } : {}),
  });
  const reportsDir = path.resolve(project.root, project.config.reporting.dir);
  const last = await readJson<ExplorationResult>(path.join(reportsDir, 'result.json'));
  if (loaded.config.flows.length === 0) {
    logger.error(`No flow to generate from: add flows under ${path.join(PROJECT_DIR, 'flows')}.`);
    return 2;
  }
  if (args.java) return generateJavaTests(args, project.root, loaded.config, last);
  if (args.gherkin) {
    const features = generateGherkinFeatures(loaded.config.flows, {
      language: loaded.config.report.language,
    });
    const directory = path.resolve(project.root, args.out ?? path.join(PROJECT_DIR, 'generated-features'));
    await mkdir(directory, { recursive: true });
    for (const feature of features) {
      await writeFile(path.join(directory, feature.fileName), feature.content, 'utf8');
      logger.info(
        `  + ${path.relative(project.root, path.join(directory, feature.fileName))}${feature.unsaid > 0 ? ` (${String(feature.unsaid)} step(s) kept as comments: no Gherkin sentence)` : ''}${feature.replayOnly.length > 0 ? ` (${String(feature.replayOnly.length)} business assertion(s) verified by the replay only)` : ''}`,
      );
    }
    return 0;
  }
  const tests = generatePlaywrightTests(loaded.config.flows, last?.flows ?? [], {
    baseUrl: loaded.config.target.baseUrl,
    ...(last?.cognitive ? { checkpoints: last.cognitive.checkpoints } : {}),
  });
  const directory = path.resolve(project.root, args.out ?? path.join(PROJECT_DIR, 'generated-tests'));
  await mkdir(directory, { recursive: true });
  for (const test of tests) {
    await writeFile(path.join(directory, test.fileName), test.content, 'utf8');
    logger.info(
      `  + ${path.relative(project.root, path.join(directory, test.fileName))} (${String(test.steps)} step(s), ${String(test.assertions)} assertion(s))`,
    );
  }
  return 0;
}

/**
 * generate-tests --java : le projet Maven (JUnit 5 + Playwright Java) des flows, à côté du projet.
 * Java et Maven ne sont pas nécessaires pour générer, seulement pour exécuter le projet écrit.
 */
async function generateJavaTests(
  args: ProjectArgs,
  root: string,
  config: ScenarioConfig,
  last: ExplorationResult | undefined,
): Promise<number> {
  const generated = generateJavaJUnitPlaywrightProject(config.flows, last?.flows ?? [], {
    baseUrl: config.target.baseUrl,
    ...(args.javaPackage ? { packageName: args.javaPackage } : {}),
    versions: { playwright: defaultPlaywrightJavaVersion() },
    ...(last?.cognitive ? { checkpoints: last.cognitive.checkpoints } : {}),
  });
  const directory = path.resolve(root, args.out ?? path.join(PROJECT_DIR, 'generated-tests-java'));
  for (const file of await writeJavaProject(generated, directory))
    logger.info(`  + ${path.relative(root, file)}`);
  for (const test of generated.tests) {
    logger.info(
      `  ${test.className}: ${String(test.steps)} step(s), ${String(test.assertions)} assertion(s)${test.unsupported.length > 0 ? `, ${String(test.unsupported.length)} unsupported step(s) (the test is aborted there)` : ''}`,
    );
    for (const entry of [...test.unsupported, ...test.notes]) logger.info(`    - ${entry}`);
  }
  logger.info(
    `Run: cd ${path.relative(root, directory) || '.'} && QA_BASE_URL=${config.target.baseUrl} mvn test   (JUnit XML in target/surefire-reports/)`,
  );
  return 0;
}
