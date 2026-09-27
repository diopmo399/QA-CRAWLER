import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse as parseYaml } from 'yaml';
import { z } from 'zod';
import { invariantSchema, type InvariantConfig, type ScenarioConfig } from '../config/config.js';
import { UI_PATTERNS, type UiPattern } from '../patterns/ui-pattern.js';
import { SemanticDictionary } from './semantic-dictionary.js';

const words = z.record(z.string().min(1), z.array(z.string().min(1)));

const domainPackSchema = z
  .object({
    name: z.string().min(1),
    description: z.string().optional(),
    concepts: words.default({}),
    synonyms: words.default({}),
    /** Indices de score : intérêt supplémentaire d'un concept sur un écran qui montre ce motif. */
    patternRules: z.record(z.enum(UI_PATTERNS), z.record(z.string().min(1), z.number())).default({}),
    invariants: z.array(invariantSchema).default([]),
  })
  .strict();

export type DomainPack = z.output<typeof domainPackSchema>;
/** Intérêt supplémentaire par motif et par concept, venu des packs de domaine. */
export type PatternRuleHints = Partial<Record<UiPattern, Record<string, number>>>;

/** Le vocabulaire et les règles de la mission : dictionnaire, indices de score et invariants des packs. */
export interface Semantics {
  dictionary: SemanticDictionary;
  patternRules: PatternRuleHints;
  /** Invariants apportés par les packs (ceux de la mission s'y ajoutent). */
  invariants: InvariantConfig[];
  /** Packs chargés, pour le rapport. */
  packs: string[];
}

/** Le dossier domain-packs/ livré avec le crawler (sources et build). */
export const BUILTIN_PACKS_DIR = fileURLToPath(new URL('../../domain-packs/', import.meta.url));

/**
 * Charge les packs de domaine de la mission : un nom (generic, ecommerce,
 * administration) désigne un pack livré avec le crawler, un chemin (.yaml/.yml)
 * un fichier de l'équipe. Les packs n'apportent que du vocabulaire, des synonymes,
 * des invariants et des indices de score — jamais une règle propre à une application.
 */
export async function loadDomainPacks(
  names: readonly string[],
  baseDir = process.cwd(),
): Promise<DomainPack[]> {
  const packs: DomainPack[] = [];
  for (const name of names) {
    const file = /\.ya?ml$/i.test(name)
      ? path.resolve(baseDir, name)
      : path.join(BUILTIN_PACKS_DIR, `${name}.yaml`);
    let text: string;
    try {
      text = await readFile(file, 'utf8');
    } catch {
      throw new Error(`domain pack "${name}" not found (${file})`);
    }
    const parsed = domainPackSchema.safeParse(parseYaml(text));
    if (!parsed.success)
      throw new Error(
        `domain pack "${name}" is invalid: ${parsed.error.issues.map((issue) => `${issue.path.join('.')}: ${issue.message}`).join('; ')}`,
      );
    packs.push(parsed.data);
  }
  return packs;
}

/** Le dictionnaire et les règles : les packs d'abord, la mission ensuite (elle a le dernier mot). */
export function semanticsOf(
  config: Pick<ScenarioConfig, 'semantics'>,
  packs: readonly DomainPack[] = [],
): Semantics {
  const patternRules: PatternRuleHints = {};
  for (const pack of packs) {
    for (const [pattern, rules] of Object.entries(pack.patternRules) as [UiPattern, Record<string, number>][])
      patternRules[pattern] = { ...patternRules[pattern], ...rules };
  }
  return {
    dictionary: new SemanticDictionary(...packs, config.semantics),
    patternRules,
    invariants: packs.flatMap((pack) => pack.invariants),
    packs: packs.map((pack) => pack.name),
  };
}

export async function loadSemantics(
  config: Pick<ScenarioConfig, 'semantics' | 'domainPacks'>,
  baseDir?: string,
): Promise<Semantics> {
  return semanticsOf(config, await loadDomainPacks(config.domainPacks, baseDir));
}
