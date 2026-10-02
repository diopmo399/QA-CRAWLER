import { readFileSync } from 'node:fs';
import path from 'node:path';
import { parse as parseYaml, stringify } from 'yaml';
import { ConfigError, parseConfig, type ConfigOverrides } from '../config/config-loader.js';
import type { ScenarioConfig } from '../config/config.js';
import { toFlowIntentGraph, type FlowIntentGraph, type FlowSourceType } from './flow-intent-graph.js';

export interface DryRunInput {
  /** Le scénario du développeur : un `.feature` ou un `flow.yaml`. Jamais modifié. */
  scenarioFile: string;
  /** Le fichier de mission (cible, connexion, sécurité, phrases de l'équipe). */
  missionFile?: string;
  overrides?: ConfigOverrides;
  env?: NodeJS.ProcessEnv;
}

export interface LoadedDryRunScenario {
  config: ScenarioConfig;
  graphs: FlowIntentGraph[];
  source: { type: FlowSourceType; file: string };
  /** Langue d'un `.feature` (`# language: fr`) ; absente pour un flow YAML. */
  language?: 'fr' | 'en';
  warnings: string[];
}

/**
 * Charge le scénario avec le chargeur existant : la mission donne la cible, la
 * connexion, la SafetyPolicy, `gherkin.steps` et les flows `reusable` (pour `run:`) ;
 * ses autres flows sont ignorés — en Dry Run, seul le scénario donné est confronté à
 * l'application. Le fichier du scénario est seulement lu.
 */
export function loadDryRunScenario(input: DryRunInput): LoadedDryRunScenario {
  const scenarioFile = path.resolve(input.scenarioFile);
  const type: FlowSourceType = /\.feature$/i.test(scenarioFile) ? 'GHERKIN' : 'YAML';
  let scenarioText: string;
  try {
    scenarioText = readFileSync(scenarioFile, 'utf8');
  } catch {
    throw new ConfigError(`Scenario file not found: ${input.scenarioFile}`);
  }

  // Une mission donnée comme scénario (`dry-run mission.yaml`) : ses flows sont vérifiés, avec sa cible,
  // sa connexion et sa sécurité.
  const missionFile =
    input.missionFile ?? (type === 'YAML' && isMissionText(scenarioText) ? scenarioFile : undefined);
  const mission = missionFile ? readMission(missionFile) : {};
  const reusable = (Array.isArray(mission.flows) ? (mission.flows as unknown[]) : []).filter(
    (flow) => isObject(flow) && flow.reusable === true,
  );
  const scenarioFlows =
    type === 'GHERKIN'
      ? [{ gherkin: scenarioFile }]
      : yamlFlows(scenarioText, scenarioFile).filter((flow) => !(isObject(flow) && flow.reusable === true));
  const raw = { ...mission, gherkin: dryRunGherkin(mission.gherkin), flows: [...reusable, ...scenarioFlows] };
  const source = missionFile ? path.resolve(missionFile) : scenarioFile;
  const hasTarget =
    input.overrides?.baseUrl !== undefined ||
    (input.env ?? process.env).QA_BASE_URL !== undefined ||
    (isObject(mission.target) && mission.target.baseUrl !== undefined);
  if (!hasTarget)
    throw new ConfigError('No target application for the dry run', [
      'give the mission with -c mission.yaml (target, sign-in, safety), or the address with --base-url https://…',
    ]);
  const { config, warnings } = parseConfig(stringify(raw), input.overrides, input.env, source);
  if (config.flows.length === 0)
    throw new ConfigError(`No scenario to check in ${input.scenarioFile}`, [
      'the file has no scenario (or only @ignore / @skip / @wip ones)',
    ]);
  const graphs = config.flows.map((flow) =>
    toFlowIntentGraph(flow, {
      type,
      file: input.scenarioFile,
      ...(type === 'GHERKIN' ? { featureText: scenarioText } : {}),
    }),
  );
  const language =
    type === 'GHERKIN' ? (/^\s*#\s*language:\s*fr\b/im.test(scenarioText) ? 'fr' : 'en') : undefined;
  return {
    config,
    graphs,
    source: { type, file: input.scenarioFile },
    ...(language ? { language } : {}),
    warnings,
  };
}

/**
 * En Dry Run, une phrase inconnue n'arrête pas le chargement : le Dry Run est fait pour des
 * scénarios incomplets ou imprécis. Mode automatique et résolution sémantique sont actifs,
 * sauf si la mission dit explicitement le contraire.
 */
function dryRunGherkin(gherkin: unknown): Record<string, unknown> {
  const given = isObject(gherkin) ? gherkin : {};
  const semantic = isObject(given.semanticResolution) ? given.semanticResolution : {};
  return {
    ...given,
    auto: given.auto ?? true,
    semanticResolution: { ...semantic, enabled: semantic.enabled ?? true },
  };
}

/** Un fichier YAML qui décrit une mission (cible, mission…) et pas seulement des flows. */
function isMissionText(text: string): boolean {
  try {
    const raw: unknown = parseYaml(text);
    return isObject(raw) && (raw.target !== undefined || raw.mission !== undefined);
  } catch {
    return false;
  }
}

function readMission(file: string): Record<string, unknown> {
  let raw: unknown;
  try {
    raw = parseYaml(readFileSync(file, 'utf8'));
  } catch (error) {
    throw new ConfigError(`Cannot read mission file: ${file}`, [error instanceof Error ? error.message : '']);
  }
  if (!isObject(raw)) throw new ConfigError(`Mission ${file} must be a YAML mapping (key: value)`);
  return raw;
}

/** Un `flow.yaml` : un flow (`name`, `steps`), ou une liste sous `flows:`. */
function yamlFlows(text: string, file: string): unknown[] {
  let raw: unknown;
  try {
    raw = parseYaml(text);
  } catch (error) {
    throw new ConfigError(`Invalid YAML in ${file}`, [error instanceof Error ? error.message : '']);
  }
  if (isObject(raw) && Array.isArray(raw.flows)) {
    // Les chemins des `.feature` d'une liste de flows sont relatifs à ce fichier.
    return (raw.flows as unknown[]).map((flow) =>
      isObject(flow) && typeof flow.gherkin === 'string'
        ? { ...flow, gherkin: path.resolve(path.dirname(file), flow.gherkin) }
        : isObject(flow) && typeof flow.testData === 'string'
          ? { ...flow, testData: path.resolve(path.dirname(file), flow.testData) }
          : flow,
    );
  }
  // Le jeu de données d'un flow (`testData: test-data.yaml`) est relatif au fichier du flow.
  if (isObject(raw) && Array.isArray(raw.steps))
    return [
      typeof raw.testData === 'string'
        ? { ...raw, testData: path.resolve(path.dirname(file), raw.testData) }
        : raw,
    ];
  throw new ConfigError(`Not a flow file: ${file}`, [
    'a flow file has a "name" and "steps" (the schema of a flow under flows: in a mission), or a "flows:" list',
  ]);
}

function isObject(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}
