import { readFileSync } from 'node:fs';
import path from 'node:path';
import { AstBuilder, compile, GherkinClassicTokenMatcher, Parser } from '@cucumber/gherkin';
import { IdGenerator, PickleStepType, type GherkinDocument, type Pickle } from '@cucumber/messages';
import { labelOf } from '../flow-includes.js';
import { GherkinStepDictionary, type CustomGherkinStep, type RawStep } from './gherkin-steps.js';

/**
 * Une entrée `flows` qui charge un fichier Gherkin au lieu d'écrire les étapes :
 *
 *   flows:
 *     - gherkin: ./features/creation.feature
 *       scenarios: ["Création simple"]   # facultatif : seulement ceux-là
 *       tags: ["@smoke"]                 # facultatif : seulement les scénarios avec l'un de ces tags
 *       thenExplore: true                # facultatif : pour tous les scénarios du fichier
 */
export interface GherkinFlowEntry {
  gherkin: string;
  scenarios?: string[];
  tags?: string[];
  thenExplore?: boolean;
  startAt?: string;
}

/** Tags reconnus sur un scénario (ou la fonctionnalité, ou une ligne d'exemples). */
const TAG_ALLOW: Record<string, string> = {
  '@mutation': 'MUTATION',
  '@dangerous': 'DANGEROUS',
  '@dangereux': 'DANGEROUS',
  '@unknown': 'UNKNOWN',
  '@inconnu': 'UNKNOWN',
};
const TAG_EXPLORE = new Set(['@explore', '@explorer', '@thenexplore']);
const TAG_SKIP = new Set(['@ignore', '@skip', '@wip', '@ignorer']);
/** « (optionnel) » à la fin d'une phrase : un échec de cette étape est un WARNING, le flow continue. */
const OPTIONAL_SUFFIX = /\s*\((?:optionnel|optionnelle|facultatif|facultative|optional)\)\s*$/i;

export class GherkinError extends Error {
  constructor(
    message: string,
    readonly details: string[] = [],
  ) {
    super(message);
    this.name = 'GherkinError';
  }
}

export function isGherkinEntry(value: unknown): value is GherkinFlowEntry {
  return value !== null && typeof value === 'object' && 'gherkin' in value;
}

/**
 * Lit un fichier .feature et renvoie ses scénarios sous forme de flows bruts (la même
 * forme qu'un flow écrit dans le YAML, validée ensuite par le même schéma). Le Contexte
 * (Background) est ajouté au début de chaque scénario, un Plan du scénario donne un
 * flow par ligne d'exemples, les tags sont hérités de la fonctionnalité.
 * Une phrase inconnue est une erreur, avec le fichier et la ligne : jamais deviner.
 */
export function gherkinFlows(
  entry: GherkinFlowEntry,
  baseDir: string,
  custom: readonly CustomGherkinStep[] = [],
): Record<string, unknown>[] {
  const file = path.resolve(baseDir, entry.gherkin);
  // Le chemin tel qu'écrit dans la mission : c'est celui que l'utilisateur reconnaît.
  const display = entry.gherkin.replace(/^\.\//, '');
  let text: string;
  try {
    text = readFileSync(file, 'utf8');
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    throw new GherkinError(
      code === 'ENOENT' ? `Gherkin file not found: ${display}` : `Cannot read Gherkin file: ${display}`,
    );
  }
  let document: GherkinDocument;
  try {
    const parser = new Parser(new AstBuilder(IdGenerator.incrementing()), new GherkinClassicTokenMatcher());
    document = parser.parse(text);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new GherkinError(`Invalid Gherkin in ${display}`, [
      message,
      // L'oubli le plus fréquent : un fichier qui commence directement par Given / Étant donné.
      ...(/#FeatureLine/.test(message)
        ? [
            'the file must start with "Feature:" (or "Fonctionnalité:" after "# language: fr"), then "Scenario:" / "Scenario Outline:" (with Examples) before the steps',
          ]
        : []),
    ]);
  }
  const pickles = compile(document, display, IdGenerator.incrementing());
  const steps = stepIndex(document);
  const dictionary = new GherkinStepDictionary(custom);
  const wanted = entry.scenarios ? new Set(entry.scenarios) : undefined;
  const wantedTags = entry.tags?.map((tag) => normalizeTag(tag));
  const unknown: string[] = [];
  const flows: Record<string, unknown>[] = [];
  const names = new Map<string, number>();

  for (const pickle of pickles) {
    const tags = pickle.tags.map((tag) => normalizeTag(tag.name));
    if (tags.some((tag) => TAG_SKIP.has(tag))) continue;
    if (wanted && !wanted.has(pickle.name)) continue;
    if (wantedTags && !wantedTags.some((tag) => tags.includes(tag))) continue;
    const allow = [...new Set(tags.flatMap((tag) => (TAG_ALLOW[tag] ? [TAG_ALLOW[tag]] : [])))];
    const flowSteps: RawStep[] = [];
    for (const step of pickle.steps) {
      const source = steps.get(step.astNodeIds[0] ?? '');
      const line = source?.line ?? pickle.location?.line;
      const keyword = source?.keyword.trim() ?? '';
      const optional = OPTIONAL_SUFFIX.test(step.text);
      const sentence = step.text.replace(OPTIONAL_SUFFIX, '');
      const table = step.argument?.dataTable?.rows.map((row) => row.cells.map((cell) => cell.value));
      let translated: RawStep[] | undefined;
      try {
        translated = dictionary.translate(sentence, table);
      } catch (error) {
        unknown.push(`${display}:${line ?? '?'}: "${sentence}": ${(error as Error).message}`);
        continue;
      }
      if (!translated) {
        unknown.push(`${display}:${line ?? '?'}: "${keyword} ${sentence}"`);
        continue;
      }
      const label = `${keyword} ${sentence}`.trim();
      translated.forEach((raw) => {
        // « Alors je suis sur "/x" » vérifie l'adresse ; « Étant donné que je suis sur "/x" » y va.
        const checked =
          step.type === PickleStepType.OUTCOME && typeof raw.goto === 'string'
            ? { expect: { url: raw.goto } }
            : raw;
        flowSteps.push({
          name: translated.length > 1 ? `${label} (${describe(raw)})` : label,
          ...checked,
          ...(allow.length > 0 ? { allow } : {}),
          ...(optional ? { optional: true } : {}),
        });
      });
    }
    if (flowSteps.length === 0) continue;
    flows.push({
      name: uniqueName(names, pickle, document),
      description: `${display}:${pickle.location?.line ?? ''}`,
      ...(entry.startAt !== undefined ? { startAt: entry.startAt } : {}),
      steps: flowSteps,
      ...(entry.thenExplore === true || tags.some((tag) => TAG_EXPLORE.has(tag))
        ? { thenExplore: true }
        : {}),
    });
  }
  if (unknown.length > 0)
    throw new GherkinError(`Unrecognised Gherkin sentence(s) in ${display}`, [
      ...unknown,
      'write it with one of the built-in sentences (see the README, "Scénarios Gherkin"), or add it under gherkin.steps in the mission',
    ]);
  if (wanted) {
    const found = new Set(pickles.map((pickle) => pickle.name));
    const missing = [...wanted].filter((name) => !found.has(name));
    if (missing.length > 0)
      throw new GherkinError(
        `Scenario(s) not found in ${display}`,
        missing.map((name) => `"${name}"`),
      );
  }
  return flows;
}

/** Mot-clé et ligne de chaque étape du document (les pickles ne gardent que le texte). */
function stepIndex(document: GherkinDocument): Map<string, { keyword: string; line: number }> {
  const index = new Map<string, { keyword: string; line: number }>();
  const visit = (steps: readonly { id: string; keyword: string; location: { line: number } }[]): void => {
    for (const step of steps) index.set(step.id, { keyword: step.keyword, line: step.location.line });
  };
  for (const child of document.feature?.children ?? []) {
    if (child.background) visit(child.background.steps);
    if (child.scenario) visit(child.scenario.steps);
    for (const nested of child.rule?.children ?? []) {
      if (nested.background) visit(nested.background.steps);
      if (nested.scenario) visit(nested.scenario.steps);
    }
  }
  return index;
}

/**
 * Le nom du flow : celui du scénario ; pour un Plan du scénario, suivi des valeurs de
 * la ligne d'exemples (« Création [Dupont, 42] ») ; numéroté en cas de doublon.
 */
function uniqueName(seen: Map<string, number>, pickle: Pickle, document: GherkinDocument): string {
  const row = exampleRow(document, pickle.astNodeIds[1]);
  const base = row ? `${pickle.name} [${row.join(', ')}]` : pickle.name;
  const count = (seen.get(base) ?? 0) + 1;
  seen.set(base, count);
  return count > 1 ? `${base} #${count}` : base;
}

function exampleRow(document: GherkinDocument, rowId: string | undefined): string[] | undefined {
  if (!rowId) return undefined;
  const scenarios = (document.feature?.children ?? []).flatMap((child) => [
    ...(child.scenario ? [child.scenario] : []),
    ...(child.rule?.children ?? []).flatMap((nested) => (nested.scenario ? [nested.scenario] : [])),
  ]);
  for (const scenario of scenarios)
    for (const examples of scenario.examples)
      for (const row of examples.tableBody) if (row.id === rowId) return row.cells.map((cell) => cell.value);
  return undefined;
}

function describe(raw: RawStep): string {
  const fill = raw.fill as { label?: unknown } | undefined;
  return typeof fill?.label === 'string' ? fill.label : labelOf(raw);
}

function normalizeTag(tag: string): string {
  const clean = tag.trim().toLowerCase();
  return clean.startsWith('@') ? clean : `@${clean}`;
}
